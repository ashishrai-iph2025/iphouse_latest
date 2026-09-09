package handlers

import "testing"

/*
The two timestamps have to be found before anything can be measured, and the
PAIR matters: a table with a discovery time and no removal time can say when
something happened but not how long it took.
*/
func TestTATTimeColsNeedsBothEnds(t *testing.T) {
	found, removed, ok := tatTimeCols([]string{
		"SourceId", "URLUploadDate", "DiscoveryDoneAt", "RemovalTime", "TATBucket",
	})
	if !ok || found != "DiscoveryDoneAt" || removed != "RemovalTime" {
		t.Fatalf("got (%q, %q, %v), want DiscoveryDoneAt/RemovalTime", found, removed, ok)
	}

	/* Open Web Sports: an upload DATE and a removal flag, no removal time.
	   Nothing can be measured, and saying so is what keeps the panel on its
	   stored column instead of drawing every row as Pending — which would read
	   as total enforcement failure rather than as an unanswerable question. */
	if _, _, ok := tatTimeCols([]string{
		"URLId", "URLUploadDate", "IsRemoved", "TATBucket",
	}); ok {
		t.Error("a table with no removal timestamp was accepted as measurable")
	}
}

/*
DiscoveryDoneAt beats URLUploadDate where both exist, and it is not cosmetic:
the upload column is a DATE, so every turnaround computed from it would be a
whole number of days. That is how this panel came to be in days.
*/
func TestDiscoveryTimeIsPreferredOverTheUploadDate(t *testing.T) {
	found, _, ok := tatTimeCols([]string{"URLUploadDate", "DiscoveryDoneAt", "RemovalTime"})
	if !ok || found != "DiscoveryDoneAt" {
		t.Errorf("found column = %q, want DiscoveryDoneAt", found)
	}
}

/*
The row from the live warehouse that started this: discovered 10:37:32, removed
11:22:02. Forty-four and a half minutes — and TATBucket filed it under
"0-20 days".
*/
func TestTheRowThatProvedThePanelWrong(t *testing.T) {
	row := map[string]any{
		"DiscoveryDoneAt": "2025-06-03T10:37:32Z",
		"RemovalTime":     "2025-06-03T11:22:02Z",
		"TATBucket":       "0-20 days",
	}
	mins, ok := tatMinutes(row, "DiscoveryDoneAt", "RemovalTime")
	if !ok {
		t.Fatal("a row with both timestamps was not measured")
	}
	if mins < 44 || mins > 45 {
		t.Fatalf("turnaround = %v min, want ~44.5", mins)
	}

	out := bandTATRows([]map[string]any{row}, "DiscoveryDoneAt", "RemovalTime")
	if strFromAny(out[2]["label"]) != "30 min-1 hr" || numOf(out[2]["urls"]) != 1 {
		t.Errorf("the row landed in %v/%v, want 30 min-1 hr", out[2]["label"], out[2]["urls"])
	}
}

// A boundary belongs to the band it closes: lo < minutes <= hi. Exactly 15
// minutes is "0-15 min". On scheduler-written data, round numbers are most of
// the rows, so getting this backwards moves most of them a band too far.
func TestBandBoundariesCloseAtTheTop(t *testing.T) {
	for _, tc := range []struct {
		removedAt string
		label     string
	}{
		{"2025-06-03T10:00:00Z", "0-15 min"},    // 0 min
		{"2025-06-03T10:15:00Z", "0-15 min"},    // exactly 15
		{"2025-06-03T10:15:01Z", "15-30 min"},   // a second past
		{"2025-06-03T10:30:00Z", "15-30 min"},   // exactly 30
		{"2025-06-03T11:00:00Z", "30 min-1 hr"}, // exactly 60
		{"2025-06-03T12:00:00Z", "1-2 hr"},      // exactly 120
		{"2025-06-03T12:00:01Z", "2 hr+"},
		{"2025-06-05T10:00:00Z", "2 hr+"}, // two days
	} {
		out := bandTATRows([]map[string]any{{
			"DiscoveryDoneAt": "2025-06-03T10:00:00Z", "RemovalTime": tc.removedAt,
		}}, "DiscoveryDoneAt", "RemovalTime")
		for _, r := range out {
			if numOf(r["urls"]) == 1 && strFromAny(r["label"]) != tc.label {
				t.Errorf("removed at %s landed in %q, want %q", tc.removedAt, r["label"], tc.label)
			}
		}
	}
}

