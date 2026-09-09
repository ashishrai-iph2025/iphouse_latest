package handlers

import "testing"

func labelsOf(rows []map[string]any) []string {
	out := make([]string, len(rows))
	for i, r := range rows {
		out[i] = strFromAny(r["label"])
	}
	return out
}

func rowsOf(labels ...string) []map[string]any {
	out := make([]map[string]any, 0, len(labels))
	for _, l := range labels {
		out = append(out, map[string]any{"label": l, "urls": int64(1)})
	}
	return out
}

func sameOrder(t *testing.T, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("got %d rows, want %d: %v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("order = %v, want %v", got, want)
			return
		}
	}
}

/*
The minute-scale buckets, which are the reason this exists.

Sorted as strings these come out 0-15min, 1hr-2hr, 15-30min, 2hr+, 30min-1hr —
every neighbour wrong, on a panel drawn as an ordered ramp whose shading asserts
the sequence.
*/
func TestMinuteBucketsOrderByDuration(t *testing.T) {
	rows := rowsOf("2hr+", "15-30min", "0-15min", "1hr-2hr", "30min-1hr")
	sortTATRows(rows)
	sameOrder(t, labelsOf(rows), []string{"0-15min", "15-30min", "30min-1hr", "1hr-2hr", "2hr+"})
}

// The same buckets however the upstream spaces and spells them. This parses
// somebody else's column, and a label that gains a space must not silently
// re-order the panel.
func TestSpellingDoesNotChangeTheOrder(t *testing.T) {
	for _, labels := range [][]string{
		{"2 hr+", "15 - 30 min", "0-15 min", "1 hr - 2 hr", "30 min - 1 hr"},
		{"2 hours+", "15 to 30 minutes", "0 to 15 minutes", "1 hour to 2 hours", "30 minutes to 1 hour"},
	} {
		rows := rowsOf(labels...)
		sortTATRows(rows)
		got := labelsOf(rows)
		if got[0] != labels[2] || got[len(got)-1] != labels[0] {
			t.Errorf("for %v the order came out %v — shortest should lead, longest should trail", labels, got)
		}
	}
}

/*
"Pending" is not zero minutes.

A row still waiting has the longest turnaround there is. Sorting it first would
put the worst outcome at the head of a ramp that reads best-to-worst, which is
the opposite of what the panel is saying.
*/
func TestNonDurationsTrail(t *testing.T) {
	rows := rowsOf("Pending", "0-15min", "(none)", "1hr-2hr")
	sortTATRows(rows)
	got := labelsOf(rows)
	sameOrder(t, got[:2], []string{"0-15min", "1hr-2hr"})
	// The two unmeasured values keep the order they arrived in.
	sameOrder(t, got[2:], []string{"Pending", "(none)"})
}

// The day-scale buckets in the warehouse today must keep working — this change
// is meant to be invisible until the buckets themselves change.
func TestDayBucketsStillOrder(t *testing.T) {
	rows := rowsOf("Pending", "20-40 days", "0-20 days")
	sortTATRows(rows)
	sameOrder(t, labelsOf(rows), []string{"0-20 days", "20-40 days", "Pending"})
}

// Minutes, hours and days on one panel compare on one scale — 90 min is after
// 1hr and before 2 days, not sorted among the other numbers beginning with 9.
func TestUnitsCompareOnOneScale(t *testing.T) {
	rows := rowsOf("2 days", "90 min", "1hr-2hr", "30 sec")
	sortTATRows(rows)
	sameOrder(t, labelsOf(rows), []string{"30 sec", "1hr-2hr", "90 min", "2 days"})
}

func TestSortKeyRejectsWhatIsNotADuration(t *testing.T) {
	for _, s := range []string{"", "Pending", "(none)", "Unknown", "N/A"} {
		if _, ok := tatSortKey(s); ok {
			t.Errorf("%q was read as a duration", s)
		}
	}
	if k, ok := tatSortKey("1hr-2hr"); !ok || k != 60 {
		t.Errorf(`tatSortKey("1hr-2hr") = (%v, %v), want (60, true)`, k, ok)
	}
}

