package handlers

import "testing"

/*
Dashboard and Reports are one entitlement with two faces.

They show the same client's figures, so a login gets exactly one of them:

	Reports granted      → Reports, and Dashboard is dropped even where it was
	                       also ticked. Two nav items for the same numbers is
	                       two places to disagree and a choice with no meaning.
	Reports not granted  → Dashboard, whether or not it was ticked. It is the
	                       floor: a login that can sign in can see its figures
	                       somewhere.

Pinned as a pure function because the rule is easy to state and easy to break —
the natural instinct when adding a module is to append it to the list, which is
exactly what reintroduces both.
*/
func TestDashboardAndReportsAreMutuallyExclusive(t *testing.T) {
	for _, tc := range []struct {
		name    string
		granted []string
		want    []string
	}{
		{"neither granted", nil, []string{"Dashboard"}},
		{"only dashboard", []string{"Dashboard"}, []string{"Dashboard"}},
		{"only reports", []string{"Reports"}, []string{"Reports"}},
		{"both granted", []string{"Dashboard", "Reports"}, []string{"Reports"}},
		// Other modules are untouched by the rule and keep their order.
		{"reports beside others", []string{"War Room", "Reports", "Data Sharing"},
			[]string{"War Room", "Reports", "Data Sharing"}},
		{"dashboard beside others", []string{"War Room", "Dashboard"},
			[]string{"Dashboard", "War Room"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := effectiveNavModules(tc.granted)
			if len(got) != len(tc.want) {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
			for i := range tc.want {
				if got[i] != tc.want[i] {
					t.Fatalf("got %v, want %v", got, tc.want)
				}
			}
		})
	}
}

// The names come from a database column, so the rule cannot depend on their
// casing matching a literal in this file.
func TestTheRuleIgnoresCasing(t *testing.T) {
	got := effectiveNavModules([]string{"dashboard", "reports"})
	if len(got) != 1 || got[0] != "reports" {
		t.Errorf("got %v, want the reports grant alone", got)
	}
}
