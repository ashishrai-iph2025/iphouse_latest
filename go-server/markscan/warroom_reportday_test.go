package markscan

import "testing"

/*
The exact bug this file pins: a report window of 2026-08-11 through 2026-08-31
undercounted YouTube against a direct MarkScan pull for the same asset and the
same calendar days — 6,940 against a true 7,102. Both gaps traced to the same
mistake in two different places: treating a UTC instant as if its own date
substring were the report's IST calendar day.

MarkScanDayRange fixes the FETCH boundary (handlers/warroom.go sent the bare
"2026-08-11" straight through, which MarkScan reads as UTC midnight — 5h30m
late). ReportDay fixes the LOCAL RE-FILTER (FilterRowsByDate compared a row's
raw UTC timestamp's own date substring against the requested window, which
names the wrong day for the 5h30m after IST midnight). Either bug alone drops
rows from the first hours of the window's start day; both were live at once.
*/

func TestMarkScanDayRangeMatchesTheVerifiedManualQuery(t *testing.T) {
	// The exact bounds a manually-built, correctly-converted MarkScan request
	// used to confirm the true total (7,102) for this asset and window — see
	// the file header. MarkScanDayRange must reproduce them from the bare
	// calendar days the date-range picker actually sends.
	start, end, ok := MarkScanDayRange("2026-08-11", "2026-08-31")
	if !ok {
		t.Fatal("expected a valid range")
	}
	if start != "2026-08-10T18:30:00.000Z" {
		t.Errorf("start = %q, want 2026-08-10T18:30:00.000Z (IST midnight on the "+
			"11th, as a UTC instant)", start)
	}
	if end != "2026-08-31T18:29:59.999Z" {
		t.Errorf("end = %q, want 2026-08-31T18:29:59.999Z (one millisecond before "+
			"IST midnight on September 1st)", end)
	}
}

func TestMarkScanDayRangeOpenEnded(t *testing.T) {
	start, end, ok := MarkScanDayRange("2026-08-11", "")
	if !ok {
		t.Fatal("expected a valid range")
	}
	if start != "2026-08-10T18:30:00.000Z" {
		t.Errorf("start = %q, want 2026-08-10T18:30:00.000Z", start)
	}
	if end != "" {
		t.Errorf("end = %q, want empty — an absent endDay must stay absent, not "+
			"become a date", end)
	}
}

func TestMarkScanDayRangeRejectsAMalformedDay(t *testing.T) {
	if _, _, ok := MarkScanDayRange("11 Aug 2026", ""); ok {
		t.Error("expected a non-YYYY-MM-DD startDay to be rejected rather than " +
			"silently parsed as something else")
	}
}

/*
The regression the bug report actually surfaced: a row uploaded in the first
5.5 hours of the window's first IST day. Its UTC timestamp's own date
substring is the PREVIOUS day — 2026-08-10 — even though the row belongs to
2026-08-11 on the report's calendar. Before this fix, FilterRowsByDate compared
that substring against the requested window and dropped the row.
*/
func TestReportDayNamesTheISTCalendarDayNotTheUTCOne(t *testing.T) {
	cases := []struct {
		name       string
		utcInstant string
		wantISTDay string
	}{
		{
			name:       "just after IST midnight, still the previous UTC day",
			utcInstant: "2026-08-10T19:00:00.000Z", // 2026-08-11 00:30 IST
			wantISTDay: "2026-08-11",
		},
		{
			name:       "just before IST midnight, still the same UTC day",
			utcInstant: "2026-08-11T17:00:00.000Z", // 2026-08-11 22:30 IST
			wantISTDay: "2026-08-11",
		},
		{
			name:       "well inside the UTC day, no boundary crossed",
			utcInstant: "2026-08-15T10:00:00.000Z", // 2026-08-15 15:30 IST
			wantISTDay: "2026-08-15",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			row := map[string]any{"urlUploadDate": c.utcInstant}
			if got := ReportDay(row); got != c.wantISTDay {
				t.Errorf("ReportDay(%q) = %q, want %q", c.utcInstant, got, c.wantISTDay)
			}
		})
	}
}

// The end-to-end shape of the bug: FilterRowsByDate must keep a row whose UTC
// timestamp names the day before the window, when that row's true IST day is
// the window's own first day.
func TestFilterRowsByDateKeepsTheFirstHoursOfISTDayOne(t *testing.T) {
	rows := []map[string]any{
		{"id": "early", "urlUploadDate": "2026-08-10T19:00:00.000Z"},         // 2026-08-11 00:30 IST
		{"id": "before-window", "urlUploadDate": "2026-08-10T10:00:00.000Z"}, // 2026-08-10 15:30 IST
	}
	out := FilterRowsByDate(rows, "2026-08-11", "2026-08-31")
	if len(out) != 1 || out[0]["id"] != "early" {
		t.Errorf("got %v; want exactly the row whose IST day is 2026-08-11 kept, "+
			"and the row whose IST day is still 2026-08-10 dropped", out)
	}
}
