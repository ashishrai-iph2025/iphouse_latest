package handlers

import (
	"strings"
	"testing"
)

/*
The warehouse's shape must not leave with the figures.

Every case below is a channel that WAS carrying schema to readers the rest of
reportsources.go exists to keep it from — a client login among them. They are
pinned together because they are one rule, and the way this regresses is one of
them being reintroduced in isolation while the others still look correct.
*/

// The realtime card's tooltip read "Open Web — mediascan._InternetURLsNEW ·
// counted on URLUploadDate", to anyone with the card on screen. The tooltip is
// gone; this pins the payload behind it, which is what the tooltip was reading
// and what devtools would show whether a tooltip existed or not.
func TestRealtimeReadingCarriesNoSchema(t *testing.T) {
	removed := int64(8202)
	ps := []RealtimePlatform{
		{Key: "openweb", Label: "Open Web", Count: 68084,
			Removed: &removed, RemovedWhen: "d.InfringingRemovalStatus = 'Approved'",
			Table: "mediascan._InternetURLsNEW", DateColumn: "URLUploadDate"},
		{Key: "youtube", Label: "YouTube", Count: 534,
			Table: "mediascan.SocialMedia", DateColumn: "UploadDate"},
	}
	scrubRealtimeSchema(ps)

	for _, p := range ps {
		if p.Table != "" || p.DateColumn != "" {
			t.Errorf("%s still names %q/%q", p.Key, p.Table, p.DateColumn)
		}
		// The removal predicate arrived later and is the same disclosure wearing
		// friendlier clothes — a column, an alias and a magic string.
		if p.RemovedWhen != "" {
			t.Errorf("%s still carries the removal predicate %q", p.Key, p.RemovedWhen)
		}
		if strings.Contains(p.RemovalBasis, "Status") || strings.Contains(p.RemovalBasis, ".") {
			t.Errorf("%s described its removals with schema: %q", p.Key, p.RemovalBasis)
		}
		// The count is the point of the card and must survive untouched.
		if p.Count == 0 || p.Label == "" {
			t.Errorf("%s lost the figure the card exists to show", p.Key)
		}
	}
	// The figure the predicate was carrying must not be scrubbed along with it,
	// and it must still be readable as "what kind of removal is this".
	if ps[0].Removed == nil || *ps[0].Removed != 8202 {
		t.Errorf("openweb lost its removal count: %v", ps[0].Removed)
	}
	if ps[0].RemovalBasis == "" {
		t.Error("openweb removals lost the one thing that distinguished them — " +
			"an approved notice is not a URL that went away")
	}
	// A platform the view never asked about must stay silent rather than
	// acquiring a description of removals it did not count.
	if ps[1].Removed != nil || ps[1].RemovalBasis != "" {
		t.Errorf("youtube invented removals: %v / %q", ps[1].Removed, ps[1].RemovalBasis)
	}
}

/*
The two spellings of "removed" must not be described alike.

Thirteen platforms record the removal themselves — the URL is gone — while Open
Web counts an APPROVED DELISTING NOTICE, which is a request that was granted
rather than an observed outcome. The card stacks them in one bar, so the words
beside the bar are the only place that difference survives.
*/
func TestRemovalBasisSeparatesNoticesFromDeadURLs(t *testing.T) {
	notice := removalBasis("d.InfringingRemovalStatus = 'Approved'")
	dead := removalBasis("t.RemovalStatus = 'Dead'")
	if notice == dead {
		t.Fatalf("both predicates described as %q", notice)
	}
	if !strings.Contains(notice, "delisting") {
		t.Errorf("the Open Web predicate reads as %q, which does not say a notice was approved", notice)
	}
	if !strings.Contains(dead, "reachable") {
		t.Errorf("the dead-URL predicate reads as %q", dead)
	}
	// An unrecognised predicate gets NO description. The figure is still
	// "removed", which is true; inventing which kind would not be.
	if got := removalBasis("x.SomethingNew = 1"); got != "" {
		t.Errorf("guessed at an unknown predicate: %q", got)
	}
	if removalBasis("") != "" {
		t.Error("a view that reports no removals must describe none")
	}
}

