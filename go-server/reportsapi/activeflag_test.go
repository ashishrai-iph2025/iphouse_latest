package reportsapi

// Whether a client-master row counts as active.
//
// It matters more than it looks. The list this feeds is what an operator picks
// from, and the two ways to get it wrong fail in opposite directions: read
// "inactive" as active and a retired company is offered and warmed; read
// "missing" as inactive and every picker in the product empties at once.

import "testing"

func TestActiveFlagReadsTheSpellingsAServiceMightSend(t *testing.T) {
	for _, tc := range []struct {
		name string
		row  map[string]any
		on   bool
		had  bool
	}{
		// JSON numbers arrive as float64, whatever the column's SQL type.
		{"json 1", map[string]any{"Active": float64(1)}, true, true},
		{"json 0", map[string]any{"Active": float64(0)}, false, true},
		{"bool true", map[string]any{"Active": true}, true, true},
		{"bool false", map[string]any{"Active": false}, false, true},
		{"string 1", map[string]any{"Active": "1"}, true, true},
		{"string 0", map[string]any{"Active": "0"}, false, true},
		{"string Y", map[string]any{"Active": "Y"}, true, true},
		{"word Active", map[string]any{"Active": "Active"}, true, true},
		{"word Inactive", map[string]any{"Active": "Inactive"}, false, true},
		{"IsActive spelling", map[string]any{"IsActive": float64(1)}, true, true},
		// The service names its own columns; case is not ours to assume.
		{"lowercase column", map[string]any{"active": float64(1)}, true, true},
		{"odd case column", map[string]any{"ACTIVE": float64(0)}, false, true},

		/* The cases that must report had=false. A row with no activity column,
		   or a null one, says nothing — and "says nothing" must never be read as
		   "inactive", or a master without the column hides every company it
		   lists. */
		{"no column at all", map[string]any{"Id": "X", "CompanyName": "Acme"}, false, false},
		{"null value", map[string]any{"Active": nil}, false, false},
		{"unrecognised word", map[string]any{"Active": "maybe"}, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			on, had := activeFlag(tc.row)
			if on != tc.on || had != tc.had {
				t.Errorf("activeFlag(%v) = (%v, %v), want (%v, %v)", tc.row, on, had, tc.on, tc.had)
			}
		})
	}
}
