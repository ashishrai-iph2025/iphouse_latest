package handlers

/*
Enforcement ACTIONS, as opposed to the URLs they covered.

Open Web - Sports is the only report whose tables record the enforcement itself
rather than only its effect. Two columns carry it, one on each half:

	SportsSourceURLRawData   SourceDMCANoticeId   the notice sent to a host
	SportsURLRawData         DelistingBatchId     the batch sent to an engine

Both are stamped on EVERY row the action covered. One notice listing forty
thousand source URLs is one notice and forty thousand rows; one delisting batch
is one submission and every link in it. So the row count answers "how many links
did we enforce on" — a number four orders of magnitude larger, already on the
page as `identified`, and easy to mistake for this one.

Which is why every figure in this file is a COUNT(DISTINCT) and why none of them
is ever added across tables: the two ids live on different tables and mean
different things, and the same id summed twice would be one notice reported as
two.

Three shapes come out of it, and they are the same measure asked three ways:

  - a headline total, per side          — computed from breakdown rows
  - per day, beside the volume trend    — ActionExpr / ActionKey on the spec
  - per counterparty                    — dimHSPNotices, dimEngineDelistingBatches

The daily and per-counterparty forms are computed from the rows reports_api
returns: the enforcement columns (SourceDMCANoticeId, DelistingBatchId) travel
with every row, so grouping and distinct-counting is done client-side.
*/

import (
	"fmt"
	"sort"
	"strings"

	"github.com/ip-house/iphouse-api/db"
)

// The warehouse's names for the two ids. Named once because four different
// places count them and a fifth checks whether the column is there at all.
const (
	colSourceNoticeID   = "SourceDMCANoticeId"
	colDelistingBatchID = "DelistingBatchId"
)

// The breakdown panels, keyed as the page and the layout know them. Two count
// per counterparty (who the action went to), two count per DAY (when it went
// out) — the day pair replaced a Day-on-Day trend card that read zero because
// the daily timeseries never carried the action ids.
const (
	dimHSPNotices             = "byHSPNotices"
	dimEngineDelistingBatches = "byDelistingBatchEngine"
	dimNoticesByDay           = "byNoticeDay"
	dimBatchesByDay           = "byDelistingBatchDay"
	/* The provider on the LINKING side. The host table records the notice a
	   provider received; the linking table records the de-indexing submissions
	   that covered links it hosts, and it carries HSPName on every row — 680
	   distinct providers against the host side's 469. Same counterparty, other
	   half of the report, so it is its own panel rather than an extension of the
	   one above: the two count different actions and must not be added. */
	dimHSPDelisting = "byDelistingBatchHSP"
)

/*
isActionPanel says whether a breakdown is one of the enforcement panels.

They share a mechanism nothing else uses — a DISTINCT over an id the service
aggregates away, which the bridge answers by walking raw rows instead — so two
places have to recognise the whole set. They used to name the keys inline, twice,
and the comment there admitted the list had already been wrong once: only the
counterparty pair was listed, and the day pair rode along by accident because
both are added for the same role.

One list, because a FIFTH panel is exactly the change that would have been made
in one place and forgotten in the other.
*/
func isActionPanel(key string) bool {
	switch key {
	case dimHSPNotices, dimEngineDelistingBatches, dimHSPDelisting,
		dimNoticesByDay, dimBatchesByDay:
		return true
	}
	return false
}

/*
actionMeasures is the enforcement action a table records, if any — used to give
each side of the report its own daily action trend, its own headline tile and
its own per-counterparty panel.

`Role` is which side of a two-table report OWNS the action, and it is what the
matching pins on — not column presence. The two sports raw tables carry shared
enforcement columns now, so "the column is there" can be true of both tables;
ownership is not symmetrical. The notice was sent to the HOST and the batch to
the engines that indexed the LINKS, and counting either from the other side's
table reports the same actions twice.

`Label` is what the card and its legend call the figure. It is a property of the
MEASURE rather than of the panel, so the trend, the tile and the table twin
cannot end up calling the same number three things.
*/
var actionMeasures = []struct{ Key, Column, Label, Role string }{
	{Key: "notices", Column: colSourceNoticeID, Label: "Notices sent", Role: "host"},
	{Key: "delistingBatches", Column: colDelistingBatchID, Label: "De-Indexing", Role: "linking"},
}

// actionLabelFor is the display name for an action key, for the places that
// have the key and not the spec that resolved it.
func actionLabelFor(key string) string {
	for _, a := range actionMeasures {
		if a.Key == key {
			return a.Label
		}
	}
	return key
}

