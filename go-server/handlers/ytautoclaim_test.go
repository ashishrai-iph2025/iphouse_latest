package handlers

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/ip-house/iphouse-api/reportsapi"
)

// datasetWithTable is the smallest dataset that sectionHasAutoClaims can judge.
func datasetWithTable(table string) reportsapi.Dataset {
	return reportsapi.Dataset{Table: table}
}

/*
Combining YouTube's two routes.

Claims and views ADD; assets and channels UNION. Getting the second pair wrong
is invisible on screen — a bigger catalogue looks like a bigger problem, not
like a bug — and it is wrong by exactly the overlap, which is the part anybody
would most want to know.
*/

func bd(vals ...string) []map[string]any {
	out := make([]map[string]any, 0, len(vals))
	for _, v := range vals {
		out = append(out, map[string]any{"value": v, "grp": v})
	}
	return out
}

/*
BOTH SPELLINGS OF A CHANNEL ARE ONE CHANNEL.

The summary keeps the bare handle, the daily table the full address. Left
unreduced the two lists share nothing, the union equals the sum, and the tile
reports 41,551 channels where there are fewer — the exact failure the union was
introduced to prevent, wearing the union's name.
*/
func TestChannelKeyReducesBothSpellingsToOne(t *testing.T) {
	want := "uc1ayxnd5dm08ady4a3lwv_g"
	for _, in := range []string{
		"UC1AYXnD5Dm08Ady4A3LWV_g",
		"https://www.youtube.com/channel/UC1AYXnD5Dm08Ady4A3LWV_g",
		"https://www.youtube.com/channel/UC1AYXnD5Dm08Ady4A3LWV_g/",
		"  UC1AYXnD5Dm08Ady4A3LWV_g  ",
	} {
		if got := youtubeChannelKey(in); got != want {
			t.Errorf("youtubeChannelKey(%q) = %q, want %q", in, got, want)
		}
	}
	// Nothing that names no channel joins a union.
	for _, in := range []string{"", "   ", nullGroupLabel} {
		if got := youtubeChannelKey(in); got != "" {
			t.Errorf("youtubeChannelKey(%q) = %q, want empty — a row with no channel "+
				"must not be counted as one", in, got)
		}
	}
	/* The daily table also carries /user/ and /@handle forms. Taking the last
	   segment reduces those too; stripping a fixed /channel/ prefix would leave
	   them whole and match them against nothing. */
	if youtubeChannelKey("https://www.youtube.com/@SomeName") != "@somename" {
		t.Error("a handle-form URL was not reduced to its last segment")
	}
}

/*
THE UNION IS NOT THE SUM.

Two routes touching the same channel have touched one channel.
*/
func TestUnionCountsTheOverlapOnce(t *testing.T) {
	auto := bd("UCa", "UCb", "UCc")
	manual := bd(
		"https://www.youtube.com/channel/UCb",
		"https://www.youtube.com/channel/UCd",
	)
	got := unionCount(auto, manual, false, false, youtubeChannelKey)
	if got != 4 {
		t.Errorf("union = %d, want 4 (a,b,c,d). 5 means UCb was counted on both "+
			"sides — the sum wearing the union's name", got)
	}
}

// Asset ids are already comparable; the union is still a union.
func TestAssetUnionCountsDistinctTitles(t *testing.T) {
	got := unionCount(bd("A", "B"), bd("b", "C"), false, false, identityKey)
	if got != 3 {
		t.Errorf("union = %d, want 3 — ids are GUIDs and two spellings of one are "+
			"one title", got)
	}
	if n := unionCount(bd("A", nullGroupLabel, ""), bd("A"), false, false, identityKey); n != 1 {
		t.Errorf("got %d, want 1 — the (none) bucket is not a title", n)
	}
}

/*
A TRUNCATED LIST IS NOT A COUNT.

An undercount on a headline tile cannot be told apart from the truth, so it is
withheld rather than drawn. Same rule the TV-channel tile follows.
*/
func TestATruncatedUnionIsWithheld(t *testing.T) {
	if got := unionCount(bd("A"), bd("B"), true, false, identityKey); got != -1 {
		t.Errorf("got %d, want -1 when one side was capped", got)
	}
	if got := unionCount(bd("A"), bd("B"), false, true, identityKey); got != -1 {
		t.Errorf("got %d, want -1 when the other side was capped", got)
	}
}

