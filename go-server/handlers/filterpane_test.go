package handlers

// The filter pane — the slicers down the right of a report — is configuration
// now rather than derivation. These pin the two things that has to keep true.
//
// First, the DEFAULT. An install where nobody has opened Report Configuration
// must get the pane it always had, or upgrading the server quietly changes every
// report on it. The old rule was: a slicer appears unless its breakdown was
// hidden, and turnaround and keyword never appear at all.
//
// Second, the NAMES. A slicer with no label reads as its query parameter —
// "franchiseName" in a dropdown a client is looking at — and the configuration
// screen offers a row nobody can identify.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The default pane, for a platform whose every breakdown is still on the page.
func TestDefaultFilterVisibleFollowsPanels(t *testing.T) {
	// A breakdown-backed slicer whose panel survived is in the pane.
	shown := map[string]bool{"country": true}
	if !defaultFilterVisible("country", shown) {
		t.Error("country has a visible byCountry panel, so its slicer belongs in the pane")
	}
	// The same slicer once the panel is hidden is not — a control whose only
	// visible effect is to empty the page.
	if defaultFilterVisible("country", map[string]bool{}) {
		t.Error("byCountry is hidden, so the Country slicer should follow it out by default")
	}
	/* A parameter no dimension names cannot be hidden by a layout, so nothing
	   should hide it here either. Every parameter the engine knows about happens
	   to have a panel today, so this is asserted against one that does not
	   exist — the branch guards the case where a spec gains a filter before the
	   registry gains the breakdown for it, and that slicer must not vanish. */
	if !defaultFilterVisible("noSuchDimension", map[string]bool{}) {
		t.Error("a parameter with no breakdown has nothing to follow out of the report, " +
			"so hiding charts must not take its slicer away")
	}
	// Read off their own panel, so no dropdown unless one is asked for.
	for _, param := range []string{"tatBucket", "keyword"} {
		if defaultFilterVisible(param, map[string]bool{param: true}) {
			t.Errorf("%s is picked by clicking its own panel; it gets no dropdown by default", param)
		}
	}
}

// Every slicer the engine understands has a name to be arranged under.
func TestFilterParamsAreLabelled(t *testing.T) {
	for _, param := range knownFilterParams {
		if filterParamLabels[param] == "" {
			t.Errorf("slicer %q has no label — Report Configuration would list it by "+
				"its query parameter, and so would the report", param)
		}
	}
}

/*
The page's own copies.

app/admin/reports/page.tsx carries FILTER_LABELS, which names the slicers a
reader sees, and PANEL_ONLY_FILTERS, which is the fallback for a server too old
to send the pane. Both say they mirror this file. This is that claim, enforced.
*/
func TestPageFilterLabelsMirrorServer(t *testing.T) {
	path := filepath.Join("..", "..", "app", "admin", "reports", "page.tsx")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("cannot read %s: %v", path, err)
	}
	src := string(raw)

	start := strings.Index(src, "const FILTER_LABELS")
	if start < 0 {
		t.Skip("FILTER_LABELS is no longer declared in the reports page")
	}
	end := strings.Index(src[start:], "\n}")
	if end < 0 {
		t.Fatal("FILTER_LABELS is not closed")
	}
	block := src[start : start+end]
	for _, param := range knownFilterParams {
		if !strings.Contains(block, param+": '"+filterParamLabels[param]+"'") {
			t.Errorf("the reports page does not label %q as %q — the pane and the report "+
				"would call the same slicer two different things",
				param, filterParamLabels[param])
		}
	}

	// The two the pane leaves out by default, and the page's fallback for them.
	for param := range panelOnlyFilters {
		if !strings.Contains(src, "PANEL_ONLY_FILTERS = new Set([") {
			t.Fatal("PANEL_ONLY_FILTERS is no longer declared in the reports page")
		}
		if !strings.Contains(src, "'"+param+"'") {
			t.Errorf("%q is off by default here but not in the page's fallback set, so a "+
				"page talking to an older server would draw a slicer this one does not", param)
		}
	}
}
