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
