package handlers

import "testing"

/*
A client's hostnames against the suspended list: counted once per suspended
SITE, whatever spelling the client's rows carry, and never counting a site the
client's rows do not mention.
*/
func TestSuspensionImpactCountsEachSuspendedSiteOnce(t *testing.T) {
	suspended := map[string]int64{
		"hotauthor.com":      1000,
		"verriptv.com":       250,
		"notthisclients.com": 999999, // suspended, but never in this client's rows
	}
	hosts := []string{
		"hotauthor.com",
		"www.hotauthor.com",      // same site, www-shifted — must not count twice
		"https://VerrIPTV.com/x", // normalised before matching
		"google.com",             // in the client's rows, not suspended
	}
	count, traffic := suspensionImpact(hosts, suspended)
	if count != 2 {
		t.Errorf("count = %d, want 2 (hotauthor.com once, verriptv.com)", count)
	}
	if traffic != 1250 {
		t.Errorf("traffic = %d, want 1250 — each suspended site's traffic added once", traffic)
	}
}

/*
The fold re-checks WebsiteStatus. A reports_api that predates the
?WebsiteStatus= filter ignores it and returns EVERY domain; without this check
each of them would be counted as suspended.
*/
func TestSuspendedFromRowsKeepsOnlySuspended(t *testing.T) {
	rows := []map[string]any{
		{"DomainName": "0gomovieshd.online", "WebsiteStatus": "Suspended", "Traffic": float64(269)},
		{"DomainName": "google.com", "WebsiteStatus": nil, "Traffic": float64(88201676454)},
		{"DomainName": "live.example", "WebsiteStatus": "Active", "Traffic": float64(5)},
		// No SimilarWeb figure: still suspended, contributes no traffic.
		{"DomainName": "1024185.xyz", "WebsiteStatus": "Suspended", "Traffic": nil},
	}
	got := suspendedFromRows(rows)
	if len(got) != 2 {
		t.Fatalf("got %d suspended domains, want 2: %v", len(got), got)
	}
	if got["0gomovieshd.online"] != 269 {
		t.Errorf("traffic for 0gomovieshd.online = %d, want 269", got["0gomovieshd.online"])
	}
	if v, ok := got["1024185.xyz"]; !ok || v != 0 {
		t.Errorf("1024185.xyz should be present with 0 traffic, got %d (present=%v)", v, ok)
	}
}

// No hostname list from any spec is "not measured", not zero.
func TestApplySuspensionKPIsLeavesTilesEmptyWhenNothingReported(t *testing.T) {
	kpi := map[string]any{}
	applySuspensionKPIs(kpi, map[string]bool{}, false)
	if _, set := kpi[kpiDomainsSuspended]; set {
		t.Error("a platform with no hostname list must not get a Domains Suspended figure")
	}
}