/*
The tiles: what adds, what replaces, and what is measured against what.
*/
func TestCombinedKPIsAddClaimsAndKeepTheRateOnManual(t *testing.T) {
	kpi := map[string]any{
		"identified": int64(41095), "removed": int64(39213),
		"views": int64(2128203552), "totalAssets": int64(170),
		"totalChannels": int64(4980),
	}
	applyAutoClaimKPIs(kpi, autoClaimFigures{
		claims: 196487, views: 67596773, assets: 460, channels: 39000,
	})

	if got := numOf(kpi["manualClaims"]); got != 41095 {
		t.Errorf("manualClaims = %d, want the figure the section published", got)
	}
	if got := numOf(kpi["autoClaims"]); got != 196487 {
		t.Errorf("autoClaims = %d", got)
	}
	if got := numOf(kpi["identified"]); got != 237582 {
		t.Errorf("Total Infringements = %d, want 237582 — the two routes together", got)
	}
	if got := numOf(kpi["views"]); got != 2195800325 {
		t.Errorf("views = %d, want the two added", got)
	}
	if got := numOf(kpi["totalAssets"]); got != 460 {
		t.Errorf("totalAssets = %d, want the union (460), not 170+389", got)
	}
	if got := numOf(kpi["totalChannels"]); got != 39000 {
		t.Errorf("totalChannels = %d, want the union", got)
	}
	/* The rate stays against MANUAL. A claim has no removal to be a share of,
	   so dividing by the combined total would report the rate collapsing every
	   time Content ID does its job — 39,213/237,582 is 16.5%, against a real
	   95.4%. */
	if got := numOf(kpi["removalPct"]); got != 95 {
		t.Errorf("removalPct rounded to %d%%, want ~95 — measured against manual "+
			"claims. Against the combined total it reads about 16%%, which is not a "+
			"fall in performance but a change of denominator", got)
	}
	if got := numOf(kpi["pending"]); got != 237582-39213 {
		t.Errorf("pending = %d, want the combined total less removals", got)
	}
}

/*
A union that could not be computed leaves its tile alone.

The YouTube figure standing on its own is an undercount of the combination, and
says so by being the number it always was. A zero would be a new wrong answer,
and a sum would be the bug this whole file avoids.
*/
func TestAnUncomputedUnionLeavesTheTileAlone(t *testing.T) {
	kpi := map[string]any{
		"identified": int64(100), "removed": int64(10),
		"totalAssets": int64(170), "totalChannels": int64(4980), "views": int64(5),
	}
	applyAutoClaimKPIs(kpi, autoClaimFigures{claims: 50, views: 5, assets: -1, channels: -1})

	if got := numOf(kpi["totalAssets"]); got != 170 {
		t.Errorf("totalAssets = %d, want the section's own 170 left untouched", got)
	}
	if got := numOf(kpi["totalChannels"]); got != 4980 {
		t.Errorf("totalChannels = %d, want 4980 left untouched", got)
	}
	// The claim figures are unaffected: they came from the summary and are whole.
	if got := numOf(kpi["identified"]); got != 150 {
		t.Errorf("identified = %d, want 150 — a failed union must not withhold the "+
			"claim count too", got)
	}
}

// Only the YouTube report gets these tiles.
func TestOnlyTheYouTubeSectionCombinesClaims(t *testing.T) {
	if !sectionHasAutoClaims(datasetWithTable(youtubeMainTable)) {
		t.Error("the YouTube daily table should carry the auto-claim tiles")
	}
	for _, tbl := range []string{
		"dashboards.Agg_Daily_Telegram_MasterNew",
		"dashboards.SocialMediaDashboard",
		"dashboards.Unified_BI_Dashboard",
		autoClaimTable,
	} {
		if sectionHasAutoClaims(datasetWithTable(tbl)) {
			t.Errorf("%s must not carry YouTube's claim tiles", tbl)
		}
	}
}

