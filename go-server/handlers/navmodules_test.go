package handlers

import "testing"

/*
The Dashboard tab must go out identified as "dashboard".

navEntries turns granted module NAMES into what the client matches on, and the
client matches on pageName. The seeded Dashboard row carries pageName
"DashboardAccess" — a spelling from before the nav keyed on pageName, present
in no NAV_ITEM — so an assembly that takes the row's word for it emits a tab
the client cannot place and silently drops.
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

	/* No grant, no tab. Previously this returned a synthesised Dashboard entry,
	   so an admin who unticked the module saw it reappear on the next page
	   load. */
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

	/* Dashboard and Reports are two separate grants: a login holding both sees
	   both tabs. There used to be a rule collapsing this to Reports alone —
	   removed because an admin who deliberately ticks both wants both, not a
	   silent drop of one of them. */
	t.Run("dashboard and reports both granted, both tabs appear", func(t *testing.T) {
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
		if len(got) != 2 {
			t.Fatalf("got %d entries, want 2: %v", len(got), got)
		}
	})

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
