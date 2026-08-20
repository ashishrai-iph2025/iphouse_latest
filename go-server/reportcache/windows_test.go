package reportcache

// The windows a pass covers, checked against the ranges the date picker
// actually produces.
//
// A cached report is keyed by its exact from/to, so a window that is one day out
// is not a slightly wrong warm — it is a key nobody will ever ask for, and the
// reader who picks that preset pays full price while the admin screen reports
// the pass as covering them.

import (
	"testing"
	"time"
)

func find(t *testing.T, wins []WarmWindow, key string) WarmWindow {
	t.Helper()
	for _, w := range wins {
		if w.Key == key {
			return w
		}
	}
	t.Fatalf("no %q window in %v", key, wins)
	return WarmWindow{}
}

func TestWarmWindowsMatchThePickerPresets(t *testing.T) {
	// A Wednesday in mid-month, so "this month" and "last 30 days" are visibly
	// different ranges rather than accidentally equal.
	now := time.Date(2026, 8, 19, 13, 45, 0, 0, time.UTC)
	wins := WarmWindows(now, []int{1, 7, 15, 30, 90}, true)

	if len(wins) != 8 {
		t.Fatalf("expected 5 rolling + 3 calendar = 8 windows, got %d: %v", len(wins), wins)
	}

	// "Last N days" is inclusive of today — 7 days is today plus the 6 before
	// it. Off by one here and every rolling window misses the picker by a day.
	for _, tc := range []struct{ key, from string }{
		{"1", "2026-08-19"},
		{"7", "2026-08-13"},
		{"15", "2026-08-05"},
		{"30", "2026-07-21"},
		{"90", "2026-05-22"},
	} {
		w := find(t, wins, tc.key)
		if w.From != tc.from || w.To != "2026-08-19" {
			t.Errorf("window %s = %s→%s, want %s→2026-08-19", tc.key, w.From, w.To, tc.from)
		}
	}

	if w := find(t, wins, "mtd"); w.From != "2026-08-01" || w.To != "2026-08-19" {
		t.Errorf("this month = %s→%s, want 2026-08-01→2026-08-19", w.From, w.To)
	}
	// The last day of the previous month, whatever its length.
	if w := find(t, wins, "lm"); w.From != "2026-07-01" || w.To != "2026-07-31" {
		t.Errorf("last month = %s→%s, want 2026-07-01→2026-07-31", w.From, w.To)
	}
	if w := find(t, wins, "ytd"); w.From != "2026-01-01" || w.To != "2026-08-19" {
		t.Errorf("this year = %s→%s, want 2026-01-01→2026-08-19", w.From, w.To)
	}
}

/*
February, a leap year, and January — the three dates where "the month before
this one" is arithmetic rather than subtracting thirty.
*/
func TestLastMonthAtTheAwkwardBoundaries(t *testing.T) {
	for _, tc := range []struct{ now, from, to string }{
		// March in a leap year: February has 29 days.
		{"2028-03-10", "2028-02-01", "2028-02-29"},
		// March in a common year.
		{"2026-03-10", "2026-02-01", "2026-02-28"},
		// January: last month is in the previous YEAR.
		{"2026-01-05", "2025-12-01", "2025-12-31"},
		// The 31st, where naive month arithmetic lands on the 1st or the 3rd.
		{"2026-05-31", "2026-04-01", "2026-04-30"},
	} {
		now, err := time.Parse("2006-01-02", tc.now)
		if err != nil {
			t.Fatal(err)
		}
		w := find(t, WarmWindows(now, nil, true), "lm")
		if w.From != tc.from || w.To != tc.to {
			t.Errorf("on %s last month = %s→%s, want %s→%s", tc.now, w.From, w.To, tc.from, tc.to)
		}
	}
}

func TestCalendarWindowsCanBeTurnedOff(t *testing.T) {
	wins := WarmWindows(time.Now().UTC(), []int{30}, false)
	if len(wins) != 1 || wins[0].Key != "30" {
		t.Fatalf("expected only the rolling window, got %v", wins)
	}
}
