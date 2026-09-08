package handlers

// Pins the rules in reportassetgenre.go, all of which are decisions about what
// to do with an answer that is not simply "here are the sports titles".
//
// No warehouse and no reports_api: every case here is a fixture of the master's
// own response shape, which is the whole reason the parse was split out of the
// request.

import (
	"context"
	"testing"
	"time"

	"github.com/ip-house/iphouse-api/reportsapi"
)

// masterBody builds a /v1/masters/assets response the way the service returns
// one — rows as []any of map[string]any, facets under their column name.
func masterBody(facets []string, rows ...map[string]any) map[string]any {
	f := make([]any, 0, len(facets))
	for _, v := range facets {
		f = append(f, v)
	}
	r := make([]any, 0, len(rows))
	for _, row := range rows {
		r = append(r, row)
	}
	return map[string]any{
		"rows":   r,
		"facets": map[string]any{"Genre": f},
	}
}

func assetRow(id, genre string) map[string]any {
	return map[string]any{"Id": id, "AssetName": "T-" + id, "Genre": genre}
}

func TestSportsAssetsFromMaster(t *testing.T) {
	t.Run("keeps the sports titles, ids lower-cased", func(t *testing.T) {
		body := masterBody([]string{"Movies", "Sports"},
			assetRow("AAAA-1111", "Sports"),
			assetRow("bbbb-2222", "Movies"),
		)
		ids, err := sportsAssetsFromMaster(body, "C1")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !ids["aaaa-1111"] {
			t.Error("the sports title is missing, or was not lower-cased")
		}
		if ids["bbbb-2222"] {
			t.Error("a Movies title was kept")
		}
		if len(ids) != 1 {
			t.Errorf("want 1 id, got %d", len(ids))
		}
	})

	/* A title can be in several genres at once, and the master returns them as
	   one comma-joined string. Matching that whole string against "Sports" would
	   drop exactly the titles a broadcaster cares most about. */
	t.Run("keeps a title tagged sport AND something else", func(t *testing.T) {
		body := masterBody([]string{"Sports", "Television"},
			assetRow("multi", "Television, Sports"),
			assetRow("spaced", " sports "),
		)
		ids, err := sportsAssetsFromMaster(body, "C1")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		for _, want := range []string{"multi", "spaced"} {
			if !ids[want] {
				t.Errorf("%q was dropped", want)
			}
		}
	})

	/* The trap this exists for: an older reports_api ignores a parameter it does
	   not recognise rather than refusing it, so `Genre=Sports` comes back as the
	   whole register. Taking that at face value would report a narrowing that
	   never happened. */
	t.Run("re-checks each row when the filter was ignored", func(t *testing.T) {
		body := masterBody([]string{"Movies", "Sports"},
			assetRow("match", "Sports"),
			assetRow("film-1", "Movies"),
			assetRow("film-2", "Movies"),
		)
		ids, err := sportsAssetsFromMaster(body, "C1")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(ids) != 1 || !ids["match"] {
			t.Errorf("want only the sports title, got %v", ids)
		}
	})

	t.Run("a cut-off list is refused", func(t *testing.T) {
		body := masterBody([]string{"Sports"}, assetRow("match", "Sports"))
		body["truncated"] = true
		if _, err := sportsAssetsFromMaster(body, "C1"); err == nil {
			t.Fatal("a truncated master answer must not be used as a complete one")
		}
	})

	/* No facet means the master could not say what genres this client holds —
	   an old service, or an untagged catalogue. Either way the narrowing is not
	   established and every list must be left alone. */
	t.Run("no genre facet is an error, not an empty set", func(t *testing.T) {
		body := map[string]any{"rows": []any{assetRow("match", "Sports")}}
		if _, err := sportsAssetsFromMaster(body, "C1"); err == nil {
			t.Fatal("want an error when the master reports no genres at all")
		}
	})

	t.Run("a client with no sports genre is an error, not an empty set", func(t *testing.T) {
		body := masterBody([]string{"Movies", "Originals"},
			assetRow("film", "Movies"))
		_, err := sportsAssetsFromMaster(body, "C1")
		if err == nil {
			t.Fatal("want an error so the caller fails open")
		}
	})

	t.Run("sports genre held but no row survives is an error", func(t *testing.T) {
		// The facet says the client has sports titles and the rows disagree —
		// which is a mismatch, not a report with no sport in it.
		body := masterBody([]string{"Sports"}, assetRow("film", "Movies"))
		if _, err := sportsAssetsFromMaster(body, "C1"); err == nil {
			t.Fatal("want an error when no row carried the genre the facet promised")
		}
	})
}

