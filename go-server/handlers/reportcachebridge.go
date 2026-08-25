package handlers

// Serving reports from the cache, and keeping it filled.
//
// The cache sits around runPlatform — the one function that turns a platform and
// a scope into a finished report — so everything that produces a report gets it
// and nothing has to know it is there. See reportcache/cache.go for what is and
// is not cached.

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/ip-house/iphouse-api/db"
	"github.com/ip-house/iphouse-api/reportcache"
	"github.com/ip-house/iphouse-api/reportsapi"
)

/*
platformShape fingerprints WHAT a platform's report contains, so that a change
to its panels invalidates the cache the same way a change to the window does.

The dimension keys, in the order sectionDimensions puts them, plus the tables
they were derived from — which between them move whenever a panel is added,
removed or renamed, and whenever a table is attached to the platform. Hashing
them means nobody has to remember to purge anything after a deploy: the key
simply stops matching the entries built by the previous shape, and those expire
on their own TTL.

Cheap enough to do per request — specsForPlatform reads the dataset catalogue,
which reportsapi caches — and it is on the request path only for reports that
are cacheable at all.
*/
func platformShape(p platformDef, clientID string) string {
	parts := make([]string, 0, 16)
	parts = append(parts, p.Tables...)
	dims := sectionDimensions(p)
	for _, d := range dims {
		parts = append(parts, strFromAny(d["key"])+":"+strFromAny(d["viz"]))
	}
	/* The configured top-N is part of the shape, not part of the filter.

	   Without it, changing a panel from ten rows to five kept serving the
	   ten-row answer for the length of the retention window — long enough for
	   somebody to change the setting, reload, see no difference and conclude
	   the control does nothing. Folding it into the shape means the new setting
	   simply has a different key, so it builds fresh and the old entries age
	   out on their own. Sorted, because a map's order is not stable and an
	   unstable shape is a cache that misses every time. */
	limits := dimRowLimits(p.Key, clientID, dims)
	keys := make([]string, 0, len(limits))
	for k := range limits {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		parts = append(parts, k+"="+strconv.Itoa(limits[k]))
	}
	sum := sha1.Sum([]byte(strings.Join(parts, "|")))
	return hex.EncodeToString(sum[:8])
}

/*
cachedPlatformReport is runPlatform with a cache in front.

The MISS path is the old path exactly: compute, answer, and store on the way out
— storing after answering, so a slow or broken Redis delays nobody. The report
is already correct at that point; caching it is bookkeeping.

`force` skips the READ and rebuilds. It exists because everything that refreshes
the cache goes through this same function, and without it a refresh was a no-op:
the pass decided a report had changed, called the builder, and the builder
handed back the very entry it had set out to replace. Nothing was recomputed
until the entry expired on its own, which made the TTL — not the data — the only
thing that ever moved a number.
*/
func cachedPlatformReport(p platformDef, q map[string]string, bg, force bool) map[string]any {
	key, drill, cacheable := reportcache.KeyKind(p.Key, q["clientId"], platformShape(p, q["clientId"]), q)
	c := reportcache.Get()

	if cacheable && c.Enabled() && !force {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		payload, at, ok := c.Read(ctx, key)
		cancel()
		if ok {
			var out map[string]any
			if json.Unmarshal(payload, &out) == nil {
				/* Stamped, and deliberately visible. A number that might be
				   twenty minutes old must say so — a reader comparing it against
				   something they just did needs to know whether it could
				   possibly include it. */
				out["cached"] = true
				out["cachedAt"] = at.UTC().Format(time.RFC3339)
				/* And checked, behind the answer. A cached report is served in
				   milliseconds and then asked, at most once every few minutes,
				   whether the warehouse has moved under it — see revalidate.
				   Not on the warmer's own reads: it has already decided.

				   Not on drill-downs either. They live for minutes, so a check
				   would rebuild an entry that is about to expire anyway, and
				   there are thousands of distinct ones — the probes alone would
				   outweigh the work the cache saves. Their short life IS their
				   freshness guarantee. */
				if !bg && !drill {
					revalidate(p, q, key)
				}
				return out
			}
		}
	}

	started := time.Now()
	out := runPlatform(p, q, bg)

	if cacheable && c.Enabled() {
		// Only a good report is worth keeping. Caching a failure would serve
		// the failure to everyone for the length of the TTL.
		if ok, _ := out["ok"].(bool); ok {
			if b, err := json.Marshal(out); err == nil {
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				/* A drill-down keeps a short life of its own — see drillTTL.
				   A plain scope passes 0 and takes the full retention window. */
				life := time.Duration(0)
				if drill {
					life = drillTTL()
				}
				c.WriteFor(ctx, key, p.Key, q["clientId"], q["from"], q["to"], b,
					float64(time.Since(started).Milliseconds()), life)
				cancel()
			}
			/* The warehouse's state AT THE MOMENT THIS WAS BUILT, recorded
			   beside the entry. This is what the next read compares against to
			   decide whether the entry still describes reality — without it,
			   "has anything changed" has nothing to change FROM.

			   Live builds only, and plain scopes only. The background pass
			   builds thousands of these and keeps its own marks; a drill-down is
			   never revalidated, so a mark for one would be written and never
			   read. */
			if !bg && !drill {
				markBuilt(p.Key, q)
			}
		}
	}
	out["cached"] = false
	return out
}

