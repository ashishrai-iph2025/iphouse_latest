package handlers

import "testing"

/*
The configurable top-N.

"Top 10 Linking Websites" is ten because the registry says ten. These pin the
two halves of making that a setting: which panels may be cut at all, and what
the card is then called.
*/

// A panel the registry already cuts is configurable; a closed list is not.
//
// The distinction is the whole safety property. A top-N over "identified per
// day" does not shorten a long tail — it drops days off the calendar, and the
// chart still looks like a chart.
func TestOnlyTopNPanelsTakeARowLimit(t *testing.T) {
	dims := []map[string]any{
		{"key": "byDomain", "label": "Top 10 Linking Websites", "limit": 10},
		{"key": "byAsset", "label": "Identification & Removal - Top 10 Assets", "limit": 10},
		// Closed lists: every value is the point of the panel.
		{"key": "byTAT", "label": "Turnaround", "limit": 0},
		{"key": "byNoticesByDay", "label": "Notices by day", "limit": 0},
	}
	// No stored layout: every configurable panel reports its registry number and
	// every closed list is absent entirely.
	got := resolveRowLimits(dims, nil)

	for _, k := range []string{"byDomain", "byAsset"} {
		if got[k] != 10 {
			t.Errorf("%s = %d, want the registry default of 10", k, got[k])
		}
	}
	for _, k := range []string{"byTAT", "byNoticesByDay"} {
		if n, present := got[k]; present {
			t.Errorf("%s was given a limit of %d — a closed list must not be cut", k, n)
		}
	}

	/* A stored row wins for the panel it names, and only that one. The stored
	   limit on byTAT is the case that matters: a closed list stays uncut even
	   when a stale row asks for a cut, which is what stops a panel that USED to
	   be a top-N from silently truncating a calendar after the registry changed
	   its mind. */
	got = resolveRowLimits(dims, map[string]layoutRow{
		"byDomain": {Limit: 5, Set: true},
		"byTAT":    {Limit: 5, Set: true},
	})
	if got["byDomain"] != 5 {
		t.Errorf("byDomain = %d, want the configured 5", got["byDomain"])
	}
	if got["byAsset"] != 10 {
		t.Errorf("byAsset = %d — configuring one panel changed another", got["byAsset"])
	}
	if n, present := got["byTAT"]; present {
		t.Errorf("a stored row cut a closed list to %d", n)
	}

	// A row that exists but sets no limit means "the default", not "zero rows".
	got = resolveRowLimits(dims, map[string]layoutRow{"byDomain": {Limit: 0, Set: true}})
	if got["byDomain"] != 10 {
		t.Errorf("byDomain = %d, want the default when no limit is stored", got["byDomain"])
	}
}

/*
The card is renamed to the size it actually shows.

A panel headed "Top 10 Apps" listing five rows is worse than either number on
its own: the reader counts the rows and concludes the report is broken.
*/
func TestTopNLabelRestatesTheConfiguredSize(t *testing.T) {
	for _, c := range []struct {
		in   string
		n    int
		want string
	}{
		{"Top 10 Linking Websites", 5, "Top 5 Linking Websites"},
		{"Identification & Removal - Top 10 Assets", 20, "Identification & Removal - Top 20 Assets"},
		{"Top 10 Apps", 10, "Top 10 Apps"},
		// Case and spacing are the label's own; only the digits move.
		{"TOP 10 Developers", 3, "TOP 3 Developers"},
		// A panel whose name carries no number keeps the name it was given —
		// "Turnaround (5)" would be this function inventing a title.
		{"Turnaround", 5, "Turnaround"},
		{"Social Media Platforms", 5, "Social Media Platforms"},
		// Nothing configured: the label is untouched rather than zeroed.
		{"Top 10 Apps", 0, "Top 10 Apps"},
		{"", 5, ""},
	} {
		if got := topNLabel(c.in, c.n); got != c.want {
			t.Errorf("topNLabel(%q, %d) = %q, want %q", c.in, c.n, got, c.want)
		}
	}
}

/*
A number the label happens to contain is not a top-N.

The pattern is anchored on the word, so a report named for a year or a codec
does not have its name rewritten by a setting that has nothing to do with it.
*/
func TestTopNLabelLeavesOtherNumbersAlone(t *testing.T) {
	for _, in := range []string{
		"2025 Season Summary",
		"Top-tier Websites",
		"H264 Streams",
	} {
		if got := topNLabel(in, 5); got != in {
			t.Errorf("topNLabel(%q) rewrote it to %q", in, got)
		}
	}
}

// The panel map is what the report page reads, so the rename has to survive the
// trip through it — and an admin's own title has to survive the rename.
func TestAPanelReportsTheConfiguredSizeUnlessRenamed(t *testing.T) {
	p := panelDef{
		Key: "byDomain", Kind: panelDim,
		Label: "Top 10 Linking Websites", DefaultLimit: 10, Limit: 5,
	}
	if got := strFromAny(p.asMap()["label"]); got != "Top 5 Linking Websites" {
		t.Errorf("panel label = %q, want the configured size", got)
	}

	// At the default there is nothing to restate.
	p.Limit = 10
	if got := strFromAny(p.asMap()["label"]); got != "Top 10 Linking Websites" {
		t.Errorf("panel label = %q, want the default name untouched", got)
	}

	/* An admin's own title wins outright. Theirs is a name, not a description
	   of the cut, and rewriting a number inside it would be this code editing
	   somebody's words. */
	p.Limit = 5
	p.Title = "Worst offenders"
	if got := strFromAny(p.asMap()["label"]); got != "Worst offenders" {
		t.Errorf("panel label = %q, want the admin's own title", got)
	}
}
