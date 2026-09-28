package admin

import (
	"testing"
	"time"
)

func TestAutoTopClamp(t *testing.T) {
	s := autoTopSettings{TopN: 500, LookbackDays: 90, EveryMinutes: 1, ReportDays: 0}
	s.clamp()
	d := defaultAutoTop()
	if s.TopN != d.TopN || s.LookbackDays != d.LookbackDays || s.EveryMinutes != d.EveryMinutes || s.ReportDays != d.ReportDays {
		t.Errorf("out-of-range settings must fall back to defaults: %+v", s)
	}
	ok := autoTopSettings{TopN: 20, LookbackDays: 30, EveryMinutes: 120, ReportDays: 90}
	ok.clamp()
	if ok.TopN != 20 || ok.LookbackDays != 30 || ok.EveryMinutes != 120 || ok.ReportDays != 90 {
		t.Errorf("in-range settings must be kept: %+v", ok)
	}
	if d.Enabled {
		t.Error("the auto-cache must be off until someone turns it on")
	}
}

func TestAutoTopPeriod(t *testing.T) {
	now := time.Date(2026, 9, 27, 10, 0, 0, 0, time.UTC)
	d := defaultAutoTop()
	if p := d.period(now); p.From != "2026-08-29" || p.To != "2026-09-27" || len(p.Windows) != 1 {
		t.Errorf("default is the last 30 days: %+v", p)
	}
	m := autoTopSettings{PeriodMode: "months", Months: 3}
	m.clamp()
	p := m.period(now)
	if len(p.Months) != 3 || p.Months[0] != "2026-07" || p.Months[2] != "2026-09" || len(p.Windows) != 3 {
		t.Errorf("last 3 months, this one included, each its own window: %+v", p)
	}
	st := autoTopSettings{PeriodMode: "start", StartDate: "2025-01-01"}
	st.clamp()
	if p := st.period(now); p.From != "2025-09-27" || p.Note == "" {
		t.Errorf("a start date over a year back is held to a year, and says so: %+v", p)
	}
	bad := autoTopSettings{PeriodMode: "start", StartDate: "2099-01-01"}
	bad.clamp()
	if bad.PeriodMode != "days" {
		t.Error("a future start date falls back to the rolling window")
	}
	big := autoTopSettings{PeriodMode: "months", Months: 24}
	big.clamp()
	if big.Months != 3 {
		t.Errorf("more than 12 months falls back to the default: %d", big.Months)
	}
}