/*
THE FIGURES MUST HAVE CARDS.

This is the failure that prompted the test: the claim figures were computed,
put in the KPI map, given labels and ⓘ notes — and no tile was ever drawn,
because a card exists only for a metric the LAYOUT was told about. Everything
looked done from the code and the section showed nothing new.

Two halves, and they have to agree with each other:

	· the layout offers a tile for each key in autoClaimKPIs
	· applyAutoClaimKPIs actually writes every one of those keys

Either half alone is silent. A metric offered and never written draws a blank
card; a metric written and never offered is invisible, which is what happened.
*/
func TestEveryClaimTileIsBothOfferedAndFilled(t *testing.T) {
	// The writer's half: every offered key is set.
	kpi := map[string]any{"identified": int64(10), "removed": int64(4), "views": int64(1)}
	applyAutoClaimKPIs(kpi, autoClaimFigures{claims: 90, views: 2, assets: -1, channels: -1})
	for _, k := range autoClaimKPIs {
		if _, ok := kpi[k]; !ok {
			t.Errorf("the layout offers a %q tile and applyAutoClaimKPIs never sets it — "+
				"the card would draw blank", k)
		}
	}

	// The layout's half: each key becomes a tile panel, with a name on it.
	tiles := kpiTilesFor(autoClaimKPIs)
	panels := defaultPanels("youtube", nil, nil, tiles, nil, nil, false, false)
	found := map[string]bool{}
	for _, p := range panels {
		if p.Kind == panelTile {
			found[p.Metric] = true
			if p.Label == "" {
				t.Errorf("the %q tile has no label", p.Metric)
			}
		}
	}
	for _, k := range autoClaimKPIs {
		if !found[k] {
			t.Errorf("no card is drawn for %q — the figure is computed and invisible, "+
				"which is the whole defect this test exists for", k)
		}
	}
	/* And Total Infringements is the tile every report already has, now
	   carrying both routes. If it were added to autoClaimKPIs it would be
	   offered twice and the band would show it twice. */
	if found["identified"] != true {
		t.Error("the identified tile is missing; Total Infringements is that tile")
	}
	for _, k := range autoClaimKPIs {
		if k == "identified" {
			t.Error("identified must not be in autoClaimKPIs — it is a base metric, " +
				"and offering it again draws the headline twice")
		}
	}
}

/*
And the layout must actually ASK for them on the YouTube platform.

The test above proves the two halves agree once the tiles are offered; it passes
autoClaimKPIs to kpiTilesFor directly, so it cannot see whether anything offers
them in the first place. platformExtraKPIs is that hook, and removing it puts the
figures back exactly where they were — computed, labelled and invisible.

Read from source because platformExtraKPIs resolves a platform's specs through
tableShapeOf, which needs the warehouse; the linkage it must contain does not.
*/
func TestTheLayoutOffersTheClaimTilesOnYouTube(t *testing.T) {
	src, err := os.ReadFile("reportlayout.go")
	if err != nil {
		t.Fatalf("read reportlayout.go: %v", err)
	}
	body := string(src)

	i := strings.Index(body, "func platformExtraKPIs")
	if i < 0 {
		t.Fatal("platformExtraKPIs is gone")
	}
	seg := body[i:]
	if e := strings.Index(seg, "\nfunc "); e > 0 {
		seg = seg[:e]
	}
	if !strings.Contains(seg, "tableHasAutoClaims") {
		t.Error("platformExtraKPIs does not test for the YouTube table, so the claim " +
			"tiles are never offered and the figures are computed but never drawn")
	}
	if !strings.Contains(seg, "autoClaimKPIs") {
		t.Error("platformExtraKPIs does not add autoClaimKPIs — the one list that " +
			"turns those figures into cards")
	}
}

/*
The cards are offered only where there is something to show.

Two gates, and they fail in opposite directions if either is dropped:

	· not the YouTube table — every other section grows two cards about a
	  platform it does not read
	· client has no claims — eight of eighty-nine do, so the other eighty-one
	  get two permanently empty cards. An offered tile is DRAWN whatever the
	  figures say; an absent value renders as an em dash rather than hiding the
	  card, deliberately, so the layout is the only thing that can decide not to
	  show it.

The client gate needs the service and is exercised against real data rather than
here. The table gate is pure, and it is checked first — so this also proves the
service is never asked about a section that could not use the answer.
*/
func TestClaimTilesAreNotOfferedOffTheYouTubeSection(t *testing.T) {
	base := []string{"views", "viewsSaved"}

	for _, tbl := range []string{
		"dashboards.Agg_Daily_Telegram_MasterNew",
		"dashboards.SocialMediaDashboard",
		"dashboards.UnifiedMobileAppsDashboardTable",
	} {
		specs := []reportSpec{{Table: tbl}}
		got := withAutoClaimTiles(context.Background(), append([]string{}, base...), specs, "any-client")
		if len(got) != len(base) {
			t.Errorf("%s was given the claim tiles (%v) — they describe a platform it "+
				"does not read", tbl, got)
		}
	}

	// And with no client at all, nothing is added even on the right table:
	// clientHasAutoClaims answers false for an empty id rather than asking.
	specs := []reportSpec{{Table: youtubeMainTable}}
	got := withAutoClaimTiles(context.Background(), append([]string{}, base...), specs, "")
	if len(got) != len(base) {
		t.Errorf("tiles were offered with no client scope: %v", got)
	}
}

