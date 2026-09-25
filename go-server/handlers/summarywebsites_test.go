package handlers

import "testing"

// The Sports Summary's five tables, each contributing its own kind of place.
func TestSummaryWebsitesComposesPlacesPerChannel(t *testing.T) {
	parts := []struct {
		table string
		kpi   map[string]any
	}{
		{"dashboards.SportsURLRawData", map[string]any{"totalDomains": int64(400)}},
		{"dashboards.SportsSourceURLRawData", map[string]any{"totalDomains": int64(200)}},
		{"dashboards.SocialMedia_Sports_Raw", map[string]any{"totalChannels": int64(150)}},
		{"dashboards.Agg_Daily_Telegram_Sports_Raw", map[string]any{"totalChannels": int64(50)}},
		// A store listing's domain is not a place a viewer watched.
		{"dashboards.UnifiedMobileAppsDashboardTable", map[string]any{"totalDomains": int64(12)}},
	}
	var sum int64
	for _, p := range parts {
		if n, ok := summaryWebsites(p.table, p.kpi); ok {
			sum += n
		}
	}
	if sum != 800 {
		t.Errorf("Total Websites = %d, want 800 (400 linking + 200 host + 150 profiles + 50 channels)", sum)
	}
}

// A table that did not report its figure contributes nothing rather than zero.
func TestSummaryWebsitesSkipsAMissingFigure(t *testing.T) {
	if _, ok := summaryWebsites("dashboards.SocialMedia_Sports_Raw", map[string]any{}); ok {
		t.Error("a social table with no channel count should not contribute")
	}
}
