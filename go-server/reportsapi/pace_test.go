package reportsapi

import (
	"context"
	"testing"
	"time"
)

/*
The budget must run out — that is the entire feature.

Without a ceiling the cache warmer sent about a thousand calls in 38 seconds and
the service refused 199 of them, which surfaced on a report page somebody had
open as "Some panels could not be loaded".
*/
func TestForegroundStopsAtTheCeiling(t *testing.T) {
	perMinute, _ := limits()
	p := &pacer{window: time.Now().Truncate(time.Minute)}
	for i := 0; i < perMinute; i++ {
		if _, ok := p.reserve(false); !ok {
			t.Fatalf("refused a foreground call at %d, ceiling is %d", i, perMinute)
		}
	}
	wait, ok := p.reserve(false)
	if ok {
		t.Fatal("the budget never runs out — the portal can still 429 itself")
	}
	if wait <= 0 || wait > time.Minute+time.Second {
		t.Errorf("wait of %v does not land in the next window", wait)
	}
}

/*
A background job must stop sooner than a person does, and the gap between the
two ceilings is what a reader gets to use while a warm pass is running.
*/
func TestBackgroundYieldsHeadroomToForeground(t *testing.T) {
	perMinute, backgroundShare := limits()
	if backgroundShare >= perMinute {
		t.Fatalf("background share %d leaves nothing for a live page (ceiling %d)",
			backgroundShare, perMinute)
	}

	p := &pacer{window: time.Now().Truncate(time.Minute)}
	// A warm pass running flat out.
	for i := 0; i < backgroundShare; i++ {
		if _, ok := p.reserve(true); !ok {
			t.Fatalf("refused a background call at %d, share is %d", i, backgroundShare)
		}
	}
	if _, ok := p.reserve(true); ok {
		t.Fatal("background traffic is not capped — it can starve a live page")
	}

	// The page someone has open still goes through.
	for i := 0; i < perMinute-backgroundShare; i++ {
		if _, ok := p.reserve(false); !ok {
			t.Fatalf("a live page was blocked by the warmer after %d calls", i)
		}
	}
}

/*
Raising the ceilings must actually raise them — this is the one lever that
changes how long a pass takes, and a setting that saves but does not apply is
worse than no setting, because the number on the screen then lies about what is
running.
*/
func TestSetBudgetTakesEffect(t *testing.T) {
	origPer, origBg := limits()
	t.Cleanup(func() { SetBudget(origPer, origBg) })

	SetBudget(1200, 900)
	if per, bg := limits(); per != 1200 || bg != 900 {
		t.Fatalf("SetBudget(1200, 900) gave (%d, %d)", per, bg)
	}
	p := &pacer{window: time.Now().Truncate(time.Minute)}
	for i := 0; i < 900; i++ {
		if _, ok := p.reserve(true); !ok {
			t.Fatalf("background call %d refused under a 900 share", i)
		}
	}

	/* A background share above the total would let a warm pass take every token
	   and leave a live page waiting on the minute boundary — the exact failure
	   this file was written to stop. It is clamped, not accepted. */
	SetBudget(500, 9000)
	if per, bg := limits(); bg > per {
		t.Errorf("background share %d exceeds the ceiling %d", bg, per)
	}
}

// The portal's ceiling has to sit under the service's own, or the two windows
// drifting against each other puts a burst over the line.
func TestCeilingIsUnderTheServiceLimit(t *testing.T) {
	const serviceDefault = 600 // reports_api RATE_LIMIT_PER_MINUTE
	// The DEFAULT, not the live value: an operator who has raised the service's
	// own limit is expected to raise this to match, and the test must not tell
	// them they are wrong for doing the thing the setting is for.
	if defaultPerMinute >= serviceDefault {
		t.Errorf("portal ceiling %d does not sit under the service's %d",
			defaultPerMinute, serviceDefault)
	}
}

// A new minute frees the budget; otherwise the first burst of the process would
// throttle it forever.
func TestWindowResets(t *testing.T) {
	perMinute, _ := limits()
	p := &pacer{window: time.Now().Truncate(time.Minute).Add(-time.Minute), used: perMinute}
	if _, ok := p.reserve(false); !ok {
		t.Error("the budget did not reset when the window turned over")
	}
}

// A caller that gave up must not sit in the queue holding a worker.
func TestTakeGivesUpWithTheContext(t *testing.T) {
	perMinute, _ := limits()
	p := &pacer{window: time.Now().Truncate(time.Minute), used: perMinute}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := p.take(ctx); err == nil {
		t.Error("take ignored a cancelled context and would block until the window turns")
	}
}

// Background marking has to survive being put on a context, or every warm call
// is treated as somebody's page and the split does nothing.
func TestBackgroundMarksTheContext(t *testing.T) {
	if isBackground(context.Background()) {
		t.Error("a plain context reads as background — a live page would be throttled")
	}
	if !isBackground(Background(context.Background())) {
		t.Error("Background() does not mark the context")
	}
}

func TestRetryAfterParsing(t *testing.T) {
	for _, c := range []struct {
		in   string
		want time.Duration
		ok   bool
	}{
		{"30", 30 * time.Second, true},
		{" 5 ", 5 * time.Second, true},
		{"", 0, false},
		{"0", 0, false},
		{"999", 0, false},                           // implausible, so not honoured
		{"Wed, 21 Oct 2026 07:28:00 GMT", 0, false}, // the HTTP-date form
	} {
		got, ok := retryAfter(c.in)
		if ok != c.ok || got != c.want {
			t.Errorf("retryAfter(%q) = %v,%v want %v,%v", c.in, got, ok, c.want, c.ok)
		}
	}
}
