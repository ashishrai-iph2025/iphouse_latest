package handlers

import (
	"os"
	"strings"
	"testing"
)

/*
The combined figures have to SURVIVE the extra-KPI loop.

applyAutoClaimKPIs sets five things, and three of them — totalAssets,
totalChannels and views — are also ExtraKPI keys that the YouTube dataset
answers under `assets`, `channels` and `views`. So the order of those two
statements decides whether the report shows the two routes combined or the
manual one alone, and for a while it decided the second: the unions were
computed, four grouped queries were spent listing both sides, and the loop
overwrote them one statement later.

That failure is invisible in every way that usually catches one. The tile is
drawn, the number is plausible, it is merely the wrong number — the YouTube
daily table's own distinct count, presented as the catalogue across both
enforcement routes.

Two tests, because neither is sufficient alone. The first pins the arithmetic,
which is exercisable here. The second pins the ORDER, which is not: it needs a
live reports_api and two datasets to answer, so it is read from source the same
way TestTheLayoutOffersTheClaimTilesOnYouTube reads reportlayout.go.
*/

func TestTheUnionReplacesEachSidesOwnCount(t *testing.T) {
	/* The numbers from ytautoclaim.go's own header: 170 titles claimed
	   automatically and 389 found manually are 466 distinct titles, not 559,
	   because most of them are the same titles. Same for channels. */
	kpi := map[string]any{
		"identified": int64(461_500), "removed": int64(400_000),
		"totalAssets": int64(389), "totalChannels": int64(4_980),
		"views": int64(11_000_000_000),
	}
	applyAutoClaimKPIs(kpi, autoClaimFigures{
		claims: 1_400_000, views: 32_500_000_000,
		assets: 466, channels: 41_551,
	})

	if got := numOf(kpi["totalAssets"]); got != 466 {
		t.Errorf("totalAssets = %d, want the union 466 — the manual side's 389 "+
			"is the figure this exists to replace", got)
	}
	if got := numOf(kpi["totalChannels"]); got != 41_551 {
		t.Errorf("totalChannels = %d, want the union 41,551", got)
	}
	/* Views ADD where assets and channels UNION, and the distinction is the
	   reason those are counted rather than summed: an upload is claimed by one
	   route or found by the other, never both, while a title and a channel are
	   routinely touched by both. */
	if got := numOf(kpi["views"]); got != 43_500_000_000 {
		t.Errorf("views = %d, want both routes added: 43.5B", got)
	}
	if got := numOf(kpi["identified"]); got != 1_861_500 {
		t.Errorf("identified = %d, want manual plus auto", got)
	}
}

/*
And the order in the bridge, read from source.

What matters is only which statement comes LAST for these three keys, so this
compares positions rather than trying to parse Go. If the loop is ever moved,
renamed or duplicated, this fails with the reason rather than the report
quietly reverting to the manual-only figures.
*/
func TestAutoClaimFiguresAreAppliedAfterTheExtraKPILoop(t *testing.T) {
	src, err := os.ReadFile("reportsapi_bridge.go")
	if err != nil {
		t.Fatalf("read reportsapi_bridge.go: %v", err)
	}
	s := string(src)

	loop := strings.Index(s, "for name := range s.ExtraKPI {")
	if loop < 0 {
		t.Fatal("the extra-KPI loop is gone or was rewritten — check by hand that " +
			"the auto-claim figures still survive whatever replaced it")
	}
	apply := strings.Index(s, "applyAutoClaimKPIs(kpi, autoClaim)")
	if apply < 0 {
		t.Fatal("applyAutoClaimKPIs is no longer called from the bridge; the YouTube " +
			"report shows the manual route alone")
	}
	if apply < loop {
		t.Error("applyAutoClaimKPIs runs BEFORE the extra-KPI loop, so the loop " +
			"overwrites totalAssets, totalChannels and views with the YouTube " +
			"daily table's own figures — the manual route alone, on tiles that " +
			"say both")
	}

	/* And only once. A second call on the other side of the loop would look
	   like belt-and-braces and would double the claims into `identified` and
	   `removed`, which the first call has already added. */
	if strings.Count(s, "applyAutoClaimKPIs(kpi, autoClaim)") != 1 {
		t.Error("applyAutoClaimKPIs is called more than once — it is not idempotent, " +
			"it ADDS the claims to identified, removed and views")
	}
}