/*
── Freshness on the read path ────────────────────────────────────────────────

	Entries are kept for a day, which is the right retention: a report opened
	this afternoon should still be a read tomorrow morning. It is the wrong
	staleness. Nobody wants yesterday's numbers because yesterday is when the
	entry happened to be built.

	So a hit answers from the cache and then, behind the response, asks the cheap
	question the warmer asks: one aggregate — a row count and a high-water mark —
	against the platform's first table. If it matches what the entry was built
	from, nothing happens. If it moved, the report is rebuilt in the background
	and the NEXT reader gets the new numbers.

	Deliberately after the answer rather than before it. A check in front of
	every hit would put a warehouse round-trip back on the path the cache exists
	to keep off it, and would do so on every open to catch the rare one where
	something changed in the last few minutes.

	Two things keep this from becoming its own load: a per-report cooldown, so a
	report opened forty times an hour is checked a handful of times; and an
	in-flight guard, so ten people opening the same cold-ish report queue one
	rebuild between them rather than ten.
*/

// How long after a check before the same report is worth checking again. A
// setting, because how fast the warehouse moves is a property of the install.
var recheckEvery atomic.Int64 // nanoseconds

func init() { recheckEvery.Store(int64(10 * time.Minute)) }

// SetCacheRecheck sets the read-path cooldown. Zero or less turns the check off
// and leaves the scheduled pass as the only thing that refreshes an entry.
func SetCacheRecheck(d time.Duration) { recheckEvery.Store(int64(d)) }

/*
── How long a drill-down lives ───────────────────────────────────────────────

	Minutes, not the retention window.

	A drill-down exists to make one gesture fast: click a bar, read it, click
	back, click the next one. That is a span of seconds to a couple of minutes,
	and it is the whole of the benefit. Keeping thousands of them for a day
	would spend on entries read once the memory that the plain scopes — read by
	everybody, all day — actually need.

	Ten minutes also bounds how stale one can be, which is why they are exempt
	from the freshness probe: checking an entry that is about to expire costs
	more than rebuilding it when it does.
*/
var drillTTLMinutes atomic.Int64

func init() { drillTTLMinutes.Store(10) }

func drillTTL() time.Duration {
	return time.Duration(drillTTLMinutes.Load()) * time.Minute
}

// SetDrillTTL sets that life. 0 or less turns drill-down caching off, leaving
// every click a full recompute — which is what the product did before.
func SetDrillTTL(d time.Duration) { drillTTLMinutes.Store(int64(d / time.Minute)) }

