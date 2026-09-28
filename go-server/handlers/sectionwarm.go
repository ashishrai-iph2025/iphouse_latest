package handlers

/*
CACHE ON DEMAND, PER REPORT SECTION — Sports and VOD on the Cache & Redis tab.

A section is the set of platforms its report page draws: Sports is every
platform the catalogue claims as Sports (sportsOnlyPlatformKeys), VOD is every
other one (vodOnlyPlatformKeys) — the same split the two pages enforce.

A request names clients and a period of at most a year, either month by month
or from a start date. It is built through warmOne — the report page's own key,
clamp and builder — with the freshness probe ON: a report already cached and
unchanged is confirmed, not rebuilt. Month windows are shaped the way the page
asks for them: a past month is its first to last day; the current month is its
first day to today, which is what the "This month" preset sends.

One run per section at a time, at the warmer's concurrency cap. The status is
kept per section so the tab can show each one's progress.
*/

import (
	"context"
	"fmt"
	"log"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/ip-house/iphouse-api/reportcache"
)

// SectionPlatforms is the platform keys (and labels) a section covers.
func SectionPlatforms(section string) ([]string, map[string]string) {
	var set map[string]bool
	switch section {
	case "sports":
		set = sportsOnlyPlatformKeys()
	case "vod":
		set = vodOnlyPlatformKeys()
	default:
		return nil, nil
	}
	labels := map[string]string{}
	var keys []string
	for _, p := range loadPlatforms() {
		if p.Enabled && p.Key != summaryKey && set[p.Key] {
			keys = append(keys, p.Key)
			labels[p.Key] = p.Label
		}
	}
	return keys, labels
}

// SectionWindow is one date window a section run builds.
type SectionWindow struct{ From, To, Label string }

/*
SectionWindows turns the tab's period into windows. months: YYYY-MM (at most 12,
spanning at most a year). Or from/to: one window, at most 366 days, `to`
defaulting to today. Anything past today is cut to today — there is no data
ahead of now.
*/
func SectionWindows(months []string, from, to string) ([]SectionWindow, error) {
	today := time.Now().UTC().Truncate(24 * time.Hour)
	if len(months) > 0 {
		seen := map[string]bool{}
		var ms []string
		for _, m := range months {
			t, err := time.Parse("2006-01", strings.TrimSpace(m))
			if err != nil {
				return nil, fmt.Errorf("%q is not a month (YYYY-MM)", m)
			}
			if k := t.Format("2006-01"); !seen[k] {
				seen[k] = true
				ms = append(ms, k)
			}
		}
		sort.Strings(ms)
		first, _ := time.Parse("2006-01", ms[0])
		last, _ := time.Parse("2006-01", ms[len(ms)-1])
		if len(ms) > 12 || first.AddDate(0, 11, 0).Before(last) {
			return nil, fmt.Errorf("at most 1 year at a time — %s to %s is longer", ms[0], ms[len(ms)-1])
		}
		var out []SectionWindow
		for _, m := range ms {
			start, _ := time.Parse("2006-01", m)
			if start.After(today) {
				continue
			}
			end := start.AddDate(0, 1, -1)
			if end.After(today) {
				end = today
			}
			out = append(out, SectionWindow{start.Format("2006-01-02"), end.Format("2006-01-02"), start.Format("Jan 2006")})
		}
		if len(out) == 0 {
			return nil, fmt.Errorf("every month chosen is in the future")
		}
		return out, nil
	}
	f, err := time.Parse("2006-01-02", strings.TrimSpace(from))
	if err != nil {
		return nil, fmt.Errorf("choose months, or a start date (YYYY-MM-DD)")
	}
	t := today
	if strings.TrimSpace(to) != "" {
		if t, err = time.Parse("2006-01-02", strings.TrimSpace(to)); err != nil {
			return nil, fmt.Errorf("the end date must be YYYY-MM-DD")
		}
	}
	if t.After(today) {
		t = today
	}
	if t.Before(f) {
		return nil, fmt.Errorf("the start date is after the end date")
	}
	if days := int(t.Sub(f).Hours()/24) + 1; days > 366 {
		return nil, fmt.Errorf("at most 1 year at a time — %s to %s is %d days", f.Format("2006-01-02"), t.Format("2006-01-02"), days)
	}
	return []SectionWindow{{f.Format("2006-01-02"), t.Format("2006-01-02"),
		f.Format("2 Jan 2006") + " → " + t.Format("2 Jan 2006")}}, nil
}

// SectionClientResult is one client's outcome in a run.
type SectionClientResult struct {
	ClientID string `json:"clientId"`
	Done     int    `json:"done"`
	Ready    int    `json:"ready"`
	Error    string `json:"error,omitempty"`
}

