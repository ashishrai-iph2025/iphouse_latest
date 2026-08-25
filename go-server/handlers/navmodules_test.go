package handlers

import "testing"

/*
Dashboard and Reports are one entitlement with two faces.

They show the same client's figures, so a login never gets both:

	Reports granted      → Reports, and Dashboard is dropped even where it was
	                       also ticked. Two nav items for the same numbers is
	                       two places to disagree and a choice with no meaning.
	Reports not granted  → Dashboard, if it was granted. Otherwise neither.

Dashboard is a permission, not a floor. It was briefly synthesised for every
login without Reports, which put a module in the nav that nobody had granted and
that no admin could take away. The rule now only ever REMOVES.

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
		{"nothing granted", nil, nil},
		{"only dashboard", []string{"Dashboard"}, []string{"Dashboard"}},
		{"only reports", []string{"Reports"}, []string{"Reports"}},
		{"both granted", []string{"Dashboard", "Reports"}, []string{"Reports"}},
		// Neither of the two is granted, and none is invented to fill the gap.
		{"neither, but other modules are", []string{"War Room"}, []string{"War Room"}},
		// Other modules are untouched by the rule and keep their order.
		{"reports beside others", []string{"War Room", "Reports", "Data Sharing"},
			[]string{"War Room", "Reports", "Data Sharing"}},
		{"dashboard beside others", []string{"War Room", "Dashboard"},
			[]string{"War Room", "Dashboard"}},
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

This is the half the rule test above does not reach. effectiveNavModules returns
NAMES; navEntries turns them into what the client matches on, and the client
matches on pageName. The seeded Dashboard row carries pageName "DashboardAccess"
— a spelling from before the nav keyed on pageName, present in no NAV_ITEM — so
an assembly that takes the row's word for it emits a tab the client cannot place
and silently drops.
*/
func TestDashboardTabKeepsTheNavsPageName(t *testing.T) {
	dropByParent := map[string][]map[string]any{}

	dashboardRow := map[string]any{
		"moduleId": int64(1), "ModuleName": "Dashboard",
		"pageName": "DashboardAccess", "navOrder": int64(1),
	}
	warRoomRow := map[string]any{
		"moduleId": int64(8), "ModuleName": "War Room",
		"pageName": "war-room", "navOrder": int64(7),
	}

	t.Run("granted, despite the legacy pageName on the row", func(t *testing.T) {
		got := navEntries(
			[]string{"Dashboard", "War Room"},
			map[string]map[string]any{"dashboard": dashboardRow, "war room": warRoomRow},
			dropByParent,
		)
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
		if intFromAny(got[0]["moduleId"]) != 1 {
			t.Errorf("moduleId = %v, want the row's id", got[0]["moduleId"])
		}
	})

	/* The point of the change: no grant, no tab. Previously this returned a
	   synthesised Dashboard entry, so an admin who unticked the module saw it
	   reappear on the next page load. */
	t.Run("not granted, so no dashboard entry at all", func(t *testing.T) {
		got := navEntries(
			[]string{"War Room"},
			map[string]map[string]any{"war room": warRoomRow},
			dropByParent,
		)
		if len(got) != 1 || got[0]["pageName"] != "war-room" {
			t.Fatalf("got %v, want war-room alone", got)
		}
	})

	t.Run("nothing granted yields nothing", func(t *testing.T) {
		got := navEntries(nil, map[string]map[string]any{}, dropByParent)
		if len(got) != 0 {
			t.Fatalf("got %v, want an empty nav", got)
		}
	})

	t.Run("reports replaces the dashboard tab", func(t *testing.T) {
		got := navEntries(
			[]string{"Dashboard", "Reports"},
			map[string]map[string]any{
				"dashboard": dashboardRow,
				"reports": {
					"moduleId": int64(10), "ModuleName": "Reports",
					"pageName": "Reports", "navOrder": int64(0),
				},
			},
			dropByParent,
		)
		if len(got) != 1 || got[0]["pageName"] != "Reports" {
			t.Fatalf("got %v, want Reports alone", got)
		}
	})

	/* Renaming a module on /admin/modules relabels its tab. Renaming it away
	   from "Dashboard" also takes it out of the rule's sight — the rule is
	   written in names — so it becomes an ordinary module carrying its own
	   pageName. Asserted so the coupling is visible rather than surprising. */
	t.Run("a module renamed away from Dashboard passes through", func(t *testing.T) {
		got := navEntries(
			[]string{"My Figures"},
			map[string]map[string]any{"my figures": {
				"moduleId": int64(1), "ModuleName": "My Figures",
				"pageName": "DashboardAccess", "navOrder": int64(1),
			}},
			dropByParent,
		)
		if len(got) != 1 {
			t.Fatalf("got %v, want the renamed module alone", got)
		}
		if got[0]["pageName"] != "DashboardAccess" {
			t.Errorf("pageName = %v, want the row's own", got[0]["pageName"])
		}
	})
}
