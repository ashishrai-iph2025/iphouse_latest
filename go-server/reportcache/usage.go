package reportcache

/*
WHICH CLIENTS PEOPLE ACTUALLY OPEN — the signal the "top clients" auto-cache
ranks by (see handlers/admin/autotop.go).

One sorted set per report kind per UTC day, in the cache's own Redis:

	rptusage:<kind>:<YYYYMMDD>   member = client id, score = opens that day

kind is "reports", "traffic" or "torrent". Each set expires after usageKeepDays,
so the history is a rolling window and never needs cleaning.

NOT under keyPrefix(): that prefix carries the build tag, and a deploy must not
forget who is used most — the ranking has to survive exactly the event (a new
build, an emptied cache) after which it matters most.

── AN "OPEN", NOT A REQUEST ─────────────────────────────────────────────────

A report page makes dozens of requests — one per panel, per slicer change — and
a traffic page makes two. Counting requests would rank clients by how many
panels their pages happen to have. So a (person, client, kind) is counted at
most once per usageDedupe: an open, however many requests it takes.

Fail-soft like the rest of this package: no Redis, no counting, no error.
*/

import (
	"context"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	usageKeepDays = 35
	usageDedupe   = 10 * time.Minute
)

// UsageKinds are the report kinds usage is recorded for.
var UsageKinds = []string{"reports", "traffic", "torrent"}

var usageSeen = struct {
	sync.Mutex
	m map[string]time.Time
}{m: map[string]time.Time{}}

func usageKey(kind string, day time.Time) string {
	return "rptusage:" + kind + ":" + day.UTC().Format("20060102")
}

/*
NoteUse records that `who` opened `kind` for clientID. Cheap and asynchronous:
it is called on the request path of every report.
*/
func (c *Cache) NoteUse(kind, clientID, who string) {
	clientID = strings.TrimSpace(clientID)
	if clientID == "" {
		return
	}
	dk := kind + "|" + strings.ToUpper(clientID) + "|" + who
	now := time.Now()
	usageSeen.Lock()
	if at, ok := usageSeen.m[dk]; ok && now.Sub(at) < usageDedupe {
		usageSeen.Unlock()
		return
	}
	usageSeen.m[dk] = now
	if len(usageSeen.m) > 20000 { // bound the dedupe map
		for k, at := range usageSeen.m {
			if now.Sub(at) > usageDedupe {
				delete(usageSeen.m, k)
			}
		}
	}
	usageSeen.Unlock()

	rdb := c.client()
	if rdb == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		key := usageKey(kind, now)
		pipe := rdb.Pipeline()
		pipe.ZIncrBy(ctx, key, 1, strings.ToUpper(clientID))
		pipe.Expire(ctx, key, usageKeepDays*24*time.Hour)
		_, _ = pipe.Exec(ctx)
	}()
}

// ClientUsage is one client's opens over a window, per kind.
type ClientUsage struct {
	ClientID string           `json:"clientId"`
	Counts   map[string]int64 `json:"counts"`
	Total    int64            `json:"total"`
	LastDay  string           `json:"lastDay"` // YYYY-MM-DD of the most recent open
}

/*
TopClients ranks clients by opens over the last `days` days (today included),
summing the kinds asked for. Most-used first; ties by most recently used.
*/
func (c *Cache) TopClients(ctx context.Context, days int, kinds []string, n int) ([]ClientUsage, error) {
	rdb := c.client()
	if rdb == nil {
		return nil, nil
	}
	if days <= 0 {
		days = 14
	}
	if days > usageKeepDays {
		days = usageKeepDays
	}
	by := map[string]*ClientUsage{}
	today := time.Now().UTC()
	pipe := rdb.Pipeline()
	type q struct {
		kind, day string
		cmd       *redis.ZSliceCmd
	}
	var qs []q
	for i := 0; i < days; i++ {
		day := today.AddDate(0, 0, -i)
		for _, k := range kinds {
			qs = append(qs, q{k, day.Format("2006-01-02"),
				pipe.ZRangeWithScores(ctx, usageKey(k, day), 0, -1)})
		}
	}
	if _, err := pipe.Exec(ctx); err != nil && err != redis.Nil {
		return nil, err
	}
	for _, x := range qs {
		zs, _ := x.cmd.Result()
		for _, z := range zs {
			id, _ := z.Member.(string)
			u := by[id]
			if u == nil {
				u = &ClientUsage{ClientID: id, Counts: map[string]int64{}}
				by[id] = u
			}
			u.Counts[x.kind] += int64(z.Score)
			u.Total += int64(z.Score)
			if x.day > u.LastDay {
				u.LastDay = x.day
			}
		}
	}
	out := make([]ClientUsage, 0, len(by))
	for _, u := range by {
		out = append(out, *u)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Total != out[j].Total {
			return out[i].Total > out[j].Total
		}
		return out[i].LastDay > out[j].LastDay
	})
	if n > 0 && len(out) > n {
		out = out[:n]
	}
	return out, nil
}