var (
	recheckMu   sync.Mutex
	recheckedAt = map[string]time.Time{}
	rebuilding  = map[string]bool{}
)

/*
freshWindow is the window key a freshness mark is filed under on the read path.

The dates themselves, not a name: a reader picks any range the calendar allows,
so there is no small set of names to file under. The scheduled pass files under
its window's name instead ("30", "mtd") precisely because its dates roll every
midnight and its mark has to survive that.
*/
func freshWindow(q map[string]string) string {
	return strings.TrimSpace(q["from"]) + "|" + strings.TrimSpace(q["to"])
}

// markBuilt records what the warehouse looked like when a report was built, so
// a later read has something to compare against.
func markBuilt(platform string, q map[string]string) {
	if recheckEvery.Load() <= 0 {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		client, from, to := q["clientId"], q["from"], q["to"]
		if fp, ok := probeFreshness(ctx, platform, client, from, to); ok && fp != "" {
			reportcache.Get().SetFingerprint(ctx, platform, client, freshWindow(q), fp)
		}
	}()
}

/*
revalidate checks a served entry against the warehouse and rebuilds it if it no
longer matches. Returns immediately; the work is a goroutine.
*/
func revalidate(p platformDef, q map[string]string, key string) {
	every := time.Duration(recheckEvery.Load())
	if every <= 0 {
		return
	}

	recheckMu.Lock()
	if rebuilding[key] || time.Since(recheckedAt[key]) < every {
		recheckMu.Unlock()
		return
	}
	recheckedAt[key] = time.Now()
	/* The map holds one small entry per distinct report opened. Left alone it
	   would grow for the life of the process, so it is swept whenever it gets
	   large — dropping anything already past its cooldown, which is exactly the
	   set that no longer affects any decision. */
	if len(recheckedAt) > 5000 {
		cutoff := time.Now().Add(-every)
		for k, at := range recheckedAt {
			if at.Before(cutoff) && !rebuilding[k] {
				delete(recheckedAt, k)
			}
		}
	}
	rebuilding[key] = true
	recheckMu.Unlock()

	// A copy, because the caller's map belongs to a request that is about to be
	// answered and may be reused or mutated after this returns.
	scope := make(map[string]string, len(q))
	for k, v := range q {
		scope[k] = v
	}

	go func() {
		defer func() {
			recheckMu.Lock()
			delete(rebuilding, key)
			recheckMu.Unlock()
		}()

		client, from, to := scope["clientId"], scope["from"], scope["to"]
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		fp, ok := probeFreshness(ctx, p.Key, client, from, to)
		/* No cheap answer available — a table with no date column, or a
		   warehouse that did not respond. Nothing happens: the retention window
		   and the scheduled pass are the backstop. Rebuilding on "I could not
		   check" would recompute every open report every cooldown on the
		   strength of no evidence at all. */
		if !ok || fp == "" {
			return
		}

		win := freshWindow(scope)
		prev, had := reportcache.Get().Fingerprint(ctx, p.Key, client, win)
		if !had {
			/* Nothing to compare against — this entry was built by the
			   background pass, which files its marks under its own window names.
			   Record what the warehouse looks like now and decide at the next
			   check. Rebuilding here instead would recompute every warmed report
			   the first time anybody opened it, which is precisely the work the
			   pass had already done. */
			reportcache.Get().SetFingerprint(ctx, p.Key, client, win, fp)
			return
		}
		if prev == fp {
			return // the entry still describes the warehouse
		}
		rebuildNow(p, scope)
	}()
}