/*
── Folding somebody else's bands into ours ───────────────────────────────────

	Every label below was on ONE client's sports summary at once, because each
	platform's table had been banded by a different hand and the summary merged
	the spellings verbatim. Ten rows, four of them the same two bands said
	differently, and "Pending" in among them.
*/
func TestFoldPlacesEveryStoredSpelling(t *testing.T) {
	cases := map[string]string{
		// The five we emit ourselves come back as themselves.
		"0-15 min":    "0-15 min",
		"15-30 min":   "15-30 min",
		"30 min-1 hr": "30 min-1 hr",
		"1-2 hr":      "1-2 hr",
		"2 hr+":       "2 hr+",

		// And the spellings the warehouse holds.
		"00 - 30min":      "15-30 min", // spans two bands — placed by its upper edge
		"30min - 1hr":     "30 min-1 hr",
		"1hr - 2hr":       "1-2 hr",
		"2 hrs and above": "2 hr+",
		"0-15min":         "0-15 min",
		"15-30min":        "15-30 min",
		"45 min":          "30 min-1 hr", // one value, not a range
		"1 hr 30 min":     "1-2 hr",      // one duration in two units, not a range
		"0-20 days":       "2 hr+",       // the takedown flow's own banding
		"20-40 days":      "2 hr+",
	}
	for label, want := range cases {
		i := tatBandFor(label)
		if i < 0 {
			t.Errorf("%q was not read as a duration at all", label)
			continue
		}
		if got := sportsTATBands[i].label; got != want {
			t.Errorf("%q folded to %q, want %q", label, got, want)
		}
	}
}

// What is not a duration is not a band. The panel says it covers the URLs that
// have come down; a row still waiting has not.
func TestFoldDropsWhatIsNotADuration(t *testing.T) {
	for _, s := range []string{"", "  ", "Pending", "(none)", "Unknown", "N/A", "In progress"} {
		if i := tatBandFor(s); i >= 0 {
			t.Errorf("%q was folded into %q", s, sportsTATBands[i].label)
		}
	}
}

/*
The whole panel, folded: ten rows in, five out, in order, with the counts of the
merged spellings added together and Pending gone.

The numbers are the ones off the screenshot this was raised from.
*/
func TestFoldTATRowsRebuildsThePanel(t *testing.T) {
	in := []map[string]any{
		{"label": "00 - 30min", "urls": int64(1011), "removed": int64(1010)},
		{"label": "Pending", "urls": int64(657), "removed": int64(0)},
		{"label": "1hr - 2hr", "urls": int64(157), "removed": int64(150)},
		{"label": "2 hr+", "urls": int64(22), "removed": int64(22)},
		{"label": "2 hrs and above", "urls": int64(12), "removed": int64(2)},
		{"label": "30min - 1hr", "urls": int64(4), "removed": int64(2)},
		{"label": "1-2 hr", "urls": int64(3), "removed": int64(3)},
		{"label": "30 min-1 hr", "urls": int64(3), "removed": int64(3)},
		{"label": "15-30 min", "urls": int64(1), "removed": int64(1)},
		{"label": "0-15 min", "urls": int64(1), "removed": int64(1)},
	}
	out := foldTATRows(in)

	sameOrder(t, labelsOf(out), []string{"0-15 min", "15-30 min", "30 min-1 hr", "1-2 hr", "2 hr+"})

	want := map[string][2]int64{
		"0-15 min":    {1, 1},
		"15-30 min":   {1012, 1011}, // "00 - 30min" + "15-30 min"
		"30 min-1 hr": {7, 5},       // "30min - 1hr" + "30 min-1 hr"
		"1-2 hr":      {160, 153},   // "1hr - 2hr" + "1-2 hr"
		"2 hr+":       {34, 24},     // "2 hr+" + "2 hrs and above"
	}
	for _, r := range out {
		label := strFromAny(r["label"])
		w := want[label]
		if got := numOf(r["urls"]); got != w[0] {
			t.Errorf("%s identified = %d, want %d", label, got, w[0])
		}
		if got := numOf(r["removed"]); got != w[1] {
			t.Errorf("%s removed = %d, want %d", label, got, w[1])
		}
		if _, has := r["value"]; has {
			t.Errorf("%s carries a `value` — a computed band is not something a click can filter on", label)
		}
	}

	// 657 Pending, and not one of them in the panel.
	var total int64
	for _, r := range out {
		total += numOf(r["urls"])
	}
	if total != 1214 {
		t.Errorf("folded total = %d, want 1214 (1871 rows less the 657 pending)", total)
	}
}

