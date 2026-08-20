package reportcache

// The background refresh.
//
// A cache that is only filled when someone asks is a cache that is cold exactly
// when it matters: the first person into a report each morning pays the full
// cost, and they are usually the one who wanted it quickly. The warmer computes
// the common case ahead of them.
//
// It is deliberately unhurried. These are the same heavy aggregates a report
// runs, against a warehouse that also serves the live page, so it works through
// its list a few at a time with a pause between passes rather than firing
// everything at once. A warmer that makes the reports slow to keep them fast has
// defeated itself.

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"
)

/*
BuildFunc computes one report, exactly as the live endpoint would.

Injected rather than imported, because the code that builds a report lives in
the handlers package and the handlers package uses this one — taking it as a
function is what keeps the dependency pointing one way.
*/
/*
`force` says whether this is a REFRESH or a FILL, and the difference matters
because the builder caches what it produces.

  true   the probe answered and the warehouse has moved. Recompute and replace,
         ignoring whatever is stored — otherwise the "rebuild" reads back the
         very entry it was called to replace.
  false  nothing could be checked. Build only if there is nothing cached, and
         leave the retention window to expire it otherwise. This is the case
         where forcing would be a full warehouse sweep every pass on the
         strength of no evidence at all.
*/
type BuildFunc func(ctx context.Context, platform, clientID, from, to string, force bool) (payload []byte, err error)

// TargetsFunc lists what is worth keeping warm: every (platform, client) pair a
// reader could actually open.
type TargetsFunc func() (platforms []string, clients []string)

/*
ProbeFunc answers "has anything changed for this report since last time" as
cheaply as it can — a row count and a high-water mark, not a rebuild.

Returns ok=false where no cheap answer exists, and the pass then rebuilds
unconditionally. That is the safe direction: a missed change shows a stale
report, and being unable to check must never be mistaken for "nothing changed".
*/
type ProbeFunc func(ctx context.Context, platform, clientID, from, to string) (fingerprint string, ok bool)

type Warmer struct {
	mu       sync.Mutex
	running  bool
	stop     chan struct{}
	interval time.Duration
	/* Several windows, not one. A reader who opens the default month and one
	   who opens the year are asking two different questions, and warming only
	   the first leaves the second paying full price. */
	windows []int
	/* The calendar ranges — this month, last month, this year — alongside the
	   rolling ones. The date picker offers both, and a rolling "last 30 days"
	   never lands on the same from/to as "this month", so warming only days-back
	   windows left three of the eight presets cold. */
	calendar bool
	conc     int
	// Skip a rebuild when the probe says nothing moved.
	skipUnchanged bool

	build   BuildFunc
	targets TargetsFunc
	probe   ProbeFunc

	lastRun     time.Time
	lastCount   int
	lastSkipped int
	lastMS      float64
	lastErr     string
	inFlight    bool
}

/*
MaxWarmConcurrency is how many reports the background pass will ever build at
once. The warehouse pool is small and the live page needs it more than this
does.

Exported so the SETTING can be clamped where it is saved, not only where it is
used. Storing 100 and running 4 meant the screen showed a number that was never
in effect — and someone reading "at a time: 100" against a pass covering two
clients reasonably concluded the pass was broken, when the field was.

RAISING THIS ALONE MAKES NOTHING FASTER. Through reports_api every call passes
the pacer in reportsapi/pace.go, so eight workers under a 300-a-minute
background ceiling do exactly what four did — they queue in a different place.
The cap is 16 rather than 4 so that an operator who has raised the ceiling can
actually spend it; the ceiling is the lever, this is the follower.
*/
const MaxWarmConcurrency = 16

// ClampWarmConcurrency brings a requested concurrency into what will actually
// run. Zero and below mean "unset", and are left for the caller to default.
func ClampWarmConcurrency(n int) int {
	if n > MaxWarmConcurrency {
		return MaxWarmConcurrency
	}
	return n
}

var warmer = &Warmer{interval: 30 * time.Minute, windows: []int{1, 7, 15, 30, 90},
	calendar: true, conc: 2, skipUnchanged: true}

func GetWarmer() *Warmer { return warmer }

