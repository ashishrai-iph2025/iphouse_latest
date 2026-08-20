package reportcache

// Can the cap actually be changed on a running Redis, and does the eviction
// policy come with it?
//
// SKIPS unless REDIS_TEST_ADDR is set. The policy half is the part worth
// testing: a cap with `noeviction` does not discard anything when full, it
// starts refusing writes — so raising the limit without fixing the policy would
// leave the cache silently unable to accept new reports.

import (
	"context"
	"os"
	"testing"
	"time"
)

func TestSetMaxMemoryAndPolicy(t *testing.T) {
	addr := os.Getenv("REDIS_TEST_ADDR")
	if addr == "" {
		t.Skip("REDIS_TEST_ADDR is not set — skipping the live memory check")
	}
	c := &Cache{}
	c.Configure(Config{Addr: addr, DB: 13, TTL: time.Minute})
	if !c.Enabled() {
		_, _, _, _, e := c.Status()
		t.Fatalf("not connected: %s", e)
	}
	ctx := context.Background()

	before, err := c.Memory(ctx)
	if err != nil {
		t.Fatalf("Memory: %v", err)
	}
	t.Logf("before: used=%d max=%d system=%d policy=%s",
		before.UsedBytes, before.MaxBytes, before.SystemBytes, before.Policy)
	if before.SystemBytes <= 0 {
		t.Error("total_system_memory not reported — the screen cannot size a limit against the machine")
	}
	t.Cleanup(func() { c.SetMaxMemory(ctx, before.MaxBytes) })

	const want = int64(512) * 1024 * 1024
	if err := c.SetMaxMemory(ctx, want); err != nil {
		t.Fatalf("SetMaxMemory: %v", err)
	}

	after, err := c.Memory(ctx)
	if err != nil {
		t.Fatalf("Memory after: %v", err)
	}
	if after.MaxBytes != want {
		t.Errorf("limit not applied: want %d, got %d", want, after.MaxBytes)
	}
	// The half that is easy to forget and expensive to get wrong.
	if after.Policy != "allkeys-lru" {
		t.Errorf("eviction policy is %q — a capped cache with no eviction refuses writes when full", after.Policy)
	}
	t.Logf("after: max=%d policy=%s", after.MaxBytes, after.Policy)
}