/*
A column holding NOTHING but "Pending" leaves no panel at all.

This is the source-URL table on a live window — 4,676 rows, every one of them
Pending — and it is the case that put the last Pending row on the summary. The
fold used to decline here and let the raw row THROUGH, which is what put the
last Pending row on the summary. Now the Pending rows are dropped, every band
comes out empty, and an all-empty panel is no panel — see tatBandRows.
*/
func TestAllPendingLeavesNoPanel(t *testing.T) {
	in := []map[string]any{
		{"label": "Pending", "urls": int64(4676), "removed": int64(0)},
	}
	if out := foldTATRows(in); out != nil {
		t.Errorf("folded to %v, want nil — nothing came down, so nothing has a turnaround",
			labelsOf(out))
	}
}

/*
An EMPTY breakdown is the one case that still declines.

Nothing found is a different statement from nothing removed: the first is a
window with no rows, which the panel reports as "no data for this period"; the
second is five bands at zero. Drawing five zeroes over an empty window would
claim a measurement nobody took.
*/
func TestEmptyBreakdownStillDeclines(t *testing.T) {
	if got := foldTATRows(nil); got != nil {
		t.Errorf("folded to %v, want nil", labelsOf(got))
	}
	if got := foldTATRows([]map[string]any{}); got != nil {
		t.Errorf("folded to %v, want nil", labelsOf(got))
	}
}

/*
The summary's two halves of Open Web, added together.

The linking table bands normally and the source table holds only Pending — the
exact pair that produced the panel this was raised from. Merged, the answer is
the linking table's bands and no Pending row.
*/
func TestOpenWebHalvesMergeWithoutPending(t *testing.T) {
	linking := foldTATRows([]map[string]any{
		{"label": "00 - 30min", "urls": int64(7681), "removed": int64(7678)},
		{"label": "1hr - 2hr", "urls": int64(5532), "removed": int64(5517)},
		{"label": "Pending", "urls": int64(5071), "removed": int64(0)},
		{"label": "30min - 1hr", "urls": int64(3187), "removed": int64(3169)},
		{"label": "2 hrs and above", "urls": int64(466), "removed": int64(374)},
	})
	source := foldTATRows([]map[string]any{
		{"label": "Pending", "urls": int64(4676), "removed": int64(0)},
	})

	merged := map[string]int64{}
	for _, part := range [][]map[string]any{linking, source} {
		for _, r := range part {
			merged[strFromAny(r["label"])] += numOf(r["urls"])
		}
	}
	if _, has := merged["Pending"]; has {
		t.Fatal("Pending survived the merge")
	}
	if len(merged) != len(sportsTATBands) {
		t.Fatalf("merged to %d rows, want %d", len(merged), len(sportsTATBands))
	}
	for label, want := range map[string]int64{
		"0-15 min": 0, "15-30 min": 7681, "30 min-1 hr": 3187, "1-2 hr": 5532, "2 hr+": 466,
	} {
		if merged[label] != want {
			t.Errorf("%s = %d, want %d", label, merged[label], want)
		}
	}
}

// Every band is drawn even at zero: "nothing took over two hours" is a finding,
// and it is what lets the summary add two platforms together.
func TestFoldAlwaysDrawsEveryBand(t *testing.T) {
	out := foldTATRows(rowsOf("0-15 min"))
	if len(out) != len(sportsTATBands) {
		t.Fatalf("got %d bands, want %d: %v", len(out), len(sportsTATBands), labelsOf(out))
	}
}

