package handlers

// What the repeat-offenders panel counts, and what it must never count.
//
// The measure is "how many DISTINCT DAYS was this account identified on", and
// every plausible way of getting it wrong produces a chart that looks right:
// counting rows ranks the account with one busy afternoon above the one that
// came back for eleven weeks; keeping the time off a datetime column makes
// every row its own day, which is the row count again wearing the day count's
// label; and letting single-day accounts through fills a card titled "Repeat
// Offenders" with accounts that never repeated.

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

/*
Many rows on one day are ONE day.

The whole point of the panel. An account that dumped two hundred URLs in a
single afternoon is not a repeat offender, and on a row count it would outrank
every account on the card.
*/
func TestOneDayIsOneDayHoweverManyRows(t *testing.T) {
	rows := []map[string]any{}
	for i := 0; i < 200; i++ {
		rows = append(rows, map[string]any{
			"ProfileURL": "https://x.com/blitz", "URLUploadDate": "2026-08-01",
		})
	}
	// A quieter account, but seen across three separate days.
	for _, d := range []string{"2026-08-01", "2026-08-09", "2026-08-30"} {
		rows = append(rows, map[string]any{"ProfileURL": "https://x.com/steady", "URLUploadDate": d})
	}

	out := computeRepeatOffenders(rows, "ProfileURL", "URLUploadDate", "", "", 10)
	if len(out) != 1 {
		t.Fatalf("want only the account seen on more than one day, got %d rows: %v", len(out), out)
	}
	if got := strFromAny(out[0]["label"]); got != "https://x.com/steady" {
		t.Errorf("the 200-row single-day account outranked the recurring one: %q", got)
	}
	if got := numOf(out[0]["repeats"]); got != 3 {
		t.Errorf("repeats = %d, want 3", got)
	}
	if got := numOf(out[0]["urls"]); got != 3 {
		t.Errorf("urls = %d, want 3 — identified is still the row count", got)
	}
}

/*
A datetime column is cut to its date.

URLUploadDate is a datetime on some of these tables. Keeping the time makes
every row a distinct "day", which turns the recurrence count back into the row
count — the exact failure this panel exists to avoid, and one that leaves every
number on the card plausible.
*/
func TestTimestampsCollapseToTheirDay(t *testing.T) {
	rows := []map[string]any{
		{"ChannelURL": "https://t.me/a", "URLUploadDate": "2026-08-01 10:37:32"},
		{"ChannelURL": "https://t.me/a", "URLUploadDate": "2026-08-01 22:04:11"},
		{"ChannelURL": "https://t.me/a", "URLUploadDate": "2026-08-02T06:00:00Z"},
	}
	out := computeRepeatOffenders(rows, "ChannelURL", "URLUploadDate", "", "", 10)
	if len(out) != 1 {
		t.Fatalf("want one account, got %d", len(out))
	}
	if got := numOf(out[0]["repeats"]); got != 2 {
		t.Errorf("repeats = %d, want 2 — three timestamps across two calendar days", got)
	}
}

/*
Gaps do not matter, and a single day is not a repeat.

Consecutive days, every Saturday and one day a month are all the same finding:
the account was caught again after it was already known. One day is not.
*/
func TestOnlyAccountsSeenOnMoreThanOneDaySurvive(t *testing.T) {
	rows := []map[string]any{
		{"ProfileURL": "once", "URLUploadDate": "2026-08-01"},
		{"ProfileURL": "gappy", "URLUploadDate": "2026-08-01"},
		{"ProfileURL": "gappy", "URLUploadDate": "2026-08-29"},
		// Blank accounts are not an account — they would merge every unattributed
		// row into one bar labelled with nothing.
		{"ProfileURL": "  ", "URLUploadDate": "2026-08-01"},
		{"ProfileURL": "  ", "URLUploadDate": "2026-08-02"},
	}
	out := computeRepeatOffenders(rows, "ProfileURL", "URLUploadDate", "", "", 10)
	if len(out) != 1 || strFromAny(out[0]["label"]) != "gappy" {
		t.Fatalf("want only \"gappy\", got %v", out)
	}
}