func (w *Warmer) Configure(interval time.Duration, windowDays []int, calendar bool, concurrency int, skipUnchanged bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if interval > 0 {
		w.interval = interval
	}
	if len(windowDays) > 0 {
		w.windows = windowDays
	}
	w.calendar = calendar
	w.skipUnchanged = skipUnchanged
	if concurrency > 0 {
		w.conc = ClampWarmConcurrency(concurrency)
	}
}

/*
── The windows a pass covers ─────────────────────────────────────────────────

	One per range the date picker can produce, because a cached report is keyed
	by its exact from/to: warming "the last 30 days" does nothing for a reader
	who picks "this month", even on the 30th.

	Two kinds, and they behave differently on purpose:

	  rolling   last N days, ending today. Its from/to move every midnight, so
	            every rolling window is genuinely new data once a day.
	  calendar  this month, last month, this year. Last month's range stops
	            moving once the month ends — its report is final, the freshness
	            probe says so, and it then costs one query a pass forever.

	The freshness mark is keyed by the window's KEY, not its dates, so the mark
	survives the daily roll of a rolling window instead of being orphaned by it.
*/
// Exported along with WarmWindows: the admin screen prices a pass from this
// list, and a returned type nothing outside the package can name is a type the
// caller has to re-derive.
type WarmWindow struct{ Key, From, To string }

const ymd = "2006-01-02"

// WarmWindows is the list a pass will build, resolved against a given day.
// Exported for the admin screen, which has to say what a pass actually covers
// before anyone waits for one.
func WarmWindows(now time.Time, days []int, calendar bool) []WarmWindow {
	out := make([]WarmWindow, 0, len(days)+3)
	today := now.Format(ymd)
	for _, n := range days {
		if n <= 0 {
			continue
		}
		out = append(out, WarmWindow{
			Key:  fmt.Sprint(n),
			From: now.AddDate(0, 0, -n+1).Format(ymd),
			To:   today,
		})
	}
	if !calendar {
		return out
	}
	monthStart := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, now.Location())
	prevStart := monthStart.AddDate(0, -1, 0)
	out = append(out,
		WarmWindow{Key: "mtd", From: monthStart.Format(ymd), To: today},
		// Ends the day before this month began, which is the last day of the
		// previous month whatever its length — no table of month lengths, and
		// February and a leap year come out right on their own.
		WarmWindow{Key: "lm", From: prevStart.Format(ymd), To: monthStart.AddDate(0, 0, -1).Format(ymd)},
		WarmWindow{Key: "ytd", From: time.Date(now.Year(), 1, 1, 0, 0, 0, 0, now.Location()).Format(ymd), To: today},
	)
	return out
}

// WindowCount is how many windows one client costs per platform, for the screen
// that has to price a pass before it runs.
func (w *Warmer) WindowCount() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return len(WarmWindows(time.Now().UTC(), w.windows, w.calendar))
}

func (w *Warmer) SetBuilders(b BuildFunc, t TargetsFunc, p ProbeFunc) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.build, w.targets, w.probe = b, t, p
}

// Start runs the loop until Stop. Safe to call twice; the second is a no-op.
func (w *Warmer) Start() {
	w.mu.Lock()
	if w.running {
		w.mu.Unlock()
		return
	}
	w.running = true
	w.stop = make(chan struct{})
	interval := w.interval
	stop := w.stop
	w.mu.Unlock()

	go func() {
		/* A pause before the first pass. Starting a warehouse sweep in the same
		   second as the process comes up competes with everything else a
		   restart is already doing. */
		select {
		case <-time.After(45 * time.Second):
		case <-stop:
			return
		}
		for {
			w.RunOnce(context.Background())
			select {
			case <-time.After(interval):
			case <-stop:
				return
			}
		}
	}()
	log.Printf("[report-warmer] started — every %s", interval)
}

func (w *Warmer) Stop() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.running {
		return
	}
	close(w.stop)
	w.running = false
	log.Printf("[report-warmer] stopped")
}

func (w *Warmer) Running() bool { w.mu.Lock(); defer w.mu.Unlock(); return w.running }

