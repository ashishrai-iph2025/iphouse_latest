package handlers

import "testing"

/*
Turnaround on the VOD reports.

Three shapes for one question, and each was wrong in its own way before this:

  · YouTube and Telegram store hour-scale buckets, folded into minute-scale
    sports bands, so every row landed in "2 hr+" — one bar under four
    permanently empty labels.
  · Social stores the bands as four COLUMNS and has no bucket to group by, so it
    had no Turnaround card at all.
  · "Pending" is not a turnaround and must appear in none of them.
*/

// The values the two VOD tables actually hold, measured on the warehouse.
var vodStoredBuckets = []string{
	"0-6 hours", "6-12 hours", "12-24 hours", "24 hours+", "Pending",
}

func tatRow(label string, urls, removed int64) map[string]any {
	return map[string]any{"label": label, "urls": urls, "removed": removed}
}

/*
EACH STORED BUCKET LANDS IN ITS OWN BAND.

Against the sports ruler all four hour-scale values collapse into "2 hr+",
because 6, 12 and 24 hours are each past its 120-minute edge. That is what the
panel was drawing.
*/
func TestTheVODBucketsEachGetTheirOwnBand(t *testing.T) {
	rows := []map[string]any{
		tatRow("0-6 hours", 10, 10),
		tatRow("6-12 hours", 20, 20),
		tatRow("12-24 hours", 30, 30),
		tatRow("24 hours+", 40, 40),
	}
	got := foldTATRowsInto(rows, vodTATBands)
	if len(got) != 4 {
		t.Fatalf("got %d bands, want 4", len(got))
	}
	want := []struct {
		label string
		urls  int64
	}{
		{"0-6 hours", 10}, {"6-12 hours", 20}, {"12-24 hours", 30}, {"24 hours+", 40},
	}
	for i, w := range want {
		if got[i]["label"] != w.label {
			t.Errorf("band %d is %q, want %q — the panel is an ordered ramp and the "+
				"shading asserts this sequence", i, got[i]["label"], w.label)
		}
		if n := numOf(got[i]["urls"]); n != w.urls {
			t.Errorf("%s holds %d, want %d", w.label, n, w.urls)
		}
	}

	// And the failure this replaced: the same rows on the sports ruler.
	old := foldTATRowsInto(rows, sportsTATBands)
	last := old[len(old)-1]
	if numOf(last["urls"]) != 100 {
		t.Errorf("the sports ruler put %d of 100 in its last band; if this is no "+
			"longer 100 the fold has changed and the VOD ruler may no longer be "+
			"needed for the reason stated", numOf(last["urls"]))
	}
}

// "Pending" is not a turnaround, on either ruler.
func TestPendingIsNeverABand(t *testing.T) {
	for _, bands := range [][]tatBand{vodTATBands, sportsTATBands} {
		for _, b := range bands {
			if b.label == "Pending" {
				t.Errorf("%q is declared as a band; a row still waiting has not come "+
					"down and has no turnaround", b.label)
			}
		}
	}
	rows := []map[string]any{
		tatRow("0-6 hours", 5, 5),
		tatRow("Pending", 9999, 0),
	}
	got := foldTATRowsInto(rows, vodTATBands)
	var total int64
	for _, r := range got {
		if r["label"] == "Pending" {
			t.Error("a Pending band reached the panel")
		}
		total += numOf(r["urls"])
	}
	if total != 5 {
		t.Errorf("the bands hold %d, want 5 — Pending's 9,999 were folded in rather "+
			"than dropped", total)
	}
}

// Every stored value is either a band or deliberately dropped: nothing silently
// lands in the wrong one.
func TestEveryStoredVODValueIsPlacedOrDropped(t *testing.T) {
	for i, v := range vodStoredBuckets {
		idx := tatBandForIn(v, vodTATBands)
		if v == "Pending" {
			if idx >= 0 {
				t.Errorf("%q was placed in band %d", v, idx)
			}
			continue
		}
		if idx != i {
			t.Errorf("%q landed in band %d (%q), want %d", v, idx,
				vodTATBands[idx].label, i)
		}
	}
}

