package handlers

import (
	"os"
	"strings"
	"testing"
)

func TestDatasetKeyOKRejectsAnythingThatCouldSteerThePath(t *testing.T) {
	ok := []string{"urls", "open-web", "open-web-source", "a", "d1", "x-9-y"}
	bad := []string{
		"", "../admin/schema", "urls/../../health", "urls?x=1", "urls#f",
		"Urls", "urls ", "url s", "urls%2f", "urls/overview", ".", "..",
		"urls.json", "-urls", "urls_source",
	}
	for _, k := range ok {
		if !datasetKeyOK.MatchString(k) {
			t.Errorf("rejected a real dataset key: %q", k)
		}
	}
	for _, k := range bad {
		if datasetKeyOK.MatchString(k) {
			t.Errorf("accepted a key that could steer the path: %q", k)
		}
	}
}

func TestDefaultOverviewDatasetIsTheOneTheEndpointServes(t *testing.T) {
	// The registry entry whose measures the landing page reads.
	if defaultOverviewDataset != "urls" {
		t.Fatalf("default dataset = %q, want %q", defaultOverviewDataset, "urls")
	}
	if !datasetKeyOK.MatchString(defaultOverviewDataset) {
		t.Fatal("the default must itself pass the key check")
	}
}

/*
The overview is NOT under /v1/sports, and this is the test that says so.

reports_api routes it as GET /v1/overview/{dataset} and its own source explains
why: it takes a dataset name, but what it answers is "how did this client's
enforcement go this week" across every platform, which is a dashboards question
rather than a sports one. Assuming the sports prefix — the shape every other
dataset endpoint has — is what produced "reports API returned 404" on a page
whose only symptom was "Figures unavailable".

Pinned as a string so that the assumption has to be re-stated to be broken.
*/
func TestOverviewPathIsNotUnderSports(t *testing.T) {
	if overviewPath != "/v1/overview/" {
		t.Fatalf("overview path = %q, want %q", overviewPath, "/v1/overview/")
	}
	if got := overviewPath + defaultOverviewDataset; got != "/v1/overview/urls" {
		t.Fatalf("built path = %q, want %q", got, "/v1/overview/urls")
	}
}

/*
── Which table a client's week is read from ──────────────────────────────────

	The default dataset reads the sports URL table. That is the right source for
	a sports client and EMPTY for everyone else, so a VOD client opened /welcome
	and was told "Nothing new was found this week" for a week in which plenty had
	been found: the page was reading the one table their reports do not use.

	So an unqualified overview picks its dataset from what the login can actually
	open — sports for a sports client, the unified dashboard for the rest.

	Both keys have to survive the path check that guards this endpoint, because
	the dataset is concatenated into a URL. A fallback that the guard rejects
	would turn a working page into a 422, which is a worse failure than the empty
	one it replaced.
*/
func TestFallbackOverviewDatasetIsTheUnifiedDashboard(t *testing.T) {
	if fallbackOverviewDataset != "unified" {
		t.Fatalf("fallback dataset = %q, want %q — dashboards.Unified_BI_Dashboard "+
			"is the table that carries every platform in one row set",
			fallbackOverviewDataset, "unified")
	}
	if !datasetKeyOK.MatchString(fallbackOverviewDataset) {
		t.Fatal("the fallback must itself pass the key check, or choosing it " +
			"would 422 the request")
	}
	if fallbackOverviewDataset == defaultOverviewDataset {
		t.Fatal("the fallback is the same key as the default, so a client with no " +
			"sports report is still reading the sports table")
	}
}

/*
hasSportsReport must ask the SAME two questions of a platform that
ReportsSections asks — enabled, and inside the login's allow-list — or the page
reads one table while the navigation offers reports from another.

Read from source: the decision needs a platform registry and a grant table, so
there is no way to exercise it here without a database. What can be checked is
that it has not drifted from the test it is meant to mirror.
*/
func TestHasSportsReportMirrorsTheSectionsFilter(t *testing.T) {
	src := readOverviewSource(t)
	start := strings.Index(src, "func hasSportsReport(")
	if start < 0 {
		t.Fatal("could not find hasSportsReport")
	}
	body := src[start:]
	if end := strings.Index(body[20:], "\nfunc "); end >= 0 {
		body = body[:20+end]
	}
	for _, want := range []string{
		"reportsAllowedForClaims", // the same allow-list as the nav
		"p.Enabled",               // a disabled platform is nobody's report
		"summaryKey",              // the summary is not a platform of its own
		"isSportsPlatform",        // and the actual question
	} {
		if !strings.Contains(body, want) {
			t.Errorf("hasSportsReport no longer references %s — it must decide the "+
				"same way ReportsSections does, or /welcome reads a table the "+
				"reader has no report for", want)
		}
	}
}

func readOverviewSource(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile("reportsoverview.go")
	if err != nil {
		t.Fatalf("read reportsoverview.go: %v", err)
	}
	return string(b)
}
