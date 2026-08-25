package handlers

/*
The two Sports headline figures added on request, and the four places each has to
be wired before a tile appears.

Both are cross-service contracts, and both fail SILENTLY. A measure name the
service does not answer for makes apiMeasureFor find nothing and the tile is
simply absent; a missing label renders the raw metric key as the tile's name.
Neither shows up as an error, on a healthy service, with the number sitting in
the warehouse the whole time.
*/

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ip-house/iphouse-api/reportsapi"
)

/*
Total Views Impacted — views on the rows that are now down.

The narrowing is `RemovalStatus = 'Dead'`, verified against the warehouse: that
column holds only 'Dead', 'Active' and empty on both sports tables, so the test
is exact rather than a LIKE. Two columns are required, and the reason the pair
matters is the failure mode of getting it wrong: on a table with views and no
removal status the CASE has nothing to test and the figure quietly equals total
views — a tile reading "every view was removed".
*/
func TestViewsImpactedNeedsBothColumns(t *testing.T) {
	if expr := sportsHeadlineKPIs(shapeWith("Views", "RemovalStatus"))["viewsImpacted"]; expr == "" {
		t.Error("a table with Views and RemovalStatus produces no viewsImpacted figure")
	} else {
		if !strings.Contains(expr, "'Dead'") {
			t.Errorf("viewsImpacted no longer narrows to the removed rows: %s", expr)
		}
		if !strings.Contains(expr, "CASE WHEN") {
			t.Errorf("viewsImpacted is not a conditional sum: %s", expr)
		}
	}
	// Views alone must produce nothing rather than the unconditional total.
	if expr := sportsHeadlineKPIs(shapeWith("Views"))["viewsImpacted"]; expr != "" {
		t.Errorf("a table with no removal marker still offered viewsImpacted: %s — "+
			"that figure would equal total views and read as a full takedown", expr)
	}
	if expr := sportsHeadlineKPIs(shapeWith("RemovalStatus"))["viewsImpacted"]; expr != "" {
		t.Errorf("a table with no views column still offered viewsImpacted: %s", expr)
	}
}

/*
Either spelling of "this row came down" works, and a rollup gets neither.

The two are not interchangeable per table — a table carries one — so the figure
has to read whichever is there rather than one hardcoded name. The third case is
the one that protects a number: a daily rollup carries a summed RemovedCount
beside a summed TotalViews and nothing that says which views belonged to the
removed rows, so there is no honest figure to compute and the tile must stay off.
*/
func TestViewsImpactedReadsWhicheverRemovalColumnExists(t *testing.T) {
	byStatus := sportsHeadlineKPIs(shapeWith("Views", "RemovalStatus"))["viewsImpacted"]
	byFlag := sportsHeadlineKPIs(shapeWith("Views", "IsRemoved"))["viewsImpacted"]

	if !strings.Contains(byStatus, "RemovalStatus = 'Dead'") {
		t.Errorf("the status form is %q", byStatus)
	}
	if !strings.Contains(byFlag, "IsRemoved = 1") {
		t.Errorf("the flag form is %q — a table recording removal as IsRemoved gets no figure", byFlag)
	}
	// Both spellings on one table: the status wins, and only one test is applied.
	both := sportsHeadlineKPIs(shapeWith("Views", "RemovalStatus", "IsRemoved"))["viewsImpacted"]
	if strings.Contains(both, "IsRemoved") {
		t.Errorf("both markers were applied at once: %s", both)
	}

	/* A rollup: views and a summed removal COUNT, no row-level marker. This must
	   stay empty. RemovedCount is not a marker — testing it per row would count
	   a whole day's views whenever that day removed anything. */
	if got := sportsHeadlineKPIs(shapeWith("TotalViews", "RemovedCount"))["viewsImpacted"]; got != "" {
		t.Errorf("a daily rollup produced a viewsImpacted expression: %s — there is "+
			"nothing on those rows that says which views came down", got)
	}
	if got := removedRowTest(shapeWith("RemovedCount", "TotalRemoved")); got != "" {
		t.Errorf("a summed removal count was mistaken for a row marker: %s", got)
	}
}

