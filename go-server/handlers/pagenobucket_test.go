package handlers

import "testing"

// Page order, 5+ last, and no "(none)" bar for the rows with no bucket.
func TestPageNoRowsReadInPageOrderWithoutTheUnfilledBucket(t *testing.T) {
	rows := []map[string]any{
		{"label": "5+", "urls": int64(900)},
		{"label": "(none)", "urls": int64(10000)},
		{"label": "2", "urls": int64(300)},
		{"label": "1", "urls": int64(100)},
		{"label": "4", "urls": int64(50)},
		{"label": "3", "urls": int64(700)},
	}
	got := pageNoRows(rows)
	want := []string{"1", "2", "3", "4", "5+"}
	if len(got) != len(want) {
		t.Fatalf("got %d rows, want %d: %v", len(got), len(want), got)
	}
	for i, w := range want {
		if l := strFromAny(got[i]["label"]); l != w {
			t.Errorf("row %d = %q, want %q", i, l, w)
		}
	}
}

// Before the ETL fills the column every row is "(none)": the panel is empty,
// not a single bar.
func TestPageNoRowsEmptyWhileColumnIsUnfilled(t *testing.T) {
	if got := pageNoRows([]map[string]any{{"label": "(none)", "urls": int64(4713)}}); len(got) != 0 {
		t.Errorf("got %v, want no rows", got)
	}
}
