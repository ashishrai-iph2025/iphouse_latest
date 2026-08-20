package handlers

// Does a report actually come back from Redis the second time?
//
// SKIPS unless REDIS_TEST_ADDR is set. This is the claim the whole feature
// rests on, and it is the one that cannot be checked by reading the code: the
// cache sits around runPlatform, and what matters is that the second call
// returns the FIRST call's answer, unchanged, without recomputing.

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/ip-house/iphouse-api/reportcache"
)

func TestReportCacheServesSecondRequest(t *testing.T) {
	addr := os.Getenv("REDIS_TEST_ADDR")
	if addr == "" {
		t.Skip("REDIS_TEST_ADDR is not set — skipping the live report-cache check")
	}
	c := reportcache.Get()
	c.Configure(reportcache.Config{Addr: addr, DB: 14, TTL: time.Minute})
	if !c.Enabled() {
		_, _, _, _, e := c.Status()
		t.Fatalf("cache not connected: %s", e)
	}
	ctx := context.Background()
	c.Purge(ctx)
	t.Cleanup(func() { c.Purge(ctx); c.Configure(reportcache.Config{}) })

	q := map[string]string{"clientId": "TEST-CLIENT", "from": "2026-08-01", "to": "2026-08-16"}
	key, ok := reportcache.Key("telegram", q["clientId"], "shape1", q)
	if !ok {
		t.Fatal("scope should be cacheable")
	}

	// Stand in for a computed report — this test is about the cache path, not
	// about the warehouse.
	built := map[string]any{"ok": true, "type": "telegram",
		"kpi": map[string]any{"identified": 4242, "removalPct": 63.8}}
	b, _ := json.Marshal(built)
	c.Write(ctx, key, "telegram", q["clientId"], q["from"], q["to"], b, 3500)

	payload, at, hit := c.Read(ctx, key)
	if !hit {
		t.Fatal("second request missed the cache — the whole feature is a no-op")
	}
	var back map[string]any
	if err := json.Unmarshal(payload, &back); err != nil {
		t.Fatalf("cached report is not valid JSON: %v", err)
	}
	kpi := back["kpi"].(map[string]any)
	if kpi["identified"].(float64) != 4242 {
		t.Errorf("the number changed through the cache: %v", kpi["identified"])
	}
	if time.Since(at) > time.Minute {
		t.Errorf("stored-at looks wrong: %v", at)
	}

	/* A drill-down must NOT be served the unfiltered answer. This is the
	   dangerous failure: same client, same window, one filter added — if the
	   key ignored the filter, a filtered report would show unfiltered totals
	   and look entirely plausible. */
	drill := map[string]string{"clientId": "TEST-CLIENT", "from": "2026-08-01", "to": "2026-08-16", "assetId": "A-1"}
	if k2, ok2 := reportcache.Key("telegram", drill["clientId"], "shape1", drill); ok2 || k2 == key {
		t.Error("a filtered scope resolved to the unfiltered cache entry")
	}
}
