package handlers

import (
	"strings"
	"testing"
)

/*
Open Web's Removed tile is de-indexing plus host takedowns.

The two halves of that report are enforced differently — a link is dropped from
the search engines, a host is taken down — and the tile summed each side's own
RemovalCount, which counted the linking side's takedowns and left out
de-indexing entirely. Two cards on the same band show the de-indexing (Google,
Bing) that the removal figure beside them ignored.
*/

func twoSidedRoles() map[string]bool { return map[string]bool{"linking": true, "host": true} }

func TestRemovedIsDelistingPlusHostTakedowns(t *testing.T) {
	roleKPI := map[string]map[string]int64{
		"linking": {"identified": 600_000, "removed": 120_000, "delisted": 478_900},
		"host":    {"identified": 212_400, "removed": 62_900},
	}
	got, ok := openWebRemovedFromDelisting(roleKPI, twoSidedRoles())
	if !ok {
		t.Fatal("the rule did not apply to a two-sided report that reports de-indexing")
	}
	if want := int64(478_900 + 62_900); got != want {
		t.Errorf("removed = %d, want %d (de-indexed + host takedowns)", got, want)
	}
	/* THE LINKING SIDE'S OWN RemovalCount DROPS OUT. Adding it would count a
	   link that was both de-indexed and taken down twice, which is the common
	   case rather than the exception — and the tile can then exceed the
	   identified figure above it. */
	if got == 478_900+62_900+120_000 {
		t.Error("the linking side's takedowns were added on top, which double-counts " +
			"every link that was both de-indexed and removed")
	}
	if got > roleKPI["linking"]["identified"]+roleKPI["host"]["identified"] {
		t.Error("removed exceeds identified")
	}
}

/*
Three ways it must decline, each for its own reason.

The third is the one worth having a test for: a linking side with no `delisted`
key has no de-indexing FIGURE, not a de-indexing figure of zero. Reading the
missing key as zero would publish "removed = host only" and silently drop the
whole linking half of the report's enforcement — a smaller number, on a tile
where a smaller number looks like bad news rather than like a bug.
*/
func TestTheRemovalRuleDeclinesWhereItCannotApply(t *testing.T) {
	full := map[string]map[string]int64{
		"linking": {"removed": 120_000, "delisted": 478_900},
		"host":    {"removed": 62_900},
	}

	// One side: nothing to recompose, and switching the definition under a
	// reader who narrowed to one side answers a question they did not ask.
	if _, ok := openWebRemovedFromDelisting(full, map[string]bool{"linking": true}); ok {
		t.Error("the rule applied to a single-sided platform")
	}

	// Two sides declared, but only one answered — a platform whose host tables
	// returned nothing.
	linkingOnly := map[string]map[string]int64{"linking": full["linking"]}
	if _, ok := openWebRemovedFromDelisting(linkingOnly, twoSidedRoles()); ok {
		t.Error("the rule applied with no host figures to add")
	}

	// Two sides, no de-indexing reported at all.
	noDelisting := map[string]map[string]int64{
		"linking": {"removed": 120_000},
		"host":    {"removed": 62_900},
	}
	if v, ok := openWebRemovedFromDelisting(noDelisting, twoSidedRoles()); ok {
		t.Errorf("the rule applied with no delisted figure, publishing %d — the "+
			"linking half's enforcement would vanish from the tile", v)
	}
}

// The daily series follows the tile. The removal-rate chart is drawn from these
// rows, so a tile recomposed while the trend stayed summed would put one figure
// on a card over a line computed from another.
func TestTheDailySeriesIsRecomposedTheSameWay(t *testing.T) {
	if got := openWebDailyFromDelisting(
		map[string]int64{"removed": 900, "delisted": 4_100},
		map[string]int64{"removed": 700},
	); got != 4_800 {
		t.Errorf("daily removed = %d, want 4800", got)
	}
	// A side with no row that day contributes nothing, which is what no rows
	// means — not an unknown day.
	if got := openWebDailyFromDelisting(map[string]int64{"delisted": 50}, nil); got != 50 {
		t.Errorf("a day with no host rows = %d, want 50", got)
	}
}

/*
And the rollup can produce a de-indexing figure at all.

The VOD linking table stores two summed counts per day rather than a flag per
URL, so inferSpec's raw-table expression finds nothing on it — which is why the
De-Indexing card drew an em dash while Google De-Indexed and Bing De-Indexed sat
beside it at 478.9K each, and why the removal rule above had no `delisted` to
read.

GREATEST and never the sum: delisting goes to both engines as one batch, so the
two counts are the same URLs. Summing them reported more de-indexings than there
were identifications.
*/
func TestTheVODLinkingRollupReportsDeIndexing(t *testing.T) {
	rollup := delistedExprFor(namedShape("dashboards.InternetInfringingURLMainDashboardTable",
		"URLCount", "RemovalCount", "GoogleDelistedCount", "BingDelistedCount"))
	if rollup == "" {
		t.Fatal("the VOD linking rollup reports no de-indexing, so the De-Indexing " +
			"card is empty and Removed has no linking half to count")
	}
	if !strings.Contains(rollup, "GREATEST(") {
		t.Errorf("de-indexing is not bounded by the larger engine count:\n  %s", rollup)
	}
	if strings.Contains(rollup, "GoogleDelistedCount) + SUM(") {
		t.Errorf("the two engine counts are summed — the same URLs counted twice:\n  %s", rollup)
	}

	/* The raw sports table keeps its EXACT form. It has a flag per URL, so the
	   union is a real distinct count there and the bound above would be a
	   needless approximation — a worse figure — on a table that can answer the
	   question properly. Which is why the flag branch is tested first. */
	raw := delistedExprFor(namedShape("dashboards.SportsURLRawData",
		"IsRemoved", "IsGoogleDelisted", "IsBingDelisted"))
	if !strings.Contains(raw, "IsGoogleDelisted") {
		t.Errorf("the raw table lost its exact de-indexing count:\n  %s", raw)
	}

	// A table recording neither reports nothing, rather than a zero that would
	// read as "no links were de-indexed".
	if got := delistedExprFor(namedShape("x", "URLCount", "RemovalCount")); got != "" {
		t.Errorf("a table with no delisting columns offered %q", got)
	}
}