/*
Total Channels — the BROADCASTER, which is not the channel beside it.

TVChannelName is the station whose feed was restreamed; ChannelURL is the account
doing the restreaming, and the Telegram sports table carries both — 58 of the
first against thousands of the second. Folding them into one key would make the
tile mean whichever column won a lookup order.
*/
func TestTVChannelsIsItsOwnFigure(t *testing.T) {
	got := channelKPIs(shapeWith("TVChannelName", "ChannelURL", "Views", "RemovalStatus"))
	tv := got["totalTVChannels"]
	if !strings.Contains(tv, "TVChannelName") {
		t.Errorf("totalTVChannels counts %q, not the broadcaster", tv)
	}
	if !strings.Contains(tv, "DISTINCT") {
		t.Errorf("totalTVChannels is not a distinct count: %s", tv)
	}
	// The account count stands beside it, from the URL, and they are different
	// figures on this table — thousands of accounts against 58 stations.
	if got["totalChannels"] == "" || got["totalChannels"] == tv {
		t.Errorf("the account count is missing or collapsed into the station one: %v", got)
	}
	// A table with no broadcaster column offers no broadcaster tile.
	if got := channelKPIs(shapeWith("ChannelURL"))["totalTVChannels"]; got != "" {
		t.Errorf("a table without TVChannelName still offered the tile: %s", got)
	}
}

// shapeWith is a table that has exactly these columns. tableShape keys on the
// lower-cased name, which is what `has` and `firstOf` look up.
func shapeWith(cols ...string) tableShape {
	sh := tableShape{Table: "dashboards.__test", Columns: map[string]string{}}
	for _, c := range cols {
		sh.Columns[strings.ToLower(c)] = c
	}
	return sh
}

/*
The service's names for both, and the page's.

reports_api declares `viewsImpacted` and `tvChannels` on the sports datasets
(internal/api/datasets.go over there). The portal has to accept exactly those,
and the report page has to carry a label for each or the tile is titled with its
own key.
*/
func TestSportsKPIsAreWiredEndToEnd(t *testing.T) {
	for portal, service := range map[string]string{
		"viewsImpacted":   "viewsImpacted",
		"totalTVChannels": "tvChannels",
	} {
		ok := false
		for _, m := range apiMeasure[portal] {
			if m == service {
				ok = true
			}
		}
		if !ok {
			t.Errorf("the portal's %q figure does not accept the service's %q measure; "+
				"it accepts %v", portal, service, apiMeasure[portal])
		}
		if kpiTileLabels[portal] == "" {
			t.Errorf("%q has no tile name, so the configuration screen lists a bare key", portal)
		}
		if kpiTileDescriptions[portal] == "" {
			t.Errorf("%q has no note behind its ⓘ", portal)
		}
	}

	raw, err := os.ReadFile(filepath.Join("..", "..", "app", "admin", "reports", "page.tsx"))
	if err != nil {
		t.Skipf("cannot read the reports page: %v", err)
	}
	src := string(raw)
	for _, key := range []string{"viewsImpacted", "totalTVChannels"} {
		if !strings.Contains(src, key+": '") {
			t.Errorf("the reports page carries no label for %q — the tile would be "+
				"titled with its own metric key", key)
		}
	}
}

