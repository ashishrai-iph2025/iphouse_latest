package store

import (
	"context"
	"testing"
	"time"
)

// The in-memory backend round-trips coverageEnd exactly like coverageStart —
// pinned separately because it is the newer of the two fields and the one a
// future edit is likelier to touch only one side of.
func TestMemStoreRoundTripsCoverageEnd(t *testing.T) {
	s := newMemStore()
	ctx := context.Background()
	now := time.Now().UTC()

	if err := s.SetMeta(ctx, "k", now, "2026-08-11", "2026-08-31"); err != nil {
		t.Fatalf("SetMeta: %v", err)
	}
	lastFetch, start, end, _, ok := s.Meta(ctx, "k")
	if !ok {
		t.Fatal("expected Meta to report ok=true after SetMeta")
	}
	if start != "2026-08-11" {
		t.Errorf("coverageStart = %q, want 2026-08-11", start)
	}
	if end != "2026-08-31" {
		t.Errorf("coverageEnd = %q, want 2026-08-31", end)
	}
	if !lastFetch.Equal(now) {
		t.Errorf("lastFetch = %v, want %v", lastFetch, now)
	}
}

// An open-ended pull (no end date) must round-trip coverageEnd as "", not as
// some other sentinel — decideFullPull's "no boundary to fall behind" branch
// depends on this exact value.
func TestMemStoreOpenEndedCoverageEnd(t *testing.T) {
	s := newMemStore()
	ctx := context.Background()
	if err := s.SetMeta(ctx, "k", time.Now().UTC(), "2026-08-11", ""); err != nil {
		t.Fatalf("SetMeta: %v", err)
	}
	_, _, end, _, _ := s.Meta(ctx, "k")
	if end != "" {
		t.Errorf("coverageEnd = %q, want empty for an open-ended pull", end)
	}
}

func TestMemStoreMetaBeforeAnySetMeta(t *testing.T) {
	s := newMemStore()
	_, _, _, _, ok := s.Meta(context.Background(), "never-seen")
	if ok {
		t.Error("expected ok=false for a key nothing has ever been stored under")
	}
}
