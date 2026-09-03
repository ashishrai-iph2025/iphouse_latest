package handlers

/*
"Titles in scope" must count titles, not the tables that happen to hold them.

The numbers below are the ones measured on DAZN with a SINGLE asset selected,
before the fix:

	Open Web              2   — SportsURLRawData + SportsSourceURLRawData
	Social Media & UGC    1   — one table, right by coincidence
	Summary               3   — 2 + 1

Every KPI on a report is additive except this one, so `kpi[k] += v` was the
obvious merge and the wrong one for a distinct count of a dimension the sources
share: the same title is enforced on every platform at once, so two tables each
reporting one asset are reporting the SAME asset.

It went unnoticed for so long because it is only visibly wrong when a filter is
applied. Unfiltered it inflated the catalogue by the table count, which nobody
can check by eye.
*/

import "testing"

// A platform merging its own tables: two sources, one shared asset.
func TestAPlatformDoesNotCountTablesAsAssets(t *testing.T) {
	kpi := map[string]int64{}
	// Two tables, each reporting the one selected asset and its own URL counts.
	for _, table := range []map[string]int64{
		{"totalAssets": 1, "identified": 3000, "removed": 1800},
		{"totalAssets": 1, "identified": 1081, "removed": 593},
	} {
		for k, v := range table {
			mergeKPI(kpi, k, v)
		}
	}

	if kpi["totalAssets"] != 1 {
		t.Errorf("totalAssets = %d, want 1 — two tables holding the same title "+
			"are one title, not two", kpi["totalAssets"])
	}
	// The additive ones must be untouched by the change.
	if kpi["identified"] != 4081 {
		t.Errorf("identified = %d, want 4081 — URL counts still add up", kpi["identified"])
	}
	if kpi["removed"] != 2393 {
		t.Errorf("removed = %d, want 2393", kpi["removed"])
	}
}

// Summary merging platforms, using the figures from the report that exposed it.
func TestSummaryDoesNotCountPlatformsAsAssets(t *testing.T) {
	kpi := map[string]int64{}
	for _, platform := range []map[string]int64{
		{"totalAssets": 1, "identified": 4081}, // Open Web, already merged
		{"totalAssets": 1, "identified": 48},   // Social Media & UGC
	} {
		for k, v := range platform {
			mergeKPI(kpi, k, v)
		}
	}
	if kpi["totalAssets"] != 1 {
		t.Errorf("Summary totalAssets = %d, want 1 (it showed 3)", kpi["totalAssets"])
	}
	if kpi["identified"] != 4129 {
		t.Errorf("identified = %d, want 4129", kpi["identified"])
	}
}

/*
Unfiltered, the merge is a MAX and not a sum: an under-report rather than a
multiplication. Two platforms covering 40 and 55 titles of one catalogue share
most of them, so 55 is the honest floor and 95 is simply wrong.
*/
func TestUnfilteredAssetsTakeTheLargestSource(t *testing.T) {
	kpi := map[string]int64{}
	for _, n := range []int64{40, 55, 12} {
		mergeKPI(kpi, "totalAssets", n)
	}
	if kpi["totalAssets"] != 55 {
		t.Errorf("totalAssets = %d, want 55 (the largest source, not the sum 107)",
			kpi["totalAssets"])
	}
}

// Places DO add up — a domain and a channel are never the same row, and the two
// open-web tables count different columns. This must not be swept up by the fix.
func TestPlacesStillAddUp(t *testing.T) {
	kpi := map[string]int64{}
	mergeKPI(kpi, "totalDomains", 60)
	mergeKPI(kpi, "totalDomains", 17)
	mergeKPI(kpi, "totalChannels", 12)
	if kpi["totalDomains"] != 77 {
		t.Errorf("totalDomains = %d, want 77 — websites still sum", kpi["totalDomains"])
	}
	if kpi["totalChannels"] != 12 {
		t.Errorf("totalChannels = %d, want 12", kpi["totalChannels"])
	}
}

func TestSelectedAssetCount(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want int64
	}{
		{"none", "", 0},
		{"blank", "   ", 0},
		{"one", "WTA-MONTERREY", 1},
		{"three", "a,b,c", 3},
		{"padded", " a , b ", 2},
		{"trailing comma", "a,b,", 2},
		// GUIDs, and two spellings of one id are one asset.
		{"same id twice", "A-1,a-1", 1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := selectedAssetCount(map[string]string{"assetId": c.in}); got != c.want {
				t.Errorf("selectedAssetCount(%q) = %d, want %d", c.in, got, c.want)
			}
		})
	}
}

/*
A named selection overrides the merged estimate, and does so ONLY where the tile
exists. A platform with no asset column has no such tile, and inventing one
because a filter was set would put a figure on a report that cannot measure it.
*/
func TestSelectionOverridesTheEstimate(t *testing.T) {
	kpi := map[string]int64{"totalAssets": 3, "identified": 4129}
	applyAssetScope(kpi, map[string]string{"assetId": "WTA-MONTERREY"})
	if kpi["totalAssets"] != 1 {
		t.Errorf("totalAssets = %d, want 1", kpi["totalAssets"])
	}
	if kpi["identified"] != 4129 {
		t.Errorf("applyAssetScope touched identified: %d", kpi["identified"])
	}

	// No filter: the merged value stands.
	kpi = map[string]int64{"totalAssets": 55}
	applyAssetScope(kpi, map[string]string{})
	if kpi["totalAssets"] != 55 {
		t.Errorf("an empty filter overwrote the merged count: %d", kpi["totalAssets"])
	}

	// No such tile: nothing is invented.
	kpi = map[string]int64{"identified": 10}
	applyAssetScope(kpi, map[string]string{"assetId": "A-1"})
	if _, has := kpi["totalAssets"]; has {
		t.Error("applyAssetScope created a totalAssets tile on a platform that has no asset column")
	}
}