/*
A row with no removal time is not in this panel at all.

It used to be, as a sixth "Pending" row, on the reasoning that a chart of only
the successes reports the fastest numbers the data can produce. Two things
overtook that:

  - the panel's own description says it covers the URLs that HAVE come down, so
    the row contradicted the card it was drawn on; and
  - only two of the eight sports tables carry a removal timestamp, so "Pending"
    appeared on those two and on none of the others. On the summary, which adds
    the platforms together, the pending figure was therefore a fact about which
    tables have a RemovalTime column rather than about enforcement.

What is outstanding is the removal-rate card's subject, and that card answers it
over the whole report instead of over one panel of it.
*/
func TestUnmeasurableRowsAreNotInThePanel(t *testing.T) {
	rows := []map[string]any{
		{"DiscoveryDoneAt": "2025-06-03T10:00:00Z", "RemovalTime": "2025-06-03T10:05:00Z"},
		{"DiscoveryDoneAt": "2025-06-03T10:00:00Z", "RemovalTime": ""},
		{"DiscoveryDoneAt": "2025-06-03T10:00:00Z", "RemovalTime": nil},
		{"DiscoveryDoneAt": "2025-06-03T10:00:00Z"},
	}
	out := bandTATRows(rows, "DiscoveryDoneAt", "RemovalTime")

	// The five bands and nothing else, on every platform, always.
	if len(out) != len(sportsTATBands) {
		t.Errorf("got %d rows, want exactly the %d bands", len(out), len(sportsTATBands))
	}
	for _, r := range out {
		if strFromAny(r["label"]) == "Pending" {
			t.Error("Pending is still a row on the turnaround panel")
		}
	}
	// A removed row counts as removed — every row in a measured band came down
	// by definition, which is what the panel's Identified/Removed pair means.
	if numOf(out[0]["urls"]) != 1 || numOf(out[0]["removed"]) != 1 {
		t.Errorf("first band = %v/%v, want 1/1", out[0]["urls"], out[0]["removed"])
	}
	// And the three unmeasurable rows went nowhere rather than into a band.
	var total int64
	for _, r := range out {
		total += numOf(r["urls"])
	}
	if total != 1 {
		t.Errorf("counted %d rows into bands, want 1", total)
	}
}

// Removed before it was found is a clock or a backfill upstream, not an instant
// takedown. Counting it in the fastest band would flatter the number, so it is
// not counted at all — the same treatment as a row that has not come down.
func TestRemovedBeforeFoundIsNotInstant(t *testing.T) {
	out := bandTATRows([]map[string]any{{
		"DiscoveryDoneAt": "2025-06-03T11:00:00Z", "RemovalTime": "2025-06-03T10:00:00Z",
	}}, "DiscoveryDoneAt", "RemovalTime")
	// The one row went nowhere, so every band is empty — and an all-empty
	// turnaround panel is no panel. See tatBandRows.
	if out != nil {
		t.Errorf("a negative turnaround produced %v", labelsOf(out))
	}
}

// The service returns RFC3339; a direct warehouse read gives a space-separated
// datetime. Both have to measure the same, or the same report differs by which
// backend served it.
func TestTimestampLayoutsAgree(t *testing.T) {
	a, okA := tatMinutes(map[string]any{
		"f": "2025-06-03T10:00:00Z", "r": "2025-06-03T10:20:00Z"}, "f", "r")
	b, okB := tatMinutes(map[string]any{
		"f": "2025-06-03 10:00:00", "r": "2025-06-03 10:20:00"}, "f", "r")
	if !okA || !okB || a != b || a != 20 {
		t.Errorf("RFC3339 gave %v (%v), plain datetime gave %v (%v); both should be 20", a, okA, b, okB)
	}
}

// The bands the calculation emits must survive the sorter unchanged, or the
// panel re-orders itself depending on which path built it.
func TestComputedBandsAreAlreadyInOrder(t *testing.T) {
	out := bandTATRows([]map[string]any{
		{"DiscoveryDoneAt": "2025-06-03T10:00:00Z", "RemovalTime": "2025-06-03T13:00:00Z"},
		{"DiscoveryDoneAt": "2025-06-03T10:00:00Z", "RemovalTime": "2025-06-03T10:01:00Z"},
		{"DiscoveryDoneAt": "2025-06-03T10:00:00Z"},
	}, "DiscoveryDoneAt", "RemovalTime")
	before := labelsOf(out)
	sortTATRows(out)
	sameOrder(t, labelsOf(out), before)
}
