// Package reportcache keeps finished reports in Redis so opening one is a read
// rather than a computation.
//
// A report is between one and eighteen aggregate queries over tables with
// millions of rows. Cold, that is seconds; the same answer served from Redis is
// single-digit milliseconds. Nothing about the report changes between two people
// opening it in the same afternoon, so computing it twice is work nobody asked
// for.
//
// WHAT IS CACHED, and what deliberately is not:
//
//	cached      a platform + client + date window with NO drill-down filters —
//	            the thing a report opens as, and what a warmer can predict
//	not cached  anything with a filter applied. Those are a long tail: eleven
//	            dimensions with hundreds of values each, so caching them would
//	            fill Redis with entries read once and never again.
//
// Redis is OPTIONAL. With no address configured the cache reports itself
// disabled and every request computes as it always did — this can be turned off
// without any report changing its answer.
package reportcache

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
)

type Config struct {
	Addr     string
	Password string
	DB       int
	// How long a cached report stays servable. Long, because a warmer refreshes
	// it far sooner; this is the backstop for a client the warmer never reaches.
	TTL time.Duration
}

type Cache struct {
	mu   sync.RWMutex
	rdb  *redis.Client
	cfg  Config
	live bool
	err  string

	hits   atomic.Int64
	misses atomic.Int64
	writes atomic.Int64
	errors atomic.Int64
}

var shared = &Cache{}

// Get returns the process-wide cache.
func Get() *Cache { return shared }

/*
Configure connects, or disconnects when the address is empty.

Called at startup and again whenever the settings are saved, so a Redis server
can be pointed at, moved or switched off without a restart.
*/
func (c *Cache) Configure(cfg Config) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.rdb != nil {
		_ = c.rdb.Close()
		c.rdb = nil
	}
	c.cfg = cfg
	c.live, c.err = false, ""

	if strings.TrimSpace(cfg.Addr) == "" {
		c.err = "no Redis address configured"
		return
	}
	if cfg.TTL <= 0 {
		c.cfg.TTL = 6 * time.Hour
	}
	c.rdb = redis.NewClient(&redis.Options{
		Addr:     cfg.Addr,
		Password: cfg.Password,
		DB:       cfg.DB,
		// Short: a cache that blocks is worse than no cache, because the report
		// still has to be computed afterwards and the wait was added to it.
		DialTimeout:  2 * time.Second,
		ReadTimeout:  2 * time.Second,
		WriteTimeout: 2 * time.Second,
	})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := c.rdb.Ping(ctx).Err(); err != nil {
		c.err = err.Error()
		return
	}
	c.live = true
}

func (c *Cache) client() *redis.Client {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if !c.live {
		return nil
	}
	return c.rdb
}

// Enabled reports whether reads and writes will actually go anywhere.
func (c *Cache) Enabled() bool { c.mu.RLock(); defer c.mu.RUnlock(); return c.live }

func (c *Cache) Status() (live bool, addr string, db int, ttl time.Duration, errText string) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.live, c.cfg.Addr, c.cfg.DB, c.cfg.TTL, c.err
}

/*
Key identifies one cached report.

Only the parameters that CHANGE THE ANSWER are in it, and they are sorted, so
the same report asked for with the parameters in a different order is one entry
rather than two. Anything with a drill-down filter returns ok=false and is not
cached at all — see the note at the top of the file.

`shape` is what the report is made OF — the panel keys it carries — as opposed
to the scope it is drawn over. It is in the key because the two go stale
independently: adding a breakdown changes no client, no window and no filter, so
without it every cached report keeps being served with the new panel MISSING for
the length of the TTL, and the new panel renders "No data." on real data. That
is not hypothetical — it is exactly what the Franchise and Match Day panels did
for six hours after they were added.
*/
func Key(platform, clientID, shape string, q map[string]string) (string, bool) {
	key, _, ok := KeyKind(platform, clientID, shape, q)
	return key, ok
}

