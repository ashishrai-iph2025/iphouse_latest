package handlers

// Renaming a card and describing it, from Report Configuration → Page Layout.
//
// Both are stored on the layout row beside the panel's position and width, and
// both are applied where every other layout decision is applied — in asMap, on
// the way to the report page. That placement is the whole design: the page reads
// `label` exactly as it always did and gains an ⓘ only where somebody wrote one,
// so no renderer needs to know that renaming exists.

import (
	"strings"
	"testing"
)

/*
A custom title REPLACES the panel's own name, and an empty one leaves it alone.

Applied in asMap rather than passed to the page as a second field, because every
renderer on that page already titles its card from `label` — trend, rate, tile
and breakdown alike. A parallel `customLabel` would have to be threaded through
each of them, and the one that got missed would silently ignore the rename.
*/
func TestACustomTitleReplacesThePanelsOwnLabel(t *testing.T) {
	p := panelDef{Key: "byDomain", Kind: panelDim, Label: "Top Domains", Span: spanHalf}

	if got := strFromAny(p.asMap()["label"]); got != "Top Domains" {
		t.Errorf("with no rename the label is %q, want the panel's own name", got)
	}
	/* byDomain has a built-in note, so it travels even unedited — that is the
	   point of them. A panel nothing describes stays silent instead, or the page
	   would draw an ⓘ with nothing behind it. */
	if got := strFromAny(p.asMap()["desc"]); got != dimDescriptions["byDomain"] {
		t.Errorf("desc = %q, want the built-in note for byDomain", got)
	}
	if _, ok := (panelDef{Key: "byNothingAtAll", Kind: panelDim}).asMap()["desc"]; ok {
		t.Error("an undescribed panel carries a desc key")
	}

	p.Title = "Worst Offending Websites"
	if got := strFromAny(p.asMap()["label"]); got != "Worst Offending Websites" {
		t.Errorf("label = %q — the rename did not reach the report", got)
	}

	// Blank is not a rename. Otherwise clearing the box would title the card ""
	// rather than putting its own name back.
	p.Title = ""
	if got := strFromAny(p.asMap()["label"]); got != "Top Domains" {
		t.Errorf("clearing the title left %q instead of the default name", got)
	}
}

/*
The description travels as its own field, on every kind of panel.

It is not a rename and must not be folded into one: the card shows the title and
the note separately, and a KPI tile has no room to show a sentence as its label.
*/
func TestADescriptionTravelsAsItsOwnFieldOnEveryKind(t *testing.T) {
	const note = "Counted once per notice, not once per URL it covered."
	for _, kind := range []string{panelTile, panelDim, panelTrend, panelRate} {
		p := panelDef{Key: "k", Kind: kind, Label: "Name", Desc: note}
		out := p.asMap()
		if got := strFromAny(out["desc"]); got != note {
			t.Errorf("%s: desc = %q, want the admin's note", kind, got)
		}
		// And it did not overwrite the title on the way.
		if got := strFromAny(out["label"]); got != "Name" {
			t.Errorf("%s: the description replaced the label (%q)", kind, got)
		}
	}
}

/*
A rename and a description are independent.

Either alone is a normal thing to want — a card renamed for a client who calls it
something else, or one left named as it is and explained — so neither may require
the other.
*/
func TestTheRenameAndTheDescriptionAreIndependent(t *testing.T) {
	titled := panelDef{Key: "k", Kind: panelTile, Label: "Removed", Title: "Taken Down"}.asMap()
	if strFromAny(titled["label"]) != "Taken Down" {
		t.Error("a rename with no description did not apply")
	}
	if _, ok := titled["desc"]; ok {
		t.Error("renaming a panel invented a description for it")
	}

	described := panelDef{Key: "k", Kind: panelTile, Label: "Removed", Desc: "Live URLs that came down."}.asMap()
	if strFromAny(described["label"]) != "Removed" {
		t.Error("describing a panel changed its name")
	}
	if strFromAny(described["desc"]) == "" {
		t.Error("a description with no rename did not travel")
	}
}

