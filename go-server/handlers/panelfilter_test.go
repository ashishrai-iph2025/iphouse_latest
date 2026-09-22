package handlers

import (
	"os"
	"strings"
	"testing"
)

/*
Only panels the service can actually answer are offered.

── What this fixed ──────────────────────────────────────────────────────────

inferSpec matches a dimension on the TABLE HAVING the column. reports_api
deciding to GROUP BY that column is a separate question, and where the two
disagreed the panel was promised anyway: the breakdown came back 422 and the
card drew empty under "Some panels could not be loaded".

"Overall Piracy - Day-wise Identification & Removal" is the whole class in one
card. It groups by URLUploadDate; no dataset in the catalogue offers a date as a
dimension (every spelling answers 422, checked against the running service); so
it has never rendered on any report, sports or VOD. The trend card above it
answers the same question from the timeseries endpoint and always has.

── What must NOT be filtered ───────────────────────────────────────────────

Four panels are computed in this package rather than by a GROUP BY, and two of
them deliberately read a column the service refuses as a dimension. Judging them
by groupability deletes four working cards, which is worse than the empty one
this removes — so the exemption is the part worth pinning down.
*/
func TestPanelsComputedHereAreNeverFilteredOut(t *testing.T) {
	for _, k := range []string{dimTAT, dimRepeatOffender, dimTopProfiles} {
		if !panelIsComputedHere(k) {
			t.Errorf("%s is computed from rows or timestamps, not from a GROUP BY — "+
				"filtering it on groupability removes a working card", k)
		}
	}
	// The action panels, via their own predicate so the two cannot drift.
	for _, k := range []string{dimEngineDelistingBatches, dimNoticesByDay, dimBatchesByDay} {
		if !isActionPanel(k) {
			t.Fatalf("%s is no longer an action panel; this test is checking nothing", k)
		}
		if !panelIsComputedHere(k) {
			t.Errorf("action panel %s would be filtered on groupability, but it counts "+
				"an APIMeasure rather than grouping by a column", k)
		}
	}
}

/*
And ordinary breakdown panels ARE judged, or the filter does nothing.

dimOverallByDay is named explicitly: it is the card this was built for, and an
exemption added for it would restore the empty panel while looking like a fix.
*/
func TestOrdinaryPanelsAreStillJudged(t *testing.T) {
	for _, k := range []string{dimOverallByDay, "byAsset", "byDomain", "byGenreId", "byPlatform"} {
		if panelIsComputedHere(k) {
			t.Errorf("%s is an ordinary breakdown and must be judged on whether the "+
				"service will group by it", k)
		}
	}
}

/*
The filter must not consume the panel's LABEL on its way past.

Several panels have two forms — Country is offered as CountryName and as
CountryId, deduped to one card by Label. If the skipped form marked the label as
seen, dropping the name form would take the card with it and the id form would
never be reached. That turns a fix for one empty panel into the silent loss of
several working ones, on exactly the datasets that carry ids rather than names —
which is every VOD table.
*/
func TestTheFilterDoesNotClaimTheLabelItSkips(t *testing.T) {
	src, err := os.ReadFile("reportsrun.go")
	if err != nil {
		t.Fatalf("read reportsrun.go: %v", err)
	}
	body := string(src)

	i := strings.Index(body, "func sectionDimensions")
	if i < 0 {
		t.Fatal("sectionDimensions is gone")
	}
	seg := body[i:]
	if e := strings.Index(seg, "\nfunc "); e > 0 {
		seg = seg[:e]
	}

	skip := strings.Index(seg, "!apiCanGroupBy(sp.Table, d.Column)")
	if skip < 0 {
		t.Fatal("sectionDimensions no longer filters on groupability, so panels the " +
			"service cannot answer are offered again")
	}
	mark := strings.Index(seg, "labelSeen[d.Label] = true")
	if mark < 0 {
		t.Fatal("the label dedup is gone")
	}
	if skip > mark {
		t.Error("the groupability skip runs AFTER the label is marked seen — a dropped " +
			"name form would take its card with it, and the id form behind it would " +
			"never be reached")
	}
}