/*
KeyKind is Key, and says whether this is a plain SCOPE or a DRILL-DOWN.

Both are cached now, and they are kept apart because they behave differently
enough that one retention rule cannot serve both:

	scope       a platform + client + window, no filters. Few, predictable, read
	            by everyone, and worth precomputing — this is what the warmer
	            fills and what a report opens as.
	drill-down  the same thing with a filter applied. Eleven dimensions with
	            hundreds of values each, so the space is effectively unbounded
	            and almost every entry is read once.

Drill-downs were not cached at all, on the reasoning that a long tail would fill
Redis with entries nobody reads twice. That reasoning was half right: it is a
long tail, and it does not fit. But it made every click a full recompute of the
whole report — measured on this warehouse, eighteen to a hundred and eight
seconds — and a reader clicking a bar, reading it, and clicking back paid it
twice.

What makes them cacheable is that filling Redis is exactly the problem eviction
solves. Entries carry a short life of their own, and the memory limit runs
allkeys-lru, so a tail nobody re-reads is evicted by the traffic that is being
re-read. The cache stops being a fixed set to predict and becomes a working set
to keep.

The two are distinguishable in the key so the admin screen can count them
separately, and so a future policy — a different life, a cap, eviction by kind —
has something to act on rather than needing this decision made again.
*/
func KeyKind(platform, clientID, shape string, q map[string]string) (key string, drill bool, ok bool) {
	if platform == "" || clientID == "" {
		return "", false, false
	}
	from, to := strings.TrimSpace(q["from"]), strings.TrimSpace(q["to"])

	/* Every parameter beyond the scope itself, in a fixed order.

	   SORTED, because Go randomises map iteration: unsorted, the same
	   drill-down would hash differently from one request to the next and never
	   hit its own entry — a cache that stores everything and reads nothing,
	   which looks exactly like a cache that is simply slow. */
	extra := make([]string, 0, len(q))
	for k, v := range q {
		v = strings.TrimSpace(v)
		if v == "" {
			continue
		}
		switch k {
		case "clientId", "from", "to", "type", "grain":
		default:
			extra = append(extra, k+"="+v)
		}
	}
	sort.Strings(extra)
	drill = len(extra) > 0

	grain := strings.TrimSpace(q["grain"])
	parts := []string{platform, clientID, from, to, grain, shape}
	parts = append(parts, extra...)
	raw := strings.Join(parts, "|")
	// Hashed because a client id is a GUID and a key made of four of them is
	// long enough to matter when there are thousands of them.
	sum := sha1.Sum([]byte(raw))

	// The kind is in the key, not only in the return value, so the two spaces
	// can never collide and can be counted apart on the admin screen.
	prefix := keyPrefix()
	if drill {
		prefix += "d:"
	}
	return prefix + hex.EncodeToString(sum[:]), drill, true
}

// Entry is a cached report plus what is needed to describe it on the admin page.
type Entry struct {
	Platform string    `json:"platform"`
	ClientID string    `json:"clientId"`
	From     string    `json:"from"`
	To       string    `json:"to"`
	StoredAt time.Time `json:"storedAt"`
	BuildMS  float64   `json:"buildMs"`
	Bytes    int       `json:"bytes"`
	Payload  []byte    `json:"-"`
}

type stored struct {
	Platform string          `json:"p"`
	ClientID string          `json:"c"`
	From     string          `json:"f"`
	To       string          `json:"t"`
	At       time.Time       `json:"at"`
	BuildMS  float64         `json:"ms"`
	Payload  json.RawMessage `json:"d"`
}

/*
Read returns a cached report.

A miss, an unreachable Redis and a corrupt record are all the same answer here —
not found — because the caller's response to each is identical: compute it. A
cache that can return an error the caller has to handle is a cache that has made
the calling code worse.
*/
func (c *Cache) Read(ctx context.Context, key string) (json.RawMessage, time.Time, bool) {
	rdb := c.client()
	if rdb == nil || key == "" {
		return nil, time.Time{}, false
	}
	b, err := rdb.Get(ctx, key).Bytes()
	if err != nil {
		if err != redis.Nil {
			c.errors.Add(1)
		}
		c.misses.Add(1)
		return nil, time.Time{}, false
	}
	var s stored
	if json.Unmarshal(b, &s) != nil || len(s.Payload) == 0 {
		c.misses.Add(1)
		return nil, time.Time{}, false
	}
	c.hits.Add(1)
	return s.Payload, s.At, true
}

