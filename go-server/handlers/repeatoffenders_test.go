package handlers

// What the repeat-offenders panel counts, and what it must never count.
//
// The measure is "how many REQUESTS arrived after we had already taken content
// down on this profile" — one completed found→removed→found cycle per count.
// Every plausible way of getting it wrong produces a chart that looks right:
//
//   · counting URLs instead of requests turns a single crawl that swept up
//     twelve posts into twelve offences, and ranks the busiest sweep top;
//   · cutting the time off the upload stamp loses every same-day return, which
//     on social is the commonest shape there is;
//   · measuring from anything but the earliest removal counts uploads that
//     preceded enforcement as though they defied it;
//   · and ranking by activity rather than by comebacks fills a card titled
//     "Repeat Offenders" with profiles that were never actioned at all.

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

/*
A sweep that finds many URLs at once is ONE request.

The whole point of the panel. A crawl that swept up two hundred posts in a
single pass found one piece of behaviour, and counting URLs would put it above
every profile on the card — including the one that was taken down and came back
twice.
*/
func TestOneSweepIsOneRequestHoweverManyURLs(t *testing.T) {
	rows := []map[string]any{}
	for i := 0; i < 200; i++ {
		rows = append(rows, map[string]any{
			"ProfileURL": "https://x.com/blitz", "URLUploadDate": "2026-08-01 09:00:00",
			"RemovalTime": "2026-08-01 11:00:00",
		})
	}
	// A quieter profile, but back twice after we removed its first post.
	for _, up := range []string{"2026-08-01 09:00:00", "2026-08-09 09:00:00", "2026-08-30 09:00:00"} {
		rows = append(rows, map[string]any{
			"ProfileURL": "https://x.com/steady", "URLUploadDate": up,
			"RemovalTime": "2026-08-01 12:00:00",
		})
	}

	out := computeRepeatOffenders(rows, "ProfileURL", "URLUploadDate", "", "", "RemovalTime", 10)
	if len(out) != 1 {
		t.Fatalf("want only the profile that came back, got %d rows: %v", len(out), out)
	}
	if got := strFromAny(out[0]["label"]); got != "https://x.com/steady" {
		t.Errorf("the 200-URL single-sweep profile outranked the recurring one: %q", got)
	}
	if got := numOf(out[0]["repeats"]); got != 2 {
		t.Errorf("repeats = %d, want 2 — two requests arrived after the first removal", got)
	}
	if got := numOf(out[0]["urls"]); got != 3 {
		t.Errorf("urls = %d, want 3 — identified is still every URL", got)
	}
}

/*
The TIME is kept, so a same-day return counts.

The opposite of what the old day count needed, and the reason it was replaced.
A profile removed at 11:00 and posting again at 14:00 came back; cutting the
stamp to its date puts both on one day and the comeback disappears. On social
that is the commonest shape there is.
*/
func TestASameDayReturnIsARepeat(t *testing.T) {
	rows := []map[string]any{
		{"ProfileURL": "p", "URLUploadDate": "2026-08-01 09:00:00", "RemovalTime": "2026-08-01 11:00:00"},
		{"ProfileURL": "p", "URLUploadDate": "2026-08-01 14:00:00", "RemovalTime": nil},
	}
	out := computeRepeatOffenders(rows, "ProfileURL", "URLUploadDate", "", "", "RemovalTime", 10)
	if len(out) != 1 {
		t.Fatalf("a same-day comeback was not counted: %v", out)
	}
	if got := numOf(out[0]["repeats"]); got != 1 {
		t.Errorf("repeats = %d, want 1", got)
	}
}

/*
Uploads BEFORE the first removal are not repeats.

They are the original offence. Counting them would make every profile we ever
actioned a repeat offender, which empties the heading of meaning.
*/
func TestUploadsBeforeTheFirstRemovalAreNotRepeats(t *testing.T) {
	rows := []map[string]any{
		{"ProfileURL": "p", "URLUploadDate": "2026-08-01 09:00:00", "RemovalTime": "2026-08-05 10:00:00"},
		{"ProfileURL": "p", "URLUploadDate": "2026-08-02 09:00:00", "RemovalTime": "2026-08-05 10:00:00"},
		{"ProfileURL": "p", "URLUploadDate": "2026-08-03 09:00:00", "RemovalTime": "2026-08-05 10:00:00"},
	}
	if out := computeRepeatOffenders(rows, "ProfileURL", "URLUploadDate", "", "", "RemovalTime", 10); len(out) != 0 {
		t.Errorf("three uploads that all preceded the takedown were drawn as repeats: %v", out)
	}
}