// /api/reports/data answers client logins. It used to answer them with the list
// of tables the report read, the ones it skipped, and warning text quoting the
// table a query failed against.
func TestReportPayloadDropsTablesAndKeepsFigures(t *testing.T) {
	out := map[string]any{
		"ok":            true,
		"kpi":           map[string]any{"identified": 68084},
		"table":         "mediascan._InternetURLsNEW",
		"tables":        []string{"mediascan._InternetURLsNEW", "mediascan.SocialMedia"},
		"skippedTables": []string{"mediascan.Telegram", "mediascan.VK"},
		"queryWarning":  "3 of this report's queries failed against mediascan._InternetURLsNEW: unknown column",
		"notices":       []string{"folded from a partial list on mediascan.SocialMedia"},
	}
	scrubReportPayload(out)

	for _, k := range []string{"table", "tables", "skippedTables"} {
		if _, still := out[k]; still {
			t.Errorf("%q survived the scrub", k)
		}
	}
	// The fact of a skip is what a reader acts on — it explains a total that
	// looks short. The names are what they cannot.
	if n, _ := out["skippedSources"].(int); n != 2 {
		t.Errorf("skippedSources = %v, want 2 — the count is the actionable half", out["skippedSources"])
	}
	if out["kpi"] == nil || out["ok"] != true {
		t.Error("the report's own figures were disturbed")
	}

	// Error text is the classic way a redaction leaks: the payload is careful
	// and the message says it anyway.
	warn := strFromAny(out["queryWarning"])
	if strings.Contains(warn, "mediascan") {
		t.Errorf("queryWarning still names the warehouse: %q", warn)
	}
	if !strings.Contains(warn, "queries failed") {
		t.Errorf("queryWarning lost the reason it exists: %q", warn)
	}
	for _, n := range asStrings(out["notices"]) {
		if strings.Contains(n, "mediascan") {
			t.Errorf("notice still names the warehouse: %q", n)
		}
	}
}

// A report that failed outright answers through "error" rather than
// "queryWarning", and that path reaches the same readers.
func TestReportPayloadRedactsOutrightFailure(t *testing.T) {
	out := map[string]any{
		"ok":    false,
		"error": "Error 1054: Unknown column 'ClientId' in 'dashboards.SportsURLRawData'",
	}
	scrubReportPayload(out)
	got := strFromAny(out["error"])
	if strings.Contains(got, "dashboards.SportsURLRawData") {
		t.Errorf("error still names the table: %q", got)
	}
	if got == "" {
		t.Error("the reason was dropped entirely — a reader can act on 'unknown column'")
	}
}

// redactWarehouseNames is deliberately blunt, and the blunt cases are the ones
// worth pinning: a URL names the reports service, a qualified name names a
// table, and both arrive inside otherwise useful sentences.
func TestRedactWarehouseNamesTakesQualifiedNamesAndURLs(t *testing.T) {
	got := redactWarehouseNames(
		"GET https://reports.internal/v1/query failed reading mediascan._InternetURLsNEW", "a data source")
	if strings.Contains(got, "reports.internal") || strings.Contains(got, "_InternetURLsNEW") {
		t.Errorf("redaction let an identifier through: %q", got)
	}
	if redactWarehouseNames("", "x") != "" {
		t.Error("an empty message should stay empty rather than becoming an alias")
	}
}

// Scrubbing must not panic on a report that carries none of these keys — most
// do not — nor on a nil payload from a failed run.
func TestScrubReportPayloadToleratesAbsentKeys(t *testing.T) {
	out := map[string]any{"ok": true}
	scrubReportPayload(out)
	if _, added := out["skippedSources"]; added {
		t.Error("skippedSources invented where nothing was skipped")
	}
	scrubReportPayload(nil)
}