/*
The two figures also have to arrive from the SERVICE, and neither is a measure it
declares today.

Both are derived instead, from calls the service already answers — see the notes
in reportsapi_bridge.go. What is pinned here is the seam each derivation hangs
on, because both fail the same silent way: the tile renders "no figure for this
period" over a window that has plenty of figures, and nothing anywhere says the
lookup missed.
*/
func TestTVChannelDimIsFoundByColumn(t *testing.T) {
	// Telegram: both columns, and TVChannelName is the station.
	telegram := reportsapi.Dataset{
		Table:   "dashboards.Agg_Daily_Telegram_Sports_Raw",
		Columns: []string{"ChannelURL", "ChannelName", "TVChannelName", "Views"},
		Dimensions: []reportsapi.Dim{
			{Key: "channel", Column: "ChannelName"},
			// The service's key and the warehouse's column are not the same
			// word, so the lookup has to go by column.
			{Key: "tvChannel", Column: "TVChannelName"},
		},
	}
	if got := tvChannelDim(telegram); got != "tvChannel" {
		t.Errorf("tvChannelDim = %q, want the station dimension, not the account one", got)
	}

	/* Open Web sports: the station is in ChannelName, and the only dimension
	   GROUPS by the id while LABELLING with the name. That is the dimension the
	   "Source of Piracy" panel draws, and the tile has to count the same
	   buckets — which is what DimByColumn's label-first order gives. */
	openWeb := reportsapi.Dataset{
		Table:   "dashboards.SportsURLRawData",
		Columns: []string{"ChannelId", "ChannelName", "IsRemoved"},
		Dimensions: []reportsapi.Dim{
			{Key: "channelId", Column: "ChannelId", LabelColumn: "ChannelName"},
		},
	}
	if got := tvChannelDim(openWeb); got != "channelId" {
		t.Errorf("tvChannelDim = %q on Open Web sports — the tile would not count "+
			"what the Source of Piracy panel beside it counts", got)
	}

	/* YouTube: ChannelName with a ChannelURL beside it, which makes it the
	   ACCOUNT. No station column, so no tile — this is the case that would
	   otherwise report thousands of "TV channels". */
	youtube := reportsapi.Dataset{
		Table:      "dashboards.Agg_Daily_Youtube_MasterNew",
		Columns:    []string{"ChannelURL", "ChannelName", "TotalViews"},
		Dimensions: []reportsapi.Dim{{Key: "channel", Column: "ChannelName"}},
	}
	if got := tvChannelDim(youtube); got != "" {
		t.Errorf("tvChannelDim = %q on a table whose ChannelName is an account", got)
	}

	// A dataset with no channel column at all — the sports social table.
	bare := reportsapi.Dataset{Columns: []string{"ProfileURL", "Views"}}
	if got := tvChannelDim(bare); got != "" {
		t.Errorf("tvChannelDim = %q on a dataset with no channel column", got)
	}
}

/*
Which column holds the station name, decided once for both paths.

The trap this guards is a single column name meaning two things: ChannelName is
ESPN on the Open Web sports tables and StreamIPTV.UK on the Telegram one, 326
against 3,950. ChannelURL is what tells them apart — a name with an account URL
beside it is the account's name.
*/
func TestTVChannelColumnTellsStationsFromAccounts(t *testing.T) {
	has := func(cols ...string) func(string) bool {
		set := map[string]bool{}
		for _, c := range cols {
			set[c] = true
		}
		return func(c string) bool { return set[c] }
	}
	for _, tc := range []struct {
		name string
		cols []string
		want string
	}{
		{"telegram sports", []string{"TVChannelName", "ChannelName", "ChannelURL"}, "TVChannelName"},
		{"open web sports", []string{"ChannelId", "ChannelName"}, "ChannelName"},
		{"youtube", []string{"ChannelName", "ChannelURL"}, ""},
		{"social sports", []string{"ProfileURL"}, ""},
	} {
		if got := tvChannelColumn(has(tc.cols...)); got != tc.want {
			t.Errorf("%s: tvChannelColumn = %q, want %q", tc.name, got, tc.want)
		}
	}
}