/* ── Counting an action off the ROWS ──────────────────────────────────────────

   RAW rows, and this is the whole point of the three functions below.

   A breakdown from reports_api is already grouped: one row per HSPName carrying
   the measures the service declares, and `SourceDMCANoticeId` is not among them
   — the id does not survive the aggregation, so there is nothing left to count
   distinct values of. Counting a breakdown gives every provider zero, which is
   how this was wrong the first time and it looked exactly like an empty panel.

   The raw rows still carry every column, the id included, so the DISTINCT is
   walked here instead. They are the same rows the repeat-offenders panel and
   the turnaround bands already page, read once and shared — see allRows in
   reportsapi_bridge.go. */

// rowKeyFor is the key a row map actually uses for a column.
//
// The catalogue's spelling and the row's are normally identical, and the exact
// hit is the first thing tried. The case-insensitive sweep behind it is for the
// one that is not — a column returned as `hspName` against a catalogue saying
// `HSPName` would otherwise read as absent on every row and count zero, which
// is indistinguishable from a provider that was genuinely never noticed.
func rowKeyFor(rows []map[string]any, col string) string {
	if col == "" {
		return col
	}
	// Several rows, not just the first: a column is missing from a row when its
	// value is null, and the first row is as likely as any to be the null one.
	probe := len(rows)
	if probe > 20 {
		probe = 20
	}
	for i := 0; i < probe; i++ {
		if _, ok := rows[i][col]; ok {
			return col
		}
	}
	lc := strings.ToLower(col)
	for i := 0; i < probe; i++ {
		for k := range rows[i] {
			if strings.ToLower(k) == lc {
				return k
			}
		}
	}
	return col
}

// enforcementTotal is the headline figure: how many distinct actions the window
// holds, however many URLs each of them covered.
func enforcementTotal(rows []map[string]any, idCol string) int64 {
	idCol = rowKeyFor(rows, idCol)
	seen := make(map[string]struct{}, 256)
	for _, r := range rows {
		if id := strFromAny(r[idCol]); id != "" {
			seen[id] = struct{}{}
		}
	}
	return int64(len(seen))
}

// enforcementByDay is the same count per day, keyed the way the daily rows are
// so the caller can patch them in place.
//
// An action spanning two days is counted on both, because the row it is stamped
// on is what dates it — the question the card answers is "what went out that
// day", and a notice covering URLs uploaded on the Monday and the Tuesday was
// working on both.
func enforcementByDay(rows []map[string]any, dateCol, idCol string) map[string]int64 {
	dateCol = rowKeyFor(rows, dateCol)
	idCol = rowKeyFor(rows, idCol)

	perDay := make(map[string]map[string]struct{}, 64)
	for _, r := range rows {
		id := strFromAny(r[idCol])
		if id == "" {
			continue
		}
		day := dayKey(strFromAny(r[dateCol]))
		if day == "" {
			continue
		}
		if perDay[day] == nil {
			perDay[day] = make(map[string]struct{}, 16)
		}
		perDay[day][id] = struct{}{}
	}

	out := make(map[string]int64, len(perDay))
	for day, ids := range perDay {
		out[day] = int64(len(ids))
	}
	return out
}

/*
enforcementDayPanel is the day-wise panel: how many distinct actions went out on
each URLUploadDate — the same figure enforcementByDay computes, shaped as panel
rows so the card draws exactly like the per-counterparty ones beside it.

Chronological order rather than count-descending: the reader of a day-wise card
is following the calendar, and the busiest-day-first order the other panels use
would shuffle the days.
*/
func enforcementDayPanel(rows []map[string]any, dateCol, idCol string) []map[string]any {
	byDay := enforcementByDay(rows, dateCol, idCol)
	days := make([]string, 0, len(byDay))
	for d := range byDay {
		days = append(days, d)
	}
	sort.Strings(days)
	out := make([]map[string]any, 0, len(days))
	for _, d := range days {
		out = append(out, map[string]any{
			"label": d, "value": d,
			"urls": byDay[d], "removed": int64(0),
		})
	}
	return out
}