/*
EVERY card and chart carries a note, and the two that are easiest to misread say
the thing that makes them misreadable.

Completeness is the test: a figure with no ⓘ is one an admin has to describe from
nothing, and the gaps are invisible until somebody opens that panel on a live
report. Asserted against the label registries rather than a hand-written list, so
a metric or a breakdown added later fails here rather than shipping bare.
*/
func TestEveryPanelCarriesADescription(t *testing.T) {
	for metric := range kpiTileLabels {
		if strings.TrimSpace(kpiTileDescriptions[metric]) == "" {
			t.Errorf("KPI tile %q has no description — its ⓘ would be empty", metric)
		}
	}
	for _, c := range dimensionCandidates {
		if strings.TrimSpace(dimDescriptions[c.Key]) == "" {
			t.Errorf("breakdown %q (%s) has no description", c.Key, c.Label)
		}
	}
	for param := range filterParamLabels {
		if strings.TrimSpace(filterDescriptions[param]) == "" {
			t.Errorf("slicer %q has no description", param)
		}
	}

	/* The distinction the whole file exists for. An action id is stamped on
	   every URL it covered, so a description that does not say "counted once
	   each" leaves the tile reading as a URL count four orders of magnitude
	   out. */
	for _, metric := range []string{"notices", "delistingBatches"} {
		if !strings.Contains(kpiTileDescriptions[metric], "once each") {
			t.Errorf("%q does not say it counts actions once each, which is the one "+
				"thing that stops it being read as a URL count", metric)
		}
	}
	// And the repeat panel, whose bars are a volume its ranking ignores.
	if !strings.Contains(dimDescriptions[dimRepeatOffender], "DAYS") {
		t.Error("the repeat-offenders note does not say it ranks by days, not volume")
	}
}

/*
The built-in note is a DEFAULT: what an admin writes wins, and clearing it goes
back to the built-in rather than to nothing.
*/
func TestAWrittenDescriptionBeatsTheBuiltInOne(t *testing.T) {
	p := panelDef{Key: "byDomain", Kind: panelDim, Label: "Top 10 Linking Websites"}
	if got := panelDescOf(p); got != dimDescriptions["byDomain"] {
		t.Errorf("an undescribed panel gave %q, want its built-in note", got)
	}

	p.Desc = "Only the domains our client cares about."
	if got := panelDescOf(p); got != p.Desc {
		t.Errorf("the admin's note lost to the built-in one: %q", got)
	}

	p.Desc = ""
	if got := panelDescOf(p); got != dimDescriptions["byDomain"] {
		t.Error("clearing the note left the panel with nothing rather than its built-in one")
	}

	// A panel nothing describes stays silent rather than inventing a sentence.
	if got := panelDescOf(panelDef{Key: "byNothingAtAll", Kind: panelDim}); got != "" {
		t.Errorf("an unknown panel invented the description %q", got)
	}
}

/*
The configuration screen is told the panel's OWN name as well as its rename.

`name` is what the panel is called before anybody renamed it, and the screen
shows it as the input's placeholder — so clearing the box has a visible meaning
("back to this") rather than being a blank field with no stated effect. Serving
only the rename would lose the default the moment one was set.
*/
func TestTheConfigScreenKeepsTheDefaultNameBesideTheRename(t *testing.T) {
	p := panelDef{Kind: panelTrend, Role: "host"}
	if name := panelName(p); name == "" || !strings.Contains(name, "Host") {
		t.Errorf("panelName gave %q — the screen has no default name to offer", name)
	}
	// panelName describes the panel's KIND and role, so a rename cannot reach it:
	// it takes no Title, which is what keeps the two apart.
	p.Title = "Anything At All"
	if name := panelName(p); strings.Contains(name, "Anything At All") {
		t.Error("panelName returned the rename — the screen would offer the custom " +
			"title as the placeholder for itself, and the default would be lost")
	}
}
