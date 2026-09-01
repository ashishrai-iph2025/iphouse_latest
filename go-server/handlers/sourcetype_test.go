package handlers

import "testing"

/*
The source-type slicer removes a TABLE, which is why these exist.

Every other filter narrows what a query returns; this one decides whether a
query runs at all. The failure it can cause is therefore not a wrong row — it is
a report missing three quarters of its sources while still looking complete, so
the two conditions that keep it safe are pinned here rather than left to the
call sites to remember.
*/

func linking(table string) reportSpec { return reportSpec{Table: table, Role: "linking"} }
func host(table string) reportSpec    { return reportSpec{Table: table, Role: "host"} }
func sideless(table string) reportSpec {
	return reportSpec{Table: table}
}

// Open Web: two tables, one per side. This is the platform the slicer is for.
func openWebSpecs() []reportSpec {
	return []reportSpec{
		linking("dashboards.InternetInfringingURLMainDashboardTable"),
		host("dashboards.InternetSourceURLMainDashboardTable"),
	}
}

func TestSourceTypeIsOfferedOnlyWhereBothSidesExist(t *testing.T) {
	cases := []struct {
		name  string
		specs []reportSpec
		want  bool
	}{
		{"open web, both sides", openWebSpecs(), true},
		{"one side only", []reportSpec{linking("a")}, false},
		{"two tables, same side", []reportSpec{linking("a"), linking("b")}, false},
		/* The one that matters. Summary - Sports reads five tables and only the
		   two open-web ones have a side; offering the slicer would let a reader
		   drop Telegram, social media and the app stores from every figure on
		   the page by picking a value that says nothing about them. */
		{"summary: sides mixed with sideless tables",
			[]reportSpec{linking("sportsUrls"), host("sportsSource"),
				sideless("telegram"), sideless("social")}, false},
		{"nothing readable", nil, false},
	}
	for _, c := range cases {
		if got := platformOffersSourceType(c.specs); got != c.want {
			t.Errorf("%s: offered=%v, want %v", c.name, got, c.want)
		}
	}
}

func TestSourceTypeKeepsOnlyTheChosenSide(t *testing.T) {
	for value, wantTable := range map[string]string{
		"infringing": "dashboards.InternetInfringingURLMainDashboardTable",
		"source":     "dashboards.InternetSourceURLMainDashboardTable",
	} {
		got := specsForSourceType(openWebSpecs(), map[string]string{sourceTypeParam: value})
		if len(got) != 1 {
			t.Fatalf("%s kept %d tables, want 1", value, len(got))
		}
		if got[0].Table != wantTable {
			t.Errorf("%s kept %s, want %s", value, got[0].Table, wantTable)
		}
	}
}

/*
Everything the slicer does not recognise leaves the report whole.

An unset value is the resting state. A typo in a query string is not, and it
must not empty the report either: an empty one cannot be told apart from a side
that genuinely found nothing, and the reader would be looking at a zero with no
way to learn it was a spelling mistake. The internal role names are refused for
the same reason — the slicer's vocabulary is the warehouse's.
*/
func TestAnUnrecognisedSourceTypeChangesNothing(t *testing.T) {
	for _, v := range []string{"", "  ", "Infringing", "linking", "host", "nonsense"} {
		got := specsForSourceType(openWebSpecs(), map[string]string{sourceTypeParam: v})
		if len(got) != 2 {
			t.Errorf("%q narrowed the report to %d tables; it should have left both", v, len(got))
		}
	}
}

// And a platform that does not offer the slicer ignores it however it arrives —
// the guard is in the filter itself, not only in whether a dropdown was drawn.
func TestAPlatformThatDoesNotOfferItIsUnaffected(t *testing.T) {
	summary := []reportSpec{linking("sportsUrls"), host("sportsSource"), sideless("telegram")}
	got := specsForSourceType(summary, map[string]string{sourceTypeParam: "infringing"})
	if len(got) != len(summary) {
		t.Errorf("a hand-typed sourceType dropped %d of the summary's %d tables",
			len(summary)-len(got), len(summary))
	}
}

// The dropdown says what the warehouse calls the two sides, and offers exactly
// the values the filter accepts — a listed option the filter ignores would be a
// control that visibly does nothing.
func TestTheOfferedValuesAreTheAcceptedOnes(t *testing.T) {
	opts := sourceTypeOptions()
	if len(opts) != len(sourceTypeRoles) {
		t.Fatalf("%d options for %d accepted values", len(opts), len(sourceTypeRoles))
	}
	for _, o := range opts {
		id, _ := o["id"].(string)
		if _, ok := sourceTypeRoles[id]; !ok {
			t.Errorf("option %q is offered but not accepted", id)
		}
		if name, _ := o["name"].(string); name == "" {
			t.Errorf("option %q has no label", id)
		}
	}
}

/*
Choosing ONE side must not stop the per-side figures being emitted.

This is the bug the slicer shipped with, and it presented as the opposite of what
it was: pick "Source" on Open Web - Sports and BOTH trend cards read "No … data
for this period", over a host table holding 27,115 rows for the window on screen.

The cause is a disagreement between two counts of the same thing. The LAYOUT is
built from the unfiltered specs — rolesForPlatform calls specsForPlatform, not
specsForSourceType — so it draws a trend card per side whatever is selected.
runPlatform decided whether to emit the data for those cards from the specs that
SURVIVED the slicer, and one survivor read as "this is a single-role platform,
which wants a merged trend instead" — a state that was unreachable before this
filter existed and is now one click away.

So the test is that the two counts differ, and that the platform's own count is
the one that does not move when a side is picked.
*/
func TestChoosingOneSideStillLeavesThePlatformTwoSided(t *testing.T) {
	openWebSports := []reportSpec{linking("sportsUrls"), host("sportsSource")}

	// What the LAYOUT sees: two sides, so two trend cards to fill.
	if got := len(rolesIn(openWebSports)); got != 2 {
		t.Fatalf("the platform carries %d sides, want 2", got)
	}

	for _, sel := range []string{"source", "infringing"} {
		filtered := specsForSourceType(openWebSports, map[string]string{sourceTypeParam: sel})

		// What the filter leaves: one. This is the number that must NOT gate the
		// per-side output.
		if got := len(rolesIn(filtered)); got != 1 {
			t.Errorf("sourceType=%s left %d sides, want 1", sel, got)
		}
		/* And the platform's own count is unchanged by the selection — the
		   invariant the emission test now rests on. If this ever stops holding,
		   the guard in runPlatform is reading the wrong set again. */
		if got := len(rolesIn(openWebSports)); got != 2 {
			t.Errorf("sourceType=%s changed the platform's side count to %d — "+
				"specsForSourceType must not mutate its input", sel, got)
		}
	}
}

/*
A genuinely one-sided platform still wants no per-side figures.

The other half of the same decision, and the reason the guard cannot simply be
deleted: a platform with one table has one trend card — the merged one — and
emitting `sources` for it would have the page draw a per-side trend the layout
never made room for. The fix has to distinguish "one side because that is all
there is" from "one side because the reader picked it".
*/
func TestASinglesidedPlatformCarriesOneSide(t *testing.T) {
	if got := len(rolesIn([]reportSpec{linking("only")})); got != 1 {
		t.Errorf("a one-table platform carries %d sides, want 1", got)
	}
	// Sideless tables are not sides. Three of them is none, not three.
	if got := len(rolesIn([]reportSpec{sideless("a"), sideless("b"), sideless("c")})); got != 0 {
		t.Errorf("sideless tables counted as %d sides, want 0", got)
	}
}
