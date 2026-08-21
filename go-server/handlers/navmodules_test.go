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

/*
The Dashboard tab must go out identified as "dashboard".

This is the half the rule test above does not reach. effectiveNavModules only
returns NAMES; navEntries turns them into what the client matches on, and the
client matches on pageName. The seeded Dashboard row carries pageName
"DashboardAccess" — a spelling from before the nav keyed on pageName, present in
no NAV_ITEM — so an assembly that takes the row's word for it emits a tab the
client cannot place and silently drops.

Worst of all it failed only for the logins that HAD the grant: without one the
lookup missed and the fallback was correct, so the bug hid behind the accounts
most likely to be used for testing it.
*/
func TestDashboardTabKeepsTheNavsPageName(t *testing.T) {
	dropByParent := map[string][]map[string]any{}

	seeded := map[string]map[string]any{
		"dashboard": {
			"moduleId": int64(1), "ModuleName": "Dashboard",
			"pageName": "DashboardAccess", "navOrder": int64(1),
		},
		"war room": {
			"moduleId": int64(8), "ModuleName": "War Room",
			"pageName": "war-room", "navOrder": int64(7),
		},
	}

	t.Run("granted, with the legacy pageName on the row", func(t *testing.T) {
		got := navEntries([]string{"Dashboard", "War Room"}, seeded, dropByParent)
		if len(got) != 2 {
			t.Fatalf("got %d entries, want 2: %v", len(got), got)
		}
		if got[0]["pageName"] != "dashboard" {
			t.Errorf("pageName = %v, want %q — the client keys on this",
				got[0]["pageName"], "dashboard")
		}
		// The row still supplies everything the nav is allowed to take from it.
		if got[0]["moduleName"] != "Dashboard" {
			t.Errorf("moduleName = %v, want the row's name", got[0]["moduleName"])
		}
		if intFromAny(got[0]["navOrder"]) != 1 {
			t.Errorf("navOrder = %v, want the row's order", got[0]["navOrder"])
		}
	})

	t.Run("not granted, so the fallback stands in", func(t *testing.T) {
		got := navEntries([]string{"War Room"}, map[string]map[string]any{
			"war room": seeded["war room"],
		}, dropByParent)
		if len(got) != 2 {
			t.Fatalf("got %v, want the fallback beside war-room", got)
		}
		// moduleId 0 marks it as synthesised rather than granted.
		if got[0]["pageName"] != "dashboard" || intFromAny(got[0]["moduleId"]) != 0 {
			t.Errorf("got %v, want a synthesised dashboard entry", got[0])
		}
	})

	t.Run("nothing granted at all", func(t *testing.T) {
		got := navEntries(nil, map[string]map[string]any{}, dropByParent)
		if len(got) != 1 || got[0]["pageName"] != "dashboard" {
			t.Fatalf("got %v, want the synthesised dashboard entry alone", got)
		}
	})

	/* Renaming a module on /admin/modules relabels its tab. Renaming it away
	   from "Dashboard" also takes it out of the rule's sight — the rule is
	   written in names — so it becomes an ordinary module carrying its own
	   pageName, and the fallback appears beside it. That is the rule working,
	   not leaking: the floor is a Dashboard tab, whatever else is granted. */
	t.Run("a module renamed away from Dashboard passes through", func(t *testing.T) {
		renamed := map[string]map[string]any{"my figures": {
			"moduleId": int64(1), "ModuleName": "My Figures",
			"pageName": "DashboardAccess", "navOrder": int64(1),
		}}
		got := navEntries([]string{"My Figures"}, renamed, dropByParent)
		if len(got) != 2 {
			t.Fatalf("got %v, want the fallback beside the renamed module", got)
		}
		if got[1]["pageName"] != "DashboardAccess" {
			t.Errorf("pageName = %v, want the row's own", got[1]["pageName"])
		}
	})

	/* Reports granted means no Dashboard tab — the other half of the rule,
	   asserted here because this is the function that emits it. */
	t.Run("reports replaces the dashboard tab", func(t *testing.T) {
		withReports := map[string]map[string]any{
			"dashboard": seeded["dashboard"],
			"reports": {
				"moduleId": int64(10), "ModuleName": "Reports",
				"pageName": "Reports", "navOrder": int64(0),
			},
		}
		got := navEntries([]string{"Dashboard", "Reports"}, withReports, dropByParent)
		if len(got) != 1 || got[0]["pageName"] != "Reports" {
			t.Fatalf("got %v, want Reports alone", got)
		}
	})
}