func TestGenreSetHas(t *testing.T) {
	cases := []struct {
		set  string
		want bool
	}{
		{"Sports", true},
		{"sports", true},
		{"Television, Sports", true},
		{"Sports,Movies", true},
		{" Sports ", true},
		{"Movies", false},
		{"", false},
		{"Esports", false}, // a different genre that contains the word
	}
	for _, c := range cases {
		if got := genreSetHas(c.set, sportsGenreName); got != c.want {
			t.Errorf("genreSetHas(%q) = %v, want %v", c.set, got, c.want)
		}
	}
}

func TestKeepSportsAssets(t *testing.T) {
	ids := map[string]bool{"a": true, "b": true}

	t.Run("drops what the master does not hold", func(t *testing.T) {
		keep, dropped := keepSportsAssets(ids, []string{"A", "b", "c", "d"})
		if dropped != 2 {
			t.Errorf("dropped = %d, want 2", dropped)
		}
		if len(keep) != 2 {
			t.Fatalf("kept %v, want the two sports ids", keep)
		}
		// The caller's own spelling is returned, not the lower-cased key —
		// the value has to go back into a map that is keyed by it.
		if keep[0] != "A" || keep[1] != "b" {
			t.Errorf("kept %v, want the values as they were passed in", keep)
		}
	})

	/* A total wipe is a mismatch between the two sides, not a report with no
	   sports titles. Narrowing to nothing would empty the slicer, which reads as
	   a broken screen. */
	t.Run("refuses to drop everything", func(t *testing.T) {
		keep, dropped := keepSportsAssets(ids, []string{"x", "y"})
		if dropped != 0 {
			t.Errorf("dropped = %d, want 0 — the list must be left alone", dropped)
		}
		if len(keep) != 2 {
			t.Errorf("kept %v, want the original list back", keep)
		}
	})

	t.Run("nothing to do reports no drops", func(t *testing.T) {
		if _, dropped := keepSportsAssets(ids, []string{"a", "b"}); dropped != 0 {
			t.Errorf("dropped = %d, want 0", dropped)
		}
	})
}

