package handlers

import (
	"os"
	"strings"
	"testing"
)

/*
Every endpoint that gates on "may this login open the report" must say WHICH
report it means.

── The bug this exists for ──────────────────────────────────────────────────

Reports and VOD Reports are deliberately separate module grants: a login can
hold one without the other (see mayOpenReport). An endpoint that asks the
unscoped wrapper therefore asks about the "Reports" module whichever page is
open — so a client granted VOD Reports, and correctly showing the VOD Reports
tab in its nav, opened the page and was told:

	Reports are not available yet
	The Reports module is not enabled for this account.

Which was true of a module they were not asking for, about a page they were not
on. ReportsSections had been made scope-aware; ReportsScope had not, and
ReportsScope is the FIRST request the client page makes — so its answer was the
whole page, and the sections endpoint never got asked.

── Why a source test ────────────────────────────────────────────────────────

Exercising the real gate needs a database, a session and an impersonation
context. The defect is not in the SQL — mayOpenReport is correct and tested by
its own callers — it is a call site asking the wrong question, which is visible
in the source and nowhere else. This fails next to the edit that causes it.
*/
func TestReportsScopeGatesOnTheScopeItWasAskedFor(t *testing.T) {
	src, err := os.ReadFile("reportclientmap.go")
	if err != nil {
		t.Fatalf("read reportclientmap.go: %v", err)
	}
	body := string(src)

	start := strings.Index(body, "func ReportsScope(")
	if start < 0 {
		t.Fatal("no ReportsScope handler — this test is checking nothing")
	}
	fn := body[start:]
	if end := strings.Index(fn[1:], "\nfunc "); end > 0 {
		fn = fn[:end+1]
	}

	/*
		It must READ the parameter. Without this the handler cannot tell the two
		pages apart however it phrases the question below.
	*/
	if !strings.Contains(fn, `r.URL.Query().Get("scope")`) {
		t.Error("ReportsScope never reads the scope parameter, so it answers for " +
			"the Reports page whichever page asked. A login holding VOD Reports " +
			"and not Reports is told the Reports module is not enabled — on the " +
			"VOD page, which it is entitled to open.")
	}

	/*
		And it must gate on the SCOPED form. mayOpenReports is the unscoped
		wrapper and resolves to pageName "Reports" — correct for the original
		page, wrong as the only question this endpoint asks.

		Checked with a trailing "(" so `mayOpenReports` cannot satisfy a search
		for `mayOpenReport`: one is a prefix of the other, and a substring test
		would pass on exactly the code that caused the bug.
	*/
	if !strings.Contains(fn, "mayOpenReport(claims, scope)") {
		t.Error("ReportsScope does not gate on mayOpenReport(claims, scope). " +
			"The unscoped mayOpenReports asks for the Reports module whatever " +
			"page is open, which is the whole of this defect.")
	}
	if strings.Contains(fn, "mayOpenReports(claims)") {
		t.Error("ReportsScope still calls the unscoped mayOpenReports — the VOD " +
			"page is gated on a module it was never asked to hold")
	}
}

/*
The client page must SEND the scope on its very first request.

A scope-aware server that is never told the scope is the same bug wearing a
different hat, and this is the one call on that page that was missing it while
its own header comment claimed the page "sends scope=vod on every request".
*/
func TestTheReportsPageSendsScopeOnTheScopeRequest(t *testing.T) {
	src, err := os.ReadFile("../../app/admin/reports/page.tsx")
	if err != nil {
		t.Skipf("reports page not readable from here: %v", err)
	}
	body := string(src)

	i := strings.Index(body, "/api/reports/scope")
	if i < 0 {
		t.Fatal("the reports page no longer calls /api/reports/scope")
	}

	/* The 300 bytes before the call: where the query string is built, following
	   the idiom every other request on this page uses. */
	from := i - 300
	if from < 0 {
		from = 0
	}
	near := body[from : i+120]

	if !strings.Contains(near, "'scope', 'vod'") {
		t.Error("the /api/reports/scope request does not carry scope=vod. The " +
			"server then gates it on the Reports module while the reader is on " +
			"VOD Reports, and because this is the first request the page makes, " +
			"its refusal replaces the entire page.")
	}
}
