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
