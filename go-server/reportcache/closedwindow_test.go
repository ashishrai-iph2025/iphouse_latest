package reportcache

import (
	"testing"
	"time"
)

func TestWindowClosed(t *testing.T) {
	day := func(off int) string { return time.Now().UTC().AddDate(0, 0, off).Format("2006-01-02") }
	cases := map[string]bool{
		day(0):       false, // today: still filling
		day(-1):      false, // yesterday: late rows may still land
		day(-2):      true,
		"2026-01-31": true,
		"":           false,
		"garbage":    false,
	}
	for to, want := range cases {
		if got := windowClosed(to); got != want {
			t.Errorf("windowClosed(%q) = %v, want %v", to, got, want)
		}
	}
}