/*
One channel tile, never two saying the same thing.

Where a table has no ChannelURL the account count and the station count are the
same column, so both keys would produce the identical figure — 326 on Open Web
sports. Two tiles reading 326 under two names invites the reader to hunt for a
difference that is not there.
*/
func TestTheDuplicateChannelTileIsDropped(t *testing.T) {
	// No ChannelURL: both resolve to ChannelName, so only the named one stays.
	same := channelKPIs(shapeWith("ChannelId", "ChannelName"))
	if _, still := same["totalChannels"]; still {
		t.Errorf("both channel tiles survived on one column: %v", same)
	}
	if same["totalTVChannels"] == "" {
		t.Error("the named channel tile was the one dropped")
	}

	// With an account URL the two count different things and both belong.
	apart := channelKPIs(shapeWith("ChannelURL", "ChannelName", "TVChannelName"))
	if apart["totalChannels"] == "" || apart["totalTVChannels"] == "" {
		t.Errorf("a table with both an account and a station lost a tile: %v", apart)
	}
	if apart["totalChannels"] == apart["totalTVChannels"] {
		t.Errorf("the two tiles count the same column: %v", apart)
	}
}

/*
Views-impacted rides on the removal-filtered summary, so it exists only where
that summary is fetched at all — which removalStatusFilter decides.

A dataset that declares its own `removed` measure is NOT given the second call
(there is nothing to count off it), so on those the derivation is unavailable and
the tile has to come from a service measure. Pinned because the two conditions
live in different files and read as unrelated.
*/
func TestViewsImpactedRidesOnTheRemovalFilteredSummary(t *testing.T) {
	// The sports Telegram and social datasets: no `removed` measure, a
	// RemovalStatus dimension — so the dead-filtered summary IS fetched.
	withStatus := reportsapi.Dataset{
		Measures:   []string{"identified", "views"},
		Dimensions: []reportsapi.Dim{{Key: "removalStatus", Column: "RemovalStatus"}},
	}
	key, ok := removalStatusFilter(withStatus)
	if !ok || key != "removalStatus" {
		t.Fatalf("removalStatusFilter = %q/%v — without it there is no dead summary "+
			"to read the impacted views off", key, ok)
	}
	if _, served := apiMeasureFor("views", withStatus); !served {
		t.Error("the views measure is not recognised, so the derived figure has nothing to sum")
	}

	// A dataset that counts removals itself gets no second summary.
	if _, ok := removalStatusFilter(reportsapi.Dataset{
		Measures:   []string{"identified", "removed"},
		Dimensions: []reportsapi.Dim{{Key: "removalStatus", Column: "RemovalStatus"}},
	}); ok {
		t.Error("a dataset with its own removed measure was given the dead-filtered summary")
	}
}

/*
The distinct count is of NAMES, and the breakdown's row count is not that number.

A breakdown returns a bucket for the rows that had no value, labelled "(none)",
because a panel saying "43 of these carry no channel" is worth showing. A DISTINCT
COUNT does not count it — SQL does not count NULL — so counting the rows reports
one channel too many, on every client, every window, forever.

Measured on one client over one month: buckets (none) 280, No Logo 43, DAZN 3,
Sky Sports 1, beIN SPORTS 1. Five rows; COUNT(DISTINCT TVChannelName) is four.
*/
func TestChannelCountSkipsTheNullBucketOnly(t *testing.T) {
	rows := []map[string]any{
		{"grp": nullGroupLabel, "label": nullGroupLabel, "identified": 280},
		{"grp": "No Logo", "label": "No Logo", "identified": 43},
		{"grp": "DAZN", "label": "DAZN", "identified": 3},
		{"grp": "Sky Sports", "label": "Sky Sports", "identified": 1},
		{"grp": "beIN SPORTS", "label": "beIN SPORTS", "identified": 1},
	}
	if got := countNamedGroups(rows); got != 4 {
		t.Errorf("countNamedGroups = %d, want 4 — the warehouse says four distinct "+
			"names for this window and the tile has to say the same", got)
	}

	/* 'No Logo' stays counted. It is a value the column holds, so it is one of
	   the distinct names whatever it means about the footage — and dropping it
	   here would be this file deciding what the warehouse meant. */
	only := countNamedGroups([]map[string]any{{"grp": "No Logo", "label": "No Logo"}})
	if only != 1 {
		t.Errorf("a real value was filtered out: got %d", only)
	}

	// An empty grp is the same absence wearing different clothes.
	if got := countNamedGroups([]map[string]any{{"grp": "", "label": ""}, {"grp": "  "}}); got != 0 {
		t.Errorf("blank buckets counted as channels: %d", got)
	}
	if got := countNamedGroups(nil); got != 0 {
		t.Errorf("countNamedGroups(nil) = %d", got)
	}

	/* The bucket KEY decides, not the label. On a dimension configured with a
	   separate label column the label is a MIN() over that column and can read
	   anything at all for the null bucket — testing it would count that bucket. */
	byKey := countNamedGroups([]map[string]any{
		{"grp": nullGroupLabel, "label": "Unknown station"},
	})
	if byKey != 0 {
		t.Errorf("the null bucket was counted because its label was not %q", nullGroupLabel)
	}
}

