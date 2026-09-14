package handlers

/*
The account's own state, on the panel that ranks by reach — three words, not
two, because RemovalProfileStatus distinguishes an account confirmed ACTIVE
from one this source never said anything about, and a reader ranking accounts
by audience wants to know which is which. Contrast with the repeat-offender
panel, which deliberately folds Active and "never told" into one label — see
repeatoffenders_test.go: TestProfileStatusIsSuspendedOrNotAvailable.
*/

import "testing"

func TestTopProfileStatusIsSuspendedActiveOrNotAvailable(t *testing.T) {
	base := func(status any) []map[string]any {
		return []map[string]any{
			{"ProfileURL": "p", "Subscribers": 100, "RemovalProfileStatus": status},
		}
	}
	for _, c := range []struct {
		status any
		want   string
	}{
		{"Dead", "Suspended"},
		{"DEAD", "Suspended"}, // the casing drift isDead exists for
		{"Active", "Active"},
		{"ACTIVE", "Active"}, // matched case-insensitively, same as Dead
		{"", "Not Available"},
		{nil, "Not Available"},
		{"Something Else", "Not Available"}, // a value neither Dead nor Active is not told apart from blank
	} {
		out := computeTopProfiles(base(c.status), "ProfileURL", "Subscribers",
			"RemovalProfileStatus", "", "", "", "", 10)
		if len(out) != 1 {
			t.Fatalf("status %v: no row drawn", c.status)
		}
		if got := strFromAny(out[0]["profileStatus"]); got != c.want {
			t.Errorf("status %v drew %q, want %q", c.status, got, c.want)
		}
	}
}

// Dead is STICKY and wins over an earlier Active — the account's final state,
// however many rows called it Active before one called it Dead. Same rule
// computeRepeatOffenders applies to its own profileDead flag.
func TestTopProfileDeadWinsOverActiveAcrossRows(t *testing.T) {
	rows := []map[string]any{
		{"ProfileURL": "p", "Subscribers": 100, "RemovalProfileStatus": "Active"},
		{"ProfileURL": "p", "Subscribers": 100, "RemovalProfileStatus": "Dead"},
	}
	out := computeTopProfiles(rows, "ProfileURL", "Subscribers", "RemovalProfileStatus", "", "", "", "", 10)
	if len(out) != 1 {
		t.Fatalf("no row drawn")
	}
	if got := strFromAny(out[0]["profileStatus"]); got != "Suspended" {
		t.Errorf("profileStatus = %q, want %q", got, "Suspended")
	}
}

// A dataset with no status column at all draws every account as Not Available,
// not absent — the column still appears, honestly reporting that this source
// cannot say. Same word the repeat-offender panel uses for its own unknown
// case, so a reader does not learn a second word for "this source cannot tell".
func TestTopProfileStatusIsNotAvailableWithNoStatusColumn(t *testing.T) {
	rows := []map[string]any{{"ProfileURL": "p", "Subscribers": 100}}
	out := computeTopProfiles(rows, "ProfileURL", "Subscribers", "", "", "", "", "", 10)
	if len(out) != 1 {
		t.Fatalf("no row drawn")
	}
	if got := strFromAny(out[0]["profileStatus"]); got != "Not Available" {
		t.Errorf("profileStatus = %q, want %q", got, "Not Available")
	}
}

/*
The account's PLATFORM, read the same way its name is — first non-empty row
wins, because a profile URL belongs to one platform throughout the window.
*/
func TestTopProfilePlatformIsReadFromTheRow(t *testing.T) {
	rows := []map[string]any{
		{"ProfileURL": "p", "Subscribers": 100, "Platform": "YouTube"},
		// A later row that goes quiet on the column must not blank out what an
		// earlier one said — same "first non-empty wins" rule the name uses.
		{"ProfileURL": "p", "Subscribers": 120, "Platform": ""},
	}
	out := computeTopProfiles(rows, "ProfileURL", "Subscribers", "", "", "Platform", "", "", 10)
	if len(out) != 1 {
		t.Fatalf("no row drawn")
	}
	if got := strFromAny(out[0]["platform"]); got != "YouTube" {
		t.Errorf("platform = %q, want %q", got, "YouTube")
	}
}

// A table with no platform column draws every account with an EMPTY platform,
// not a guessed one — the frontend reads that as "nothing to show", the same
// way it reads an empty profileStatus as "no status column at all".
func TestTopProfilePlatformIsEmptyWithNoPlatformColumn(t *testing.T) {
	rows := []map[string]any{{"ProfileURL": "p", "Subscribers": 100, "Platform": "YouTube"}}
	// platformCol left empty — the column is on the row, but nothing said to read it.
	out := computeTopProfiles(rows, "ProfileURL", "Subscribers", "", "", "", "", "", 10)
	if len(out) != 1 {
		t.Fatalf("no row drawn")
	}
	if got := strFromAny(out[0]["platform"]); got != "" {
		t.Errorf("platform = %q, want empty — platformCol was not given", got)
	}
}
