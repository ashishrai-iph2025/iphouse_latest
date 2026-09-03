package handlers

/*
Open Web's removal is swapped for the realtime endpoint's figure. Nothing else
on the KPI band is.

The swap is arithmetic — take Open Web's ETL share out, add the live one in — so
it rests entirely on that share being attributed to the right tables. Attribute
it too widely and a platform nobody was looking at is silently corrupted.

That is not hypothetical: the first version attributed by the inferred ROLE, and
inferRole reads "linking" off any table with an InfringingDomain column. The
mobile-apps table has one. The Mobile Apps page then reported
"10,263 of 0 taken down" at a removal rate of 0% — a removal count belonging to
another platform, over its own empty identified count. These tests exist for that
bug.
*/

import "testing"

func TestOnlyTheTwoOpenWebTablesAreAttributed(t *testing.T) {
	openWeb := []string{
		"dashboards.SportsURLRawData",
		"dashboards.SportsSourceURLRawData",
	}
	for _, tbl := range openWeb {
		if !isOpenWebSportsTable(tbl) {
			t.Errorf("%s is not attributed to Open Web — its ETL removals would be "+
				"left in the total AND the live figure added on top", tbl)
		}
	}

	/* Everything else must be left alone. The mobile-apps table is first because
	   it is the one that actually broke, and the social/telegram tables because
	   they are what the swap would corrupt next. */
	other := []string{
		"dashboards.UnifiedMobileAppsDashboardTable",
		"dashboards.SocialMedia_Sports_Raw",
		"dashboards.Agg_Daily_Telegram_Sports_Raw",
		"dashboards.SocialMediaDashboard",
		"dashboards.Agg_Daily_Telegram_MasterNew",
		"dashboards.Agg_Daily_Youtube_MasterNew",
		"dashboards.Agg_Daily_InternetSearchEngineDiscovery",
		/* The NON-sports open web is excluded too: /v1/realtime/sports answers
		   for the sports genre only, so its figure under an all-genre denominator
		   would be a different population. */
		"dashboards.InternetInfringingURLMainDashboardTable",
		"dashboards.InternetSourceURLMainDashboardTable",
		"",
	}
	for _, tbl := range other {
		if isOpenWebSportsTable(tbl) {
			t.Errorf("%s is attributed to Open Web — the swap would run on it and "+
				"report Open Web's removals against this platform's identified count",
				tbl)
		}
	}
}

// Spelling and spacing must not decide it: the table name arrives from a
// configuration row, and a stray space would silently switch the swap off and
// leave the ETL figure showing with no sign anything was skipped.
func TestOpenWebTableMatchIsForgivingOfFormatting(t *testing.T) {
	for _, tbl := range []string{
		"dashboards.sportsurlrawdata",
		"DASHBOARDS.SPORTSURLRAWDATA",
		"  dashboards.SportsURLRawData  ",
	} {
		if !isOpenWebSportsTable(tbl) {
			t.Errorf("%q was not recognised as an Open Web table", tbl)
		}
	}
	// But a different table that merely looks similar must not match.
	for _, tbl := range []string{
		"dashboards.SportsURLRawDataArchive",
		"mediascan.SportsURLRawData",
		"sportsurlrawdata",
	} {
		if isOpenWebSportsTable(tbl) {
			t.Errorf("%q matched, and it is not one of Open Web's two tables", tbl)
		}
	}
}

/*
The live call refuses to run without an explicit window.

openWebLiveRemoved asks /v1/realtime for an explicit from/to precisely so it does
NOT get the configured season — the season is five months and the report's range
is usually one, and a season-wide removal count over a month's identified count
is a removal rate above 100%. An empty window would fall back to the endpoint's
own default, which IS that season, so it has to be refused here rather than sent.

No network is reached: every case below fails the guard first.
*/
func TestOpenWebLiveRemovedNeedsAnExplicitWindow(t *testing.T) {
	cases := []struct{ clientID, from, to, why string }{
		{"", "2026-08-01", "2026-09-02", "no client"},
		{"CLIENT", "", "2026-09-02", "no start"},
		{"CLIENT", "2026-08-01", "", "no end"},
		{"CLIENT", "", "", "no window at all"},
	}
	for _, c := range cases {
		if _, ok := openWebLiveRemoved(c.clientID, "", c.from, c.to); ok {
			t.Errorf("%s: the call went ahead — it would be answered for the "+
				"configured season instead of the report's range", c.why)
		}
	}
}
