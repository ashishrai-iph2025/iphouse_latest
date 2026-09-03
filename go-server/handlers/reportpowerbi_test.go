package handlers

/*
A platform can be an embedded Power BI report instead of a warehouse query.

These pin the parts that need no database: what an unset source kind means, and
that the data endpoint answers a Power BI platform without going anywhere near
the warehouse. The resolution itself needs dcp_module and dcp_user_module_map, so
it is checked from source the same way the other cross-boundary invariants in
this package are.
*/

import (
	"os"
	"strings"
	"testing"
)

/*
An absent source kind is a QUERIED report.

Every platform that existed before the column did is a warehouse query, and the
column was added with ALTER — so the rows that predate it read as empty string,
not as 'table'. If empty were treated as anything else, adding the column would
have silently turned every existing report into a Power BI one.
*/
func TestAnUnsetSourceKindIsATableReport(t *testing.T) {
	for _, kind := range []string{"", "table", "TABLE", " table ", "nonsense", "sql"} {
		p := platformDef{Key: "k", SourceKind: normaliseKindForTest(kind)}
		if p.isPowerBI() {
			t.Errorf("source kind %q was read as Power BI — only the exact "+
				"stored value %q may be", kind, sourceKindPowerBI)
		}
	}
	if !(platformDef{SourceKind: sourceKindPowerBI}).isPowerBI() {
		t.Error("a platform stored as powerbi is not being read as one")
	}
}

// loadPlatforms lower-cases, trims and defaults the column; this mirrors that so
// the table above exercises the values that actually reach platformDef.
func normaliseKindForTest(raw string) string {
	k := strings.ToLower(strings.TrimSpace(raw))
	if k != sourceKindPowerBI {
		return sourceKindTable
	}
	return k
}

/*
The data endpoint must answer a Power BI platform BEFORE it touches the
warehouse.

Everything after that point turns a window into SQL — the sports-period clamp,
the scope, the cache key, the eighteen aggregates. A Power BI report has no
window and no SQL, so reaching any of it would spend a warehouse round trip to
build a payload the page throws away, and would clamp dates that mean nothing.

Read from source because exercising it needs a warehouse, a cache and a platform
registry. What can be checked is the ORDER: the short-circuit sits above the line
that builds the scope.
*/
func TestPowerBIAnswersBeforeTheWarehouseIsTouched(t *testing.T) {
	src, err := os.ReadFile("reports.go")
	if err != nil {
		t.Fatalf("read reports.go: %v", err)
	}
	body := string(src)

	guard := strings.Index(body, "if p.isPowerBI() {")
	if guard < 0 {
		t.Fatal("the data endpoint no longer short-circuits Power BI platforms")
	}

	/* Scoped to the ENCLOSING function, which the first version of this test was
	   not — and it failed on correct code as a result. reports.go builds a scope
	   in ReportsOptions as well, earlier in the file, so a search from position
	   zero finds that one and concludes the guard comes after it. The comparison
	   only means anything within one function. */
	const decl = "\nfunc "
	funcStart := strings.LastIndex(body[:guard], decl)
	if funcStart < 0 {
		t.Fatal("could not find the function the guard sits in")
	}
	funcEnd := len(body)
	if next := strings.Index(body[guard:], decl); next >= 0 {
		funcEnd = guard + next
	}
	fn := body[funcStart:funcEnd]
	guardIn := strings.Index(fn, "if p.isPowerBI() {")

	scopeIn := strings.Index(fn, "scope := flatQuery(q)")
	if scopeIn < 0 {
		t.Fatal("this function no longer builds a SQL scope — the test needs updating")
	}
	if guardIn > scopeIn {
		t.Error("the Power BI short-circuit is AFTER the scope is built. Everything " +
			"below that line is about turning a window into SQL, which an embed " +
			"has none of — this spends a warehouse round trip on a payload the " +
			"page discards.")
	}

	if clampIn := strings.Index(fn, "clampToSportsPeriod(scope, period)"); clampIn >= 0 && guardIn > clampIn {
		t.Error("the Power BI short-circuit is after the sports-period clamp, " +
			"which would clamp dates that mean nothing for an embed")
	}
}

/*
Saving 'powerbi' without a dashboard must be refused.

A platform set to Power BI with no module is a report nobody can open: the
reader gets an explanation, but only after loading a page that was never going
to work. It is a 422 at the point of saving instead.
*/
func TestSavingPowerBIRequiresADashboard(t *testing.T) {
	src, err := os.ReadFile("reportplatforms.go")
	if err != nil {
		t.Fatalf("read reportplatforms.go: %v", err)
	}
	body := string(src)

	if !strings.Contains(body, "Choose which dashboard this Power BI report is") {
		t.Error("saving a Power BI platform no longer requires a module — a " +
			"platform with none is a report that cannot be opened")
	}
	/* And the module is checked to EXIST. Without it the failure moves to the
	   reader: a platform pointing at a deleted module fails on the report page,
	   where nothing can explain it. */
	if !strings.Contains(body, "That dashboard no longer exists") {
		t.Error("the chosen module is not verified against dcp_module")
	}
	/* A module is only stored when the kind is powerbi. Kept for a table report
	   it would be a value that changes nothing, waiting to confuse the next
	   person who reads the row. */
	if !strings.Contains(body, "if kind == sourceKindPowerBI {") {
		t.Error("the module is no longer gated on the source kind")
	}
}