// Write stores a computed report. Failures are counted and swallowed: a report
// that was produced correctly must not fail because it could not be cached.
func (c *Cache) Write(ctx context.Context, key, platform, clientID, from, to string, payload []byte, buildMS float64) {
	c.writeFor(ctx, key, platform, clientID, from, to, payload, buildMS, 0)
}

/*
WriteFor stores an entry with a life of its own.

A drill-down is kept for minutes rather than for the retention window: it exists
to make "click, read, click back" instant, which is a span of seconds, and
keeping thousands of them for a day would spend the memory the plain scopes need
on entries read once.
*/
func (c *Cache) WriteFor(ctx context.Context, key, platform, clientID, from, to string, payload []byte, buildMS float64, ttl time.Duration) {
	c.writeFor(ctx, key, platform, clientID, from, to, payload, buildMS, ttl)
}

func (c *Cache) writeFor(ctx context.Context, key, platform, clientID, from, to string, payload []byte, buildMS float64, ttl time.Duration) {
	rdb := c.client()
	if rdb == nil || key == "" || len(payload) == 0 {
		return
	}
	rec, err := json.Marshal(stored{
		Platform: platform, ClientID: clientID, From: from, To: to,
		At: time.Now().UTC(), BuildMS: buildMS, Payload: payload,
	})
	if err != nil {
		c.errors.Add(1)
		return
	}
	c.mu.RLock()
	full := c.cfg.TTL
	c.mu.RUnlock()
	if ttl <= 0 || ttl > full {
		ttl = full
	}

	if err := rdb.Set(ctx, key, rec, ttl).Err(); err != nil {
		c.errors.Add(1)
		return
	}
	/* Tracked in a set so the admin page can list what is cached without a
	   KEYS scan, which blocks Redis on a large keyspace.

	   Drill-downs are NOT indexed. The index answers "what is warm" — the
	   predictable set the pass maintains and an operator reasons about — and
	   thousands of ten-minute filter combinations would bury it while making
	   the listing read every one of them on every poll. They are found by
	   prefix instead, which is what Purge does. */
	if isDrillKey(key) {
		c.writes.Add(1)
		return
	}
	rdb.SAdd(ctx, metaKey(), key)
	// Against the FULL retention window, not this entry's: a short-lived
	// drill-down must not shorten the index that every entry is listed in.
	rdb.Expire(ctx, metaKey(), full*2)
	c.writes.Add(1)
}

// List describes what is currently cached, newest first.
func (c *Cache) List(ctx context.Context, limit int) ([]Entry, error) {
	rdb := c.client()
	if rdb == nil {
		return nil, fmt.Errorf("cache is not connected")
	}
	keys, err := rdb.SMembers(ctx, metaKey()).Result()
	if err != nil {
		return nil, err
	}
	out := make([]Entry, 0, len(keys))
	var dead []string
	for _, k := range keys {
		b, err := rdb.Get(ctx, k).Bytes()
		if err != nil {
			// Expired out from under the index; tidy it rather than listing it.
			dead = append(dead, k)
			continue
		}
		var s stored
		if json.Unmarshal(b, &s) != nil {
			dead = append(dead, k)
			continue
		}
		out = append(out, Entry{
			Platform: s.Platform, ClientID: s.ClientID, From: s.From, To: s.To,
			StoredAt: s.At, BuildMS: s.BuildMS, Bytes: len(b),
		})
	}
	if len(dead) > 0 {
		rdb.SRem(ctx, metaKey(), toAny(dead)...)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].StoredAt.After(out[j].StoredAt) })
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// isDrillKey reports whether a key holds a filtered view rather than a plain
// scope. The kind is carried in the key, so the two can be told apart without
// reading the entry.
func isDrillKey(key string) bool { return strings.HasPrefix(key, keyPrefix()+"d:") }

