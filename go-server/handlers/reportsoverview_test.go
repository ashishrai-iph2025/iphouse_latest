package handlers

import "testing"

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
