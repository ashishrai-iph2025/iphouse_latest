package handlers

import (
	"strings"
	"testing"
)

func shapeOf(table string, cols ...string) tableShape {
	m := make(map[string]string, len(cols))
	for _, c := range cols {
		m[strings.ToLower(c)] = c
	}
	return tableShape{Table: table, Columns: m}
}

var socialCols = []string{
	"ClientMasterId", "URLUploadDate", "AssetId", "ProfileURL", "ProfileURL_Hash",
	"ProfileRemovalStatus", "TotalInfringements", "TotalSubscribers",
	"TotalAutoClaims", "TotalManualClaims",
}

func TestSocialVODKPIsOfferTheClaimAndAudienceTiles(t *testing.T) {
	got := socialVODKPIs("dashboards.SocialMediaDashboard", shapeOf("dashboards.SocialMediaDashboard", socialCols...))
	for _, k := range []string{"autoClaims", "manualClaims", "totalSubscribers", "impactedSubscribers"} {
		if got[k] == "" {
			t.Errorf("social table is missing the %q tile", k)
		}
	}
	if !strings.Contains(got["impactedSubscribers"], "'Dead'") {
		t.Errorf("impactedSubscribers is not held to suspended profiles: %q", got["impactedSubscribers"])
	}
}

// The Summary reads a table with the same columns. manualClaims there would
// switch its removal-rate denominator to one platform's claims.
func TestSocialVODKPIsDoNotLeakOntoTheSummaryTable(t *testing.T) {
	if got := socialVODKPIs("dashboards.Unified_BI_Dashboard", shapeOf("dashboards.Unified_BI_Dashboard", socialCols...)); len(got) != 0 {
		t.Errorf("Unified_BI_Dashboard acquired social tiles: %v", got)
	}
}