/*
A profile nothing was ever removed from scores zero, and is absent.

It may be the client's worst problem — posting daily, untouched — but it is not
a REPEAT offender, and the card beside this one already ranks by volume. This is
the case the old day count got backwards: it ranked exactly this profile third
while showing a profile removed twenty-three times as a "5".
*/
func TestAProfileNeverActionedIsNotARepeatOffender(t *testing.T) {
	rows := []map[string]any{}
	for _, up := range []string{"2026-08-01 09:00:00", "2026-08-02 09:00:00", "2026-08-03 09:00:00"} {
		rows = append(rows, map[string]any{"ProfileURL": "p", "URLUploadDate": up, "RemovalTime": nil})
	}
	if out := computeRepeatOffenders(rows, "ProfileURL", "URLUploadDate", "", "", "RemovalTime", 10); len(out) != 0 {
		t.Errorf("a profile with no removals at all was drawn as a repeat offender: %v", out)
	}
}

/*
The profile's own state, in the two words the card shows.

Dead is a suspension. Everything else — Active, blank, a column this table does
not carry — is the absence of one, and they are deliberately one label: Active
and "we were never told" are the same amount of evidence that the account is
still up.
*/
func TestProfileStatusIsSuspendedOrNotAvailable(t *testing.T) {
	base := func(status any) []map[string]any {
		return []map[string]any{
			{"ProfileURL": "p", "URLUploadDate": "2026-08-01 09:00:00",
				"RemovalTime": "2026-08-01 10:00:00", "RemovalProfileStatus": status},
			{"ProfileURL": "p", "URLUploadDate": "2026-08-01 14:00:00",
				"RemovalTime": nil, "RemovalProfileStatus": status},
		}
	}
	for _, c := range []struct {
		status any
		want   string
	}{
		{"Dead", "Suspended"},
		{"DEAD", "Suspended"}, // the casing drift isDead exists for
		{"Active", "Not Available"},
		{"", "Not Available"},
		{nil, "Not Available"},
	} {
		out := computeRepeatOffenders(base(c.status), "ProfileURL", "URLUploadDate", "", "", "RemovalTime", 10)
		if len(out) != 1 {
			t.Fatalf("status %v: no row drawn", c.status)
		}
		if got := strFromAny(out[0]["profileStatus"]); got != c.want {
			t.Errorf("status %v drew %q, want %q", c.status, got, c.want)
		}
	}
}

// Removal counting is unchanged, and still agrees with the KPI tile above the
// panel — same column, same case-insensitive Dead.
func TestRemovedMatchesTheKPIsOwnRule(t *testing.T) {
	rows := []map[string]any{
		{"ProfileURL": "p", "URLUploadDate": "2026-08-01 09:00:00",
			"RemovalTime": "2026-08-01 10:00:00", "RemovalStatus": "Dead"},
		{"ProfileURL": "p", "URLUploadDate": "2026-08-01 14:00:00",
			"RemovalTime": nil, "RemovalStatus": "DEAD"},
		{"ProfileURL": "p", "URLUploadDate": "2026-08-01 15:00:00",
			"RemovalTime": nil, "RemovalStatus": "Active"},
	}
	out := computeRepeatOffenders(rows, "ProfileURL", "URLUploadDate", "", "", "RemovalTime", 10)
	if len(out) != 1 {
		t.Fatalf("want one profile, got %d", len(out))
	}
	if got := numOf(out[0]["removed"]); got != 2 {
		t.Errorf("removed = %d, want 2 — DEAD is the same status as Dead", got)
	}
}

/*
Ranked by repeats, then volume, then URL.

Volume breaks the first tie because two profiles that each came back once are
not equally interesting, and the URL breaks that one so a report run twice over
the same window draws the same chart rather than reshuffling its ties.
*/
func TestRankedByRepeatsThenVolumeThenURL(t *testing.T) {
	// Everything removed at 10:00 on day one; later uploads are the comebacks.
	mk := func(url string, uploads ...string) []map[string]any {
		out := []map[string]any{{"ProfileURL": url,
			"URLUploadDate": "2026-08-01 09:00:00", "RemovalTime": "2026-08-01 10:00:00"}}
		for _, up := range uploads {
			out = append(out, map[string]any{"ProfileURL": url, "URLUploadDate": up})
		}
		return out
	}
	rows := []map[string]any{}
	rows = append(rows, mk("b", "2026-08-02 09:00:00")...)
	rows = append(rows, mk("a", "2026-08-02 09:00:00")...)
	rows = append(rows, mk("heavy", "2026-08-02 09:00:00", "2026-08-02 09:00:00")...)
	rows = append(rows, mk("top", "2026-08-02 09:00:00", "2026-08-03 09:00:00")...)

	out := computeRepeatOffenders(rows, "ProfileURL", "URLUploadDate", "", "", "RemovalTime", 10)
	got := []string{}
	for _, r := range out {
		got = append(got, strFromAny(r["label"]))
	}
	want := []string{"top", "heavy", "a", "b"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("order = %v, want %v", got, want)
	}

	// And the limit cuts from the bottom of that order.
	if cut := computeRepeatOffenders(rows, "ProfileURL", "URLUploadDate", "", "", "RemovalTime", 2); len(cut) != 2 ||
		strFromAny(cut[0]["label"]) != "top" {
		t.Errorf("limit did not keep the top of the ranking: %v", cut)
	}
}