/*
Purge removes every cached report. The index goes with it, so nothing is left
pointing at keys that no longer exist.

Drill-downs are swept by PREFIX rather than read from the index, because they
are deliberately not in it. Without this pass, "Empty the cache" would leave
every filtered view behind — and an operator clearing the cache to see a change
take effect would click a bar and be served the old answer anyway.
*/
func (c *Cache) Purge(ctx context.Context) (int, error) {
	rdb := c.client()
	if rdb == nil {
		return 0, fmt.Errorf("cache is not connected")
	}
	keys, err := rdb.SMembers(ctx, metaKey()).Result()
	if err != nil {
		return 0, err
	}
	if len(keys) > 0 {
		rdb.Del(ctx, keys...)
	}
	rdb.Del(ctx, metaKey())
	n := len(keys)

	/* The unindexed halves, by prefix. SCAN so a large keyspace does not block
	   Redis.

	   Two of them, and the second is not merely housekeeping:

	     d:*   the drill-downs, which are deliberately not indexed.
	     fp:*  the FRESHNESS MARKS — what the warehouse looked like when each
	           report was last built.

	   Leaving the marks behind made "Empty the cache" a trap. The next warm
	   pass probes, finds a mark that still matches, concludes nothing has
	   changed and SKIPS the rebuild — so the cache someone had just emptied
	   stayed empty, and stayed empty until the data moved or the marks aged out
	   four retention windows later. Emptying the cache has to mean the reports
	   get built again. */
	for _, pattern := range []string{keyPrefix() + "d:*", keyPrefix() + "fp:*"} {
		var cursor uint64
		for {
			found, next, serr := rdb.Scan(ctx, cursor, pattern, 500).Result()
			if serr != nil {
				break
			}
			if len(found) > 0 && rdb.Del(ctx, found...).Err() == nil {
				n += len(found)
			}
			cursor = next
			if cursor == 0 {
				break
			}
		}
	}
	return n, nil
}

// Stats are the counters the admin page reports. Reset on restart — they
// describe this process, and are labelled as such rather than implying history.
func (c *Cache) Stats() map[string]int64 {
	return map[string]int64{
		"hits": c.hits.Load(), "misses": c.misses.Load(),
		"writes": c.writes.Load(), "errors": c.errors.Load(),
	}
}

// Info returns selected fields from Redis INFO — enough to see whether the
// server is healthy without shipping the whole several-hundred-line dump.
func (c *Cache) Info(ctx context.Context) (map[string]string, error) {
	rdb := c.client()
	if rdb == nil {
		return nil, fmt.Errorf("cache is not connected")
	}
	raw, err := rdb.Info(ctx).Result()
	if err != nil {
		return nil, err
	}
	want := map[string]bool{
		"redis_version": true, "uptime_in_days": true, "connected_clients": true,
		"used_memory_human": true, "maxmemory_human": true, "maxmemory_policy": true,
		"evicted_keys": true, "keyspace_hits": true, "keyspace_misses": true,
		"role": true,
	}
	out := map[string]string{}
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		k, v, ok := strings.Cut(line, ":")
		if ok && want[k] {
			out[k] = v
		}
	}
	return out, nil
}

/*
── Memory ───────────────────────────────────────────────────────────────────

	Redis takes its cap at RUN TIME (CONFIG SET maxmemory), which is what makes
	this settable from a screen at all. Two things follow from that, and both
	are told to the operator rather than left to be discovered:

	  - it does NOT survive a restart of Redis. Whatever started the server —
	    a compose command, a redis.conf — wins again the moment it comes back.
	    This service re-applies the stored value every time it connects, which
	    covers a portal restart; a Redis restart while the portal keeps running
	    is the gap, and the durable fix is the line that starts Redis.
	  - a managed Redis usually FORBIDS it. ElastiCache and friends reject
	    CONFIG SET, so the error is surfaced verbatim rather than swallowed.
*/
type MemoryInfo struct {
	UsedBytes   int64  `json:"usedBytes"`
	MaxBytes    int64  `json:"maxBytes"`
	SystemBytes int64  `json:"systemBytes"`
	Policy      string `json:"policy"`
}

