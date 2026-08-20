package reportcache

// Live check against a real Redis.
//
// SKIPS unless REDIS_TEST_ADDR is set, so `go test ./...` is unaffected on a
// machine without one. Deliberately not mocked: what can break here is the
// round trip — what Redis stores, what comes back, and whether the index and
// the payload agree — and a fake Redis is a copy of my belief about that.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"time"
)

func liveCache(t *testing.T) *Cache {
	t.Helper()
	addr := os.Getenv("REDIS_TEST_ADDR")
	if addr == "" {
		t.Skip("REDIS_TEST_ADDR is not set — skipping the live cache check")
	}
	c := &Cache{}
	c.Configure(Config{Addr: addr, DB: 15, TTL: time.Minute})
	if !c.Enabled() {
		_, _, _, _, e := c.Status()
		t.Fatalf("could not connect to %s: %s", addr, e)
	}
	ctx := context.Background()
	c.Purge(ctx)
	return c
}

func TestCacheRoundTrip(t *testing.T) {
	c := liveCache(t)
	ctx := context.Background()

	key, ok := Key("telegram", "CLIENT-1", "shape1", map[string]string{"from": "2026-08-01", "to": "2026-08-16"})
	if !ok {
		t.Fatal("an unfiltered scope should be cacheable")
	}

	if _, _, hit := c.Read(ctx, key); hit {
		t.Fatal("read a value from an empty cache")
	}

	payload := []byte(`{"ok":true,"kpi":{"identified":1234}}`)
	c.Write(ctx, key, "telegram", "CLIENT-1", "2026-08-01", "2026-08-16", payload, 42)

	got, at, hit := c.Read(ctx, key)
	if !hit {
		t.Fatal("miss after write")
	}
	if string(got) != string(payload) {
		t.Fatalf("payload changed in transit:\n want %s\n got  %s", payload, got)
	}
	if time.Since(at) > time.Minute {
		t.Errorf("stored timestamp looks wrong: %v", at)
	}

	// The listing is what the admin page reads; it must describe the entry
	// without needing the payload decoded.
	entries, err := c.List(ctx, 100)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(entries))
	}
	if entries[0].Platform != "telegram" || entries[0].ClientID != "CLIENT-1" {
		t.Errorf("entry describes the wrong report: %+v", entries[0])
	}

	st := c.Stats()
	if st["hits"] != 1 || st["misses"] != 1 || st["writes"] != 1 {
		t.Errorf("counters wrong: %v", st)
	}

	n, err := c.Purge(ctx)
	if err != nil || n != 1 {
		t.Fatalf("Purge: n=%d err=%v", n, err)
	}
	if _, _, hit := c.Read(ctx, key); hit {
		t.Error("still hitting after purge")
	}
}

/*
Drill-downs are cached, and kept in their own space.

They used not to be, on the reasoning that the keyspace is unbounded — which is
true, and is what eviction is for. What it cost was a full recompute on every
click: eighteen to a hundred and eight seconds, measured, paid again the moment
a reader clicked back.

What this pins is the SEPARATION. A filtered view must never share a key with
the unfiltered one, or a click would be answered with the whole-client numbers.
*/
func TestDrillDownsAreCachedApartFromPlainScopes(t *testing.T) {
	plain := map[string]string{"from": "2026-08-01", "to": "2026-08-16"}
	base, drill, ok := KeyKind("telegram", "C1", "shape1", plain)
	if !ok || drill {
		t.Fatalf("a plain scope came back ok=%v drill=%v", ok, drill)
	}

	seen := map[string]string{base: "unfiltered"}
	for _, q := range []map[string]string{
		{"from": "2026-08-01", "to": "2026-08-16", "assetId": "A-1"},
		{"from": "2026-08-01", "to": "2026-08-16", "assetId": "A-2"},
		{"from": "2026-08-01", "to": "2026-08-16", "language": "English"},
		{"from": "2026-08-01", "to": "2026-08-16", "assetId": "A-1", "language": "English"},
		{"tatBucket": "Pending"},
	} {
		k, drill, ok := KeyKind("telegram", "C1", "shape1", q)
		if !ok {
			t.Errorf("%v was not cacheable", q)
			continue
		}
		if !drill {
			t.Errorf("%v was not recognised as a drill-down", q)
		}
		if prev, clash := seen[k]; clash {
			t.Errorf("%v shares a key with %s — one would be served the other's numbers", q, prev)
		}
		seen[k] = fmt.Sprint(q)
		// Drill-downs live in their own prefix, so Purge can find them and the
		// index can leave them out.
		if !isDrillKey(k) {
			t.Errorf("%v is not in the drill-down keyspace", q)
		}
	}

	// And the scope parameters themselves must NOT make it a drill-down.
	if _, drill, ok := KeyKind("telegram", "C", "shape1",
		map[string]string{"from": "a", "to": "b", "type": "telegram", "grain": "day"}); !ok || drill {
		t.Errorf("an unfiltered scope came back ok=%v drill=%v", ok, drill)
	}
}