// Status is what the admin page reports about the last pass.
func (w *Warmer) Status() map[string]any {
	w.mu.Lock()
	defer w.mu.Unlock()
	return map[string]any{
		"running":       w.running,
		"inFlight":      w.inFlight,
		"intervalMin":   int(w.interval / time.Minute),
		"windowDays":    w.windows,
		"calendar":      w.calendar,
		"windowCount":   len(WarmWindows(time.Now().UTC(), w.windows, w.calendar)),
		"concurrency":   w.conc,
		"skipUnchanged": w.skipUnchanged,
		"lastRun":       nullTime(w.lastRun),
		"lastCount":     w.lastCount,
		"lastSkipped":   w.lastSkipped,
		"lastMs":        w.lastMS,
		"lastError":     w.lastErr,
	}
}

func nullTime(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t.UTC().Format(time.RFC3339)
}

/*
RunOnce refreshes every target once.

Exposed so the admin page can force a pass — "warm now" after a data load is
the thing an operator actually wants, rather than waiting out the interval.

Overlapping passes are refused rather than queued: the previous one is still
using the warehouse, and starting a second doubles the load to produce the same
answer.
*/
func (w *Warmer) RunOnce(ctx context.Context) {
	w.mu.Lock()
	if w.inFlight || w.build == nil || w.targets == nil {
		w.mu.Unlock()
		return
	}
	w.inFlight = true
	build, targets, probe := w.build, w.targets, w.probe
	conc, windows, skip := w.conc, append([]int(nil), w.windows...), w.skipUnchanged
	calendar := w.calendar
	w.mu.Unlock()

	started := time.Now()
	platforms, clients := targets()

	today := time.Now().UTC()

	type job struct {
		platform, client, from, to, window string
	}
	jobs := make(chan job)
	var (
		wg      sync.WaitGroup
		countMu sync.Mutex
		built   int
		skipped int
		lastErr string
	)

	for i := 0; i < conc; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range jobs {
				/* The cheap question first. One aggregate against an indexed
				   column decides whether the other eighteen are needed at all —
				   which is what makes a 400-day window sustainable rather than a
				   full year of scanning on every pass. */
				/* Whether to REPLACE what is cached, or only fill a gap in it.
				   With the probe off, every pass is a deliberate unconditional
				   refresh, so force. With it on, only evidence forces. */
				force := !skip || probe == nil
				if skip && probe != nil {
					pctx, pcancel := context.WithTimeout(ctx, 30*time.Second)
					fp, ok := probe(pctx, j.platform, j.client, j.from, j.to)
					pcancel()
					if ok && fp != "" {
						prev, had := Get().Fingerprint(ctx, j.platform, j.client, j.window)
						if had && prev == fp {
							countMu.Lock()
							skipped++
							countMu.Unlock()
							continue
						}
						// It answered, and it does not match what this report was
						// last built from. That is the evidence.
						force = true
						/* The mark is NOT recorded here. Writing it before the
						   build would declare the report fresh even if the build
						   then failed — and the next pass would skip it, leaving
						   a stale report marked current forever. It is written
						   after a successful build, below. */
					}
				}

				jctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
				payload, err := build(jctx, j.platform, j.client, j.from, j.to, force)
				cancel()

				countMu.Lock()
				if err != nil {
					lastErr = err.Error()
				} else if len(payload) > 0 {
					built++
					// Only now, with a report actually stored, is the mark true.
					if skip && probe != nil {
						pctx, pcancel := context.WithTimeout(ctx, 30*time.Second)
						if fp, ok := probe(pctx, j.platform, j.client, j.from, j.to); ok && fp != "" {
							Get().SetFingerprint(ctx, j.platform, j.client, j.window, fp)
						}
						pcancel()
					}
				}
				countMu.Unlock()
			}
		}()
	}

	wins := WarmWindows(today, windows, calendar)
	for _, win := range wins {
		for _, p := range platforms {
			for _, c := range clients {
				jobs <- job{p, c, win.From, win.To, win.Key}
			}
		}
	}
	close(jobs)
	wg.Wait()

	w.mu.Lock()
	w.inFlight = false
	w.lastRun = time.Now().UTC()
	w.lastCount = built
	w.lastSkipped = skipped
	w.lastMS = float64(time.Since(started).Milliseconds())
	w.lastErr = lastErr
	w.mu.Unlock()

	log.Printf("[report-warmer] pass done — %d built, %d unchanged, in %s (%d platform(s) x %d client(s) x %d window(s))",
		built, skipped, time.Since(started).Round(time.Second), len(platforms), len(clients), len(wins))
}
