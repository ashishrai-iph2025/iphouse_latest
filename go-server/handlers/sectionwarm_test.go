package handlers

import (
	"testing"
	"time"
)

func TestSectionWindows(t *testing.T) {
	ws, err := SectionWindows([]string{"2026-08", "2026-07", "2026-07"}, "", "")
	if err != nil || len(ws) != 2 || ws[0].From != "2026-07-01" || ws[0].To != "2026-07-31" || ws[1].To != "2026-08-31" {
		t.Fatalf("months → first-to-last-day windows, deduped, oldest first: %+v %v", ws, err)
	}
	// The current month ends today — what the "This month" preset sends.
	now := time.Now().UTC()
	cur, _ := SectionWindows([]string{now.Format("2006-01")}, "", "")
	if len(cur) != 1 || cur[0].To != now.Format("2006-01-02") {
		t.Errorf("current month must end today: %+v", cur)
	}
	if _, err := SectionWindows([]string{"2025-01", "2026-01"}, "", ""); err == nil {
		t.Error("13 months must be refused")
	}
	if _, err := SectionWindows(nil, "2025-01-01", "2026-06-01"); err == nil {
		t.Error("over 366 days must be refused")
	}
	if ws, err := SectionWindows(nil, "2026-01-15", "2026-03-10"); err != nil || len(ws) != 1 || ws[0].From != "2026-01-15" {
		t.Errorf("a start-date range is one window: %+v %v", ws, err)
	}
	if _, err := SectionWindows(nil, "", ""); err == nil {
		t.Error("no period must be refused")
	}
}