/*
The same drill-down must hash the same way every time.

Go randomises map iteration, so a key built by walking the filters in map order
would differ from request to request: every click would store an entry and then
never find it again. A cache that writes and never reads looks exactly like a
cache that is simply slow, which is the hardest kind of bug to be told about.
*/
func TestDrillKeyIsStableAcrossMapOrder(t *testing.T) {
	q := map[string]string{
		"from": "2026-08-01", "to": "2026-08-16",
		"assetId": "A-1", "language": "English", "country": "India",
		"platform": "Twitter", "tatBucket": "0-15 min",
	}
	first, _, ok := KeyKind("telegram", "C1", "shape1", q)
	if !ok {
		t.Fatal("not cacheable")
	}
	for i := 0; i < 200; i++ {
		// A fresh map each time, so Go picks a new iteration order.
		again := make(map[string]string, len(q))
		for k, v := range q {
			again[k] = v
		}
		if got, _, _ := KeyKind("telegram", "C1", "shape1", again); got != first {
			t.Fatalf("the same drill-down hashed two ways: %s then %s", first, got)
		}
	}
}

// Two different windows are two different reports; one key for both would serve
// August's numbers to someone asking about July.
func TestKeyVariesWithWindow(t *testing.T) {
	a, _ := Key("telegram", "C1", "shape1", map[string]string{"from": "2026-07-01", "to": "2026-07-31"})
	b, _ := Key("telegram", "C1", "shape1", map[string]string{"from": "2026-08-01", "to": "2026-08-31"})
	c, _ := Key("telegram", "C2", "shape1", map[string]string{"from": "2026-07-01", "to": "2026-07-31"})
	if a == b {
		t.Error("different date windows produced the same key")
	}
	if a == c {
		t.Error("different clients produced the same key")
	}
}

/*
A report that gained a panel is a different report.

Without this, adding a breakdown changed nothing the key was made of — same
platform, same client, same window — so every cached entry kept being served
with the new panel absent, and the panel drew "No data." over data that was
there. It took six hours to clear on its own, which is exactly as long as it
takes for a deploy to look broken.
*/
func TestKeyVariesWithShape(t *testing.T) {
	scope := map[string]string{"from": "2026-07-01", "to": "2026-07-31"}
	before, ok1 := Key("open-web-sports", "C1", "dims-without-franchise", scope)
	after, ok2 := Key("open-web-sports", "C1", "dims-with-franchise", scope)
	if !ok1 || !ok2 {
		t.Fatal("an unfiltered scope should be cacheable")
	}
	if before == after {
		t.Error("adding a panel did not change the cache key — stale reports will hide it")
	}
}

func TestPayloadSurvivesAsJSON(t *testing.T) {
	c := liveCache(t)
	ctx := context.Background()
	key, _ := Key("urls", "C9", "shape1", map[string]string{"from": "2026-08-01", "to": "2026-08-02"})

	orig := map[string]any{"ok": true, "kpi": map[string]any{"identified": 99, "removalPct": 63.8},
		"daily": []any{map[string]any{"date": "2026-08-01", "urls": 5}}}
	b, _ := json.Marshal(orig)
	c.Write(ctx, key, "urls", "C9", "2026-08-01", "2026-08-02", b, 1)

	got, _, hit := c.Read(ctx, key)
	if !hit {
		t.Fatal("miss")
	}
	var back map[string]any
	if err := json.Unmarshal(got, &back); err != nil {
		t.Fatalf("cached payload is not valid JSON: %v", err)
	}
	kpi := back["kpi"].(map[string]any)
	if kpi["removalPct"].(float64) != 63.8 {
		t.Errorf("a float changed value through the cache: %v", kpi["removalPct"])
	}
	c.Purge(ctx)
}
