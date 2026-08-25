package handlers

// The one thing every figure in enforcementactions.go has to get right: it
// counts ACTIONS, not the URLs they covered.
//
// A notice id is stamped on every source URL the notice listed and a batch id
// on every link in the submission, so a plain COUNT answers a different question
// — one that is four orders of magnitude larger, already on the same page as
// `identified`, and entirely plausible as an answer to this one. Every test
// below exists because the wrong version of it looks right.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

/*
Both breakdowns count DISTINCT ids, over the column the panel groups by.

`Ident` is a %s template filled with the column named by `Needs` — see inferSpec
— so the panel counts the id it just proved the table has, rather than a
differently spelled one that does not exist. Getting this wrong does not fail: it
draws the section's own identified count under a title promising notices.
*/
func TestEnforcementPanelsCountActionsNotURLs(t *testing.T) {
	want := map[string]struct{ column, needs, measure, param, role string }{
		dimHSPNotices:             {"HSPName", colSourceNoticeID, "notices", "hspName", "host"},
		dimEngineDelistingBatches: {"SearchEngineName", colDelistingBatchID, "delistingBatches", "searchEngine", "linking"},
	}
	seen := map[string]bool{}
	for _, d := range dimensionCandidates {
		w, ok := want[d.Key]
		if !ok {
			continue
		}
		seen[d.Key] = true
		if d.Column != w.column {
			t.Errorf("%s groups by %q, want %q", d.Key, d.Column, w.column)
		}
		if d.Needs != w.needs {
			t.Errorf("%s requires %q, want %q — the panel would appear on tables "+
				"that cannot answer it", d.Key, d.Needs, w.needs)
		}
		if !strings.HasPrefix(d.Ident, "COUNT(DISTINCT ") {
			t.Errorf("%s counts with %q — anything but COUNT(DISTINCT …) counts the "+
				"URLs an action covered, not the actions", d.Key, d.Ident)
		}
		if !strings.Contains(d.Ident, "%s") {
			t.Errorf("%s does not take the column from Needs, so it counts a "+
				"hard-coded spelling", d.Key)
		}
		// No removal counterpart: an action is sent or it is not.
		if d.Removed != "0" {
			t.Errorf("%s draws a removal series (%q) against a figure that has none", d.Key, d.Removed)
		}
		if d.APIMeasure != w.measure {
			t.Errorf("%s asks reports_api for %q, want %q — the API path would draw "+
				"the identified count under this title", d.Key, d.APIMeasure, w.measure)
		}
		if got := DIMFilterParam(d.Key); got != w.param {
			t.Errorf("%s filters on %q, want %q", d.Key, got, w.param)
		}
		if d.Viz != "value" {
			t.Errorf("%s draws as %q; one measure wants single-series bars", d.Key, d.Viz)
		}
		// Pinned to a side, because the columns exist on both tables now and
		// presence-matching would build the panel twice and sum it.
		if d.Role != w.role {
			t.Errorf("%s is pinned to role %q, want %q", d.Key, d.Role, w.role)
		}
	}
	for key := range want {
		if !seen[key] {
			t.Errorf("no dimension candidate for %q", key)
		}
	}
}

/*
The headline totals are role-pinned, not presence-matched.

They used to be extraKPICandidates entries, matched on "the column is there" —
which stopped being enough the day both raw tables gained both columns: each
spec would then emit both KPIs and runPlatform would sum them, one notice
reported as two. So the action block in inferSpec owns them now, and the
candidate list must never grow a presence-matched form again. The SUM spellings
stay: they are the per-row counters the OTHER tables carry, and no second table
shares those columns.
*/
func TestEnforcementKPIsAreRolePinnedNotPresenceMatched(t *testing.T) {
	for _, c := range extraKPICandidates {
		if c.Key == "delistingBatches" {
			t.Errorf("delistingBatches is back in extraKPICandidates (%q) — presence-"+
				"matched, it double-counts on tables that share the column", c.Expr)
		}
		if c.Key == "notices" && strings.Contains(c.Expr, "DISTINCT") {
			t.Errorf("a DISTINCT notices form is back in extraKPICandidates (%q)", c.Expr)
		}
	}
	// The SUM forms survive for the tables that only have counters.
	found := false
	for _, c := range extraKPICandidates {
		if c.Key == "notices" && c.NeedsCol == "NoticeCount" {
			found = true
		}
	}
	if !found {
		t.Error("SUM(NoticeCount) left extraKPICandidates — the search-engine tables lose their notices tile")
	}
}

