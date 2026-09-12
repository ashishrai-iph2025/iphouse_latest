package handlers

import (
	"os"
	"strings"
	"testing"
)

/*
The monitoring scope slicer: what it sends, and — mostly — what it does not.

The hazard here is not a wrong number, it is a SILENT one. Everything about this
control is designed so that the unnarrowed report is the report that was served
before the control existed, and every test below is about some way that could
stop being true without anything failing.
*/

// Only the narrowing value is ever recognised. Everything else — an absent
// parameter, the end-to-end value, a typo — reads as "do not narrow", because a
// mistyped query string emptying a report cannot be told apart from a genuinely
// quiet client once it has happened.
func TestMonitoringScopeOnlyRecognisesTheNarrowingValue(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{monitoringOnlyScope, monitoringOnlyScope},
		{"  " + monitoringOnlyScope + " ", monitoringOnlyScope},
		{endToEndScope, ""},
		{"", ""},
		{"Monitoring-Only", ""}, // case matters: reports_api compares the literal
		{"zzz", ""},
	} {
		if got := monitoringScopeValue(map[string]string{monitoringScopeParam: c.in}); got != c.want {
			t.Errorf("monitoringScopeValue(%q) = %q, want %q", c.in, got, c.want)
		}
	}
	// And a scope that never mentions it at all.
	if got := monitoringScopeValue(map[string]string{}); got != "" {
		t.Errorf("an absent parameter read as %q", got)
	}
}

/*
THE CROSS-SERVICE LITERAL.

reports_api's predicate compares the bound value against its own copy of
"monitoring-only". There is no shared package between the two services, so a
rename on one side alone does not fail to compile, does not error at runtime,
and does not log: the comparison simply reads false and the whole report is
served where a narrowed one was asked for.

Read out of the sibling checkout where it is present, and skipped where it is
not, so this is a guard on a developer's machine and never a broken build on a
box that only has the portal.
*/
func TestTheNarrowingValueMatchesTheServiceThatHonoursIt(t *testing.T) {
	const src = "../../../reports_api/internal/api/assetattrs.go"
	b, err := os.ReadFile(src)
	if err != nil {
		t.Skipf("reports_api is not checked out beside this repo: %v", err)
	}
	want := `monitoringOnlyScope = "` + monitoringOnlyScope + `"`
	if !strings.Contains(string(b), want) {
		t.Errorf("reports_api does not define %s — the portal would send a value that "+
			"service compares false, and the report would come back unnarrowed with "+
			"nothing to say why", want)
	}
	if !strings.Contains(string(b), `monitoringScopeParam = "`+monitoringScopeParam+`"`) {
		t.Errorf("reports_api names the parameter something other than %q", monitoringScopeParam)
	}
}

/*
The slicer must NOT be in knownFilterParams.

specHonoursFilters refuses to run any spec that does not declare an active
slicer in its own Filters map, and no spec declares this one — it is not a
column. Listed there, choosing Monitoring Only would drop every spec on the
page: a report that empties itself when you use one of its own controls.

sourceType is absent for the same reason and is checked alongside, because the
two are the only slicers this is true of and a list that regained one would
likely regain both.
*/
func TestNonColumnSlicersStayOutOfKnownFilterParams(t *testing.T) {
	for _, param := range knownFilterParams {
		if param == monitoringScopeParam {
			t.Errorf("%q is in knownFilterParams — specHonoursFilters will drop every "+
				"spec the moment it is set", monitoringScopeParam)
		}
		if param == sourceTypeParam {
			t.Errorf("%q is in knownFilterParams — see the note beside the list", sourceTypeParam)
		}
	}
}

// The dropdown offers exactly the two engagements, narrowing one first.
func TestMonitoringScopeOptions(t *testing.T) {
	opts := monitoringScopeOptions()
	if len(opts) != 2 {
		t.Fatalf("the dropdown offers %d values, want 2", len(opts))
	}
	if opts[0]["id"] != monitoringOnlyScope || opts[1]["id"] != endToEndScope {
		t.Errorf("the values are %v — want monitoring first, which is workflow order", opts)
	}
	for _, o := range opts {
		if strings.TrimSpace(o["name"].(string)) == "" {
			t.Errorf("a value has no name: %v", o)
		}
	}
}

/*
It is a ceiling, not a dimension, so it must never be a breakdown's filter.

The two scopes overlap — end-to-end contains monitoring-only — so there is no
GROUP BY that puts an asset in one bucket. A panel keyed on it would draw two
bars whose total was larger than the report.
*/
func TestMonitoringScopeIsNotADimension(t *testing.T) {
	for _, key := range []string{
		"byAsset", "byGenre", "byPlatform", "byDomain", "byTAT", "byLanguage", "byCountry",
	} {
		if DIMFilterParam(key) == monitoringScopeParam {
			t.Errorf("dimension %q maps to %q — it is a ceiling, not a grouping",
				key, monitoringScopeParam)
		}
	}
}

// Every slicer in the pane needs a name and an ⓘ; TestEveryPanelCarriesADescription
// enforces the second. This pins the first, which is what the rail actually shows.
func TestMonitoringScopeIsNamedInTheRail(t *testing.T) {
	if got := filterParamLabel(monitoringScopeParam); got == "" || got == monitoringScopeParam {
		t.Errorf("the rail would label the slicer %q — its raw parameter name", got)
	}
}
