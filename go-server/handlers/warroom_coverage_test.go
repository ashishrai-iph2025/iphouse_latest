package handlers

import "testing"

/*
The bug this file pins: a full pull scoped to 2026-08-11 → 2026-08-31, then a
LATER request for 2026-09-01 → 2026-09-08 — a window entirely past the first
one's end date. The old decision only checked whether the new window started
BEFORE the stored coverage (widened); a window moved forward instead took the
incremental branch, which can only add rows that changed since lastFetch — it
can never backfill September rows that were already old in MarkScan before
the first pull ever ran. The report rendered a real "0 identified" for a week
MarkScan had over a thousand YouTube rows for, with nothing on screen to say
the pull never happened.
*/
func TestDecideFullPullExtendsWhenTheWindowMovesPastCoverageEnd(t *testing.T) {
	d := decideFullPull("auto", true, 68563, "2026-08-11", "2026-08-31", "2026-09-01", "2026-09-08")
	if !d.full {
		t.Error("expected a full pull: the window moved past the stored coverage's end date")
	}
	if !d.extended {
		t.Error("expected extended=true")
	}
	if d.widened {
		t.Error("expected widened=false: the start date did not move backward")
	}
}

func TestDecideFullPullStaysIncrementalWithinCoverage(t *testing.T) {
	// A narrower window fully inside what a bounded full pull already covered
	// must NOT force a re-pull — that's the whole point of the incremental
	// path, and the fix above must not make it fire needlessly.
	d := decideFullPull("auto", true, 68563, "2026-08-11", "2026-08-31", "2026-08-15", "2026-08-20")
	if d.full {
		t.Error("expected an incremental pull: the window is entirely inside the known coverage")
	}
}

func TestDecideFullPullExtendsOnAnOpenEndedRequestPastABoundedCoverage(t *testing.T) {
	// No end date means "everything through today," which reaches past a
	// PAST pull that was explicitly bounded.
	d := decideFullPull("auto", true, 68563, "2026-08-11", "2026-08-31", "2026-09-01", "")
	if !d.full || !d.extended {
		t.Error("expected an open-ended request to extend past a bounded coverage end")
	}
}

func TestDecideFullPullStaysIncrementalWhenCoverageIsOpenEnded(t *testing.T) {
	// coverageEnd == "" means the last full pull was itself open-ended — the
	// ordinary, continuously-refreshed case (a preset with no fixed end, or
	// the realtime poller). This must not force a full pull on every request
	// just because no end boundary was ever recorded.
	d := decideFullPull("auto", true, 100, "2026-08-11", "", "2026-09-01", "2026-09-08")
	if d.full {
		t.Error("expected an incremental pull: an open-ended coverage has no end to fall behind")
	}
	if d.extended {
		t.Error("expected extended=false when coverageEnd is open-ended")
	}
}

func TestDecideFullPullOnANewAsset(t *testing.T) {
	d := decideFullPull("auto", false, 0, "", "", "2026-09-01", "2026-09-08")
	if !d.full {
		t.Error("expected a full pull for an asset with no stored data")
	}
	// hasData is false, so neither reason should be reported as the cause —
	// "no data yet" already explains it, and logging "window widened (x < "")"
	// for a brand-new asset would misdescribe why.
	if d.widened || d.extended {
		t.Error("expected widened/extended to stay false (unreported) when there is no prior data at all")
	}
}

func TestDecideFullPullForcedMode(t *testing.T) {
	d := decideFullPull("full", true, 68563, "2026-08-11", "2026-08-31", "2026-08-15", "2026-08-20")
	if !d.full {
		t.Error("expected mode=full to force a full pull regardless of coverage")
	}
}