/*
Both tables carrying all three enforcement columns is ONE report, not two copies.

This is the scenario the pinning exists for, run through inferSpec itself with
seeded shapes: two tables of identical enforcement columns, one host and one
linking. Each side must come out with ITS action and only its action — tile,
daily expression and panel all from the one pinned decision — while the provider
FILTER lands on both sides, because a filter only one spec declares excludes the
other spec from a filtered report entirely.
*/
func TestIdenticalSchemasKeepEachActionOnItsOwnSide(t *testing.T) {
	shared := []string{
		"ClientId", "URLUploadDate", "AssetId", "SearchEngineName",
		"HSPName", colSourceNoticeID, colDelistingBatchID, "IsRemoved",
	}
	seed := func(table string, own ...string) {
		cols := map[string]string{}
		for _, c := range append(append([]string{}, shared...), own...) {
			cols[strings.ToLower(c)] = c
		}
		shapeCacheMu.Lock()
		shapeCache[table] = tableShape{Table: table, Columns: cols}
		shapeCacheMu.Unlock()
	}
	const hostT, linkT = "dashboards.__test_host", "dashboards.__test_linking"
	seed(hostT, "SourceDomain")
	seed(linkT, "InfringingDomain")
	defer invalidateShapeCache()

	host, ok := inferSpec("open-web-sports", "Open Web - Sports", hostT)
	if !ok {
		t.Fatal("host spec not usable")
	}
	linking, ok := inferSpec("open-web-sports", "Open Web - Sports", linkT)
	if !ok {
		t.Fatal("linking spec not usable")
	}

	if host.ActionKey != "notices" {
		t.Errorf("host action = %q, want notices", host.ActionKey)
	}
	if linking.ActionKey != "delistingBatches" {
		t.Errorf("linking action = %q, want delistingBatches — presence-matching "+
			"gave it the first action in the list", linking.ActionKey)
	}

	// The tile follows the same pinned decision, and ONLY that side has it.
	if _, ok := host.ExtraKPI["notices"]; !ok {
		t.Error("host spec has no notices tile")
	}
	if _, ok := host.ExtraKPI["delistingBatches"]; ok {
		t.Error("host spec counts delisting batches — the column is there, the figure is not its")
	}
	if _, ok := linking.ExtraKPI["delistingBatches"]; !ok {
		t.Error("linking spec has no delistingBatches tile")
	}
	if _, ok := linking.ExtraKPI["notices"]; ok {
		t.Error("linking spec counts notices — one notice would be reported twice")
	}

	// The panels stay on their sides too.
	dims := func(sp reportSpec) map[string]bool {
		out := map[string]bool{}
		for _, d := range sp.Dimensions {
			out[d.Key] = true
		}
		return out
	}
	hd, ld := dims(host), dims(linking)
	if !hd[dimHSPNotices] || hd[dimEngineDelistingBatches] {
		t.Errorf("host panels wrong: hsp=%v batches=%v", hd[dimHSPNotices], hd[dimEngineDelistingBatches])
	}
	if !ld[dimEngineDelistingBatches] || ld[dimHSPNotices] {
		t.Errorf("linking panels wrong: batches=%v hsp=%v", ld[dimEngineDelistingBatches], ld[dimHSPNotices])
	}

	/* The provider FILTER is the exception, on purpose: both tables can honour
	   it, and a filter only the host declared would cut the linking half out of
	   any provider-filtered report (see specHonoursFilters). */
	if host.Filters["hspName"] != "HSPName" {
		t.Errorf("host hspName filter = %q", host.Filters["hspName"])
	}
	if linking.Filters["hspName"] != "HSPName" {
		t.Errorf("linking hspName filter = %q — filtering by provider would drop "+
			"the whole linking half of the page", linking.Filters["hspName"])
	}
}