/*
And ReportsSections must actually call it.

This is the linkage that puts the cards on the page. platformExtraKPIs feeds the
layout EDITOR; the list a reader's report is drawn from is built separately in
ReportsSections, and a metric added only to the first is arranged by admins and
never rendered. That was the state of this feature twice.
*/
func TestReportsSectionsOffersTheClaimTiles(t *testing.T) {
	src, err := os.ReadFile("reportsrun.go")
	if err != nil {
		t.Fatalf("read reportsrun.go: %v", err)
	}
	body := string(src)

	i := strings.Index(body, "func ReportsSections")
	if i < 0 {
		t.Fatal("ReportsSections is gone")
	}
	seg := body[i:]
	if e := strings.Index(seg, "\nfunc "); e > 0 {
		seg = seg[:e]
	}
	if !strings.Contains(seg, "withAutoClaimTiles") {
		t.Error("ReportsSections does not call withAutoClaimTiles, so the tile list " +
			"the page draws from never gains the claim cards — the figures are " +
			"computed, labelled, and invisible")
	}
	/* It must narrow `extras`, the list handed to kpiTilesFor below it. Applied
	   to anything else it would be computed and discarded. */
	if !strings.Contains(seg, "extras = withAutoClaimTiles(") {
		t.Error("withAutoClaimTiles is called but its result is not assigned back to " +
			"extras, which is the list kpiTilesFor and sectionPanels are given")
	}
}

/*
An empty window must not touch the section's own figures.

The gate above decides whether the CARDS appear; this decides whether anything
else moves. Without it a client whose window holds no claims still has its asset
and channel counts REPLACED by unions of the same lists — and the channel union
is keyed on the address, which drops a channel the hash-based count includes. So
Channels would fall from 4,980 to 4,979 on a report with nothing to combine, for
a reason no reader could ever discover.

Read from source because the bail sits inside a function that needs the service;
what it must contain does not.
*/
func TestAnEmptyClaimWindowTouchesNothing(t *testing.T) {
	src, err := os.ReadFile("ytautoclaim.go")
	if err != nil {
		t.Fatalf("read ytautoclaim.go: %v", err)
	}
	body := string(src)

	i := strings.Index(body, "func autoClaimCombine")
	if i < 0 {
		t.Fatal("autoClaimCombine is gone")
	}
	seg := body[i:]
	if e := strings.Index(seg, "\nfunc "); e > 0 {
		seg = seg[:e]
	}
	if !strings.Contains(seg, `numOf(sum["rowCount"]) == 0`) {
		t.Error("autoClaimCombine does not bail on an empty window — a client with no " +
			"claims in range has its asset and channel counts replaced by unions of " +
			"the same data, which is not a no-op: the channel union is keyed on the " +
			"address and drops channels the hash count includes")
	}
	/* And the bail must come BEFORE the breakdowns, or eighty-one of
	   eighty-nine clients pay for four full-cardinality scans per report load
	   whose every answer is discarded. */
	bail := strings.Index(seg, `numOf(sum["rowCount"]) == 0`)
	work := strings.Index(seg, "BreakdownFull")
	if bail > 0 && work > 0 && bail > work {
		t.Error("the empty-window bail runs AFTER the union queries, so the work is " +
			"done and thrown away for every client with no claims")
	}
}

/*
The removal rate is a share of what COULD be removed.

Set in the spec result, it never survives: the per-platform merge drops
removalPct on purpose — it is derived, not additive — and recomputes it from the
merged totals. So holding the rate to manual claims has to happen at that
recompute, and the first attempt, which set it upstream, had no effect at all.
DAZN's YouTube enforcement showed as 16.51% where it is 95.42%.
*/
func TestTheRateIsHeldToManualClaimsAtTheRecompute(t *testing.T) {
	src, err := os.ReadFile("reportplatforms.go")
	if err != nil {
		t.Fatalf("read reportplatforms.go: %v", err)
	}
	body := string(src)

	i := strings.Index(body, `kpiOut["removalPct"] = roundTo(pct, 2)`)
	if i < 0 {
		t.Fatal("the post-merge rate computation is gone")
	}
	// The 900 bytes before it: where the denominator is chosen.
	from := i - 900
	if from < 0 {
		from = 0
	}
	seg := body[from:i]

	if !strings.Contains(seg, `kpi["manualClaims"]`) {
		t.Error("the rate is computed from the identified total with no regard for " +
			"manualClaims — on YouTube that divides removals by the automatic claims " +
			"too, and an automatic claim has no removal to be a share of. The figure " +
			"then falls every time Content ID does its job better.")
	}
	/* And only where the distinction exists. Every other report has no
	   manualClaims, so the denominator must stay the identified figure. */
	if !strings.Contains(seg, "base := ident") {
		t.Error("the denominator does not default to the identified figure, so every " +
			"report without manual claims loses its rate")
	}
}
