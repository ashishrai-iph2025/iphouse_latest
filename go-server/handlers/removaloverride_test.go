package handlers

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

/*
A dataset's own removed measure must survive the row walk.

── The bug ──────────────────────────────────────────────────────────────────

The API bridge substitutes a row-walk removal count for the summary's, because
some datasets have no removed measure and answer 0 — indistinguishable from a
real zero. That substitution is right for those datasets and wrong for every
other one, and it was unguarded.

It became visible when `wantRows` grew a new reason to be true: wantTotalSubscribers
switches the row walk on purely to compute a subscriber tile, so the VOD Telegram
and YouTube tables began reading their rows — and the substitution then discarded
their real SUM(RemovedCount) in favour of a count derived from a removal column
those tables do not carry.

A DAZN Telegram report showed Removed 0, Removal % 0 and Pending equal to the
entire window, while the warehouse held 1,247 removals for that client over the
same 82 days. Zero is the worst available wrong answer: it is a legal value, so
it reads as "nothing came down" rather than as "not measured".

── Why a source test ────────────────────────────────────────────────────────

The defect is a missing condition on a switch case, not arithmetic. Reaching it
at runtime needs the service, a warehouse and a client whose data has this exact
shape. In the source it is one guard, in three places that must agree.
*/
func TestRowWalkNeverOverridesADatasetsOwnRemovedMeasure(t *testing.T) {
	src, err := os.ReadFile("reportsapi_bridge.go")
	if err != nil {
		t.Fatalf("read reportsapi_bridge.go: %v", err)
	}
	body := string(src)

	/*
		Every `case haveRowMx` that assigns a removal figure must carry the
		guard. Matched on the case line itself: an unguarded `case haveRowMx:`
		is precisely the bug, and there is no legitimate reason for one to
		reappear in this file — the three sites (the KPI tile, the daily trend
		and the per-panel tallies) are the three places the figure is written,
		and they have to agree or the report contradicts itself on screen.
	*/
	bare := regexp.MustCompile(`(?m)^\s*case haveRowMx:\s*$`)
	if locs := bare.FindAllStringIndex(body, -1); len(locs) > 0 {
		for _, l := range locs {
			t.Errorf("unguarded `case haveRowMx:` at byte %d — it will overwrite a "+
				"dataset's own removed measure with a row-walk count the table has "+
				"no column for, and the tile reads 0", l[0])
		}
	}

	guarded := strings.Count(body, "case haveRowMx && !ds.HasMeasure(\"removed\"):")
	if guarded != 3 {
		t.Errorf("found %d guarded row-walk removal branches, want 3 (the KPI tile, "+
			"the daily trend and the per-panel tallies). If a site was added or "+
			"removed, the three must still agree — a tile reporting removals above "+
			"a trend drawing a flat zero is the failure this guard prevents", guarded)
	}
}

/*
The three sites must stay consistent with each other.

The KPI, the daily series and the panels are read together on one screen. A
guard applied to one and not the others swaps a wrong number for a visible
contradiction, which is not an improvement — the trend would draw zero under a
tile reporting thousands.
*/
func TestTheThreeRemovalSitesAgree(t *testing.T) {
	src, err := os.ReadFile("reportsapi_bridge.go")
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	body := string(src)

	for _, anchor := range []struct{ what, near string }{
		{"the KPI tile", `kpi["removed"] = removed`},
		{"the daily trend", `row["removed"] = rowMx.removedByDay[dayKey(date)]`},
		{"the per-panel tallies", `rowMx.removedByCol[col]`},
	} {
		i := strings.Index(body, anchor.near)
		if i < 0 {
			t.Errorf("%s: could not find %q — this test is no longer checking it",
				anchor.what, anchor.near)
			continue
		}
		// The guard governing that assignment sits in the 900 bytes before it.
		from := i - 900
		if from < 0 {
			from = 0
		}
		if !strings.Contains(body[from:i], `HasMeasure("removed")`) {
			t.Errorf("%s writes a removal figure with no HasMeasure(\"removed\") guard "+
				"above it", anchor.what)
		}
	}
}
