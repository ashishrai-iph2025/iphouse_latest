package handlers

import "testing"

/*
A two-sided report shows its two sides — as tiles, and on one axis.

Open Web is two halves: the pages that LINK to infringing content and the ones
that HOST it. runPlatform has assembled six per-side figures from roleKPI since
the per-side trends were built — identification, distinct websites and distinct
pirate brands, each split by side — and none of them had ever been drawn.

── THE TWO LISTS ───────────────────────────────────────────────────────────

platformExtraKPIs is the layout EDITOR's list: what an admin may place. The list
a reader's page renders is built separately in ReportsSections, out of each
spec's ExtraKPI — and these six are not ExtraKPI entries, because no spec
computes them. A metric in the first list and not the second is offered to an
admin arranging panels and never rendered for anybody.

That is the third feature to go missing this way (the YouTube claim tiles were
the first, the per-side tiles the second), which is why the test below asserts
the RELATIONSHIP between the two lists rather than the contents of either.
*/

func twoSided() platformDef {
	return platformDef{
		Key: "open-web", Label: "Open Web", Enabled: true,
		Tables: []string{
			"dashboards.InternetInfringingURLMainDashboardTable",
			"dashboards.InternetSourceURLMainDashboardTable",
		},
	}
}

func TestPerSideTilesReachThePageAndNotOnlyTheEditor(t *testing.T) {
	/* Built from the role list directly rather than from a warehouse shape:
	   withPerSideTiles asks rolesForPlatform, which resolves through
	   specsForPlatform and needs the warehouse. What this pins is the rule it
	   applies once it has an answer. */
	got := withPerSideTiles([]string{"totalDomains", "totalAssets"}, twoSided())

	have := map[string]bool{}
	for _, k := range got {
		have[k] = true
	}
	/* Nothing is asserted about the six when the platform has no roles — that is
	   the next test. Here the platform either resolved two sides, in which case
	   all six must be present, or resolved none, in which case none may be. A
	   PARTIAL answer is the failure: it would mean the list is being filtered by
	   something other than the two-sided guard. */
	n := 0
	for _, k := range perSideKPIs {
		if have[k] {
			n++
		}
	}
	if n != 0 && n != len(perSideKPIs) {
		t.Fatalf("withPerSideTiles added %d of %d per-side tiles — all or none", n, len(perSideKPIs))
	}

	// The figures the reader actually asked for are in that set, under the names
	// runPlatform publishes them by.
	for _, k := range []string{"linkingDomains", "hostDomains"} {
		found := false
		for _, s := range perSideKPIs {
			if s == k {
				found = true
			}
		}
		if !found {
			t.Errorf("%q is not in perSideKPIs, so no page can draw it", k)
		}
	}

	// What was already there is kept, and nothing is duplicated.
	for _, k := range []string{"totalDomains", "totalAssets"} {
		if !have[k] {
			t.Errorf("withPerSideTiles dropped the existing tile %q", k)
		}
	}
	seen := map[string]int{}
	for _, k := range got {
		seen[k]++
		if seen[k] > 1 {
			t.Errorf("%q appears twice — the band would draw it twice", k)
		}
	}
}

/*
One side gets none of them.

Each of these is the headline figure under a second name on a single-sided
report, and a band reading "Total Infringements 812,400" beside "Total Linking
Identification 812,400" invites a reader to hunt for a difference that is not
there. Same guard as runPlatform and platformExtraKPIs, which is the point: the
three decide the same thing and must decide it identically.
*/
func TestASingleSidedPlatformGetsNoPerSideTiles(t *testing.T) {
	one := platformDef{
		Key: "youtube", Label: "YouTube", Enabled: true,
		Tables: []string{"dashboards.Agg_Daily_Youtube_MasterNew"},
	}
	got := withPerSideTiles([]string{"views"}, one)
	for _, k := range got {
		for _, s := range perSideKPIs {
			if k == s {
				t.Errorf("a single-sided platform was offered %q", k)
			}
		}
	}
	if len(got) != 1 || got[0] != "views" {
		t.Errorf("a single-sided platform's tiles were altered: %v", got)
	}
}

/*
── The combined monthly card ───────────────────────────────────────────────

Its own panel KIND, not a third panelTrend. A trend card draws one source's two
series; this draws both sources on one axis, which is a different chart and
would otherwise need a `role` naming two roles.

Offered only where there are two sides, for the same reason as the tiles above:
with one side it is the card above it, drawn again.
*/
func TestTheCombinedMonthlyCardIsOfferedOnlyOnATwoSidedReport(t *testing.T) {
	both := defaultPanels("open-web", nil, []string{"linking", "host"}, nil, nil, nil, false, false)
	found := false
	for _, p := range both {
		if p.Kind == panelTrendSplit {
			found = true
			if p.Key != keyTrendSplit {
				t.Errorf("the combined card has key %q, want %q", p.Key, keyTrendSplit)
			}
			if p.Span != spanFull {
				t.Errorf("the combined card is %q wide; four series need the full row", p.Span)
			}
			if p.Label == "" || p.DefaultDesc == "" {
				t.Error("the combined card has no name or no ⓘ note")
			}
		}
	}
	if !found {
		t.Error("a two-sided report has no combined monthly card")
	}

	one := defaultPanels("youtube", nil, []string{"linking"}, nil, nil, nil, false, false)
	for _, p := range one {
		if p.Kind == panelTrendSplit {
			t.Error("a single-sided report was given the combined card, which would " +
				"draw the same chart as the trend above it")
		}
	}
}

/*
And it is named the same on both screens.

panelName is what Report Configuration lists a card as; the label defaultPanels
put on it is what the report titles it. A card listed under one name and drawn
under another leaves an admin nothing to match the two by — the exact fault the
trend cards' own comment records having had.
*/
func TestTheCombinedCardIsNamedTheSameWhenArrangedAsWhenRead(t *testing.T) {
	for _, p := range defaultPanels("open-web", nil, []string{"linking", "host"}, nil, nil, nil, false, false) {
		if p.Kind != panelTrendSplit {
			continue
		}
		if got := panelName(p); got != p.Label {
			t.Errorf("Report Configuration calls it %q, the report calls it %q", got, p.Label)
		}
		if got := defaultPanelDesc(p); got == "" {
			t.Error("the combined card falls through defaultPanelDesc with no note")
		}
	}
}
