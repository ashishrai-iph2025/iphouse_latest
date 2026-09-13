package handlers

import (
	"encoding/json"
	"net/url"
	"os"
	"strings"
	"testing"
)

// readHandlerSource reads one file of this package. The source-reading tests
// here pin CALL SITES — that a road applies the exclusions at all — which no
// behavioural test can see without a warehouse behind it.
func readHandlerSource(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(name)
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return string(b)
}

/*
The exclusion list is a setting that SUBTRACTS, and every way it can subtract
the wrong amount is silent.

A report that is narrower than it should be does not error — it renders, with
smaller numbers, and looks exactly like a quiet week. So the properties worth
pinning are the ones that decide how much comes off: the encoding the values
travel in, that nothing is sent when nothing is hidden, and that both roads to
the warehouse carry the same list.
*/

/*
The list travels as JSON, because a value can hold a comma.

Four franchise names in mediascan.Asset do — "Warhammer 40,000" among them — and
the comma-separated encoding the pirate-brand filter uses would split that into
two entries matching nothing. The franchise would stay on the report after being
hidden, with no error to explain it.
*/
func TestTheListSurvivesAValueWithAComma(t *testing.T) {
	got := dimExclusionJSON([]string{"Warhammer 40,000", "Serie A"})

	var back []string
	if err := json.Unmarshal([]byte(got), &back); err != nil {
		t.Fatalf("the encoded list is not JSON: %q (%v)", got, err)
	}
	if len(back) != 2 {
		t.Fatalf("decoded to %d values, want 2: %v", len(back), back)
	}
	found := false
	for _, v := range back {
		if v == "Warhammer 40,000" {
			found = true
		}
	}
	if !found {
		t.Errorf("the comma-bearing name did not survive the round trip: %v", back)
	}
}

/*
Nothing hidden sends nothing at all.

This is what makes "all selected by default" true without storing anything: a
client with no exclusions reaches reports_api with no such parameter, so the
report — and its cache key — is byte-identical to the one served before this
feature existed. An unsent filter cannot change a figure.
*/
func TestNothingHiddenSendsNoParameter(t *testing.T) {
	v := url.Values{}
	applyDimExclusionMap(v, map[string][]string{})
	if len(v) != 0 {
		t.Errorf("an empty exclusion set sent %v", v)
	}

	// And a dimension present but empty is still nothing to send.
	v = url.Values{}
	applyDimExclusionMap(v, map[string][]string{"franchise": {}, "asset": {"  "}})
	if len(v) != 0 {
		t.Errorf("an empty list sent %v", v)
	}
}

// What IS hidden goes under the parameter reports_api declares for it.
func TestEachDimensionTravelsUnderItsOwnParameter(t *testing.T) {
	v := url.Values{}
	applyDimExclusionMap(v, map[string][]string{
		"franchise": {"Serie A"},
		"matchDay":  {"Matchday 4"},
		"asset":     {"A-GUID"},
	})
	for dim, param := range dimExclusionParams {
		if v.Get(param) == "" {
			t.Errorf("%s was hidden but nothing was sent under %s", dim, param)
		}
	}
	if got := v.Get("excludeFranchise"); got != `["Serie A"]` {
		t.Errorf("excludeFranchise = %q", got)
	}
}

/*
The same set always encodes the same way.

Two saves of one selection have to produce one string, or the report's cache key
changes for a setting that did not — and every client whose exclusions were
re-saved rebuilds its whole report for nothing.
*/
func TestTheEncodingIsStable(t *testing.T) {
	a := dimExclusionJSON([]string{"LaLiga", "Serie A", "LaLiga", " Serie A "})
	b := dimExclusionJSON([]string{"Serie A", "LaLiga"})
	if a != b {
		t.Errorf("the same set encoded two ways:\n  %s\n  %s", a, b)
	}
	// Deduplicated and trimmed on the way, so the same value twice is one value.
	var back []string
	_ = json.Unmarshal([]byte(a), &back)
	if len(back) != 2 {
		t.Errorf("encoded %d values, want 2: %v", len(back), back)
	}
}