/*
Which reports narrow, read off the names inferSpec has in hand.

The negative cases matter more than the positive one: a sports table narrowed
here would cost a master read per report to confirm what its own ETL already
guarantees, and a VOD report narrowed here would lose most of its titles.
*/
func TestSportsReportOnAllGenreTable(t *testing.T) {
	cases := []struct {
		name, key, label, table string
		want                    bool
	}{
		{"the mobile-apps sports report", "mobile-apps-sports", "Mobile Apps - Sports",
			"dashboards.UnifiedMobileAppsDashboardTable", true},
		// The label alone is enough: a platform keyed `mobileapps` and renamed by
		// an admin is still recognised from what they called it.
		{"named only in the label", "mobileapps", "App Stores — Sports",
			"dashboards.UnifiedMobileAppsDashboardTable", true},
		// And a rename that drops the word gives the report its whole catalogue
		// back, which is the same thing isSportsPlatform does with the period.
		{"renamed away from sport", "mobileapps", "Mobile Apps (2026 Season)",
			"dashboards.UnifiedMobileAppsDashboardTable", false},
		// Already narrowed upstream.
		{"a sports raw table", "open-web-sports", "Open Web - Sports",
			"dashboards.SportsURLRawData", false},
		{"the sports social table", "social-sports", "Social - Sports",
			"dashboards.SocialMedia_Sports_Raw", false},
		// Not a sports report at all.
		{"open web", "open-web", "Open Web",
			"dashboards.InternetInfringingURLMainDashboardTable", false},
		{"mobile apps outside sport", "mobileapps", "Mobile Apps",
			"dashboards.UnifiedMobileAppsDashboardTable", false},
	}
	for _, c := range cases {
		if got := sportsReportOnAllGenreTable(c.key, c.label, c.table); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

func TestSportsOnlySpecSet(t *testing.T) {
	mobile := reportSpec{Table: "dashboards.UnifiedMobileAppsDashboardTable",
		AssetCol: "AssetId", SportsAssetsOnly: true}
	sportsRaw := reportSpec{Table: "dashboards.SportsURLRawData", AssetCol: "AssetId"}
	openWeb := reportSpec{Table: "dashboards.InternetInfringingURLMainDashboardTable",
		AssetCol: "AssetId"}
	noAssets := reportSpec{Table: "dashboards.SomethingElse"}

	cases := []struct {
		name  string
		specs []reportSpec
		want  bool
	}{
		{"the mobile-apps sports report", []reportSpec{mobile}, true},
		{"a sports summary over both kinds", []reportSpec{mobile, sportsRaw}, true},
		// Nothing here needs the master: a Sports* table is narrowed by whatever
		// fills it, so reading the master could only confirm what is already true.
		{"sports tables alone", []reportSpec{sportsRaw}, false},
		// The cross-platform Summary. Narrowing this would delete the VOD titles
		// from a slicer they belong in.
		{"a mixed summary", []reportSpec{mobile, openWeb}, false},
		{"a table with no assets does not block it", []reportSpec{mobile, noAssets}, true},
		{"nothing at all", nil, false},
	}
	for _, c := range cases {
		if got := sportsOnlySpecSet(c.specs); got != c.want {
			t.Errorf("%s: sportsOnlySpecSet = %v, want %v", c.name, got, c.want)
		}
	}
}

/*
The slicer narrowing itself, over a seeded cache so no request is made.

Two things are being pinned: that the values are removed from the map the rest of
mergeSpecOptionsViaAPI goes on to read, and that the counts and names already
folded into the survivors are still there afterwards.
*/
func TestNarrowSportsAssetOptions(t *testing.T) {
	const client = "TEST-GENRE-CLIENT"
	seed := func(ids map[string]bool, err error) {
		sportsAssetMu.Lock()
		sportsAssetCache[client] = sportsAssetEntry{at: time.Now(), ids: ids, err: err}
		sportsAssetMu.Unlock()
	}
	t.Cleanup(func() {
		sportsAssetMu.Lock()
		delete(sportsAssetCache, client)
		sportsAssetMu.Unlock()
	})

	specs := []reportSpec{{
		Table: "dashboards.UnifiedMobileAppsDashboardTable",
		Label: "Mobile Apps - Sports", AssetCol: "AssetId", SportsAssetsOnly: true,
	}}
	values := func() map[string]map[string]*slicerValue {
		return map[string]map[string]*slicerValue{
			"assetId": {
				"MATCH-1": {name: "Final", count: 40},
				"FILM-1":  {name: "A Film", count: 900},
			},
			// Untouched: only the asset list is a question about genre.
			"appName": {"Some App": {name: "Some App", count: 5}},
		}
	}

	t.Run("drops the non-sports titles and keeps the rest intact", func(t *testing.T) {
		seed(map[string]bool{"match-1": true}, nil)
		flat := values()
		narrowSportsAssetOptions(context.Background(), specs, client, flat)
		if _, still := flat["assetId"]["FILM-1"]; still {
			t.Error("a non-sports title survived the Asset slicer")
		}
		v := flat["assetId"]["MATCH-1"]
		if v == nil || v.name != "Final" || v.count != 40 {
			t.Errorf("the sports title lost its name or count: %+v", v)
		}
		if len(flat["appName"]) != 1 {
			t.Error("a slicer that is not about assets was touched")
		}
	})

	// Fail open: the report as it read before, not an empty dropdown.
	t.Run("leaves the list alone when the master could not answer", func(t *testing.T) {
		seed(nil, context.DeadlineExceeded)
		flat := values()
		narrowSportsAssetOptions(context.Background(), specs, client, flat)
		if len(flat["assetId"]) != 2 {
			t.Errorf("want both titles left in place, got %d", len(flat["assetId"]))
		}
	})

	t.Run("leaves a mixed set alone", func(t *testing.T) {
		seed(map[string]bool{"match-1": true}, nil)
		mixed := append([]reportSpec{}, specs...)
		mixed = append(mixed, reportSpec{
			Table: "dashboards.InternetInfringingURLMainDashboardTable", AssetCol: "AssetId"})
		flat := values()
		narrowSportsAssetOptions(context.Background(), mixed, client, flat)
		if len(flat["assetId"]) != 2 {
			t.Errorf("a summary spanning sports and VOD must not be narrowed; got %d", len(flat["assetId"]))
		}
	})
}

/*
── Two Mobile Apps sections, one dataset, one parameter apart ───────────────

The sports Mobile Apps report and an overall one read the SAME warehouse table
through the same code. What separates them is a single query parameter, and this
is the test that says so.

It matters because the two are configuration, not code: a platform is a row an
admin edits on Report Configuration, and whether a given section is the sports
one or the overall one follows from what they called it —
sportsReportOnAllGenreTable reads the flag off the platform's own name. So the
guarantee cannot be "the sports one is narrowed"; it has to be "a section is
narrowed exactly when it is a sports report on an all-genre table", which is what
these two cases pin.
*/
func TestOnlyTheSportsSectionIsHeldToTheGenre(t *testing.T) {
	// One dataset, standing in for the mobile-apps entry: the asset dimension is
	// what apiScope maps a spec filter onto, and nothing here depends on the rest.
	ds := reportsapi.Dataset{
		Key:   "mobile-apps",
		Table: "dashboards.UnifiedMobileAppsDashboardTable",
		Dimensions: []reportsapi.Dim{
			{Key: "assetId", Column: "AssetId", LabelColumn: "AssetName"},
		},
		DateFromParam: "from", DateToParam: "to",
	}
	q := map[string]string{"clientId": "C1", "from": "2026-08-01", "to": "2026-08-31"}

	/* The SPORTS section. Its table holds every genre, so the report has to say
	   which one it is about or it counts films beside matches in every figure. */
	sports := reportSpec{
		Key: "mobile-apps-sports", Label: "Mobile Apps - Sports",
		Table: "dashboards.UnifiedMobileAppsDashboardTable",
		AssetCol: "AssetId", SportsAssetsOnly: true,
		Filters: map[string]string{"assetId": "AssetId"},
	}
	got := apiScope(sports, ds, q, "")
	if got.Get(sportsGenreParam) != sportsGenreName {
		t.Errorf("the sports section sent %s=%q, want %q — every figure on that page "+
			"is built from this scope, so an absent filter is an all-genre report "+
			"under a sports heading",
			sportsGenreParam, got.Get(sportsGenreParam), sportsGenreName)
	}

	/* The OVERALL section: the same table, the same code, no "sports" in its
	   name. It must send nothing at all — a genre on this scope would narrow the
	   one report whose whole purpose is to cover every genre, and there would
	   then be no way to ask for it. */
	overall := reportSpec{
		Key: "mobile-apps", Label: "Mobile Apps",
		Table: "dashboards.UnifiedMobileAppsDashboardTable",
		AssetCol: "AssetId", SportsAssetsOnly: false,
		Filters: map[string]string{"assetId": "AssetId"},
	}
	got = apiScope(overall, ds, q, "")
	if v := got.Get(sportsGenreParam); v != "" {
		t.Errorf("the overall section sent %s=%q — that report is meant to cover "+
			"every genre, and narrowing it leaves no section that does",
			sportsGenreParam, v)
	}

	// And the flag really is derived from the names rather than hand-set, so the
	// two specs above are the two an admin can actually create.
	if !sportsReportOnAllGenreTable(sports.Key, sports.Label, sports.Table) {
		t.Error("a sports-named platform on an all-genre table was not flagged")
	}
	if sportsReportOnAllGenreTable(overall.Key, overall.Label, overall.Table) {
		t.Error("an overall-named platform on the same table was flagged as sports")
	}
	/* And a sports report whose table is already narrowed by its own ETL is not
	   flagged either — sending the filter there would be a parameter the dataset
	   does not declare, and a request that can only confirm what is true. */
	if sportsReportOnAllGenreTable("open-web-sports", "Open Web - Sports",
		"dashboards.SportsURLRawData") {
		t.Error("a Sports* table was flagged; its ETL has already narrowed it")
	}
}

/*
── The Summary's title count is held to the genre too ──────────────────────

The sports Summary counts titles by unioning the asset ids each of its tables
found, so that a title enforced on five platforms is counted once. One of those
tables is the all-genre mobile-apps source, and its ids are the client's whole
catalogue — which is why the Summary reported more titles in scope than the
sections beneath it, on a page whose every other figure was about sport.

This is a DIRECT-SQL path, not the reports_api one, so the genre filter on the
dataset does not reach it. It is narrowed here instead, by the same rule and the
same function the slicer and the Assets panel use — which is the point of the
test: three places narrow, and they must narrow identically or the tile, the
panel and the dropdown disagree about how many titles the report is about.

The narrowing itself is keepSportsAssets, already pinned above. What this covers
is that the Summary applies it to the ALL-GENRE spec and to nothing else.
*/
func TestSummaryNarrowsOnlyTheAllGenreSpec(t *testing.T) {
	sports := map[string]bool{"a-1": true, "a-2": true}

	/* The all-genre table: films in the list, and they go. */
	kept, dropped := keepSportsAssets(sports, []string{"A-1", "film-9", "A-2", "film-3"})
	if dropped != 2 {
		t.Errorf("dropped %d, want the two films", dropped)
	}
	if len(kept) != 2 || kept[0] != "A-1" || kept[1] != "A-2" {
		t.Errorf("kept %v, want the two sports titles in the order the table gave them", kept)
	}

	/* A Sports* table is NOT narrowed — its ETL did that already. The guard is
	   the spec flag, so what is pinned here is that the flag says no for one. */
	if sportsReportOnAllGenreTable("open-web-sports", "Open Web - Sports",
		"dashboards.SportsURLRawData") {
		t.Error("a Sports* spec would be narrowed a second time in the Summary")
	}
	if !sportsReportOnAllGenreTable("mobile-apps-sports", "Mobile Apps - Sports",
		"dashboards.UnifiedMobileAppsDashboardTable") {
		t.Error("the all-genre spec would not be narrowed in the Summary")
	}

	/* And an OVERALL mobile apps section is not narrowed either, in the Summary
	   or anywhere else: it is the one report meant to span every genre, and its
	   titles belong in a title count that is about the whole client. */
	if sportsReportOnAllGenreTable("mobile-apps", "Mobile Apps",
		"dashboards.UnifiedMobileAppsDashboardTable") {
		t.Error("the overall section would be narrowed to sport")
	}

	/* Fails OPEN. An empty scope — an unreachable master, an untagged catalogue
	   — leaves the list exactly as it was rather than reporting nothing in
	   scope. A title count that is a little high is what this reported
	   yesterday; one narrowed on a lookup that did not work is a confident wrong
	   answer. */
	all := []string{"A-1", "film-9"}
	back, gone := keepSportsAssets(map[string]bool{}, all)
	if gone != 0 || len(back) != len(all) {
		t.Errorf("an empty scope narrowed the union to %v — it must leave it alone", back)
	}
}