/*
The ruler is chosen per table, and only the two that need it get the new one.
*/
func TestOnlyTheHourScaleTablesUseTheVODRuler(t *testing.T) {
	for _, tbl := range []string{
		"dashboards.Agg_Daily_Youtube_MasterNew",
		"dashboards.Agg_Daily_Telegram_MasterNew",
	} {
		if got := tatBandsFor(tbl); len(got) != len(vodTATBands) || got[0].label != "0-6 hours" {
			t.Errorf("%s is not read with the VOD ruler", tbl)
		}
	}
	for _, tbl := range []string{
		"dashboards.SportsURLRawData",
		"dashboards.SportsSourceURLRawData",
		/* The Summary merges every platform and its stored column holds both
		   scales at once. It keeps the sports bands rather than gaining a third
		   answer — see vodTATBands' note. */
		"dashboards.Unified_BI_Dashboard",
	} {
		if got := tatBandsFor(tbl); got[0].label != "0-15 min" {
			t.Errorf("%s lost the sports ruler", tbl)
		}
	}
}

/*
Social's four columns become the same four bands.

There is no removed series of its own: every one of those columns counts
something that HAS come down, so identified and removed are the same number and
a second series would be a bar compared with itself.
*/
func TestSocialColumnsBecomeTheSameBands(t *testing.T) {
	sum := map[string]any{
		"tat0to6": int64(4), "tat6to12": int64(3),
		"tat12to24": int64(2), "tat24plus": int64(1),
	}
	got := columnTATRows(sum)
	if len(got) != 4 {
		t.Fatalf("got %d bands, want 4", len(got))
	}
	for i, w := range []struct {
		label string
		urls  int64
	}{{"0-6 hours", 4}, {"6-12 hours", 3}, {"12-24 hours", 2}, {"24 hours+", 1}} {
		if got[i]["label"] != w.label || numOf(got[i]["urls"]) != w.urls {
			t.Errorf("band %d is %v/%v, want %s/%d", i,
				got[i]["label"], got[i]["urls"], w.label, w.urls)
		}
	}

	// Nothing to draw: no card, rather than a ring with no arc.
	if columnTATRows(map[string]any{
		"tat0to6": int64(0), "tat6to12": int64(0),
		"tat12to24": int64(0), "tat24plus": int64(0),
	}) != nil {
		t.Error("an all-zero window still drew a panel")
	}
	// A summary that carries none of them is not a zero window, it is a table
	// that does not answer this question.
	if columnTATRows(map[string]any{"identified": int64(5)}) != nil {
		t.Error("a summary with no TAT measures still drew a panel")
	}
	if columnTATRows(nil) != nil {
		t.Error("a nil summary drew a panel")
	}
}

// Only Social takes the column road.
func TestOnlySocialReadsTurnaroundFromColumns(t *testing.T) {
	if !tableHasColumnTAT("dashboards.SocialMediaDashboard") {
		t.Error("Social records turnaround as columns and should take that road")
	}
	for _, tbl := range []string{
		"dashboards.Agg_Daily_Youtube_MasterNew",
		"dashboards.Unified_BI_Dashboard",
		"dashboards.SportsURLRawData",
	} {
		if tableHasColumnTAT(tbl) {
			t.Errorf("%s has a bucket to group by and must not read columns", tbl)
		}
	}
}

/*
The VOD labels sort as durations, not as strings.

"12-24 hours" and "24 hours+" both lead with a 24 once the parser reaches them,
so without the band's own lower edge their order is whatever built the list —
and the ramp's shading would assert a sequence its labels contradict.
*/
func TestVODBandsSortInDurationOrder(t *testing.T) {
	rows := []map[string]any{
		tatRow("24 hours+", 1, 1),
		tatRow("0-6 hours", 1, 1),
		tatRow("12-24 hours", 1, 1),
		tatRow("6-12 hours", 1, 1),
	}
	sortTATRows(rows)
	for i, want := range []string{"0-6 hours", "6-12 hours", "12-24 hours", "24 hours+"} {
		if rows[i]["label"] != want {
			t.Errorf("position %d is %q, want %q", i, rows[i]["label"], want)
		}
	}
}