// Nothing user-visible calls this figure "restreamed" any more — it is a distinct
// count of a column, and the tile says so rather than telling a story about what
// the rows mean.
func TestChannelTileWordingIsAPlainDistinctCount(t *testing.T) {
	if strings.Contains(kpiTileDescriptions["totalTVChannels"], "restream") {
		t.Error("the channel tile note still describes restreaming")
	}
	if !strings.Contains(kpiTileDescriptions["totalTVChannels"], "distinct") {
		t.Error("the channel tile note no longer says what it counts")
	}
	raw, err := os.ReadFile(filepath.Join("..", "..", "app", "admin", "reports", "page.tsx"))
	if err != nil {
		t.Skipf("cannot read the reports page: %v", err)
	}
	if strings.Contains(string(raw), "restreamed") {
		t.Error("the reports page still says restreamed")
	}
}

/*
The hosting-provider panel on the LINKING half, added on request.

Measured before it was built, because the code's own comments said these columns
were empty and they are no longer: SportsURLRawData carries HSPName on all
3,029,174 rows (680 distinct providers) and a DelistingBatchId on 802,125 of them
(2,711 distinct submissions). The host table carries SourceDMCANoticeId on 693,375
rows, 128,539 distinct.

What this pins is the pair NOT collapsing into one thing. They group by the same
column, against the same counterparty, on two tables — and they count different
actions, so the failure to guard against is one panel quietly answering for both.
*/
func TestTheProviderPanelsAreTwoPanels(t *testing.T) {
	var host, linking *struct {
		Key, Column, Label, Viz, Ident, Removed, Needs, APIMeasure, Role string
	}
	for _, d := range dimensionCandidates {
		row := &struct {
			Key, Column, Label, Viz, Ident, Removed, Needs, APIMeasure, Role string
		}{d.Key, d.Column, d.Label, d.Viz, d.Ident, d.Removed, d.Needs, d.APIMeasure, d.Role}
		switch d.Key {
		case dimHSPNotices:
			host = row
		case dimHSPDelisting:
			linking = row
		}
	}
	if host == nil || linking == nil {
		t.Fatal("one of the two provider panels is not in the registry")
	}

	// Same counterparty, same shape.
	if linking.Column != host.Column {
		t.Errorf("the linking panel groups by %q, not the provider column %q",
			linking.Column, host.Column)
	}
	/* Different ACTION, and this is the point. The notice went to the provider;
	   the submission went to search engines about links the provider hosts. A
	   shared Needs column would mean both panels drawn off one table, counting
	   the same ids twice under two titles. */
	if linking.Needs == host.Needs {
		t.Errorf("both provider panels need %q — one of them is counting the "+
			"other's action", linking.Needs)
	}
	if linking.Needs != colDelistingBatchID {
		t.Errorf("the linking panel counts %q; the linking table records de-indexing "+
			"submissions and carries no notice id", linking.Needs)
	}
	if linking.Role != "linking" || host.Role != "host" {
		t.Errorf("roles are %q/%q — the pinning is what stops each table drawing "+
			"both panels", linking.Role, host.Role)
	}
	// Two cards on one page may not wear one name.
	if linking.Label == host.Label {
		t.Errorf("both provider panels are called %q", linking.Label)
	}
	if strings.Contains(linking.Label, "Notices") {
		t.Errorf("the linking panel is called %q, which names an action it does "+
			"not count", linking.Label)
	}

	// One slicer, so a click on either narrows both halves.
	if DIMFilterParam(dimHSPDelisting) != DIMFilterParam(dimHSPNotices) {
		t.Errorf("the two provider panels filter on %q and %q — the page would carry "+
			"two provider filters that can disagree",
			DIMFilterParam(dimHSPDelisting), DIMFilterParam(dimHSPNotices))
	}

	// And the bridge has to recognise it as an action panel, or its DISTINCT is
	// taken over a breakdown that aggregated the id away and every bar reads 0.
	if !isActionPanel(dimHSPDelisting) {
		t.Error("the linking provider panel is not an action panel, so its count " +
			"would be taken from the aggregate and every provider would read zero")
	}
	if kpiTileDescriptions[dimHSPDelisting] == "" && dimDescriptions[dimHSPDelisting] == "" {
		t.Error("the linking provider panel has no note behind its ⓘ")
	}
}

