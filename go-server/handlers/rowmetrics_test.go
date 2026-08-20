package handlers

import (
	"testing"

	"github.com/ip-house/iphouse-api/reportsapi"
)

func socialDS() reportsapi.Dataset {
	return reportsapi.Dataset{
		Key:       "social",
		Measures:  []string{"identified", "views", "subscribers"},
		DateParam: "URLUploadDate",
		Columns: []string{
			"SourceId", "URLUploadDate", "Platform", "RemovalStatus",
			"RemovalProfileStatus", "ProfileURL", "Subscribers", "InfringementTypeId",
		},
		Dimensions: []reportsapi.Dim{
			{Key: "infringementTypeId", Column: "InfringementTypeId", LabelColumn: "InfringementTypeName"},
			{Key: "platform", Column: "Platform"},
		},
	}
}

/*
A dataset the service CAN count for must be left alone.

The summary is faster and authoritative. Counting rows over the top of it would
be slower and would drift from it the moment either side changed.
*/
func TestRowRemovalsOnlyWhereTheServiceCannotAnswer(t *testing.T) {
	ds := socialDS()
	if !needsRowRemovals(ds) {
		t.Error("a dataset with RemovalStatus and no removed measure should be counted from rows")
	}

	ds.Measures = append(ds.Measures, "removed")
	if needsRowRemovals(ds) {
		t.Error("a dataset that declares a removed measure was overridden by the row count")
	}

	// And a dataset that can answer neither way is left alone rather than
	// reported as zero removals out of zero.
	bare := reportsapi.Dataset{Measures: []string{"identified"}, Columns: []string{"URLId"}}
	if needsRowRemovals(bare) {
		t.Error("a dataset with no removal signal at all was counted from rows")
	}
}

/*
'Dead' and 'DEAD' are the same removal.

Not defensive coding: one client's year holds 13,267 of the first and 2,378 of
the second. An exact match drops fifteen per cent of the removals and then
reports the result as the removal rate.
*/
func TestDeadIsMatchedWhateverItsCase(t *testing.T) {
	rows := []map[string]any{
		{"RemovalStatus": "Dead"}, {"RemovalStatus": "DEAD"}, {"RemovalStatus": " dead "},
		{"RemovalStatus": "Active"}, {"RemovalStatus": "ACTIVE"}, {"RemovalStatus": nil}, {},
	}
	m := computeRowMetrics(rows, "", nil)
	if m.removed != 3 {
		t.Errorf("removed = %d, want 3", m.removed)
	}
}

/*
An account's audience is counted ONCE, at its largest.

The same profile appears on every post it made, carrying a subscriber snapshot
each time. Summing the column counts that audience once per post — which is how
the tile read 2.1 billion where the accounts hold 1.4 million.
*/
func TestSubscribersCountedOncePerProfile(t *testing.T) {
	rows := []map[string]any{
		{"RemovalProfileStatus": "Dead", "ProfileURL": "https://x.com/a", "Subscribers": float64(100)},
		{"RemovalProfileStatus": "DEAD", "ProfileURL": "https://x.com/a", "Subscribers": float64(150)},
		{"RemovalProfileStatus": "Dead", "ProfileURL": "https://x.com/a", "Subscribers": float64(120)},
		{"RemovalProfileStatus": "Dead", "ProfileURL": "https://x.com/b", "Subscribers": float64(7)},
		// Still up: its audience was never taken off the table, so it is not
		// part of what the takedowns achieved.
		{"RemovalProfileStatus": "Active", "ProfileURL": "https://x.com/c", "Subscribers": float64(9999)},
		// No URL to be distinct by.
		{"RemovalProfileStatus": "Dead", "ProfileURL": "", "Subscribers": float64(500)},
	}
	m := computeRowMetrics(rows, "", nil)

	if m.profilesSuspended != 2 {
		t.Errorf("profiles suspended = %d, want 2 (a and b)", m.profilesSuspended)
	}
	// 150 (a's largest, not 100+150+120) + 7.
	if m.impactedSubscribers != 157 {
		t.Errorf("impacted subscribers = %d, want 157", m.impactedSubscribers)
	}
}

/*
The post's status and the account's status are different questions.

A post can come down while the account stays up, and an account can be suspended
with its posts still listed. Reading one from the other would make both wrong.
*/
func TestPostAndProfileStatusAreCountedSeparately(t *testing.T) {
	rows := []map[string]any{
		{"RemovalStatus": "Dead", "RemovalProfileStatus": "Active", "ProfileURL": "u1", "Subscribers": float64(5)},
		{"RemovalStatus": "Active", "RemovalProfileStatus": "Dead", "ProfileURL": "u2", "Subscribers": float64(9)},
	}
	m := computeRowMetrics(rows, "", nil)
	if m.removed != 1 {
		t.Errorf("removed = %d, want 1", m.removed)
	}
	if m.profilesSuspended != 1 || m.impactedSubscribers != 9 {
		t.Errorf("profiles = %d subs = %d, want 1 and 9", m.profilesSuspended, m.impactedSubscribers)
	}
}