/*
Removals are read off the SAME column rowmetrics.go counts them from, with the
same case-insensitive match.

One client's rows carry 13,267 'Dead' and 2,378 'DEAD'. An exact match would
draw this panel's orange bars fifteen per cent short of the removal figure on
the tile directly above them.
*/
func TestRemovedMatchesTheKPIsOwnRule(t *testing.T) {
	rows := []map[string]any{
		{"ProfileURL": "a", "URLUploadDate": "2026-08-01", "RemovalStatus": "Dead"},
		{"ProfileURL": "a", "URLUploadDate": "2026-08-02", "RemovalStatus": "DEAD"},
		{"ProfileURL": "a", "URLUploadDate": "2026-08-03", "RemovalStatus": " dead "},
		{"ProfileURL": "a", "URLUploadDate": "2026-08-04", "RemovalStatus": "Active"},
	}
	out := computeRepeatOffenders(rows, "ProfileURL", "URLUploadDate", "", "", 10)
	if got := numOf(out[0]["removed"]); got != 3 {
		t.Errorf("removed = %d, want 3 — 'Dead', 'DEAD' and ' dead ' are one status", got)
	}
	if got := numOf(out[0]["urls"]); got != 4 {
		t.Errorf("urls = %d, want 4", got)
	}
}

/*
An open-web table spells it IsRemoved, and a table with neither column says
"nothing removed" rather than dropping the panel — the recurrence figure is what
the card is for and it is still right.
*/
func TestRemovedFallsBackToTheRemovalFlag(t *testing.T) {
	if !rowRemoved(map[string]any{"IsRemoved": 1}) {
		t.Error("IsRemoved=1 was not read as removed")
	}
	if rowRemoved(map[string]any{"IsRemoved": 0}) {
		t.Error("IsRemoved=0 was read as removed")
	}
	if rowRemoved(map[string]any{"SomethingElse": "Dead"}) {
		t.Error("a table with no removal column reported a removal")
	}
	// RemovalStatus wins where both are present: it is the column the KPI band
	// counts, and two sources of truth on one card is one too many.
	if rowRemoved(map[string]any{"RemovalStatus": "Active", "IsRemoved": 1}) {
		t.Error("IsRemoved overrode RemovalStatus")
	}
}

/*
The order is days first, then volume, then the URL — and the cut is ten.

Volume breaks the tie because two accounts seen on the same days are not equally
interesting; the URL breaks that one so the same window drawn twice is the same
chart rather than a reshuffle of its ties.
*/
func TestRankedByDaysThenVolumeThenURL(t *testing.T) {
	rows := []map[string]any{}
	add := func(url string, days, perDay int) {
		for d := 1; d <= days; d++ {
			for i := 0; i < perDay; i++ {
				rows = append(rows, map[string]any{
					"ProfileURL":    url,
					"URLUploadDate": fmt.Sprintf("2026-08-%02d", d),
				})
			}
		}
	}
	add("busy-but-brief", 2, 500) // most URLs, fewest days
	add("bbb", 5, 1)              // same days as below, fewer URLs
	add("aaa", 5, 9)              // same days, more URLs → must come first
	add("persistent", 9, 1)       // most days → top of the card

	out := computeRepeatOffenders(rows, "ProfileURL", "URLUploadDate", "", "", 10)
	want := []string{"persistent", "aaa", "bbb", "busy-but-brief"}
	if len(out) != len(want) {
		t.Fatalf("want %d rows, got %d: %v", len(want), len(out), out)
	}
	for i, w := range want {
		if got := strFromAny(out[i]["label"]); got != w {
			t.Errorf("row %d = %q, want %q", i, got, w)
		}
	}

	// And the limit is honoured, on the ranking above rather than on map order.
	if cut := computeRepeatOffenders(rows, "ProfileURL", "URLUploadDate", "", "", 2); len(cut) != 2 ||
		strFromAny(cut[0]["label"]) != "persistent" || strFromAny(cut[1]["label"]) != "aaa" {
		t.Errorf("the limit did not keep the top of the ranking: %v", cut)
	}
}

