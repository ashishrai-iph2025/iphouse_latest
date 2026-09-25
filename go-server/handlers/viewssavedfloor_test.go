package handlers

import (
	"strings"
	"testing"
)

/*
Total Views Saved is never negative, and Social & UGC has the tile at all.

The report showed a client -1.1 billion views saved beside 43.5 billion views,
on YouTube, on a card that is read as the value enforcement returned to them.
The figure is ten per cent of "what this content was assumed to be worth, less
what it had already taken", and nothing in that subtraction stops it going the
other way for content that out-earned the rate set for its genre.

These pin both halves of the fix: every expression that produces the figure
floors it per row, the assembled figure is floored again on the way out, and
the one report that never had the tile now declares it.
*/

func TestEveryViewsSavedExpressionFloorsTheRow(t *testing.T) {
	for key, s := range reportSpecs {
		expr, ok := s.ExtraKPI["viewsSaved"]
		if !ok {
			continue
		}
		if !strings.Contains(expr, "GREATEST(") {
			t.Errorf("spec %q sums views saved unfloored, so one over-performing "+
				"row cancels the rows that did save views:\n  %s", key, expr)
		}
	}
	/* The candidates are the ones that matter most: the static specs above only
	   seed the sidebar, while these are what inferSpec actually attaches to a
	   configured platform's table — which is the path the VOD report runs on. */
	seen := 0
	for _, c := range extraKPICandidates {
		if c.Key != "viewsSaved" {
			continue
		}
		seen++
		if !strings.Contains(c.Expr, "GREATEST(") {
			t.Errorf("the %s candidate sums views saved unfloored:\n  %s",
				c.NeedsCol, c.Expr)
		}
	}
	/* Two spellings of the column, and both have to be here: ViewsSaved on the
	   YouTube and Telegram rollups, TotalViewsSaved on the social dashboard.
	   Losing the second is how Social & UGC came to show Views with no Views
	   Saved beside it. */
	if seen != 2 {
		t.Fatalf("expected a views-saved candidate for each spelling of the column, found %d", seen)
	}
}

/*
Social & UGC declares the tile.

Its warehouse table spells the column TotalViewsSaved where YouTube and Telegram
spell it ViewsSaved, and the spec was written against the other spelling — so the
section published Views and nothing beside it, while both its neighbours had the
pair. A missing tile reads as "this platform saves no views", which is a stronger
claim than the report was making.
*/
func TestSocialDeclaresViewsSaved(t *testing.T) {
	s, ok := specFor("social")
	if !ok {
		t.Fatal("the social spec is gone")
	}
	expr, ok := s.ExtraKPI["viewsSaved"]
	if !ok {
		t.Fatal("Social & UGC publishes no Views Saved tile")
	}
	if !strings.Contains(expr, "TotalViewsSaved") {
		t.Errorf("social reads views saved from the wrong column — its table "+
			"spells it TotalViewsSaved:\n  %s", expr)
	}
}

/*
The floor on the assembled figure.

This is the one that survives a version skew — a portal talking to a reports_api
that still sums the raw column — so it is tested on the map rather than only on
the SQL.
*/
func TestFloorViewsSavedClampsWithoutInventingATile(t *testing.T) {
	kpi := map[string]any{"viewsSaved": int64(-1_100_000_000), "views": int64(43_500_000_000)}
	floorViewsSaved(kpi)
	if got := numOf(kpi["viewsSaved"]); got != 0 {
		t.Errorf("a negative views-saved figure reached the tile: %d", got)
	}
	if got := numOf(kpi["views"]); got != 43_500_000_000 {
		t.Errorf("the floor touched a figure that is not its business: %d", got)
	}

	// A positive figure is passed through untouched — the floor is a floor, not
	// a rewrite.
	kpi = map[string]any{"viewsSaved": int64(2_400_000)}
	floorViewsSaved(kpi)
	if got := numOf(kpi["viewsSaved"]); got != 2_400_000 {
		t.Errorf("the floor altered a figure that was already positive: %d", got)
	}

	/* AND IT DOES NOT CREATE THE KEY. A section with no Views Saved tile must
	   not gain one reading zero: absent and zero say different things, and the
	   layout already distinguishes them — an absent figure renders as an em
	   dash, a zero as a claim that nothing was saved. */
	kpi = map[string]any{"views": int64(10)}
	floorViewsSaved(kpi)
	if _, ok := kpi["viewsSaved"]; ok {
		t.Error("the floor invented a Views Saved tile for a section that has none")
	}

	floorViewsSaved(nil) // must not panic
}