// The measured path and the folded path agree on the bands, so a summary that
// merges a table with timestamps and one without is adding like to like.
func TestMeasuredAndFoldedAgreeOnTheBands(t *testing.T) {
	measured := bandTATRows([]map[string]any{
		{"found": "2026-08-01T10:00:00Z", "removed": "2026-08-01T10:05:00Z"},
	}, "found", "removed")
	folded := foldTATRows(rowsOf("0-15 min"))
	sameOrder(t, labelsOf(measured), labelsOf(folded))
}

// No Pending row from the measured path either — the two unmeasurable cases
// (never removed, removed before it was found) leave the panel entirely.
func TestMeasuredPathHasNoPendingRow(t *testing.T) {
	rows := []map[string]any{
		{"found": "2026-08-01T10:00:00Z", "removed": "2026-08-01T10:10:00Z"}, // 10 min
		{"found": "2026-08-01T10:00:00Z", "removed": ""},                     // still up
		{"found": "2026-08-01T10:00:00Z", "removed": "2026-08-01T09:00:00Z"}, // clock skew
	}
	out := bandTATRows(rows, "found", "removed")
	sameOrder(t, labelsOf(out), []string{"0-15 min", "15-30 min", "30 min-1 hr", "1-2 hr", "2 hr+"})
	var total int64
	for _, r := range out {
		total += numOf(r["urls"])
	}
	if total != 1 {
		t.Errorf("counted %d rows into bands, want 1 — the other two are not turnarounds", total)
	}
}

/*
The panel exactly as one client's Telegram report showed it: the five band
labels already correct, in VOLUME order, with Pending sitting third at 22%.

Worth its own case because it is the shape that looks like it needs no work —
every label is already one of ours, so a reader could reasonably conclude the
fold has nothing to do. It has two things to do: drop the Pending row, and put
the five back on their axis, which volume order had scrambled.
*/
func TestFoldDropsPendingFromAnAlreadyCanonicalPanel(t *testing.T) {
	in := []map[string]any{
		{"label": "15-30 min", "urls": int64(7689), "removed": int64(7685)},
		{"label": "1-2 hr", "urls": int64(5546), "removed": int64(5521)},
		{"label": "Pending", "urls": int64(4676), "removed": int64(0)},
		{"label": "30 min-1 hr", "urls": int64(3200), "removed": int64(3178)},
		{"label": "2 hr+", "urls": int64(568), "removed": int64(490)},
		{"label": "0-15 min", "urls": int64(5), "removed": int64(5)},
	}
	out := foldTATRows(in)

	sameOrder(t, labelsOf(out), []string{"0-15 min", "15-30 min", "30 min-1 hr", "1-2 hr", "2 hr+"})

	for _, r := range out {
		if strFromAny(r["label"]) == "Pending" {
			t.Fatal("Pending survived the fold")
		}
	}
	// The five real bands keep every one of their rows; only the 4,676 go.
	var total int64
	for _, r := range out {
		total += numOf(r["urls"])
	}
	if total != 17008 {
		t.Errorf("folded total = %d, want 17008 (21,684 less the 4,676 pending)", total)
	}
}

/*
And the same rows through sortTATRows alone, which is what a panel that somehow
reached the page unfolded would get.

Belt and braces on the ORDER specifically: the bands were being emitted by
volume, and the sorter is the only thing standing between that and a ramp whose
shading asserts a sequence its labels contradict.
*/
func TestSortPutsCanonicalBandsBackOnTheirAxis(t *testing.T) {
	rows := rowsOf("15-30 min", "1-2 hr", "30 min-1 hr", "2 hr+", "0-15 min")
	sortTATRows(rows)
	sameOrder(t, labelsOf(rows), []string{"0-15 min", "15-30 min", "30 min-1 hr", "1-2 hr", "2 hr+"})
}