/*
Each side of the report records ONE action, and they are different actions.

The notice id is on the host table and the batch id on the linking one. If both
resolved to the same key the two trends would draw the same number twice under
two titles, and the daily merge in runPlatform would add a host's notices to a
linking side that never sent any.
*/
func TestEachSideRecordsItsOwnAction(t *testing.T) {
	if len(actionMeasures) != 2 {
		t.Fatalf("want two actions, got %d", len(actionMeasures))
	}
	byKey := map[string]string{}
	roles := map[string]bool{}
	for _, a := range actionMeasures {
		if byKey[a.Key] != "" {
			t.Errorf("two actions share the key %q", a.Key)
		}
		byKey[a.Key] = a.Column
		if a.Label == "" {
			t.Errorf("action %q has no display name", a.Key)
		}
		if actionLabelFor(a.Key) != a.Label {
			t.Errorf("actionLabelFor(%q) disagrees with the registry", a.Key)
		}
		// Every action names its side — an unpinned one matches both tables
		// now that the columns are shared, and is drawn twice.
		if a.Role == "" {
			t.Errorf("action %q is pinned to no side", a.Key)
		} else if roles[a.Role] {
			t.Errorf("two actions claim the %q side", a.Role)
		}
		roles[a.Role] = true
	}
	if byKey["notices"] != colSourceNoticeID {
		t.Errorf("notices reads %q, want %q", byKey["notices"], colSourceNoticeID)
	}
	if byKey["delistingBatches"] != colDelistingBatchID {
		t.Errorf("delistingBatches reads %q, want %q", byKey["delistingBatches"], colDelistingBatchID)
	}
	// An unknown key falls back to itself rather than to another action's name.
	if got := actionLabelFor("nothing"); got != "nothing" {
		t.Errorf("actionLabelFor fell back to %q", got)
	}
}

/*
The Day-on-Day action trend cards are GONE, replaced by the day-wise breakdown
panels.

They were removed on request: the daily timeseries never carried the action ids,
so the cards drew a flat zero under an honest-looking title. The same figure now
arrives as breakdown panels (dimNoticesByDay, dimBatchesByDay), built exactly
like the per-counterparty enforcement panels beside them. This test keeps the
trend form from coming back — a layout emitting an action trend again would
resurrect the zero-line cards.
*/
func TestActionTrendsAreReplacedByDayPanels(t *testing.T) {
	roles := []string{"linking", "host"}
	actions := map[string]string{"linking": "delistingBatches", "host": "notices"}

	for _, p := range defaultPanels("open-web-sports", nil, roles, nil, actions, map[string]bool{"linking": true}, false) {
		if p.Kind == panelTrend && p.Metric != "" {
			t.Errorf("an action trend (%q) is back in the layout — that card drew "+
				"zero every day and was replaced by the day-wise panels", p.Key)
		}
	}
	// The volume trends themselves are untouched.
	got := map[string]bool{}
	for _, p := range defaultPanels("open-web-sports", nil, roles, nil, actions, map[string]bool{"linking": true}, false) {
		if p.Kind == panelTrend {
			got[p.Key] = true
		}
	}
	for _, key := range []string{"trend:linking", "trend:host"} {
		if !got[key] {
			t.Errorf("no volume trend keyed %q", key)
		}
	}
}

