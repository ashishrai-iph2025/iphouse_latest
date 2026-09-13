package handlers

/*
The app-source panel: what it counts, and what it calls things.

Two ways this panel can be wrong while looking right, and both are pinned here.

	THE NAMES. SourceTable holds warehouse table names —
	"GooglePlayStoreURLsNEW" — and a panel drawn straight off the column puts
	four of those on a client's report. The mapping is keyed lowercase because
	the warehouse is not consistent about the suffix: three of the four end
	"URLsNEW" and one ends "URLsNew", so an exact match would tidy three names
	and leave the fourth showing raw beside them.

	THE MEASURE. Removal here is SourceRemovalStatus = 'Dead', which the service
	publishes as `sourceRemoved` — verified against the live dataset, where that
	measure reads 186 on the Dead rows and 0 on every other status. The
	section's own `removed` agrees with it on today's data and is a different
	definition; a panel naming one and counting the other is right until the day
	it is not.
*/

import "testing"

/*
Every value the live dataset returns has a name.

The four are the whole set as at the time of writing, read off the catalogue
rather than guessed. A fifth appearing upstream is not a failure — it shows as
itself, which is the rule below.
*/
func TestEveryKnownAppSourceIsNamed(t *testing.T) {
	for _, c := range []struct{ raw, want string }{
		{"GooglePlayStoreURLsNEW", "Google Play Store"},
		{"iTunesURLsNEW", "Apple App Store"},
		{"ThirdPartyAppsURLsNEW", "Third-Party Apps"},
		// The odd one out: "New", not "NEW". This is the case an exact-match
		// map would miss, and it is in the live data.
		{"ThirdPartyMobileAppURLsNew", "Third-Party Mobile Apps"},
	} {
		if got := appSourceName(c.raw); got != c.want {
			t.Errorf("appSourceName(%q) = %q, want %q", c.raw, got, c.want)
		}
	}
}

// Casing drift must not cost a name — the suffix already varies upstream.
func TestAppSourceNamesSurviveCasingDrift(t *testing.T) {
	for _, raw := range []string{
		"googleplaystoreurlsnew", "GOOGLEPLAYSTOREURLSNEW", "GooglePlayStoreUrlsNew",
	} {
		if got := appSourceName(raw); got != "Google Play Store" {
			t.Errorf("appSourceName(%q) = %q, want Google Play Store", raw, got)
		}
	}
}

/*
An unknown source shows as ITSELF rather than being folded or dropped.

A table added upstream then appears on the report under its raw name — ugly and
findable, which is the point. Folding it into "Other" would hide a source nobody
had decided to publish, and dropping it would silently remove its volume from a
panel whose totals a reader adds up.
*/
func TestAnUnknownAppSourceKeepsItsRawName(t *testing.T) {
	if got := appSourceName("SomeNewStoreURLsNEW"); got != "SomeNewStoreURLsNEW" {
		t.Errorf("an unrecognised source was rewritten to %q", got)
	}
	if got := appSourceName("   "); got != "Unknown" {
		t.Errorf("a blank source read as %q, want Unknown", got)
	}
}

/*
The LABEL is renamed and the VALUE is not.

`value` is what a click on the panel filters by. Renaming it would send "Google
Play Store" to a column holding "GooglePlayStoreURLsNEW" and return an empty
report with no error anywhere — the quietest possible failure.
*/
func TestNamingLeavesTheFilterValueAlone(t *testing.T) {
	rows := nameAppSourceRows([]map[string]any{
		{"label": "GooglePlayStoreURLsNEW", "value": "GooglePlayStoreURLsNEW", "urls": 291, "removed": 94},
	})
	if got := strFromAny(rows[0]["label"]); got != "Google Play Store" {
		t.Errorf("label = %q, want the readable name", got)
	}
	if got := strFromAny(rows[0]["value"]); got != "GooglePlayStoreURLsNEW" {
		t.Errorf("value = %q — a click would filter on a string the column does not hold", got)
	}
	// A row that arrived without a value gets the raw label as one, so the
	// panel stays clickable rather than losing its filter on the way through.
	rows = nameAppSourceRows([]map[string]any{{"label": "iTunesURLsNEW"}})
	if got := strFromAny(rows[0]["value"]); got != "iTunesURLsNEW" {
		t.Errorf("value = %q, want the raw name carried across", got)
	}
}

/*
The panel reads the SOURCE removal measure, not the section's.

Pinned on the candidate because that is the one place the choice is made, and
because the two measures agree on today's data — so nothing about the numbers
would reveal a change back to the default.
*/
func TestTheAppSourcePanelCountsSourceRemovals(t *testing.T) {
	found := false
	for _, c := range dimensionCandidates {
		if c.Key != dimAppSource {
			continue
		}
		found = true
		if c.APIRemoved != "sourceRemoved" {
			t.Errorf("removal series reads %q, want sourceRemoved — the measure that "+
				"counts SourceRemovalStatus = 'Dead'", c.APIRemoved)
		}
		if c.Column != "SourceTable" {
			t.Errorf("groups by %q, want SourceTable", c.Column)
		}
		/* Gated on the column, so the panel stays off every report that has no
		   such source — which is every platform but this one. */
		if c.Needs != "SourceTable" {
			t.Errorf("requires %q; without the gate this panel appears on reports "+
				"that cannot fill it", c.Needs)
		}
	}
	if !found {
		t.Fatalf("%s is not in dimensionCandidates", dimAppSource)
	}
}