func (c *Cache) Memory(ctx context.Context) (MemoryInfo, error) {
	var out MemoryInfo
	rdb := c.client()
	if rdb == nil {
		return out, fmt.Errorf("cache is not connected")
	}
	raw, err := rdb.Info(ctx, "memory").Result()
	if err != nil {
		return out, err
	}
	for _, line := range strings.Split(raw, "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), ":")
		if !ok {
			continue
		}
		switch k {
		case "used_memory":
			out.UsedBytes = parseInt64(v)
		case "maxmemory":
			out.MaxBytes = parseInt64(v)
		case "total_system_memory":
			out.SystemBytes = parseInt64(v)
		case "maxmemory_policy":
			out.Policy = v
		}
	}
	return out, nil
}

/*
SetMaxMemory changes the cap on the running server.

`allkeys-lru` is set alongside it, and deliberately: a cap with the default
`noeviction` policy does not discard anything when full — it starts REFUSING
WRITES, so the cache silently stops taking new reports and every request
recomputes while Redis sits there apparently healthy. For a pure cache, evicting
the least recently used entry is the only sensible behaviour, and raising the
cap without fixing the policy would leave that trap in place.
*/
func (c *Cache) SetMaxMemory(ctx context.Context, bytes int64) error {
	rdb := c.client()
	if rdb == nil {
		return fmt.Errorf("cache is not connected")
	}
	if bytes < 0 {
		return fmt.Errorf("memory limit cannot be negative")
	}
	if err := rdb.ConfigSet(ctx, "maxmemory", fmt.Sprint(bytes)).Err(); err != nil {
		return fmt.Errorf("Redis refused the change: %w — a managed Redis usually forbids CONFIG SET; set it where the server is started instead", err)
	}
	if err := rdb.ConfigSet(ctx, "maxmemory-policy", "allkeys-lru").Err(); err != nil {
		return fmt.Errorf("limit set, but the eviction policy could not be changed: %w", err)
	}
	return nil
}

func parseInt64(s string) int64 {
	var n int64
	for _, ch := range strings.TrimSpace(s) {
		if ch < '0' || ch > '9' {
			break
		}
		n = n*10 + int64(ch-'0')
	}
	return n
}

/*
── Freshness marks ──────────────────────────────────────────────────────────

	What the warehouse looked like the last time a report was built: a cheap
	fingerprint — a row count and a high-water mark — kept beside the entry.

	This is what makes a 400-day window affordable. Rebuilding one is eighteen
	aggregates over a year of rows; asking whether anything CHANGED is one. On a
	client whose data has not moved since the last pass, the pass costs a single
	query instead of eighteen, and the cached report is already correct.
*/
func fpKey(platform, clientID, window string) string {
	return keyPrefix() + "fp:" + platform + ":" + clientID + ":" + window
}

// Fingerprint returns the mark stored for a report, if any.
func (c *Cache) Fingerprint(ctx context.Context, platform, clientID, window string) (string, bool) {
	rdb := c.client()
	if rdb == nil {
		return "", false
	}
	v, err := rdb.Get(ctx, fpKey(platform, clientID, window)).Result()
	if err != nil {
		return "", false
	}
	return v, true
}

/*
SetFingerprint records the mark a report was built from.

Given a longer life than the report itself, deliberately: if the entry expires
but nothing upstream changed, the mark still says so and the next pass can
rebuild once and then go quiet again rather than treating every expiry as new
data.
*/
func (c *Cache) SetFingerprint(ctx context.Context, platform, clientID, window, fp string) {
	rdb := c.client()
	if rdb == nil || fp == "" {
		return
	}
	c.mu.RLock()
	ttl := c.cfg.TTL
	c.mu.RUnlock()
	rdb.Set(ctx, fpKey(platform, clientID, window), fp, ttl*4)
}

func toAny(s []string) []any {
	out := make([]any, len(s))
	for i, v := range s {
		out[i] = v
	}
	return out
}