/*
The day-wise panels are shaped like the per-counterparty ones — same distinct
count, grouped by URLUploadDate instead of by name, pinned to their sides.
*/
func TestDayPanelsCountDistinctActionsPerUploadDate(t *testing.T) {
	want := map[string]struct{ needs, measure, role string }{
		dimNoticesByDay: {colSourceNoticeID, "notices", "host"},
		dimBatchesByDay: {colDelistingBatchID, "delistingBatches", "linking"},
	}
	seen := map[string]bool{}
	for _, d := range dimensionCandidates {
		w, ok := want[d.Key]
		if !ok {
			continue
		}
		seen[d.Key] = true
		if d.Column != "URLUploadDate" {
			t.Errorf("%s groups by %q, want URLUploadDate — day-wise is the whole point", d.Key, d.Column)
		}
		if d.Needs != w.needs {
			t.Errorf("%s requires %q, want %q", d.Key, d.Needs, w.needs)
		}
		if !strings.HasPrefix(d.Ident, "COUNT(DISTINCT ") {
			t.Errorf("%s counts with %q — anything else counts URLs, not actions", d.Key, d.Ident)
		}
		if d.APIMeasure != w.measure {
			t.Errorf("%s asks reports_api for %q, want %q", d.Key, d.APIMeasure, w.measure)
		}
		if d.Role != w.role {
			t.Errorf("%s is pinned to role %q, want %q — unpinned it draws on both sides", d.Key, d.Role, w.role)
		}
		if d.Viz != "value" {
			t.Errorf("%s draws as %q; one measure wants single-series bars", d.Key, d.Viz)
		}
	}
	for key := range want {
		if !seen[key] {
			t.Errorf("no dimension candidate for %q", key)
		}
	}

	// Rows in, panel rows out: timestamps fold to their day, ids are counted
	// distinctly, and the bars run in calendar order.
	rows := []map[string]any{
		{"URLUploadDate": "2026-08-23", colSourceNoticeID: "N-3"},
		{"URLUploadDate": "2026-08-22 10:00:00", colSourceNoticeID: "N-1"},
		{"URLUploadDate": "2026-08-22 15:30:00", colSourceNoticeID: "N-1"},
		{"URLUploadDate": "2026-08-22", colSourceNoticeID: "N-2"},
		{"URLUploadDate": "2026-08-23", colSourceNoticeID: nil},
	}
	out := enforcementDayPanel(rows, "URLUploadDate", colSourceNoticeID)
	if len(out) != 2 {
		t.Fatalf("want 2 days, got %d: %v", len(out), out)
	}
	if l := strFromAny(out[0]["label"]); l != "2026-08-22" {
		t.Errorf("first bar is %q — the panel must run in calendar order", l)
	}
	if n := numOf(out[0]["urls"]); n != 2 {
		t.Errorf("22 Aug counted %d, want 2 — 3 means rows were counted, not notices", n)
	}
	if n := numOf(out[1]["urls"]); n != 1 {
		t.Errorf("23 Aug counted %d, want 1 — the nil-id row is a URL, not an action", n)
	}
}

