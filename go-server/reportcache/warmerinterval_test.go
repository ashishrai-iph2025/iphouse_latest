package reportcache

/*
The wait between passes must honour the CURRENT interval, not the one that was in
force when the loop started.

This shipped broken. Start() read w.interval into a local and the loop slept on
that local forever; Configure wrote the field, and Start() is a no-op while the
warmer is already running, so nothing re-entered the loop. Saving a new interval
therefore changed what the settings screen reported — Status() reads the field —
and not the schedule the pass actually kept. An operator moving the pass from
thirty minutes to five saw "every 5 minutes", got a pass every thirty, and had no
way to tell which number was real.
*/

import (
	"testing"
	"time"
)

// withNapCap shrinks the re-read granularity for the duration of a test.
func withNapCap(t *testing.T, d time.Duration) {
	t.Helper()
	prev := warmNapCap
	warmNapCap = d
	t.Cleanup(func() { warmNapCap = prev })
}

func TestWaitForNextPassPicksUpAShortenedInterval(t *testing.T) {
	withNapCap(t, 2*time.Millisecond)

	w := &Warmer{interval: time.Hour}
	stop := make(chan struct{})
	defer close(stop)

	done := make(chan bool, 1)
	go func() { done <- w.waitForNextPass(stop) }()

	// Long enough that the waiter is definitely inside its nap loop, short
	// enough that the hour has not elapsed by any measure.
	time.Sleep(10 * time.Millisecond)
	w.Configure(20*time.Millisecond, nil, false, 0, true)

	select {
	case ok := <-done:
		if !ok {
			t.Fatal("the wait reported a stop when it was only reconfigured")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the wait did not notice the shortened interval — it is still " +
			"sleeping on the value it started with, which is the bug this guards")
	}
}

// The other direction: the interval is respected, not merely re-read. A waiter
// whose interval has not elapsed must still be waiting.
func TestWaitForNextPassWaitsOutTheInterval(t *testing.T) {
	withNapCap(t, 2*time.Millisecond)

	w := &Warmer{interval: 5 * time.Second}
	stop := make(chan struct{})
	defer close(stop)

	done := make(chan bool, 1)
	go func() { done <- w.waitForNextPass(stop) }()

	select {
	case <-done:
		t.Fatal("the wait returned immediately — a 5s interval was not honoured, " +
			"so every pass would run back-to-back")
	case <-time.After(80 * time.Millisecond):
		// Still waiting, which is correct.
	}
}

func TestWaitForNextPassStops(t *testing.T) {
	withNapCap(t, 2*time.Millisecond)

	w := &Warmer{interval: time.Hour}
	stop := make(chan struct{})

	done := make(chan bool, 1)
	go func() { done <- w.waitForNextPass(stop) }()

	time.Sleep(5 * time.Millisecond)
	close(stop)

	select {
	case ok := <-done:
		if ok {
			t.Fatal("stopping the warmer reported that the next pass is due")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the wait ignored Stop — the goroutine would outlive the warmer")
	}
}

/*
Configure must not silently drop an interval, because the screen reports the
field it writes: a value stored and not applied is the failure above, and a value
applied and not stored is the same failure seen from the other end.
*/
func TestConfigureKeepsTheInterval(t *testing.T) {
	w := &Warmer{interval: time.Hour}

	w.Configure(7*time.Minute, []int{1, 30}, true, 3, true)
	if got := w.Status()["intervalMin"]; got != 7 {
		t.Fatalf("intervalMin = %v, want 7", got)
	}

	// Zero means "unset" and must leave the previous value alone rather than
	// setting a pass that runs continuously.
	w.Configure(0, nil, true, 0, true)
	if got := w.Status()["intervalMin"]; got != 7 {
		t.Fatalf("a zero interval overwrote the stored one: intervalMin = %v, want 7", got)
	}
}