/*
Every dataset that can produce the panel resolves ONE of the URL spellings.

The dimension candidate and the counter have to name the same column list, or a
table whose column is ProfileURL gets a panel keyed on a column the walk never
reads and draws nothing, with no error anywhere to say why.
*/
func TestTheCandidateAndTheCounterShareOneColumnList(t *testing.T) {
	found := false
	for _, c := range dimensionCandidates {
		if c.Key != dimRepeatOffender {
			continue
		}
		found = true
		got := append([]string{c.Column}, c.Alts...)
		if len(got) != len(repeatURLColumns) {
			t.Fatalf("candidate names %v, repeatURLColumns is %v", got, repeatURLColumns)
		}
		for i := range got {
			if got[i] != repeatURLColumns[i] {
				t.Errorf("candidate column %d = %q, repeatURLColumns has %q",
					i, got[i], repeatURLColumns[i])
			}
		}
	}
	if !found {
		t.Fatal("no dimension candidate for the repeat-offenders panel")
	}
}

/*
The panel is drawn as `repeat`, and the layout has to accept that word.

validViz silently ignores a chart type outside its list, which would drop the
panel through to the generic renderer — a pair of grey bars with no day count
under a title promising the opposite.
*/
func TestRepeatIsAChartTypeTheLayoutAccepts(t *testing.T) {
	if !validViz("repeat") {
		t.Error("the layout rejects \"repeat\", so the panel cannot keep its shape")
	}
	if !wideViz["repeat"] {
		t.Error("the panel defaults to half a row — ten URLs across it name nobody")
	}
	for _, c := range dimensionCandidates {
		if c.Key == dimRepeatOffender && c.Viz != "repeat" {
			t.Errorf("the candidate asks for %q, not \"repeat\"", c.Viz)
		}
	}
}

/*
And the PAGE has to know how to draw it.

The Go side can name any chart type it likes; the vocabulary that matters is
renderDim's, and a shape the page has no branch for renders as the fallback
bars. Checked against the source rather than trusted, the same way this package
already pins DIM_FILTER and FILTER_LABELS.
*/
func TestPageRendersTheRepeatShape(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("..", "..", "app", "admin", "reports", "page.tsx"))
	if err != nil {
		t.Skipf("reports page not readable from here: %v", err)
	}
	page := string(src)
	for _, want := range []string{
		"viz === 'repeat'", // the render branch
		"RepeatOffenders",  // the component behind it
		"byRepeatOffender", // the dimension it is keyed on
	} {
		if !strings.Contains(page, want) {
			t.Errorf("the reports page has no %q — the panel would fall through to the default bars", want)
		}
	}
}

/*
A dataset that reads rows for this panel must not have its removal figures
rewritten as a side effect.

wantRows switches on computeRowMetrics, whose row-counted removals OVERRIDE the
summary's. That is right for a dataset with no `removed` measure and wrong for
one that has it, so the two reasons to page rows are tracked apart — see
runSpecViaAPI. This pins the condition that keeps them apart.
*/
func TestRowMetricsStayOffDatasetsTheServiceCanAnswer(t *testing.T) {
	ds := socialDS()
	ds.Measures = append(ds.Measures, "removed")
	ds.Columns = append(ds.Columns, "ChannelURL")
	if needsRowRemovals(ds) {
		t.Error("a dataset that declares a removed measure would have its KPI overwritten " +
			"by the row walk the repeat panel triggers")
	}
	// And the panel itself still works there: it never consults rowMetrics.
	rows := []map[string]any{
		{"ChannelURL": "u", "URLUploadDate": "2026-08-01"},
		{"ChannelURL": "u", "URLUploadDate": "2026-08-02"},
	}
	if out := computeRepeatOffenders(rows, "ChannelURL", dateColOf(ds), "", "", 10); len(out) != 1 {
		t.Errorf("the panel did not draw on a dataset with its own removed measure: %v", out)
	}
}