/*
enforcementByGroup is the per-counterparty panel: how many distinct actions each
provider or engine was on the receiving end of.

`removed` is a flat zero on every row and that is deliberate. A notice is sent
or it is not; "how many of them came down" is a question about the URLs it
covered, and that figure is the panel above this one. Emitting the key anyway
keeps the row shape identical to every other breakdown, so the Table view and
the cross-filter need no special case.
*/
func enforcementByGroup(rows []map[string]any, groupCol, idCol string, limit int) []map[string]any {
	groupCol = rowKeyFor(rows, groupCol)
	idCol = rowKeyFor(rows, idCol)

	byLabel := make(map[string]map[string]struct{}, 64)
	for _, r := range rows {
		id := strFromAny(r[idCol])
		if id == "" {
			continue
		}
		label := strings.TrimSpace(strFromAny(r[groupCol]))
		if label == "" {
			label = "Unknown"
		}
		if byLabel[label] == nil {
			byLabel[label] = make(map[string]struct{}, 16)
		}
		byLabel[label][id] = struct{}{}
	}

	out := make([]map[string]any, 0, len(byLabel))
	for label, ids := range byLabel {
		out = append(out, map[string]any{
			"label": label, "value": label,
			"urls": int64(len(ids)), "removed": int64(0),
		})
	}
	// Count descending, then label — so two providers on the same figure hold a
	// stable order across refreshes instead of swapping places under the reader.
	sort.SliceStable(out, func(i, j int) bool {
		a, b := numOf(out[i]["urls"]), numOf(out[j]["urls"])
		if a != b {
			return a > b
		}
		return strFromAny(out[i]["label"]) < strFromAny(out[j]["label"])
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

/*
Warehouse fallback — when reports_api does not return the enforcement columns.

The preferred path is row-level: allRows pages reports_api and the caller groups
and counts. But if reports_api omits the columns (currently true for sports), every
row is skipped and the count is zero — silent and indistinguishable from a provider
that was never noticed.

Rather than an empty panel, query the warehouse directly as a safety net. This is
NOT the normal path; it only fires when the API rows have no data to work with and
the warehouse is configured.
*/

// enforcementViaWarehouse counts distinct id from the warehouse, over a WHERE clause.
func enforcementViaWarehouse(table, idCol string, where string, args []any) (int64, error) {
	if !db.ReportsConfigured() {
		return 0, nil // No warehouse; return 0 silently so the panel is blank, not errored.
	}
	rows, err := db.ReportsQuery(
		fmt.Sprintf("SELECT COUNT(DISTINCT %s) AS v FROM %s %s", idCol, table, where),
		args...)
	if err != nil {
		return 0, err
	}
	return numOf(firstRow(rows)["v"]), nil
}

// enforcementDailyViaWarehouse counts distinct id per day from the warehouse.
func enforcementDailyViaWarehouse(table, idCol, dateCol string, where string, args []any) (map[string]int64, error) {
	if !db.ReportsConfigured() {
		return map[string]int64{}, nil
	}
	rows, err := db.ReportsQuery(
		fmt.Sprintf(
			"SELECT DATE(%s) AS d, COUNT(DISTINCT %s) AS v FROM %s %s GROUP BY d",
			dateCol, idCol, table, where),
		args...)
	if err != nil {
		return nil, err
	}
	out := make(map[string]int64, len(rows))
	for _, r := range rows {
		out[dayKey(strFromAny(r["d"]))] = numOf(r["v"])
	}
	return out, nil
}

// enforcementDayPanelViaWarehouse is enforcementDayPanel's fallback: the same
// day-wise distinct count read straight from the warehouse, shaped as panel rows
// in calendar order.
func enforcementDayPanelViaWarehouse(table, dateCol, idCol string, where string, args []any) ([]map[string]any, error) {
	byDay, err := enforcementDailyViaWarehouse(table, idCol, dateCol, where, args)
	if err != nil {
		return nil, err
	}
	days := make([]string, 0, len(byDay))
	for d := range byDay {
		days = append(days, d)
	}
	sort.Strings(days)
	out := make([]map[string]any, 0, len(days))
	for _, d := range days {
		out = append(out, map[string]any{
			"label": d, "value": d,
			"urls": byDay[d], "removed": int64(0),
		})
	}
	return out, nil
}

// enforcementGroupViaWarehouse counts distinct id per group label from the warehouse.
func enforcementGroupViaWarehouse(table, groupCol, idCol string, where string, args []any, limit int) ([]map[string]any, error) {
	if !db.ReportsConfigured() {
		return []map[string]any{}, nil
	}
	limitStr := ""
	if limit > 0 {
		limitStr = fmt.Sprintf(" LIMIT %d", limit)
	}
	rows, err := db.ReportsQuery(
		fmt.Sprintf(
			"SELECT COALESCE(%s,'Unknown') AS label, COUNT(DISTINCT %s) AS urls FROM %s %s GROUP BY %s ORDER BY urls DESC%s",
			groupCol, idCol, table, where, groupCol, limitStr),
		args...)
	if err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0, len(rows))
	for _, r := range rows {
		out = append(out, map[string]any{
			"label":   strFromAny(r["label"]),
			"value":   strFromAny(r["label"]),
			"urls":    numOf(r["urls"]),
			"removed": int64(0),
		})
	}
	return out, nil
}