// rebuildNow recomputes a report and replaces its entry, ignoring what is
// already cached for it.
func rebuildNow(p platformDef, q map[string]string) {
	started := time.Now()
	out := cachedPlatformReport(p, q, true, true)
	if ok, _ := out["ok"].(bool); !ok {
		/* Left in place on purpose. The cached entry is a report that WORKED;
		   replacing it with a failure because the warehouse was briefly
		   unreachable would turn a slightly old number into no number at all. */
		log.Printf("[report-cache] revalidate %s/%s: rebuild failed, keeping the cached copy",
			p.Key, q["clientId"])
		return
	}
	log.Printf("[report-cache] refreshed %s/%s %s→%s in %s — the warehouse had changed",
		p.Key, q["clientId"], q["from"], q["to"], time.Since(started).Round(time.Millisecond))
	// The mark moves with the entry. Left at the old value, every later check
	// would see a difference and rebuild again, forever.
	markBuilt(p.Key, q)
}

/*
warmOne is what the background pass calls. It reuses the same path a request
takes, so a warmed report and a requested one cannot differ.

`force` is the caller's decision, not this function's — see BuildFunc. Warming
an entry that already exists is the whole job when something says it has changed,
and a build that answered from the cache would refresh nothing; but forcing on no
evidence would rebuild the world on every pass.
*/
func warmOne(ctx context.Context, platform, clientID, from, to string, force bool) ([]byte, error) {
	p, ok := platformByKey(platform)
	if !ok {
		return nil, fmt.Errorf("platform %q is not enabled", platform)
	}
	q := map[string]string{"clientId": clientID, "from": from, "to": to}
	out := cachedPlatformReport(p, q, true, force)
	/* A report that came back not-ok is NOT cached — see cachedPlatformReport —
	   so the client simply never appears in the admin table, and previously it
	   did so without a word anywhere. Silence there is indistinguishable from
	   "the pass never ran", which is exactly the conclusion an operator drew.
	   The reason travels back to the caller instead. */
	if okv, _ := out["ok"].(bool); !okv {
		reason := strFromAny(out["error"])
		if reason == "" {
			reason = "the report produced no data for this window"
		}
		return nil, fmt.Errorf("%s", reason)
	}
	return json.Marshal(out)
}

/*
warmTargets is every pair worth keeping warm: the enabled platforms, and the
clients someone can actually open a report for.

The client list comes from the portal's own MAPPING rather than from the
warehouse. That is the right set and a much smaller one: a warehouse client with
no portal login mapped to it is a report nobody can open, and warming it would
spend the warehouse's time on an answer with no reader.
*/
func warmTargets() ([]string, []string) {
	platforms := []string{}
	for _, p := range loadPlatforms() {
		if p.Enabled && p.Key != summaryKey {
			platforms = append(platforms, p.Key)
		}
	}

	clients := []string{}
	rows, err := db.Query(
		"SELECT DISTINCT " + ClientIDColumn + " AS cid FROM dcp_user " +
			"WHERE " + ClientIDColumn + " IS NOT NULL AND " + ClientIDColumn + " != '' AND deleted = 0")
	if err != nil {
		log.Printf("[report-warmer] client list: %v", err)
		return platforms, clients
	}
	for _, r := range rows {
		if v := strFromAny(r["cid"]); v != "" {
			clients = append(clients, v)
		}
	}
	return platforms, clients
}

/*
probeFreshness answers "has anything changed for this report" for the price of
one aggregate.

It asks the reports API for the platform's first table: rowCount and
lastUpdated. Those two together move whenever a row is added, removed or
rewritten, which is the whole question — and a MAX over an indexed column plus a
COUNT is a fraction of the eighteen queries a rebuild costs.

Returns ok=false when it cannot get a cheap answer: not in API mode, no dataset,
or a table with no change column at all. The pass then rebuilds unconditionally,
which is the safe direction — never mistake "could not check" for "unchanged".
*/
func probeFreshness(ctx context.Context, platform, clientID, from, to string) (string, bool) {
	p, ok := platformByKey(platform)
	if !ok {
		return "", false
	}
	specs, _ := specsForPlatform(p)
	if len(specs) == 0 {
		return "", false
	}

	/* EVERY table the platform reads, not just the first.

	   A report merges its tables, so a change in any one of them changes the
	   report — and Open Web Sports reads two. Probing only the first declared
	   the report unchanged whenever the second was the one that moved, and the
	   entry then stood until its retention window expired. That is a stale
	   report produced by the freshness check itself, which is the worst place
	   for one.

	   The marks are concatenated in spec order, so the fingerprint changes if
	   any table's does. One extra aggregate per additional table, against the
	   fifty calls a rebuild costs. */
	parts := make([]string, 0, len(specs))
	for _, sp := range specs {
		fp, ok := probeSpec(ctx, sp, clientID, from, to)
		if !ok {
			/* One unanswerable table makes the whole answer unanswerable. A
			   fingerprint built from the tables that DID answer would be stable
			   while the missing one changed underneath it — reporting "nothing
			   changed" on evidence that could not see the change. */
			return "", false
		}
		parts = append(parts, fp)
	}
	return strings.Join(parts, "~"), true
}

