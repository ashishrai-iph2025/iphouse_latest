package handlers

import (
	"strings"
	"testing"
)

/*
The brand, on the hostnames this actually has to get right.

Every case here came off the live warehouse, and the two marked ones are the
reason the rule departs from the Power BI model at all — before the departure
they reported brands of "en" and "live", which are not brands.
*/
func TestDomainRootBrand(t *testing.T) {
	for _, c := range []struct{ host, want string }{
		// No subdomain — the registrable domain is the whole thing.
		{"livetv.sx", "livetv"},
		{"vipleague.io", "vipleague"},
		{"foo.com", "foo"},

		// Numbered clones fold into one brand.
		{"livetv901.me", "livetv"},
		{"foo2.com", "foo"},
		{"foo1234.com", "foo"},
		// FIVE digits: at most four come off, so this is "foo1". A brand that
		// genuinely ends in digits keeps them past the fourth.
		{"foo12345.com", "foo1"},

		/* SUBDOMAINS ARE NOT BRANDS. Every one of these reported the leading
		   label before the rule changed, and they are what put "v", "s-c",
		   "481-pull" and "178cs" at the top of the Root Domain panel ranked as
		   though they were major operators. */
		{"jackgzh8.4fguseaicu74adjective.sbs", "4fguseaicu74adjective"},
		{"v3.example.com", "example"},
		{"s-c.example.com", "example"},
		{"481-pull.example.com", "example"},
		{"pc-gqj-pull.example.com", "example"},
		{"178cs.example.com", "example"},
		{"lb.example.com", "example"},

		// The prefixes the old rule needed a list for now fall away like any
		// other subdomain.
		{"www.live.com", "live"},
		{"cdn.livetv872.me", "livetv"},
		{"m.foo.com", "foo"},
		{"ja.foo.com", "foo"},
		{"en12.sportplus.live", "sportplus"},
		{"live3.totalsportek.christmas", "totalsportek"},
		{"a.b.c.foo.com", "foo"},

		// Multi-part public suffixes.
		{"example.co.uk", "example"},
		{"shop.example.com.br", "example"},
		// ".website" is a long TLD, so "co" here is a brand, not a suffix.
		{"co.website", "co"},

		// A word that merely starts with a former prefix is untouched.
		{"livescore.com", "livescore"},
		{"english.example.com", "example"},

		// Degenerate input must not panic or fold everything into one group.
		{"", ""},
		{"localhost", "localhost"},
		{"WWW.FOO.COM", "foo"},
		{"  livetv.sx  ", "livetv"},
		{"foo..com", "foo"},
		{"foo.com.", "foo"},
		{"12.foo.com", "foo"},
	} {
		if got := domainRootBrand(c.host); got != c.want {
			t.Errorf("domainRootBrand(%q) = %q, want %q", c.host, got, c.want)
		}
	}
}

/*
Folding is where the two numbers the report wants come from: the volume behind a
brand, and how many hostnames it is spread over. A brand carrying one without
the other cannot say whether a rise is a new operator or one operator spawning
mirrors.
*/
func TestFoldDomainRowsSumsAndCountsMirrors(t *testing.T) {
	rows := []map[string]any{
		{"label": "livetv.sx", "urls": int64(100), "removed": int64(40)},
		{"label": "livetv901.me", "urls": int64(50), "removed": int64(10)},
		{"label": "cdn.livetv872.me", "urls": int64(25), "removed": int64(5)},
		{"label": "vipleague.io", "urls": int64(200), "removed": int64(90)},
	}
	out := foldDomainRows(rows, domainRootBrand)

	if len(out) != 2 {
		t.Fatalf("folded to %d brands, want 2: %v", len(out), out)
	}
	// Ranked by volume, like every other breakdown panel.
	if got := strFromAny(out[0]["label"]); got != "vipleague" {
		t.Errorf("first brand is %q, want vipleague — rows are not ranked by volume", got)
	}

	byName := map[string]map[string]any{}
	for _, r := range out {
		byName[strFromAny(r["label"])] = r
	}
	lt := byName["livetv"]
	if numOf(lt["urls"]) != 175 {
		t.Errorf("livetv urls = %v, want 175 — the mirrors were not added up", lt["urls"])
	}
	if numOf(lt["removed"]) != 55 {
		t.Errorf("livetv removed = %v, want 55", lt["removed"])
	}
	if numOf(lt["mirrors"]) != 3 {
		t.Errorf("livetv mirrors = %v, want 3", lt["mirrors"])
	}
	/* No `value`. A brand is not something the warehouse holds, so there is no
	   id to filter on — and a row carrying one would make the panel look
	   clickable when the click cannot be pushed down to the API. */
	if _, has := lt["value"]; has {
		t.Error("a folded row carries a filter value it cannot be filtered by")
	}
}

