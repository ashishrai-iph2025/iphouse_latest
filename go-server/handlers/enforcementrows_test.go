package handlers

// Counting an enforcement action off the ROWS.
//
// Every test here exists because the version that counted a BREAKDOWN shipped
// and looked right: reports_api answers a breakdown with one row per group
// carrying the measures it declares, the notice id is not among them, and a
// DISTINCT over that is zero for every provider. An all-zero panel draws as an
// empty one, which is indistinguishable from a provider nobody has noticed.

import (
	"strings"
	"testing"
)

/*
The panels count RAW rows, because a breakdown has aggregated the id away.

Both halves are asserted — the raw rows give the true count, the breakdown shape
gives nothing — so a future edit cannot quietly point this back at c.Breakdown
and still pass.
*/
func TestEnforcementPanelsCountRawRowsNotBreakdownRows(t *testing.T) {
	// One notice covering three source URLs, a second covering one, and a
	// different provider with one of its own. Six rows, three notices.
	raw := []map[string]any{
		{"HSPName": "Netulu Incorporated", colSourceNoticeID: "N-1"},
		{"HSPName": "Netulu Incorporated", colSourceNoticeID: "N-1"},
		{"HSPName": "Netulu Incorporated", colSourceNoticeID: "N-1"},
		{"HSPName": "Netulu Incorporated", colSourceNoticeID: "N-2"},
		{"HSPName": "6 COLLYER QUAY", colSourceNoticeID: "N-3"},
		// A row no notice covered: counted as a URL, never as an action.
		{"HSPName": "6 COLLYER QUAY", colSourceNoticeID: nil},
	}
	got := enforcementByGroup(raw, "HSPName", colSourceNoticeID, 0)
	if len(got) != 2 {
		t.Fatalf("want 2 providers, got %d: %v", len(got), got)
	}
	if l := strFromAny(got[0]["label"]); l != "Netulu Incorporated" {
		t.Errorf("ranked %q first; the busiest provider leads", l)
	}
	if n := numOf(got[0]["urls"]); n != 2 {
		t.Errorf("Netulu counted %d — 4 means it counted ROWS, which is the URLs "+
			"those notices covered rather than the notices", n)
	}
	if n := numOf(got[1]["urls"]); n != 1 {
		t.Errorf("6 COLLYER QUAY counted %d, want 1", n)
	}
	// Every row carries `removed`, flat zero — the same shape the other
	// breakdowns have, so the Table view needs no special case for these two.
	if _, ok := got[0]["removed"]; !ok {
		t.Error("no `removed` key; this row does not match the other breakdowns")
	}

	// And the shape that was being counted before: a breakdown, id gone.
	breakdown := []map[string]any{
		{"label": "Netulu Incorporated", "identified": int64(40000), "removed": int64(12)},
		{"label": "6 COLLYER QUAY", "identified": int64(9000), "removed": int64(3)},
	}
	if rows := enforcementByGroup(breakdown, "HSPName", colSourceNoticeID, 0); len(rows) != 0 {
		t.Errorf("a breakdown produced %v — the id is not on those rows, so any "+
			"figure at all here is invented", rows)
	}
}

/*
The daily series and the tile count the same way, off the same rows.

The tile is NOT the sum of the days. One batch covering URLs uploaded across two
days is on both, so the days add to more than the total — and the total is the
honest answer to "how many batches went out", which is what the tile asks.
*/
func TestEnforcementDailyAndTotalCountDistinctly(t *testing.T) {
	rows := []map[string]any{
		{"URLUploadDate": "2026-08-22", colDelistingBatchID: "B-1"},
		{"URLUploadDate": "2026-08-22", colDelistingBatchID: "B-1"},
		{"URLUploadDate": "2026-08-22", colDelistingBatchID: "B-2"},
		// Same batch, a second day — it covered URLs from both.
		{"URLUploadDate": "2026-08-23 04:15:00", colDelistingBatchID: "B-1"},
		{"URLUploadDate": "2026-08-23", colDelistingBatchID: ""},
	}
	byDay := enforcementByDay(rows, "URLUploadDate", colDelistingBatchID)
	if byDay["2026-08-22"] != 2 {
		t.Errorf("22 Aug counted %d, want 2 distinct batches", byDay["2026-08-22"])
	}
	/* The timestamp folds to its day, or the patch keys a bucket the trend has
	   no point for and the figure silently lands nowhere. */
	if byDay["2026-08-23"] != 1 {
		t.Errorf("23 Aug counted %d, want 1 — a timestamp must fold to its day",
			byDay["2026-08-23"])
	}
	if n := enforcementTotal(rows, colDelistingBatchID); n != 2 {
		t.Errorf("total = %d, want 2 — the batches, not the days they touched", n)
	}
}

// A column the service spells differently from the catalogue still counts.
// Without this every figure reads zero and nothing on the page says why.
func TestEnforcementCountsSurviveAColumnCaseDifference(t *testing.T) {
	rows := []map[string]any{
		{"hspname": "Netulu Incorporated", "sourcedmcanoticeid": "N-1"},
		{"hspname": "Netulu Incorporated", "sourcedmcanoticeid": "N-2"},
	}
	got := enforcementByGroup(rows, "HSPName", colSourceNoticeID, 0)
	if len(got) != 1 || numOf(got[0]["urls"]) != 2 {
		t.Errorf("a case difference lost the count: %v", got)
	}
}

