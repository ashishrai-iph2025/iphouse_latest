package reportcache

/*
Keeping reports usable across a deploy, and for as long as they are right.

── Across a deploy ───────────────────────────────────────────────────────────

	Keys carry the build (version.go), so a new build cannot READ the old one's
	entries as its own — that is what stops a fixed calculation from hiding
	behind cached numbers. It also meant every deploy started from an empty
	cache, and thousands of reports had to be rebuilt before anything was fast.

	So the previous build is remembered (in Redis, outside any build's prefix),
	and a report missing under the new build can be CARRIED OVER: served from
	the previous build's entry while the caller rebuilds it with the new code
	straight away. The first open after a deploy is instant; the numbers the new
	code produces follow within the rebuild, not hours later. One build back
	only — anything older has been rebuilt or has expired.

── For as long as they are right ─────────────────────────────────────────────

	An entry starts with the configured retention (a day by default). Every time
	the freshness check CONFIRMS it still matches the warehouse, its life is
	extended to ConfirmedTTL. A report the check cannot answer for keeps the
	short life, so nothing unverifiable can stand for a month.
*/

import (
	"context"
	"encoding/json"
	"strings"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
)

// ConfirmedTTL is how long an entry the freshness check has vouched for is kept.
// Redis's own memory limit (allkeys-lru) still evicts under pressure.
const ConfirmedTTL = 30 * 24 * time.Hour

// Where the current and previous build tags are kept — outside every build's
// prefix, so each build can find the one before it.
const enginesKey = "rpt:engines"

var previousEngine atomic.Value // string

// registerEngine records this build as current and remembers the one before it.
// Called on every successful connect.
func registerEngine(ctx context.Context, rdb *redis.Client) {
	cur := engine()
	stored, err := rdb.HGet(ctx, enginesKey, "current").Result()
	switch {
	case err != nil && err != redis.Nil:
		return
	case stored == "" || err == redis.Nil:
		rdb.HSet(ctx, enginesKey, "current", cur)
	case stored != cur:
		// A new build: the old current becomes previous.
		rdb.HSet(ctx, enginesKey, "previous", stored, "current", cur)
		previousEngine.Store(stored)
		return
	}
	if prev, err := rdb.HGet(ctx, enginesKey, "previous").Result(); err == nil && prev != "" && prev != cur {
		previousEngine.Store(prev)
	}
}

func previousPrefix() string {
	if p, _ := previousEngine.Load().(string); p != "" {
		return "rpt:" + p + ":"
	}
	return ""
}

// ReadCarried returns the PREVIOUS build's entry for a key of this build, if
// there is one. Not counted as a hit: it is a stand-in the caller must rebuild.
func (c *Cache) ReadCarried(ctx context.Context, key string) (json.RawMessage, time.Time, bool) {
	rdb := c.client()
	prev := previousPrefix()
	cur := keyPrefix()
	if rdb == nil || prev == "" || !strings.HasPrefix(key, cur) {
		return nil, time.Time{}, false
	}
	b, err := rdb.Get(ctx, prev+strings.TrimPrefix(key, cur)).Bytes()
	if err != nil {
		return nil, time.Time{}, false
	}
	var s stored
	if json.Unmarshal(b, &s) != nil || len(s.Payload) == 0 {
		return nil, time.Time{}, false
	}
	return s.Payload, s.At, true
}

// Extend lengthens an entry's life to d — never shortens it. Used when the
// freshness check confirms an entry still matches the warehouse.
func (c *Cache) Extend(ctx context.Context, key string, d time.Duration) {
	rdb := c.client()
	if rdb == nil || key == "" || d <= 0 {
		return
	}
	// GT: only if the new expiry is later than the current one (Redis 7+).
	// On an older Redis the command errors and the entry keeps its life.
	rdb.ExpireGT(ctx, key, d)
}