// Every panel this file answers for must be recognised, and nothing else may
// be — a dimension wrongly routed here would be folded from hostnames instead
// of being grouped by the API.
func TestDomainFoldForRoutesOnlyItsOwnPanels(t *testing.T) {
	for _, k := range []string{dimDomainRoot, dimDomainRootMirrors} {
		if _, ok := domainFoldFor(k); !ok {
			t.Errorf("%s is not routed to the fold", k)
		}
	}
	for _, k := range []string{"byDomain", "byDomainSource", "byAsset", "byTAT", ""} {
		if _, ok := domainFoldFor(k); ok {
			t.Errorf("%s was wrongly routed to the domain fold", k)
		}
	}
}

/*
An asset panel must be able to name its rows even when the fact table's own name
column is empty.

The registry prefers the NAME column wherever a table has one, so byAssetName
wins the dedup against byAsset and carries no lookup. That is right until the
column exists and is entirely NULL — Agg_Daily_Telegram_Sports_Raw has AssetId
on all 8,926 rows and AssetName on none of them — at which point every group
came back unlabelled, the merge dropped every row for having no label, and a
panel titled "Top 10 Assets" read "No data." beside a tile reporting 267 assets.
*/
func TestAssetDimensionsAlwaysResolveAMaster(t *testing.T) {
	for _, key := range []string{"byAsset", "byAssetName"} {
		// As the registry declares it: no lookup of its own.
		if got := lookupForDim(dimension{Key: key}); got != assetMasterTable {
			t.Errorf("%s falls back to %q, want %q — its rows cannot be named",
				key, got, assetMasterTable)
		}
	}
	// A dimension that declares its own lookup keeps it.
	own := dimension{Key: "byGenreId", LookupTable: "mediascan.Genre"}
	if got := lookupForDim(own); got != "mediascan.Genre" {
		t.Errorf("declared lookup was overridden with %q", got)
	}
	// Everything else still resolves to nothing, so no panel gains a join it
	// was never meant to have.
	if got := lookupForDim(dimension{Key: "byDomain"}); got != "" {
		t.Errorf("byDomain gained a lookup: %q", got)
	}
}

/*
Every dimension the warehouse spells two ways needs a master to fall back on.

Each has a NAME form the registry prefers and an ID form behind it, and
reports_api resolves a name column to the id dimension it labels — so a table
whose name column is null hands back ids nobody can read, the values are dropped
as unpickable, and the SLICER RENDERS EMPTY with nothing to say why. Language
did exactly that on Agg_Daily_Telegram_Sports_Raw.

Genre is deliberately absent: reports_api serves no genre master, and every
table carrying the dimension has a readable GenreName.
*/
func TestNameFormDimensionsFallBackToAMaster(t *testing.T) {
	want := map[string]string{
		"byLanguage":           "mediascan.Language",
		"byLanguageId":         "mediascan.Language",
		"byCountry":            "mediascan.Countries",
		"byCountryId":          "mediascan.Countries",
		"byQuality":            "mediascan.QualityOfPrint",
		"byQualityId":          "mediascan.QualityOfPrint",
		"byInfringementType":   "mediascan.InfringmentType",
		"byInfringementTypeId": "mediascan.InfringmentType",
		"bySearchEngine":       "mediascan.SearchEngine",
		"bySearchEngineId":     "mediascan.SearchEngine",
	}
	for key, table := range want {
		if got := lookupForDim(dimension{Key: key}); got != table {
			t.Errorf("%s falls back to %q, want %q — its slicer empties when the "+
				"table's name column is null", key, got, table)
		}
	}
	if got := lookupForDim(dimension{Key: "byGenre"}); got != "" {
		t.Errorf("byGenre resolves %q, but reports_api serves no genre master", got)
	}
}