/*
The account-URL slicer is filterable but never LISTED.

Two separate promises, and the expensive one is the second. It has to stay out
of the pane — a dropdown of raw URLs is a control nobody can pick from — and out
of the options fetch, which is a full distinct-scan of that column per table on
every change to the window, for a list that is not drawn. It must still reach
the page's filter set, or clicking a column on the panel would cross-filter
nothing.
*/
func TestTheAccountSlicerIsFilterableButUnlistable(t *testing.T) {
	param := DIMFilterParam(dimRepeatOffender)
	if param == "" {
		t.Fatal("the repeat-offenders panel claims no slicer, so clicking it does nothing")
	}
	if !unlistedFilterParams[param] {
		t.Errorf("%q is not unlisted — the options endpoint would scan every account "+
			"URL in the window for a dropdown that is never drawn", param)
	}
	if !panelOnlyFilters[param] {
		t.Errorf("%q would be offered a dropdown in the rail", param)
	}
	// And it is still a parameter the engine honours, or specHonoursFilters
	// would let every table run unfiltered under a filter chip.
	known := false
	for _, p := range knownFilterParams {
		if p == param {
			known = true
		}
	}
	if !known {
		t.Errorf("%q is not in knownFilterParams", param)
	}

	/* Unlisted means "no dropdown, no value listing" — NEVER "ignored". The
	   WHERE the direct path builds must apply it, or clicking a column shows a
	   chip over totals that quietly disregard it. This regressed once: the
	   listing skip was placed in specWhere instead of the options lister. */
	sp := reportSpec{Table: "t", ClientCol: "ClientMasterId", DateCol: "URLUploadDate",
		Filters: map[string]string{param: "ChannelURL"}}
	where, args := specWhere(sp, map[string]string{"clientId": "c1", param: "https://x.com/y"})
	if !strings.Contains(where, "ChannelURL = ?") || len(args) != 2 {
		t.Errorf("specWhere dropped the unlisted filter: %q %v", where, args)
	}
}

/*
Every unlisted slicer is a panel-only slicer.

The two are a hierarchy, not a pair of independent flags: panel-only says "no
dropdown unless somebody asks", unlisted says the dropdown could not be filled
at all. An unlisted parameter that was not also panel-only would default INTO
the pane and render permanently empty — which is exactly the state the pane's
own comment says a slicer must never be left in.
*/
func TestUnlistedSlicersAreAlsoPanelOnly(t *testing.T) {
	for param := range unlistedFilterParams {
		if !panelOnlyFilters[param] {
			t.Errorf("%q has no values to list but defaults into the pane", param)
		}
		if defaultFilterVisible(param, map[string]bool{param: true}) {
			t.Errorf("%q would be drawn as a dropdown with nothing in it", param)
		}
	}
}

/*
A pre-aggregated table counts with its own columns, not with rows.

Agg_Daily_Youtube_MasterNew carries ChannelURL — so it gets this panel — and one
of its rows stands for a whole day's TotalCount. Counting rows there would draw
a channel with 40,000 infringements as a bar of 3, beside bars from raw tables
that are honest counts, under one shared y-axis.

The DAY count is the same either way, which is the point of collecting dates
into a set: a rollup holds one row per account per day and a raw table holds
many, and both answer "three days".
*/
func TestPreAggregatedRowsCountWithTheirOwnColumns(t *testing.T) {
	rows := []map[string]any{
		{"ChannelURL": "c", "URLUploadDate": "2026-08-01", "TotalCount": 12000, "RemovedCount": 4000},
		{"ChannelURL": "c", "URLUploadDate": "2026-08-02", "TotalCount": 20000, "RemovedCount": 9000},
		{"ChannelURL": "c", "URLUploadDate": "2026-08-03", "TotalCount": 8000, "RemovedCount": 1000},
	}
	ident, removed := repeatMeasureColumns([]string{"ChannelURL", "URLUploadDate", "TotalCount", "RemovedCount"})
	if ident != "TotalCount" || removed != "RemovedCount" {
		t.Fatalf("measure columns = %q/%q, want TotalCount/RemovedCount", ident, removed)
	}

	out := computeRepeatOffenders(rows, "ChannelURL", "URLUploadDate", ident, removed, 10)
	if len(out) != 1 {
		t.Fatalf("want one account, got %d", len(out))
	}
	if got := numOf(out[0]["urls"]); got != 40000 {
		t.Errorf("urls = %d, want 40000 — the rollup was counted as 3 rows", got)
	}
	if got := numOf(out[0]["removed"]); got != 14000 {
		t.Errorf("removed = %d, want 14000", got)
	}
	if got := numOf(out[0]["repeats"]); got != 3 {
		t.Errorf("repeats = %d, want 3 — the day count is the same either way", got)
	}

	// And a raw table resolves to no measure columns, so it keeps counting rows.
	if i, r := repeatMeasureColumns([]string{"ProfileURL", "URLUploadDate", "RemovalStatus"}); i != "" || r != "" {
		t.Errorf("a raw table resolved measure columns %q/%q", i, r)
	}
}