/*
BOTH ROADS carry the list.

The report filters a fact table through apiScope; the live card counts capture
tables through realtimeFetch. They share no other code, and a client whose report
hid a franchise while the card above it still counted one is the two halves of a
page disagreeing about what they are showing — which is the failure the live card
exists to not have.

Read from source, because the alternative is a warehouse: what is being pinned is
that the call is present at both sites, which no behavioural test can see.
*/
func TestBothRoadsApplyTheExclusions(t *testing.T) {
	for _, c := range []struct{ file, site string }{
		{"reportsapi_bridge.go", "the sports report's scope"},
		{"realtime.go", "the live counts card"},
	} {
		src := readHandlerSource(t, c.file)
		if !strings.Contains(src, "applyDimExclusions(") {
			t.Errorf("%s does not apply the client's exclusions, so %s would report on "+
				"values the client has hidden", c.file, c.site)
		}
	}
	/* And the report's CACHE has to key on them, or hiding a franchise changes
	   nothing visible until the retention window rolls — which reads as a
	   control that does nothing. */
	if src := readHandlerSource(t, "reportcachebridge.go"); !strings.Contains(src, "dimExclusionsFor(clientID)") {
		t.Error("the cached report's shape ignores the exclusions, so a saved change " +
			"is invisible until the entry expires")
	}
}

/*
Only the three dimensions the asset master can be narrowed by.

A fourth accepted here would be stored, sent, and silently ignored by
reports_api — a setting that saves, reloads, and does nothing.
*/
func TestOnlyTheKnownDimensionsAreAccepted(t *testing.T) {
	for _, dim := range dimExclusionOrder {
		if !isDimExclusionKey(dim) {
			t.Errorf("%q is in the display order but is not a known dimension", dim)
		}
		if dimExclusionLabels[dim] == "" {
			t.Errorf("%q has no label, so the screen would draw an unnamed section", dim)
		}
	}
	if len(dimExclusionOrder) != len(dimExclusionParams) {
		t.Errorf("%d dimensions are shown but %d are declared — one of them is either "+
			"unreachable or unsendable", len(dimExclusionOrder), len(dimExclusionParams))
	}
	for _, bad := range []string{"genre", "country", "", "Franchise"} {
		if isDimExclusionKey(bad) {
			t.Errorf("%q is accepted as a dimension but reports_api narrows by no such thing", bad)
		}
	}
}

/*
An unreadable setting hides NOTHING.

The failure direction matters more here than almost anywhere: a read that failed
closed would present as every figure on the report dropping at once, which sends
somebody to the warehouse rather than to this table.
*/
func TestAnUnreadableSettingHidesNothing(t *testing.T) {
	// No portal database in the test binary, which is exactly the unreadable case.
	if got := dimExclusionsFor("SOME-CLIENT"); len(got) != 0 {
		t.Errorf("an unreadable setting hid %v", got)
	}
	if got := dimExclusionsFor(""); len(got) != 0 {
		t.Errorf("an empty client hid %v", got)
	}
	v := url.Values{}
	applyDimExclusions(v, "SOME-CLIENT")
	if len(v) != 0 {
		t.Errorf("an unreadable setting still narrowed the query: %v", v)
	}
}

/*
── A SAVE ANSWERS FROM THE BODY IT WAS GIVEN ────────────────────────────────

This shipped broken once and is the reason the test exists. The save handler
ended by calling the GET handler to render its answer; the GET reads its client
from the QUERY STRING and a PUT carries it in the BODY, so every save committed
and then answered "clientId is required".

That is the worst shape a bug of this kind can take. The write had already
happened, so the screen reported a failure over a change that was stored — and a
reload would show the admin the change they had just been told did not happen.

Read from source, because what has to be pinned is that the save does not
delegate to a handler reading a different part of the request.
*/
func TestASaveDoesNotAnswerFromTheQueryString(t *testing.T) {
	src := readHandlerSource(t, "dimexclusions.go")

	save := src[strings.Index(src, "func DimExclusionsSave("):]
	if i := strings.Index(save[1:], "\nfunc "); i >= 0 {
		save = save[:i+1]
	}
	if strings.Contains(save, "DimExclusionsGet(") {
		t.Error("the save renders its answer through the GET handler, which reads " +
			"clientId from the query string — a PUT carries it in the body, so the " +
			"save commits and then reports that the client is missing")
	}
	if !strings.Contains(save, "writeDimExclusions(w, body.ClientID)") {
		t.Error("the save no longer answers from the client id it was given")
	}
	/* And nothing may Fail AFTER the write. A failure reported over a committed
	   change is a screen and a database that disagree, which no amount of
	   retrying resolves. */
	if at := strings.Index(save, "saveDimExclusions("); at >= 0 {
		after := save[at:]
		// The save's own error branch is the one legitimate Fail after this point.
		if n := strings.Count(after, "Fail(w,"); n > 1 {
			t.Errorf("%d Fail calls after the write — a save that committed must not "+
				"answer with an error", n)
		}
	}
}