// probeSpec is the cheap question for one table.
func probeSpec(ctx context.Context, s reportSpec, clientID, from, to string) (string, bool) {
	if !reportsViaAPI() {
		return probeFreshnessDB(s, clientID, from, to)
	}
	c := reportsapi.Get()
	ds, ok := c.ByTable(ctx, s.Table)
	if !ok {
		return "", false
	}
	scope := url.Values{}
	scope.Set("ClientId", clientID)
	if from != "" && to != "" {
		scope.Set(ds.DateFromParam, from)
		scope.Set(ds.DateToParam, to)
	}
	sum, err := c.Summary(ctx, ds, scope)
	if err != nil || sum == nil {
		return "", false
	}
	/* Three marks, not one.

	   rowCount alone misses an in-place correction that rewrites a row without
	   adding one. lastUpdated alone misses a deletion, which moves the count and
	   not the maximum. lastDate catches a backfill that lands rows in the past.

	   lastUpdated is the one carrying the removals, and it earns its place:
	   measured on this warehouse, every removed row's UpdatedOn is later than
	   its RemovalTime — the removal is written and the row's change stamp moves
	   with it — so a takedown recorded for a post uploaded last month still
	   moves the mark for last month's window, which is the window the report is
	   keyed by. */
	fp := fmt.Sprintf("%v|%v|%v",
		sum["rowCount"], sum["lastUpdated"], sum["lastDate"])
	if fp == "<nil>|<nil>|<nil>" {
		return "", false
	}
	return fp, true
}

/*
probeFreshnessDB is the same question asked of the warehouse directly.

It exists because everything that refreshes an entry now REBUILDS it, and a
rebuild is only affordable when something cheap has said it is needed. Without a
direct-mode probe, an install reading the warehouse rather than reports_api
would have no cheap answer for any report — and "could not check" means rebuild,
which would turn every pass into a full sweep of every client, platform and
window.

One aggregate over the range already indexed for the report itself: how many
rows, and the latest date among them. Both move on an insert and on a delete,
which between them are how this warehouse changes. An in-place correction that
alters neither is the case this cannot see — the same blind spot the reports_api
probe has, and the reason the TTL still exists underneath.
*/
func probeFreshnessDB(s reportSpec, clientID, from, to string) (string, bool) {
	if !db.ReportsConfigured() || s.Table == "" || s.DateCol == "" || s.ClientCol == "" {
		return "", false
	}
	where := " WHERE " + s.ClientCol + " = ?"
	args := []any{clientID}
	if from != "" && to != "" {
		where += " AND " + s.DateCol + " BETWEEN ? AND ?"
		args = append(args, from, to)
	}
	row, err := db.ReportsQuery(
		"SELECT COUNT(*) AS rowCount, MAX("+s.DateCol+") AS lastDate FROM "+s.Table+where, args...)
	if err != nil || len(row) == 0 {
		return "", false
	}
	return fmt.Sprintf("%v|%v", row[0]["rowCount"], row[0]["lastDate"]), true
}

// StartReportCache wires the cache and the warmer together at boot.
func StartReportCache() {
	reportcache.GetWarmer().SetBuilders(warmOne, warmTargets, probeFreshness)
}
