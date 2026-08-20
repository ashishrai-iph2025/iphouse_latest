package handlers

import (
	"net/http/httptest"
	"strings"
	"testing"
)

/*
The asset scope reaches the service as ONE comma-joined list.

Worth pinning because the failure it replaced was invisible. The endpoint used
to match the whole joined string as a single asset id, so a two-asset selection
returned a confident zero — no error, no warning, just a live card reporting
that nothing had ever been found. Nothing but comparing the two ways of asking
would have caught it, and nothing in the response distinguished it from a
genuinely quiet client.

It now sums server-side (21 assets in one call returned 6,508, exactly the
total of the same 21 asked individually). If that ever regresses, the joining
here is the seam it would regress at.
*/
func TestSplitParamsFlattensBothSpellings(t *testing.T) {
	// Repeated parameters and comma-separated lists both arrive; callers use
	// whichever suits them, and the War Room uses repeats because an asset name
	// may itself contain a comma.
	got := splitParams([]string{"A,B", " C ", "", "D,,E"})
	want := []string{"A", "B", "C", "D", "E"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("splitParams = %v, want %v", got, want)
	}
	if len(splitParams(nil)) != 0 {
		t.Error("no parameters should give no assets, which means every asset")
	}
}

/*
The same asset twice must not be counted twice.

A dedupe here rather than a hope about the caller: the War Room resolves NAMES
to ids, and one title recorded under two names would otherwise send the same id
twice — which the service would sum, inflating the very number the filter was
added to make precise.
*/
func TestDedupeKeepsFirstSpellingAndDropsRepeats(t *testing.T) {
	got := dedupe([]string{"A-1", "B-2", "a-1", "B-2", "C-3"})
	want := []string{"A-1", "B-2", "C-3"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("dedupe = %v, want %v", got, want)
	}
}

/*
Asset ids come off the request in both spellings, and an empty scope means every
asset rather than none.
*/
func TestRealtimeAssetIDsReadsIdsFromTheRequest(t *testing.T) {
	r := httptest.NewRequest("GET", "/api/realtime/war-room?assetId=A,B&assetId=C", nil)
	got, err := realtimeAssetIDs(r.Context(), r, "CLIENT-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if strings.Join(got, ",") != "A,B,C" {
		t.Errorf("got %v, want A,B,C", got)
	}

	// No asset parameters at all: the card is the client's whole total, and the
	// joined scope must be empty so no assetId is sent.
	bare := httptest.NewRequest("GET", "/api/realtime/war-room", nil)
	none, err := realtimeAssetIDs(bare.Context(), bare, "CLIENT-1")
	if err != nil || len(none) != 0 {
		t.Errorf("an unscoped request gave %v (err %v), want no assets", none, err)
	}
	if strings.Join(none, ",") != "" {
		t.Error("an empty scope must join to the empty string, or every request is filtered by nothing")
	}
}
