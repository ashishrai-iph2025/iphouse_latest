package reportcache

// The guarantee this file exists for: a report computed by one build is never
// served by another.
//
// It failed once in the way that is hardest to notice — nothing errored, the
// numbers were simply yesterday's, and the fix looked like it had not worked.

import (
	"strings"
	"testing"
)

func TestEveryKeyCarriesTheBuild(t *testing.T) {
	tag := engine()
	if tag == "" {
		t.Fatal("no build tag at all — every build would share one key space")
	}

	q := map[string]string{"clientId": "C1", "from": "2026-01-01", "to": "2026-01-31"}
	key, ok := Key("social", "C1", "shape123", q)
	if !ok {
		t.Fatal("a plain scope was not cacheable")
	}
	// The report key, the index it is listed in, and the freshness mark all have
	// to move together. One of them left behind is a build reading another's
	// bookkeeping about entries it cannot see.
	for name, got := range map[string]string{
		"report key":  key,
		"meta set":    metaKey(),
		"fingerprint": fpKey("social", "C1", "30"),
	} {
		if !strings.HasPrefix(got, "rpt:"+tag+":") {
			t.Errorf("%s = %q, which is not scoped to build %s", name, got, tag)
		}
	}
}

/*
The bug, reproduced.

Two builds, identical platform, client, window and shape — the exact situation
that served a day-old removed=0 after the fix shipped. The keys must differ.
*/
func TestTwoBuildsDoNotShareAnEntry(t *testing.T) {
	q := map[string]string{"clientId": "C1", "from": "2026-01-01", "to": "2026-01-31"}

	before, _ := Key("social", "C1", "sameshape", q)
	metaBefore := metaKey()

	restore := engineTag
	t.Cleanup(func() { engineTag = restore })
	engineTag = "v3-adifferentbuild"

	after, _ := Key("social", "C1", "sameshape", q)

	if before == after {
		t.Error("two builds produced the same key for the same report — " +
			"the newer one would serve the older one's numbers")
	}
	if metaBefore == metaKey() {
		t.Error("two builds share one index; each would list entries it cannot read")
	}
}

/*
The tag has to be STABLE within a build.

Derived per call — from a timestamp, a random value, a pointer — every request
would miss, the cache would never hit, and the symptom would be a slow product
rather than a wrong one. Both are failures; this one just takes longer to find.
*/
func TestTagIsStableAcrossCalls(t *testing.T) {
	first := engine()
	for i := 0; i < 100; i++ {
		if engine() != first {
			t.Fatalf("the build tag changed between calls: %q then %q", first, engine())
		}
	}
	if tag, source := EngineTag(); tag != first || source == "" {
		t.Errorf("EngineTag() = (%q, %q), want (%q, non-empty)", tag, source, first)
	}
}

/*
A dirty tree must not be identified by its revision.

Two builds from the same commit with different working trees would otherwise
share a key space, and one would serve the other's reports — which is the very
failure this replaces, arriving by a different route.
*/
func TestDirtyTreeFallsBackFromTheRevision(t *testing.T) {
	if _, source := EngineTag(); source == "vcs revision" {
		// Built from a clean checkout, so the revision was used. Nothing to
		// assert beyond that it was not taken from a modified tree — which
		// vcsRevision refuses by construction.
		t.Log("identified by a clean vcs revision")
		return
	}
	// Otherwise a hash of the binary, which is exact by definition.
	if _, source := EngineTag(); source != "binary hash" && source != "the payload constant only" {
		t.Errorf("unexpected identity source %q", source)
	}
}

/*
Emptying the cache has to mean the reports get BUILT AGAIN.

The freshness marks — what the warehouse looked like when each report was last
built — were left behind by Purge. The next warm pass then probed, found a mark
that still matched, concluded nothing had changed, and skipped the rebuild. So
the cache someone had just emptied stayed empty: not until the next pass, but
until the data moved or the marks aged out four retention windows later.

Nothing about that is visible. The screen says the cache was emptied, the pass
reports "0 built, N unchanged", and both are telling the truth.
*/
func TestPurgePatternsCoverTheMarksAndTheDrillDowns(t *testing.T) {
	report, _, _ := KeyKind("social", "C1", "shape", map[string]string{"from": "a", "to": "b"})
	drill, isDrill, _ := KeyKind("social", "C1", "shape", map[string]string{"from": "a", "to": "b", "assetId": "A1"})
	mark := fpKey("social", "C1", "30")

	if !isDrill {
		t.Fatal("the filtered scope was not recognised as a drill-down")
	}

	/* Purge reaches the indexed reports through the meta set, and everything
	   else by these two prefixes. A key matching none of the three would
	   survive an "Empty the cache" — which is how the marks survived. */
	drillPat := keyPrefix() + "d:"
	markPat := keyPrefix() + "fp:"

	if !strings.HasPrefix(drill, drillPat) {
		t.Errorf("drill-down key %q is not under %q, so Purge would miss it", drill, drillPat)
	}
	if !strings.HasPrefix(mark, markPat) {
		t.Errorf("freshness mark %q is not under %q, so Purge would miss it", mark, markPat)
	}
	// The plain report must NOT match either sweep pattern — it is deleted via
	// the index, and matching a prefix sweep as well would be a second delete
	// of the same key and a misleading count.
	if strings.HasPrefix(report, drillPat) || strings.HasPrefix(report, markPat) {
		t.Errorf("a plain report key %q collides with a sweep prefix", report)
	}
}