/*
An action panel has no removed series, and nothing may fill one in for it.

The five enforcement panels count an ACTION — a notice sent, a de-indexing
submission made — and there is no such thing as a notice that came down. What
became of the URLs a notice covered is a different panel with a different title.

The bug this guards is subtle and looked plausible: the breakdown builder empties
`removedKey` for a panel with an APIMeasure, then two branches further down fill
`removed` per group anyway — from the URLs grouped under the same provider. The
card then drew a second series, and on real data its bars would have read "1,713
submissions, 257,956 removed", which is not a ratio of anything. It is pinned at
the level of the declaration because that is what the builder reads.
*/
func TestActionPanelsDeclareNoRemovedSeries(t *testing.T) {
	found := 0
	for _, d := range dimensionCandidates {
		if !isActionPanel(d.Key) {
			continue
		}
		found++
		/* An APIMeasure is what empties removedKey on the API path, and the
		   literal "0" is what keeps the direct-SQL path from summing the
		   section's own removal expression under this panel's title. Both are
		   required: the two paths draw the same card. */
		if d.APIMeasure == "" {
			t.Errorf("%s names no APIMeasure, so the API path would draw the "+
				"identified count under a title promising an action", d.Key)
		}
		if d.Removed != "0" {
			t.Errorf("%s declares Removed %q — an action has no removal figure, and "+
				"a non-zero expression here is the section's own removals wearing "+
				"this panel's title", d.Key, d.Removed)
		}
		if d.Ident == "" || !strings.Contains(d.Ident, "DISTINCT") {
			t.Errorf("%s counts %q — an action id is stamped on every row it "+
				"covered, so anything but a DISTINCT counts URLs", d.Key, d.Ident)
		}
	}
	if found != 5 {
		t.Errorf("found %d action panels, want 5 — isActionPanel and the registry "+
			"have drifted apart", found)
	}
}

/*
And the guard itself: the builder must skip the per-group removal fill when the
panel has no removed series.

Read from source because the branch it protects needs a live service and a
warehouse to exercise, while what can go wrong is structural — the case is one
deletion away from the two branches below it filling every action panel again.
*/
func TestTheRemovedFillIsGuarded(t *testing.T) {
	src := readSourceFile(t, "reportsapi_bridge.go")
	at := strings.Index(src, "case aggRemovals:")
	if at < 0 {
		t.Fatal("the per-group removal fill is gone")
	}
	// The guard is the case immediately above it.
	from := at - 900
	if from < 0 {
		from = 0
	}
	before := src[from:at]
	if !strings.Contains(before, `case removedKey == "":`) {
		t.Error("the per-group removal fill is no longer guarded on the panel " +
			"having a removed series; every action panel would grow a second series")
	}
}

func readSourceFile(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(name)
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return string(b)
}
