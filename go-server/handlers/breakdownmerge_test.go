package handlers

/*
A measure added to one breakdown merge must not go missing in the other.

A breakdown row is merged twice on the way to a reader: once across the tables
of one platform (reportplatforms.go), once across the platforms of the summary
(reportsummary.go). Both merges CONSTRUCT the row they emit from summed
measures rather than copying it forward, so a measure only one of them names is
silently gone by the time the page sees it.

That failure is quiet in the worst way. The panel renders, the labels are right,
the volumes are right, and one column reads 0 all the way down. Nothing logs,
nothing 500s, and the figure looks like a fact about the client rather than a
bug. It shipped exactly once: the mirror count on the combined root-domain card
was added to the summary merge and missed in the platform merge, so Open Web —
the one platform that reads two tables, and therefore the one that merges — put
0 mirrors on every brand.

The fix was to give the two merges one implementation. These tests hold them
there, from both ends: the fold's behaviour, and the fact that neither file has
grown its own copy of it again.
*/

import (
	"os"
	"strings"
	"testing"
)

// ── The fold ─────────────────────────────────────────────────────────────────

/*
Volumes and mirror counts ADD across the tables being merged.

A hostname is in exactly one of them — the linking table holds infringing
domains, the host table holds source domains — so the two sides are counting
different hostnames of the same brand and the sum is what the figure means.
*/
func TestVolumesAndMirrorsAddUp(t *testing.T) {
	got := map[string]int64{}
	accumulateBreakdown(got, map[string]any{"urls": 120, "removed": 90, "mirrors": 7})
	accumulateBreakdown(got, map[string]any{"urls": 30, "removed": 12, "mirrors": 4})

	for _, c := range []struct {
		key  string
		want int64
	}{{"urls", 150}, {"removed", 102}, {"mirrors", 11}} {
		if got[c.key] != c.want {
			t.Errorf("%s = %d, want %d", c.key, got[c.key], c.want)
		}
	}
}

/*
Recurrence is a DAY COUNT, so it takes the largest instead.

Two tables that both saw an account on the same Saturday saw it on one day, not
two. Summing them can hand the panel more days than the window holds, and the
card presents that number as a fact about the calendar.
*/
func TestRecurrenceTakesTheLargestRatherThanTheSum(t *testing.T) {
	got := map[string]int64{}
	accumulateBreakdown(got, map[string]any{"urls": 40, "repeats": 3})
	accumulateBreakdown(got, map[string]any{"urls": 25, "repeats": 5})
	accumulateBreakdown(got, map[string]any{"urls": 10, "repeats": 2})

	if got["repeats"] != 5 {
		t.Errorf("repeats = %d, want 5 — summing gives the impossible 10", got["repeats"])
	}
	if got["urls"] != 75 {
		t.Errorf("urls = %d, want 75: volumes still add", got["urls"])
	}
}

// A panel that never carried a measure must not gain a column of noughts from a
// map that defaulted one in. Only urls and removed are unconditional.
func TestAPanelWithoutTheseMeasuresDoesNotGrowThem(t *testing.T) {
	m := map[string]int64{}
	accumulateBreakdown(m, map[string]any{"urls": 9, "removed": 4})
	row := mergedBreakdownRow("acme.example", m, "")

	for _, k := range []string{"mirrors", "repeats", "value"} {
		if _, has := row[k]; has {
			t.Errorf("row carries %q (= %v) though nothing put one in", k, row[k])
		}
	}
	if row["label"] != "acme.example" || numOf(row["urls"]) != 9 || numOf(row["removed"]) != 4 {
		t.Errorf("the measures that are always carried came out wrong: %v", row)
	}
}

// And a panel that does carry them keeps them — the regression itself.
func TestTheMergedRowKeepsEveryMeasureItWasGiven(t *testing.T) {
	m := map[string]int64{}
	accumulateBreakdown(m, map[string]any{"urls": 131333, "removed": 128900, "mirrors": 28})
	row := mergedBreakdownRow("acme.example", m, "acme.example")

	if numOf(row["mirrors"]) != 28 {
		t.Errorf("mirrors = %v, want 28 — this is the 0-on-every-row bug", row["mirrors"])
	}
	// The raw grouping value a click filters on, carried only where there is one.
	if row["value"] != "acme.example" {
		t.Errorf("value = %v, want the grouping value", row["value"])
	}
}

// ── The two call sites ───────────────────────────────────────────────────────

/*
Neither merge may grow its own copy of the fold again.

Behavioural tests above cannot see a second merge that quietly stopped calling
the shared one — that is precisely how the two drifted apart the first time — so
this reads the source. The pattern it bans, breakdowns[key][label]["…"], is the
direct measure write both files used to do inline.
*/
func TestBothMergesUseTheOneFold(t *testing.T) {
	for _, file := range []string{"reportplatforms.go", "reportsummary.go"} {
		src, err := os.ReadFile(file)
		if err != nil {
			t.Fatalf("%s: %v", file, err)
		}
		s := string(src)

		for _, call := range []string{"accumulateBreakdown(breakdowns[key][label], row)", "mergedBreakdownRow(label, m,"} {
			if !strings.Contains(s, call) {
				t.Errorf("%s no longer calls %s — the two merges have come apart, "+
					"and a measure added to one will read 0 in the other", file, call)
			}
		}
		if i := strings.Index(s, `breakdowns[key][label]["`); i >= 0 {
			t.Errorf("%s writes a measure straight into the totals at byte %d. "+
				"Add it to accumulateBreakdown instead, so both merges get it.", file, i)
		}
	}
}