// Removals are filed by day so the trend and the removal rate stop reading 0%
// under a tile that says 37%.
func TestRemovalsAreFiledByDay(t *testing.T) {
	rows := []map[string]any{
		{"RemovalStatus": "Dead", "URLUploadDate": "2026-06-01"},
		{"RemovalStatus": "Dead", "URLUploadDate": "2026-06-01"},
		{"RemovalStatus": "Dead", "URLUploadDate": "2026-06-02T13:45:00Z"},
		{"RemovalStatus": "Active", "URLUploadDate": "2026-06-01"},
	}
	m := computeRowMetrics(rows, "URLUploadDate", nil)
	if m.removedByDay["2026-06-01"] != 2 {
		t.Errorf("1 June = %d, want 2", m.removedByDay["2026-06-01"])
	}
	// A datetime is filed under its date, or no bucket would ever match it.
	if m.removedByDay["2026-06-02"] != 1 {
		t.Errorf("2 June = %d, want 1", m.removedByDay["2026-06-02"])
	}
	if got := dayKey("2026-06-02T13:45:00Z"); got != "2026-06-02" {
		t.Errorf("dayKey = %q, want 2026-06-02", got)
	}
}

/*
An empty grouping value is filed under "(none)".

That is the literal the service produces —
COALESCE(NULLIF(CAST(col AS CHAR),”),'(none)') — and counting removals under ""
while the breakdown filed its rows under "(none)" leaves that bar at zero. It is
usually the largest bar on the panel.
*/
func TestGroupTalliesMatchTheServicesOwnLabels(t *testing.T) {
	rows := []map[string]any{
		{"RemovalStatus": "Dead", "Platform": "Twitter"},
		{"RemovalStatus": "Dead", "Platform": "Twitter"},
		{"RemovalStatus": "Dead", "Platform": ""},
		{"RemovalStatus": "Dead", "Platform": nil},
		{"RemovalStatus": "Active", "Platform": "Twitter"},
	}
	m := computeRowMetrics(rows, "", []string{"Platform"})
	if m.removedByCol["Platform"]["Twitter"] != 2 {
		t.Errorf("Twitter = %d, want 2", m.removedByCol["Platform"]["Twitter"])
	}
	if m.removedByCol["Platform"]["(none)"] != 2 {
		t.Errorf("(none) = %d, want 2", m.removedByCol["Platform"]["(none)"])
	}
	if got := groupValue("  "); got != "(none)" {
		t.Errorf("groupValue(blank) = %q, want (none)", got)
	}
}

/*
The tally has to be keyed by the column the SERVICE grouped by.

The portal asks for AssetName; the dataset groups on AssetId and labels with
AssetName, so the breakdown's `value` is an id. Tallying rows by the name would
match none of them and every orange bar would read zero.
*/
func TestColumnForDimIsTheGroupingColumn(t *testing.T) {
	ds := socialDS()
	key, ok := ds.DimByColumn("InfringementTypeName")
	if !ok || key != "infringementTypeId" {
		t.Fatalf("DimByColumn(InfringementTypeName) = %q, %v", key, ok)
	}
	if col := ds.ColumnForDim(key); col != "InfringementTypeId" {
		t.Errorf("ColumnForDim(%q) = %q, want InfringementTypeId", key, col)
	}
	if col := ds.ColumnForDim("nope"); col != "" {
		t.Errorf("an unknown dimension returned %q", col)
	}
}

func TestDateColOfFindsTheBucketColumn(t *testing.T) {
	if col := dateColOf(socialDS()); col != "URLUploadDate" {
		t.Errorf("dateColOf = %q, want URLUploadDate", col)
	}
	// A dataset naming a parameter that is not a column files nothing by day,
	// and the series keeps whatever the service gave it.
	odd := reportsapi.Dataset{DateParam: "SomeParam", Columns: []string{"A", "B"}}
	if col := dateColOf(odd); col != "" {
		t.Errorf("dateColOf = %q, want empty", col)
	}
}

/*
The cheap path has to be chosen wherever it exists, and never over a measure the
service already provides.

This is what keeps the sports summary affordable: two of its five tables have no
`removed` measure, and both can be FILTERED on removal status. Reading their
rows to count removals — nine sequential page requests for one client's year —
sat on the critical path of every uncached report and every filter click.
*/
func TestRemovalsPreferTheFilterOverPagingRows(t *testing.T) {
	ds := socialDS() // no removed measure, RemovalStatus is a dimension
	ds.Dimensions = append(ds.Dimensions, reportsapi.Dim{Key: "removalStatus", Column: "RemovalStatus"})

	key, ok := removalStatusFilter(ds)
	if !ok || key != "removalStatus" {
		t.Fatalf("removalStatusFilter = (%q, %v), want removalStatus", key, ok)
	}

	// A dataset the service can already count for must never be second-guessed
	// by a filtered re-query: the measure is authoritative and cheaper still.
	served := ds
	served.Measures = append(served.Measures, "removed")
	if _, ok := removalStatusFilter(served); ok {
		t.Error("a dataset with a removed measure was routed through the filter path")
	}

	// And a dataset with neither has nothing to filter by, so it falls back to
	// the rows rather than silently reporting no removals.
	noDim := socialDS()
	if _, ok := removalStatusFilter(noDim); ok {
		t.Error("a dataset with no removal-status dimension offered a filter key")
	}
	if !needsRowRemovals(noDim) {
		t.Error("that dataset should still be counted from rows")
	}
}
