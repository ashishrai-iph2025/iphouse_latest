package handlers

// The two mappings that have to stay in step with the dimension registry, and
// the one that has to stay in step with the PAGE.
//
// Both failures are silent. A dimension whose slicer parameter is missing from
// knownFilterParams still draws its panel and still sets its filter — and every
// spec then runs UNFILTERED, because specHonoursFilters only refuses a spec for
// a parameter it knows about. The report shows a filter chip over totals that
// ignore it, which is the worst kind of wrong number: one that looks answered.
//
// A dimension missing from the page's DIM_FILTER is quieter still: the panel
// renders, and clicking a bar does nothing at all.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Every dimension that claims a slicer must be a slicer the report engine
// recognises.
func TestDimFilterParamsAreKnown(t *testing.T) {
	known := map[string]bool{}
	for _, p := range knownFilterParams {
		known[p] = true
	}
	for _, d := range dimensionCandidates {
		param := DIMFilterParam(d.Key)
		if param == "" {
			continue // panel-only dimension, nothing to filter
		}
		if !known[param] {
			t.Errorf("dimension %q filters on %q, which is not in knownFilterParams — "+
				"setting that slicer would leave every spec running unfiltered",
				d.Key, param)
		}
	}
}

/*
The sports dimensions, pinned to the columns the reports API exposes for them.

These two are not columns of any fact table: reports_api reads them off
mediascan.Asset and offers them on the four sports datasets (see
internal/api/assetattrs.go in that service). The names here are what the bridge
matches against that service's own column list, so a rename on either side
turns both panels into "No data." with nothing to say why.
*/
func TestSportsAssetDimensions(t *testing.T) {
	want := map[string]struct{ column, param string }{
		"byFranchise": {"FranchiseName", "franchiseName"},
		"byMatchDay":  {"MatchDay", "matchDay"},
	}
	for _, d := range dimensionCandidates {
		w, ok := want[d.Key]
		if !ok {
			continue
		}
		delete(want, d.Key)
		if d.Column != w.column {
			t.Errorf("%s groups by %q, want %q", d.Key, d.Column, w.column)
		}
		if got := DIMFilterParam(d.Key); got != w.param {
			t.Errorf("%s filters on %q, want %q — the bridge sends this to "+
				"reports_api as its dimension key", d.Key, got, w.param)
		}
		// A season's fixtures are a distribution, not a top-N: the merge must
		// keep every row rather than cutting to fifteen.
		if !closedSetDims[d.Key] {
			t.Errorf("%s is not in closedSetDims, so merging two tables would cut "+
				"it to the top 15 and leave holes in the season", d.Key)
		}
	}
	for k := range want {
		t.Errorf("dimension %q is not in the registry", k)
	}
}

/*
The page's own copy of the mapping.

app/admin/reports/page.tsx carries DIM_FILTER, which is what makes clicking a
bar cross-filter the rest of the page, and its comment says it mirrors
DIMFilterParam. This is that comment, enforced.
*/
func TestPageDimFilterMirrorsServer(t *testing.T) {
	path := filepath.Join("..", "..", "app", "admin", "reports", "page.tsx")
	src, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("cannot read %s: %v", path, err)
	}
	start := strings.Index(string(src), "const DIM_FILTER")
	if start < 0 {
		t.Skip("DIM_FILTER is no longer declared in the reports page")
	}
	end := strings.Index(string(src)[start:], "\n}")
	if end < 0 {
		t.Fatal("DIM_FILTER is not closed")
	}
	block := string(src)[start : start+end]

	for _, d := range dimensionCandidates {
		param := DIMFilterParam(d.Key)
		if param == "" {
			continue
		}
		if !strings.Contains(block, d.Key+": '"+param+"'") {
			t.Errorf("the reports page maps no %s → %q; clicking that panel would "+
				"cross-filter nothing", d.Key, param)
		}
	}
}

/*
Every visual on the reports page is clickable, the dated ones included.

The categorical panels always were — TestPageDimFilterMirrorsServer above is
what keeps them so. The DATED ones were not, and the gap was invisible in the
way that matters most: the chart draws, the tooltip follows the cursor, and the
click does nothing, which reads as a broken page rather than as a feature nobody
wired. A card's TABLE twin had the same hole, and worse — a reader switches to it
precisely because the chart clipped the row they were reaching for.

Read from source because the alternative is a browser. What is pinned is narrow
and structural: the call sites hand these components a pick. Whether the pick
then narrows the range is periodSpan's job, and it is checked by the arithmetic
in the page.
*/
func TestReportsPageVisualsAcceptAPick(t *testing.T) {
	src := reportsPageSource(t)

	// The dated charts, and every table twin. Each is a self-closing element, so
	// its own "/>" bounds the props that belong to it.
	for _, tag := range []string{"<Trend ", "<RateTrend ", "<DataTable "} {
		found := 0
		for i := 0; ; {
			at := strings.Index(src[i:], tag)
			if at < 0 {
				break
			}
			at += i
			end := strings.Index(src[at:], "/>")
			if end < 0 {
				t.Fatalf("%s at offset %d is never closed", tag, at)
			}
			el := src[at : at+end]
			if !strings.Contains(el, "onPick") {
				t.Errorf("a %s call site takes no onPick, so clicking it does nothing: %s",
					strings.TrimSpace(tag), strings.Join(strings.Fields(el), " "))
			}
			found++
			i = at + end
		}
		if found == 0 {
			t.Errorf("no %s call sites found — this test is no longer checking anything",
				strings.TrimSpace(tag))
		}
	}

	/* A click on a date has to know what range the mark stood for. toTrend draws
	   two grains — a day, and a month once the range passes 62 rows — and a
	   month that resolved to one day would silently show a thirtieth of what the
	   reader clicked. */
	if !strings.Contains(src, "function periodSpan(") {
		t.Error("periodSpan is gone; a dated click has nothing to turn a label into a range")
	}
	if !strings.Contains(src, "Date.UTC(y, mo, 0)") {
		t.Error("the month end is no longer computed from day 0 of the next month — " +
			"a hardcoded month length gets February wrong every fourth year")
	}
}

// The page, read once. Skipped rather than failed when it cannot be reached:
// the Go module is built and tested on its own in CI.
func reportsPageSource(t *testing.T) string {
	t.Helper()
	path := filepath.Join("..", "..", "app", "admin", "reports", "page.tsx")
	b, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("cannot read %s: %v", path, err)
	}
	return string(b)
}