/*
Every source table must resolve to a channel, and the two halves of the open web
must resolve to the SAME one.

That merge is the reason the mapping exists: the warehouse splits the open web
into the pages that link to infringing content and the ones that host it, and to
anyone comparing the open web against Telegram they are one channel. Matching
order matters as much as the names — a mobile-apps table also holds URL columns,
so the specific fragments have to be tested before the general "url" one.
*/
func TestSourceChannelNames(t *testing.T) {
	for _, c := range []struct{ table, want string }{
		{"dashboards.SportsURLRawData", "Open Web"},
		{"dashboards.SportsSourceURLRawData", "Open Web"},
		{"dashboards.InternetInfringingURLMainDashboardTable", "Open Web"},
		{"dashboards.InternetSourceURLMainDashboardTable", "Open Web"},
		{"dashboards.Agg_Daily_Telegram_Sports_Raw", "Telegram"},
		{"dashboards.Agg_Daily_Telegram_MasterNew", "Telegram"},
		{"dashboards.SocialMedia_Sports_Raw", "Social Media / UGC"},
		{"dashboards.SocialMediaDashboard", "Social Media / UGC"},
		// Holds URL columns, so it must be matched before the "url" fragment.
		{"dashboards.UnifiedMobileAppsDashboardTable", "Mobile Apps"},
		{"dashboards.Agg_Daily_Youtube_MasterNew", "YouTube"},
		{"dashboards.Agg_Daily_InternetSearchEngineDiscovery", "Search Engine"},
	} {
		if got := sourceChannelName(c.table); got != c.want {
			t.Errorf("sourceChannelName(%q) = %q, want %q", c.table, got, c.want)
		}
	}

	// The sports summary's five tables are four channels.
	p := platformDef{Tables: []string{
		"dashboards.Agg_Daily_Telegram_Sports_Raw",
		"dashboards.SocialMedia_Sports_Raw",
		"dashboards.SportsSourceURLRawData",
		"dashboards.SportsURLRawData",
		"dashboards.UnifiedMobileAppsDashboardTable",
	}}
	if got := sourceChannelsFor(p); len(got) != 4 {
		t.Errorf("five tables resolved to %d channels (%v), want 4", len(got), got)
	}

	// A single-channel platform gets no comparison panel: one bar equal to the
	// KPI tile above it says nothing.
	one := platformDef{Tables: []string{
		"dashboards.SportsURLRawData",
		"dashboards.SportsSourceURLRawData",
	}}
	if got := sourceChannelsFor(one); len(got) != 1 {
		t.Errorf("both open-web tables resolved to %d channels (%v), want 1", len(got), got)
	}
}

/*
The two "platform" panels answer different questions, and their names have to say
which.

byPlatform groups by the `Platform` column, which ONLY the social/UGC tables
carry. On a report that also reads the open web it therefore lists a strict
subset of where infringements were found — and titled "Platforms" it reads as the
complete list, whose first missing entry anybody notices is Open Web.

The channel split lives on bySourcePlatform instead, and TestSourceChannelNames
above proves Open Web is in it. Open Web is deliberately NOT folded into
byPlatform: those rows double as the Platform slicer's values, and no table
carries `Platform = 'Open Web'` while the open-web tables declare no platform
filter at all — so specHonoursFilters would drop every spec and clicking that row
would empty the report.
*/
func TestThePlatformPanelSaysItIsSocialOnly(t *testing.T) {
	var label string
	for _, c := range dimensionCandidates {
		if c.Key == "byPlatform" {
			label = c.Label
		}
	}
	if label == "" {
		t.Fatal("no byPlatform dimension candidate")
	}
	if !strings.Contains(strings.ToLower(label), "social") {
		t.Errorf("byPlatform is called %q — it lists only the platforms the social "+
			"tables name, so a title that does not say so reads as the complete "+
			"list and invites \"where is Open Web\"", label)
	}
	/* And the channel panel that DOES carry Open Web is a different key, so the
	   two are never mistaken for one another. */
	if dimSourcePlatform == "byPlatform" {
		t.Error("the channel split and the social split share a key")
	}
}
