package handlers

import "testing"

/*
A client's own layout is not disturbed by anything added after it was designed.

── THE RULE ─────────────────────────────────────────────────────────────────

A save writes a row for EVERY panel on the page. So a panel missing from a
stored layout is, without exception, one that did not exist when that layout was
saved — and what should happen to it depends entirely on whose layout it is
missing from:

	a CLIENT'S OWN     → hidden. Somebody arranged this page; a new card must not
	                     appear in the middle of it because the registry gained one.
	the SHARED default → shown. This is where an admin arranges the default for
	                     everyone, and a new panel invisible here is invisible to
	                     every report at once.

── WHY IT IS TESTED AT ALL ──────────────────────────────────────────────────

The failure mode is silent in both directions. Get it wrong one way and panels
a client has never seen appear on their report unannounced; the other way and
panels vanish from reports that were showing them, with nothing to say why.
Neither errors.
*/

func layoutFixture() []panelDef {
	return []panelDef{
		{Key: "a", Kind: panelDim, Label: "A"},
		{Key: "b", Kind: panelDim, Label: "B"},
		// The panel added after the layout was designed — in the registry, in
		// nobody's stored rows.
		{Key: "new", Kind: panelDim, Label: "Newly added"},
	}
}

func panelByKey(t *testing.T, panels []panelDef, key string) panelDef {
	t.Helper()
	for _, p := range panels {
		if p.Key == key {
			return p
		}
	}
	t.Fatalf("panel %q is not in the result at all — it must be hidden, never dropped", key)
	return panelDef{}
}

// A client's OWN layout: the new panel arrives hidden, and the panels they did
// arrange are untouched.
func TestANewPanelIsHiddenFromAClientsOwnLayout(t *testing.T) {
	stored := map[string]layoutRow{
		"a": {Order: 20, Set: true},
		"b": {Order: 10, Set: true},
	}
	got := overlayLayout(layoutFixture(), stored, true)

	if n := panelByKey(t, got, "new"); !n.Hidden {
		t.Error("a panel added since this client's layout was designed is visible on " +
			"their report — it would appear in the middle of a page somebody arranged")
	}
	// Hidden, NOT dropped: the editor lists it so an admin can switch it on.
	if len(got) != 3 {
		t.Errorf("the overlay returned %d panels, want 3 — a hidden panel still has to "+
			"reach the layout editor", len(got))
	}
	// And the arrangement they saved still holds.
	if panelByKey(t, got, "a").Hidden || panelByKey(t, got, "b").Hidden {
		t.Error("a panel the client arranged came back hidden")
	}
	if got[0].Key != "b" {
		t.Errorf("the saved order was not applied: first panel is %q, want b", got[0].Key)
	}
}

/*
The SHARED layout is the opposite case.

An admin arranging the default has to see a new panel to place it. Hidden here,
a newly added card would be invisible on every report at once and there would be
no screen on which to discover it.
*/
func TestANewPanelStaysVisibleInTheSharedLayout(t *testing.T) {
	stored := map[string]layoutRow{
		"a": {Order: 10, Set: true},
		"b": {Order: 20, Set: true},
	}
	got := overlayLayout(layoutFixture(), stored, false)
	if panelByKey(t, got, "new").Hidden {
		t.Error("a newly added panel is hidden in the shared layout — no admin would " +
			"ever see it to place it")
	}
}

/*
A client with NO layout of their own follows the default, and the fallback is
not their design.

layoutForScoped answers `own = false` for the shared rows it hands back to such
a client, so a new panel reaches them exactly as it reaches everyone else. Hiding
it here would hide it from every client who has never been arranged individually
— which is most of them.
*/
func TestAClientOnTheSharedLayoutSeesNewPanels(t *testing.T) {
	shared := map[string]layoutRow{"a": {Order: 10, Set: true}, "b": {Order: 20, Set: true}}
	// `own` is what layoutForScoped returns for a fallback: false.
	got := overlayLayout(layoutFixture(), shared, false)
	if panelByKey(t, got, "new").Hidden {
		t.Error("a client following the shared layout had a new panel hidden — they " +
			"have designed nothing, so there is nothing to protect")
	}
}

// No stored layout at all is the untouched case: the registry's panels, as they
// come, whoever is asking.
func TestNoStoredLayoutChangesNothing(t *testing.T) {
	for _, own := range []bool{true, false} {
		got := overlayLayout(layoutFixture(), map[string]layoutRow{}, own)
		if len(got) != 3 {
			t.Fatalf("own=%v: %d panels, want 3", own, len(got))
		}
		for _, p := range got {
			if p.Hidden {
				t.Errorf("own=%v: %q was hidden with no layout stored at all", own, p.Key)
			}
		}
	}
}

/*
An explicitly hidden panel stays hidden, and an explicitly shown one stays shown.

The new branch runs only where there is NO row. A stored row is a decision
somebody made, in either direction, and it wins over the default this rule
supplies.
*/
func TestAStoredDecisionBeatsTheDefault(t *testing.T) {
	stored := map[string]layoutRow{
		"a":   {Order: 10, Set: true},
		"b":   {Order: 20, Hidden: true, Set: true},
		"new": {Order: 30, Set: true}, // arranged since — must NOT be re-hidden
	}
	got := overlayLayout(layoutFixture(), stored, true)
	if panelByKey(t, got, "b").Hidden != true {
		t.Error("a panel hidden on purpose came back shown")
	}
	if panelByKey(t, got, "new").Hidden {
		t.Error("a panel the client has since arranged was hidden again — once it has " +
			"a row it is a decision, not a new arrival")
	}
}
