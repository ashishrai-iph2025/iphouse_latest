package reportsapi

import (
	"context"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

/*
Staying inside the service's request budget — and leaving room for a person.

reports_api refuses a caller that exceeds RATE_LIMIT_PER_MINUTE (600 by default)
with a 429, counted PER SOURCE ADDRESS. The portal is one address, so every
request it makes — a page someone is looking at, and every report the cache
warmer rebuilds in the background — spends from one budget.

The warmer can exhaust it on its own. It runs four reports at a time and a
report is roughly fifty calls (a summary and a trend per table, plus one per
panel, plus one per slicer), so a pass over ten platforms and two clients is
about a thousand calls in well under a minute. Measured on a cold cache: 1,000
requests in 38 seconds, 199 of them refused — and the refusals landed on the
report page someone had open, which showed "Some panels could not be loaded".

That is the wrong way round. The warmer has no deadline; the person does. So:

  · Every outbound call takes a token, and a call that cannot get one WAITS
    rather than being sent and refused. The portal can no longer 429 itself.

  · Background calls stop sooner. They are held to `backgroundShare` of the
    budget, which keeps the rest free for whatever a person is doing. A warmer
    running flat out therefore slows down instead of crowding anyone out.

The ceiling is set a little under the service's own so that a burst arriving
just before a window boundary cannot cross it.
*/

/*
── The ceilings, and why they are settings ───────────────────────────────────

	These two numbers decide how long a warm pass takes, and nothing else does.
	A report is roughly fifty calls, so a pass over 160 clients and 10 platforms
	is some 80,000 calls — at 300 a minute that is four and a half hours, and no
	amount of extra goroutines changes it by a second, because every one of them
	is sitting in take() waiting for the same window to turn over.

	They were constants. That made the one lever that actually moves the number
	unreachable without a rebuild, which is why they are now read from the
	reports API settings — see admin.ApplyReportsAPIBudget.

	defaultPerMinute is the portal's self-imposed ceiling, a fifth under the
	service's own default of 600. The margin absorbs the clock skew between the
	two windows, which are not aligned and cannot be.

	defaultBackground is how much of that a background job may take. A warm pass
	is then paced at roughly five calls a second, and 180 calls a minute stay
	free for the pages people are actually reading.
*/
const (
	defaultPerMinute  = 480
	defaultBackground = 300
)

var (
	limitMu     sync.RWMutex
	perMinuteN  = defaultPerMinute
	backgroundN = defaultBackground
	// Counters, so the admin screen can say "the pass is waiting on the rate
	// limit" rather than leaving someone to conclude it has hung.
	callsSent   atomic.Int64
	callsBg     atomic.Int64
	callsWaited atomic.Int64
	waitedNanos atomic.Int64
)

/*
SetBudget applies the ceilings.

`perMinute` is what the PORTAL will send; keep it under whatever the service
enforces, because a call the portal sends and the service refuses is worse than
one the portal delayed — the refusal lands on whichever request happened to be
in flight, which is usually a page someone has open.

`background` is clamped into the portal's own ceiling: a background share above
the total would let a warm pass take the whole budget and starve the live pages,
which is the arrangement this file exists to prevent.
*/
func SetBudget(perMinute, background int) {
	limitMu.Lock()
	defer limitMu.Unlock()
	if perMinute > 0 {
		perMinuteN = perMinute
	}
	if background > 0 {
		backgroundN = background
	}
	if backgroundN > perMinuteN {
		backgroundN = perMinuteN
	}
}

func limits() (int, int) {
	limitMu.RLock()
	defer limitMu.RUnlock()
	return perMinuteN, backgroundN
}

/*
BudgetStats is what the pacing is costing, for a screen that has to explain why
a pass is slow.

`waitedSeconds` is the total time calls have spent held back — the single number
that says whether the rate limit is the constraint. Small, and something else is
slow; hours, and this is the whole answer.
*/
func BudgetStats() map[string]any {
	per, bg := limits()
	budget.mu.Lock()
	used, window := budget.used, budget.window
	budget.mu.Unlock()

	return map[string]any{
		"perMinute": per, "background": bg,
		"usedThisMinute":  used,
		"windowStart":     window.UTC().Format(time.RFC3339),
		"calls":           callsSent.Load(),
		"backgroundCalls": callsBg.Load(),
		"throttled":       callsWaited.Load(),
		"waitedSeconds":   float64(waitedNanos.Load()) / float64(time.Second),
	}
}

type ctxKey int

const bgKey ctxKey = 0

/*
Background marks a context as belonging to a job nobody is waiting on.

Passed by the cache warmer. Anything without it is treated as a page someone has
open, which is the safe default: a background job wrongly treated as foreground
merely gets a larger share, while the reverse would make somebody wait behind a
warm pass.
*/
func Background(ctx context.Context) context.Context {
	return context.WithValue(ctx, bgKey, true)
}

func isBackground(ctx context.Context) bool {
	v, _ := ctx.Value(bgKey).(bool)
	return v
}

type pacer struct {
	mu     sync.Mutex
	window time.Time
	used   int
}

// budget is process-wide: the service counts per ADDRESS, and the portal is
// one address however many goroutines it runs.
var budget = &pacer{window: time.Now().Truncate(time.Minute)}

/*
take blocks until this call fits in the budget, or the context ends.

Sleeps to the top of the next minute rather than spinning: the service's own
counter resets on a whole minute, so there is nothing to be gained by asking
again before then, and a busy loop across four warm workers is its own problem.
*/
func (p *pacer) take(ctx context.Context) error {
	bg := isBackground(ctx)
	started := time.Now()
	held := false
	for {
		wait, ok := p.reserve(bg)
		if ok {
			callsSent.Add(1)
			if bg {
				callsBg.Add(1)
			}
			if held {
				callsWaited.Add(1)
				waitedNanos.Add(int64(time.Since(started)))
			}
			return nil
		}
		held = true
		t := time.NewTimer(wait)
		select {
		case <-t.C:
		case <-ctx.Done():
			t.Stop()
			if held {
				waitedNanos.Add(int64(time.Since(started)))
			}
			return ctx.Err()
		}
	}
}

// reserve counts one call if there is room, and otherwise says how long until
// the window turns over.
func (p *pacer) reserve(background bool) (wait time.Duration, ok bool) {
	p.mu.Lock()
	defer p.mu.Unlock()

	now := time.Now()
	if w := now.Truncate(time.Minute); w.After(p.window) {
		p.window = w
		p.used = 0
	}

	per, bg := limits()
	ceiling := per
	if background {
		ceiling = bg
	}
	if p.used < ceiling {
		p.used++
		return 0, true
	}
	// +50ms so the sleep lands after the boundary rather than exactly on it.
	return p.window.Add(time.Minute + 50*time.Millisecond).Sub(now), false
}

/*
retryAfter reads the pause a 429 asked for.

Only used if one is somehow still returned — the pacing above is meant to make
that impossible, and a 429 arriving anyway means something else shares this
address, so the value the service sends is better than any guess made here.
*/
func retryAfter(v string) (time.Duration, bool) {
	v = strings.TrimSpace(v)
	if v == "" {
		return 0, false
	}
	secs := 0
	for _, r := range v {
		if r < '0' || r > '9' {
			return 0, false
		}
		secs = secs*10 + int(r-'0')
		if secs > 120 {
			return 0, false
		}
	}
	if secs <= 0 {
		return 0, false
	}
	return time.Duration(secs) * time.Second, true
}