type sectionRun struct {
	Section    string                          `json:"section"`
	Period     string                          `json:"period"`
	Windows    []SectionWindow                 `json:"windows"`
	Platforms  int                             `json:"platforms"`
	Total      int                             `json:"total"`
	Done       int                             `json:"done"`
	Ready      int                             `json:"ready"`
	StartedAt  time.Time                       `json:"startedAt"`
	FinishedAt time.Time                       `json:"finishedAt"`
	Running    bool                            `json:"running"`
	Clients    map[string]*SectionClientResult `json:"clients"`
	By         string                          `json:"by"`
}

var sectionRuns = struct {
	sync.Mutex
	m map[string]*sectionRun
}{m: map[string]*sectionRun{}}

// SectionRunStatus is a copy of the section's last run, safe to encode.
func SectionRunStatus(section string) map[string]any {
	sectionRuns.Lock()
	defer sectionRuns.Unlock()
	r := sectionRuns.m[section]
	if r == nil {
		return nil
	}
	clients := make([]SectionClientResult, 0, len(r.Clients))
	for _, c := range r.Clients {
		clients = append(clients, *c)
	}
	sort.Slice(clients, func(i, j int) bool { return clients[i].ClientID < clients[j].ClientID })
	var eta any
	if r.Running && r.Done > 0 {
		per := time.Since(r.StartedAt) / time.Duration(r.Done)
		eta = int((per * time.Duration(r.Total-r.Done)).Seconds())
	}
	return map[string]any{"section": r.Section, "period": r.Period, "windows": r.Windows, "platforms": r.Platforms,
		"total": r.Total, "done": r.Done, "ready": r.Ready, "startedAt": r.StartedAt, "finishedAt": r.FinishedAt,
		"running": r.Running, "clients": clients, "by": r.By, "etaSeconds": eta,
		"elapsedSeconds": int(time.Since(r.StartedAt).Seconds())}
}

/*
StartSectionWarm starts a run for a section. Refused while one is running for
the same section: the second would build the same reports under the same keys.
*/
func StartSectionWarm(section string, clientIDs []string, windows []SectionWindow, period, by string) (int, error) {
	platforms, _ := SectionPlatforms(section)
	if len(platforms) == 0 {
		return 0, fmt.Errorf("no %s platform is enabled", section)
	}
	sectionRuns.Lock()
	if r := sectionRuns.m[section]; r != nil && r.Running {
		sectionRuns.Unlock()
		return 0, fmt.Errorf("a %s run is already in progress — wait for it or watch it below", section)
	}
	run := &sectionRun{Section: section, Period: period, Windows: windows, Platforms: len(platforms),
		Total: len(platforms) * len(windows) * len(clientIDs), StartedAt: time.Now().UTC(), Running: true,
		Clients: map[string]*SectionClientResult{}, By: by}
	for _, c := range clientIDs {
		run.Clients[c] = &SectionClientResult{ClientID: c}
	}
	sectionRuns.m[section] = run
	sectionRuns.Unlock()

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 12*time.Hour)
		defer cancel()
		type job struct {
			platform, client string
			w                SectionWindow
		}
		jobs := make(chan job)
		var wg sync.WaitGroup
		for i := 0; i < reportcache.MaxWarmConcurrency; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for j := range jobs {
					jctx, jcancel := context.WithTimeout(ctx, 5*time.Minute)
					payload, err := warmOne(jctx, j.platform, j.client, j.w.From, j.w.To, false)
					jcancel()
					sectionRuns.Lock()
					run.Done++
					c := run.Clients[j.client]
					c.Done++
					if err != nil {
						c.Error = err.Error()
						log.Printf("[section-cache] %s %s/%s %s→%s: %v", section, j.platform, j.client, j.w.From, j.w.To, err)
					} else if len(payload) > 0 {
						run.Ready++
						c.Ready++
					}
					sectionRuns.Unlock()
				}
			}()
		}
		// Newest window first: the month someone is most likely to open next.
		for wi := len(windows) - 1; wi >= 0; wi-- {
			for _, c := range clientIDs {
				for _, p := range platforms {
					select {
					case jobs <- job{p, c, windows[wi]}:
					case <-ctx.Done():
					}
				}
			}
		}
		close(jobs)
		wg.Wait()
		sectionRuns.Lock()
		run.Running, run.FinishedAt = false, time.Now().UTC()
		sectionRuns.Unlock()
		log.Printf("[section-cache] %s run %s for %d client(s): %d of %d report(s) ready",
			section, period, len(clientIDs), run.Ready, run.Total)
	}()
	return run.Total, nil
}