/*
No removal-stamp column, no panel.

The count is measured from it. A table that cannot say when anything came down
cannot say what came after, and the honest answer is an absent panel — a panel
of zeroes is a wrong number nobody asks about.
*/
func TestWithoutARemovalStampThereIsNoPanel(t *testing.T) {
	rows := []map[string]any{
		{"ProfileURL": "p", "URLUploadDate": "2026-08-01 09:00:00"},
		{"ProfileURL": "p", "URLUploadDate": "2026-08-02 09:00:00"},
	}
	if out := computeRepeatOffenders(rows, "ProfileURL", "URLUploadDate", "", "", "", 10); len(out) != 0 {
		t.Errorf("a table with no removal stamp drew rows: %v", out)
	}
	if got := repeatRemovalTimeColumn([]string{"ProfileURL", "URLUploadDate"}); got != "" {
		t.Errorf("resolved %q as a removal stamp on a table that has none", got)
	}
	if got := repeatRemovalTimeColumn([]string{"ProfileURL", "RemovalTime"}); got != "RemovalTime" {
		t.Errorf("did not resolve RemovalTime, got %q", got)
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
		{"ChannelURL": "u", "URLUploadDate": "2026-08-01 09:00:00", "RemovalTime": "2026-08-01 10:00:00"},
		{"ChannelURL": "u", "URLUploadDate": "2026-08-02 09:00:00"},
	}
	if out := computeRepeatOffenders(rows, "ChannelURL", dateColOf(ds), "", "", "RemovalTime", 10); len(out) != 1 {
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

The REPEAT count is a different story, and this is where the new measure costs
something. A daily rollup carries no removal stamp — it holds one row per
account per day with totals on it, and nothing saying when any individual URL
came down — so it cannot say what was uploaded AFTER a takedown. The panel is
absent there rather than drawn at zero, which is asserted below alongside the
measure columns that do still resolve.
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

	/* A rollup has no removal stamp, so this panel cannot be built from it. The
	   resolver finds nothing to pass in, and the walk draws nothing when given
	   nothing — the two halves of the same refusal. */
	if got := repeatRemovalTimeColumn([]string{"ChannelURL", "URLUploadDate", "TotalCount", "RemovedCount"}); got != "" {
		t.Errorf("resolved %q as a removal stamp on a daily rollup", got)
	}
	if out := computeRepeatOffenders(rows, "ChannelURL", "URLUploadDate", ident, removed, "", 10); len(out) != 0 {
		t.Errorf("a rollup with no removal stamp drew a repeat panel: %v", out)
	}

	/* Where a table DOES carry both — its own measure columns and a removal
	   stamp — the measures are still read off the columns rather than counted
	   as rows. That is the part of this test the new measure did not change. */
	stamped := []map[string]any{
		{"ChannelURL": "c", "URLUploadDate": "2026-08-01 09:00:00",
			"TotalCount": 12000, "RemovedCount": 4000, "RemovalTime": "2026-08-01 10:00:00"},
		{"ChannelURL": "c", "URLUploadDate": "2026-08-02 09:00:00",
			"TotalCount": 20000, "RemovedCount": 9000},
		{"ChannelURL": "c", "URLUploadDate": "2026-08-03 09:00:00",
			"TotalCount": 8000, "RemovedCount": 1000},
	}
	out := computeRepeatOffenders(stamped, "ChannelURL", "URLUploadDate", ident, removed, "RemovalTime", 10)
	if len(out) != 1 {
		t.Fatalf("want one account, got %d", len(out))
	}
	if got := numOf(out[0]["urls"]); got != 40000 {
		t.Errorf("urls = %d, want 40000 — the rollup was counted as 3 rows", got)
	}
	if got := numOf(out[0]["removed"]); got != 14000 {
		t.Errorf("removed = %d, want 14000", got)
	}
	if got := numOf(out[0]["repeats"]); got != 2 {
		t.Errorf("repeats = %d, want 2 — two uploads followed the first removal", got)
	}

	// And a raw table resolves to no measure columns, so it keeps counting rows.
	if i, r := repeatMeasureColumns([]string{"ProfileURL", "URLUploadDate", "RemovalStatus"}); i != "" || r != "" {
		t.Errorf("a raw table resolved measure columns %q/%q", i, r)
	}
}
