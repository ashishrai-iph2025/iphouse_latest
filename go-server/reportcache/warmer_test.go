package reportcache

// Does the pass actually cover every window, and does it actually skip work?
//
// SKIPS unless REDIS_TEST_ADDR is set — the fingerprints live in Redis, so
// "skipped" cannot be observed without one.

import (
	"context"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"
)

func TestWarmerCoversEveryWindowAndSkipsUnchanged(t *testing.T) {
	addr := os.Getenv("REDIS_TEST_ADDR")
	if addr == "" {
		t.Skip("REDIS_TEST_ADDR is not set — skipping the live warmer check")
	}
	Get().Configure(Config{Addr: addr, DB: 12, TTL: time.Minute})
	if !Get().Enabled() {
		_, _, _, _, e := Get().Status()
		t.Fatalf("not connected: %s", e)
	}
	ctx := context.Background()
	Get().Purge(ctx)
	t.Cleanup(func() { Get().Purge(ctx); Get().Configure(Config{}) })

	var (
		mu     sync.Mutex
		builds []string
		probes int
	)
	// A fingerprint that never changes — so the second pass has nothing to do.
	forced := 0
	build := func(_ context.Context, platform, client, from, to string, force bool) ([]byte, error) {
		mu.Lock()
		builds = append(builds, fmt.Sprintf("%s|%s|%s..%s", platform, client, from, to))
		if force {
			forced++
		}
		mu.Unlock()
		return []byte(`{"ok":true}`), nil
	}
	targets := func() ([]string, []string) { return []string{"telegram", "youtube"}, []string{"C1"} }
	probe := func(_ context.Context, platform, client, from, to string) (string, bool) {
		mu.Lock()
		probes++
		mu.Unlock()
		return "rows=100|updated=2026-08-16T00:00:00Z", true
	}

	w := &Warmer{interval: time.Hour, windows: []int{30, 400}, conc: 2, skipUnchanged: true}
	w.SetBuilders(build, targets, probe)

	// Pass one: nothing is known, so everything is built.
	w.RunOnce(ctx)
	mu.Lock()
	first := append([]string(nil), builds...)
	mu.Unlock()

	if len(first) != 4 {
		t.Fatalf("expected 2 platforms × 1 client × 2 windows = 4 builds, got %d: %v", len(first), first)
	}
	// Both windows must actually appear — a 400-day window that silently
	// resolves to the 30-day range would cache the wrong answer under the right
	// key, which no later check would catch.
	var saw30, saw400 bool
	today := time.Now().UTC()
	want30 := today.AddDate(0, 0, -29).Format("2006-01-02")
	want400 := today.AddDate(0, 0, -399).Format("2006-01-02")
	for _, b := range first {
		if contains(b, want30) {
			saw30 = true
		}
		if contains(b, want400) {
			saw400 = true
		}
	}
	if !saw30 || !saw400 {
		t.Errorf("both windows should have been built: saw30=%v saw400=%v in %v", saw30, saw400, first)
	}

	// Pass two: the probe returns the same mark, so nothing should be rebuilt.
	mu.Lock()
	builds = nil
	mu.Unlock()
	w.RunOnce(ctx)

	mu.Lock()
	second := len(builds)
	mu.Unlock()
	if second != 0 {
		t.Errorf("second pass rebuilt %d report(s) despite an unchanged fingerprint", second)
	}
	st := w.Status()
	if st["lastSkipped"].(int) != 4 {
		t.Errorf("expected 4 skipped, got %v", st["lastSkipped"])
	}

	/* And when the data DOES move, it must rebuild. This is the direction that
	   matters: a cache that never notices a change is worse than no cache. */
	changed := func(_ context.Context, _, _, _, _ string) (string, bool) {
		return "rows=101|updated=2026-08-17T00:00:00Z", true
	}
	w.SetBuilders(build, targets, changed)
	mu.Lock()
	builds = nil
	forced = 0
	mu.Unlock()
	w.RunOnce(ctx)
	mu.Lock()
	third := len(builds)
	mu.Unlock()
	if third != 4 {
		t.Errorf("a changed fingerprint should rebuild all 4, got %d", third)
	}
	/* And it must ask for a REPLACEMENT, not a fill. The builder caches what it
	   produces, so a rebuild that did not say "ignore what is stored" would read
	   the stale entry straight back and report it as refreshed — which is how a
	   pass can run every half hour for a day and change nothing. */
	mu.Lock()
	gotForced := forced
	mu.Unlock()
	if gotForced != 4 {
		t.Errorf("all 4 rebuilds after a changed fingerprint should have been forced, got %d", gotForced)
	}
}

// A probe that cannot answer must NOT force. "I could not check" is not evidence
// of a change, and forcing on it turns every pass into a full warehouse sweep.
func TestWarmerDoesNotForceWhenTheProbeCannotAnswer(t *testing.T) {
	var (
		mu     sync.Mutex
		forced int
		builds int
	)
	build := func(_ context.Context, _, _, _, _ string, force bool) ([]byte, error) {
		mu.Lock()
		builds++
		if force {
			forced++
		}
		mu.Unlock()
		return []byte(`{"ok":true}`), nil
	}
	targets := func() ([]string, []string) { return []string{"telegram"}, []string{"C1"} }
	silent := func(_ context.Context, _, _, _, _ string) (string, bool) { return "", false }

	w := &Warmer{interval: time.Hour, windows: []int{30}, conc: 1, skipUnchanged: true}
	w.SetBuilders(build, targets, silent)
	w.RunOnce(context.Background())

	mu.Lock()
	defer mu.Unlock()
	if builds != 1 {
		t.Fatalf("expected 1 build, got %d", builds)
	}
	if forced != 0 {
		t.Errorf("an unanswerable probe forced %d rebuild(s); it must leave the entry alone", forced)
	}
}

func contains(hay, needle string) bool {
	for i := 0; i+len(needle) <= len(hay); i++ {
		if hay[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}