/*
The configuration screen calls a trend card exactly what the report calls it.

They disagreed: the report titled a card "Day-on-Day Linking Identification &
De-Indexing" from the data in front of it, while panelName said "Linking
identification over time" — the same panel under two names, with nothing an
admin could match the two lists by. One function owns the name now.

The grain is deliberately absent. "Day-on-Day" becomes "Month-on-Month" when the
reader changes the range, so a name carrying it could not stay true to a layout
stored once.
*/
func TestATrendCardIsNamedTheSameOnBothScreens(t *testing.T) {
	delisting := map[string]bool{"linking": true}

	link := trendPanelLabel("open-web-sports", "linking", delisting)
	if link != "Linking Identification & De-Indexing" {
		t.Errorf("linking trend is called %q — the report titles it "+
			"\"Linking Identification & De-Indexing\"", link)
	}
	/* Only the linking side has a delisting figure, so the host card must name
	   removals — or it promises a series its chart does not draw. */
	host := trendPanelLabel("open-web-sports", "host", delisting)
	if host != "Host Identification & Removal" {
		t.Errorf("host trend is called %q, want \"Host Identification & Removal\"", host)
	}
	for _, name := range []string{link, host} {
		if strings.Contains(name, "Day-on-Day") || strings.Contains(name, "Month-on-Month") {
			t.Errorf("%q carries the grain, which flips under the reader", name)
		}
	}

	// panelName defers to it, so the configuration screen reads the same string.
	for _, role := range []string{"linking", "host"} {
		want := trendPanelLabel("open-web-sports", role, delisting)
		got := panelName(panelDef{Kind: panelTrend, Role: role, Label: want})
		if got != want {
			t.Errorf("panelName(%s) = %q, want %q", role, got, want)
		}
	}

	// And the panels defaultPanels builds carry it, or the report has no `label`
	// to prefer and falls back to computing a name of its own.
	byKey := map[string]panelDef{}
	for _, p := range defaultPanels("open-web-sports", nil, []string{"linking", "host"}, nil,
		map[string]string{}, delisting, false) {
		byKey[p.Key] = p
	}
	if got := byKey["trend:linking"].Label; got != "Linking Identification & De-Indexing" {
		t.Errorf("the linking trend panel carries label %q", got)
	}
	if got := byKey["rate"].Label; got != "Removal rate" {
		t.Errorf("the rate panel carries label %q, want \"Removal rate\"", got)
	}
}

/*
The portal asks reports_api for measures that exist over there.

These names are a contract with a separate service (internal/api/datasets.go in
reports_api): `noticesSent` and `delistingBatches` on the two sports raw
datasets. A mismatch is silent — apiMeasureFor simply finds nothing and the tile
and both panels come back empty, with the service healthy the whole time.
*/
func TestTheMeasureNamesMatchTheService(t *testing.T) {
	for portal, want := range map[string]string{
		"notices":          "noticesSent",
		"delistingBatches": "delistingBatches",
	} {
		found := false
		for _, m := range apiMeasure[portal] {
			if m == want {
				found = true
			}
		}
		if !found {
			t.Errorf("the portal's %q figure does not accept the service's %q measure; "+
				"it accepts %v", portal, want, apiMeasure[portal])
		}
	}
}

/*
The page's own copies of the two new names.

app/admin/reports/page.tsx carries KPI_LABELS and DIM_FILTER, both of which say
they mirror this package. A tile whose label is missing renders as its raw
metric key; a breakdown missing from DIM_FILTER renders fine and cross-filters
nothing.
*/
func TestPageMirrorsTheEnforcementNames(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "app", "admin", "reports", "page.tsx"))
	if err != nil {
		t.Skipf("reports page not readable from here: %v", err)
	}
	page := string(raw)

	if !strings.Contains(page, "delistingBatches: '"+kpiTileLabels["delistingBatches"]+"'") {
		t.Errorf("the page does not label delistingBatches as %q",
			kpiTileLabels["delistingBatches"])
	}
	for _, dim := range []string{dimHSPNotices, dimEngineDelistingBatches} {
		if !strings.Contains(page, dim+": '"+DIMFilterParam(dim)+"'") {
			t.Errorf("the page maps no %s → %q; clicking that panel would cross-filter nothing",
				dim, DIMFilterParam(dim))
		}
	}
	/* The two day-wise panels are breakdowns now, so the page needs no
	   action-trend branch — and must not grow one back. `p.metric` on a trend
	   panel was what drew the Day-on-Day cards that read a flat zero. */
	if strings.Contains(page, "p.metric && src") {
		t.Error("the action-trend branch is back on the page — that card drew zero " +
			"every day and was replaced by the day-wise breakdown panels")
	}
	/* Every panel the layout declares must DRAW, even with nothing behind it.
	   Returning null left Report Configuration listing panels that were nowhere
	   to be found on the report — the mismatch this NoData state fixes. */
	if !strings.Contains(page, "NoData") {
		t.Error("the page has no empty state — a panel with no data vanishes, and " +
			"the layout then lists a card the reader cannot find")
	}
}
