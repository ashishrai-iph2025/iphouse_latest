package handlers

/*
Reports for the "top clients" auto-cache (handlers/admin/autotop.go).

The same builder as the on-demand "cache these clients now" (WarmClients) —
warmOne, so the keys are the ones a reader asks for — with two differences:

  - the freshness probe is ON (force=false). This runs on a schedule, and a
    report whose warehouse data has not moved since it was cached is left as
    it is rather than rebuilt: the job is to keep things ready, not to redo
    work every hour.
  - it does not touch the on-demand status the Cache & Redis tab shows under
    "Last on-demand caching" — that panel answers what an operator asked for,
    and an automatic pass overwriting it would hide exactly that.

Concurrency is the warmer's own cap, as everywhere: the live pages need the
warehouse more than this does.
*/

import (
	"context"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/ip-house/iphouse-api/reportcache"
)

// ReportsOutcome is what one client's reports came to.
type ReportsOutcome struct {
	Ready     int    `json:"ready"`     // cached (freshly built or confirmed unchanged)
	Attempted int    `json:"attempted"` // platform reports tried
	Error     string `json:"error,omitempty"`
}

// WarmReportsFor keeps every enabled platform report ready for each client,
// over the last `days` days.
func WarmReportsFor(ctx context.Context, clientIDs []string, days int) map[string]*ReportsOutcome {
	if days <= 0 {
		days = 30
	}
	today := time.Now().UTC()
	return WarmReportsWindows(ctx, clientIDs, []SectionWindow{{
		From: today.AddDate(0, 0, -days+1).Format("2006-01-02"), To: today.Format("2006-01-02")}})
}

// WarmReportsWindows keeps every enabled platform report ready for each client,
// for each date window (month windows, or one range).
func WarmReportsWindows(ctx context.Context, clientIDs []string, windows []SectionWindow) map[string]*ReportsOutcome {

	var platforms []string
	for _, p := range loadPlatforms() {
		if p.Enabled && p.Key != summaryKey {
			platforms = append(platforms, p.Key)
		}
	}
	out := map[string]*ReportsOutcome{}
	type job struct {
		platform, client string
		w                SectionWindow
	}
	jobs := make(chan job)
	var mu sync.Mutex
	var wg sync.WaitGroup
	for i := 0; i < reportcache.MaxWarmConcurrency; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range jobs {
				jctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
				payload, err := warmOne(jctx, j.platform, j.client, j.w.From, j.w.To, false)
				cancel()
				mu.Lock()
				o := out[j.client]
				o.Attempted++
				if err != nil {
					o.Error = err.Error()
					log.Printf("[auto-top] reports %s/%s: %v", j.platform, j.client, err)
				} else if len(payload) > 0 {
					o.Ready++
				}
				mu.Unlock()
			}
		}()
	}
	for _, c := range clientIDs {
		if c = strings.TrimSpace(c); c == "" {
			continue
		}
		out[c] = &ReportsOutcome{}
	}
	// Newest window first: the one someone is most likely to open next.
	for wi := len(windows) - 1; wi >= 0; wi-- {
		for _, c := range clientIDs {
			if out[strings.TrimSpace(c)] == nil {
				continue
			}
			for _, p := range platforms {
				select {
				case jobs <- job{p, strings.TrimSpace(c), windows[wi]}:
				case <-ctx.Done():
					close(jobs)
					wg.Wait()
					return out
				}
			}
		}
	}
	close(jobs)
	wg.Wait()
	return out
}
