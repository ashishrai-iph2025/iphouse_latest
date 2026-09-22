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

/*
The overview is NOT under /v1/vod, and this is the test that says so.

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
	/* Built with a dataset rather than with THE dataset: which table the page
	   reads is pinned next door, and what this test is about is the prefix. */
	if got := overviewPath + "urls"; got != "/v1/overview/urls" {
		t.Fatalf("built path = %q, want %q", got, "/v1/overview/urls")
	}
}

/*
── Which table a client's week is read from ──────────────────────────────────

	ONE dataset, for everybody.

	It used to be two: a login holding any sports report read the sports URL
	table, everyone else read the unified dashboard. The intent was right and the
	mechanism was not — the report allow-list is PER LOGIN and a client's data is
	not, so two people at one company got different answers about the same week.
	On staging, the Netflix login holding only the sports report keys was told
	"Nothing new was found this week" while every other Netflix login saw the
	real figures.

	So this pins the single source, and pins that the choice is no longer made
	from the session: a landing figure must not depend on who is looking at it.

	The key still has to survive the path check that guards this endpoint,
	because the dataset is concatenated into a URL. A default the guard rejects
	would turn a working page into a 422, which is a worse failure than the empty
	one it replaced.
*/
func TestOverviewReadsTheUnifiedDashboardForEveryone(t *testing.T) {
	if defaultOverviewDataset != "unified" {
		t.Fatalf("overview dataset = %q, want %q — dashboards.Unified_BI_Dashboard "+
			"is the table that carries every platform in one row set",
			defaultOverviewDataset, "unified")
	}
	if !datasetKeyOK.MatchString(defaultOverviewDataset) {
		t.Fatal("the default must itself pass the key check, or every overview " +
			"would 422")
	}
}

/*
The dataset must not be chosen from the SESSION.

Read from source because the alternative needs a platform registry and a grant
table, and there is no way to exercise that here without a database. What can be
checked is that the branch has not come back: any of these names inside the
handler means the landing figure depends on who is signed in again.
*/
func TestOverviewDatasetIsNotChosenPerLogin(t *testing.T) {
	src := readOverviewSource(t)
	start := strings.Index(src, "func ReportsOverview(")
	if start < 0 {
		t.Fatal("could not find ReportsOverview")
	}
	body := src[start:]
	for _, banned := range []string{
		"hasSportsReport",
		"reportsAllowedForClaims",
		"isSportsPlatform",
	} {
		if strings.Contains(body, banned) {
			t.Errorf("ReportsOverview references %s — the landing figures would "+
				"again depend on the login's report grants rather than on the "+
				"client's data", banned)
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