/*
The resolved id column reaches the panel.

inferSpec proves the table has the id and spells it into the SQL for the direct
path. The API path has no SQL to read it back out of, so the column travels on
the dimension — and without it the panel has nothing to count and returns empty,
which is the same silent blank this whole file is about.

Seeded shapes rather than a live warehouse: the point is what inferSpec DERIVES
from a column list, and the two sports raw tables' lists are exactly this.
*/
func TestPanelsCarryTheResolvedIDColumn(t *testing.T) {
	shared := []string{"ClientId", "URLUploadDate", "SearchEngineName", "HSPName", "IsRemoved"}
	seed := func(table string, own ...string) {
		cols := map[string]string{}
		for _, c := range append(append([]string{}, shared...), own...) {
			cols[strings.ToLower(c)] = c
		}
		shapeCacheMu.Lock()
		shapeCache[table] = tableShape{Table: table, Columns: cols}
		shapeCacheMu.Unlock()
	}
	const hostT, linkT = "dashboards.__test_idcol_host", "dashboards.__test_idcol_link"
	seed(hostT, "SourceDomain", colSourceNoticeID)
	seed(linkT, "InfringingDomain", colDelistingBatchID)
	defer invalidateShapeCache()

	find := func(sp reportSpec, key string) (dimension, bool) {
		for _, d := range sp.Dimensions {
			if d.Key == key {
				return d, true
			}
		}
		return dimension{}, false
	}

	host, ok := inferSpec("open-web-sports", "Open Web - Sports", hostT)
	if !ok {
		t.Fatal("host spec not usable")
	}
	d, ok := find(host, dimHSPNotices)
	if !ok {
		t.Fatal("the host table grew no notices panel")
	}
	if d.Column != "HSPName" {
		t.Errorf("notices panel groups by %q, want HSPName", d.Column)
	}
	if d.CountDistinctCol != colSourceNoticeID {
		t.Errorf("notices panel counts %q, want %q — empty means the panel has "+
			"nothing to count and draws blank", d.CountDistinctCol, colSourceNoticeID)
	}
	if host.ActionCol != colSourceNoticeID {
		t.Errorf("host ActionCol = %q — the tile and the daily series count this",
			host.ActionCol)
	}

	linking, ok := inferSpec("open-web-sports", "Open Web - Sports", linkT)
	if !ok {
		t.Fatal("linking spec not usable")
	}
	d, ok = find(linking, dimEngineDelistingBatches)
	if !ok {
		t.Fatal("the linking table grew no delisting-batches panel")
	}
	if d.Column != "SearchEngineName" {
		t.Errorf("batches panel groups by %q, want SearchEngineName — HSPName here "+
			"would rank delisting batches by hosting provider", d.Column)
	}
	if d.CountDistinctCol != colDelistingBatchID {
		t.Errorf("batches panel counts %q, want %q", d.CountDistinctCol, colDelistingBatchID)
	}
	if linking.ActionCol != colDelistingBatchID {
		t.Errorf("linking ActionCol = %q", linking.ActionCol)
	}
}

/*
The catalogue's column list is not the whole truth, and this is why the panels
were missing.

reports_api keeps two separate lists: the columns it DECLARES for a dataset and
the fields it actually RETURNS on rows. For the sports raw datasets they
disagree — the ids come back on every row and appear in no declared list — and
apiTableShape builds the shape from the declared one. A column absent from the
shape does not exist as far as inferSpec is concerned, so no enforcement panel
was built, no action trend was offered, and nothing anywhere failed or logged.

Asserted on the table names because that is what the portal keys datasets by,
and because an entry silently lost from that map takes the visuals with it and
looks exactly like the panels being broken again.
*/
func TestRowOnlyColumnsReachTheShape(t *testing.T) {
	want := map[string]string{
		"dashboards.SportsURLRawData":       colDelistingBatchID,
		"dashboards.SportsSourceURLRawData": colSourceNoticeID,
	}
	for table, id := range want {
		cols := map[string]string{"clientid": "ClientId", "urluploaddate": "URLUploadDate"}
		addRowOnlyColumns(table, cols)

		if cols[strings.ToLower(id)] != id {
			t.Errorf("%s: %s never reached the shape — the enforcement panels and the "+
				"action trend are all derived from it, so all of them vanish", table, id)
		}
		// The provider is the column the notices panel GROUPS by. Without it the
		// panel has a count and nothing to attribute it to.
		if cols["hspname"] != "HSPName" {
			t.Errorf("%s: HSPName never reached the shape", table)
		}
	}

	/* The catalogue wins where both have the column: its spelling is what the
	   rows are keyed by, and overwriting it would be this map second-guessing
	   the service about its own columns. */
	cols := map[string]string{strings.ToLower(colSourceNoticeID): "sourceDmcaNoticeId"}
	addRowOnlyColumns("dashboards.SportsSourceURLRawData", cols)
	if got := cols[strings.ToLower(colSourceNoticeID)]; got != "sourceDmcaNoticeId" {
		t.Errorf("the union overwrote the catalogue's spelling with %q", got)
	}

	// A table not in the map is left completely alone.
	untouched := map[string]string{"clientid": "ClientId"}
	addRowOnlyColumns("dashboards.SomeOtherTable", untouched)
	if len(untouched) != 1 {
		t.Errorf("an unlisted table gained columns: %v", untouched)
	}
}
