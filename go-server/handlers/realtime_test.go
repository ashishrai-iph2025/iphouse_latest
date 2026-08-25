package handlers

import (
	"encoding/json"
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

/*
── The removed half ──────────────────────────────────────────────────────────

The sports view answers with `removed` beside `count` and `totalRemoved` beside
`total`; the war-room view does not ask for either. THREE answers arrive looking
like zero and only one of them is one:

	removed: 8202   counted, and that many are down
	removed: 0      counted, and none are down — a finding, and the whole point
	                of a card that shows quiet platforms rather than hiding them
	removed: null   this platform could not be counted at all
	(absent)        this VIEW does not count removals

Which is why the field is a pointer here rather than an int64. The trap it is
pinned against is `omitempty`: on a plain int it eats the second row above, and
a client whose enforcement has not started yet becomes indistinguishable from
one nobody is enforcing for.
*/
func TestRealtimeReadingKeepsTheRemovedHalf(t *testing.T) {
	// The service's own answer, trimmed to the fields this side reads.
	const sports = `{
	  "view": "sports", "clientId": "70408704-E460-41EB-8304-022DFAFE704C",
	  "total": 13460, "totalRemoved": 8202,
	  "platforms": [
	    {"key":"open-web","label":"Open Web","family":"open-web","count":13271,
	     "removed":8202,"removedWhen":"d.InfringingRemovalStatus = 'Approved'",
	     "table":"mediascan._InternetURLsNEW","dateColumn":"URLUploadDate"},
	    {"key":"ugc-other","label":"UGC & other social media","family":"ugc","count":189,
	     "removed":0,"removedWhen":"t.RemovalStatus = 'Dead'",
	     "table":"mediascan.UGCAndOtherSocialMediaURLs","dateColumn":"DiscoveryDoneAt"},
	    {"key":"vk","label":"VK","family":"social","count":null,
	     "removed":null,"error":"not counted"}
	  ]}`

	var got realtimeResponse
	if err := json.Unmarshal([]byte(sports), &got); err != nil {
		t.Fatalf("the service's own shape no longer decodes: %v", err)
	}
	if got.TotalRemoved == nil || *got.TotalRemoved != 8202 {
		t.Fatalf("totalRemoved = %v, want 8202", got.TotalRemoved)
	}
	if got.Total != 13460 {
		t.Errorf("total = %d — the identified half must be untouched by any of this", got.Total)
	}

	openWeb, ugc, vk := got.Platforms[0], got.Platforms[1], got.Platforms[2]
	if openWeb.Removed == nil || *openWeb.Removed != 8202 {
		t.Errorf("open-web removed = %v, want 8202", openWeb.Removed)
	}
	if ugc.Removed == nil || *ugc.Removed != 0 {
		t.Errorf("ugc removed = %v — a counted zero is a finding and must survive as one", ugc.Removed)
	}
	// Not counted is not zero. The card draws nothing here rather than
	// reporting that a platform it could not read has had nothing taken down.
	if vk.Removed != nil {
		t.Errorf("vk removed = %v, want nothing — that platform did not answer", *vk.Removed)
	}

	// The war-room view sends neither field, and neither may be invented.
	var bare realtimeResponse
	if err := json.Unmarshal([]byte(`{"view":"war-room","total":11,"platforms":[{"key":"yt","count":11}]}`), &bare); err != nil {
		t.Fatalf("war-room shape: %v", err)
	}
	if bare.TotalRemoved != nil || bare.Platforms[0].Removed != nil {
		t.Error("the war-room reading acquired removals it never counted")
	}
}

/*
And the same three answers must survive being RE-encoded for the browser.

`omitempty` on a pointer drops only nil, which is exactly the distinction above
— but it is one field-type edit away from dropping the counted zero too, and
that edit would look like a tidy-up.
*/
func TestRealtimePayloadKeepsACountedZeroAndOmitsAnAbsentOne(t *testing.T) {
	zero, some := int64(0), int64(8202)
	ps := []RealtimePlatform{
		{Key: "open-web", Count: 13271, Removed: &some,
			RemovedWhen: "d.InfringingRemovalStatus = 'Approved'"},
		{Key: "ugc-other", Count: 189, Removed: &zero, RemovedWhen: "t.RemovalStatus = 'Dead'"},
		{Key: "vk", Count: 0},
	}
	scrubRealtimeSchema(ps)

	out, err := json.Marshal(ps)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	js := string(out)

	// Decoded back rather than pattern-matched: what matters is whether the KEY
	// is there and what it holds, not where it landed in the object.
	var back []map[string]any
	if err := json.Unmarshal(out, &back); err != nil {
		t.Fatalf("the payload does not decode: %v", err)
	}
	if v, ok := back[1]["removed"]; !ok || v != float64(0) {
		t.Errorf("the counted zero was dropped from the payload: %s", js)
	}
	if _, invented := back[2]["removed"]; invented {
		t.Errorf("a platform that reported no removals was given one: %s", js)
	}
	// The predicate that produced these figures must not travel with them.
	if strings.Contains(js, "RemovalStatus") || strings.Contains(js, "mediascan") {
		t.Errorf("the payload still carries warehouse schema: %s", js)
	}
	if !strings.Contains(js, "delisting") {
		t.Errorf("open-web lost the words that say what its removals are: %s", js)
	}
}
