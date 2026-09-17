package handlers

// Reading the reports through reports_api instead of the warehouse.
//
// Set REPORTS_API_URL and the portal stops holding analytics credentials: the
// three places the report engine touched the warehouse are served over HTTP
// instead, and everything above them — the platform registry, the layout, the
// access checks, the merging of several tables into one platform — is unchanged
// and does not know the difference.
//
// The three seams:
//
//	tableShapeOf   what columns a table has. The engine INFERS each spec from
//	               the schema, so without this nothing resolves at all and every
//	               platform reports "none of this platform's tables can be read".
//	runSpec        one table's KPI band, trend and breakdown panels.
//	mergeSpecOptions  the slicer values.
//
// Unset REPORTS_API_URL and none of this runs. The direct-to-warehouse path is
// untouched and remains the default, so this is reversible by deleting one
// environment variable.

import (
	"context"
	"fmt"
	"log"
	"net/url"
	"sort"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/ip-house/iphouse-api/db"
	"github.com/ip-house/iphouse-api/reportsapi"
)

// reportsViaAPI is the single switch. Read in each seam rather than cached in a
// package variable, so the mode is decided by configuration at the moment of
// use and a test can set it without a restart.
func reportsViaAPI() bool { return reportsapi.Configured() }

/*
maxAPIBreakdownRows is the ceiling reports_api puts on one breakdown.

Named here because exceeding it is a 422, and a 422 on a slicer query does not
look like an error to a reader — it looks like a slicer with nothing in it.
Keep this at or below the service's own maximum.
*/
const maxAPIBreakdownRows = 200

/*
domainFoldRows is how deep the hostname breakdown goes when it is being FOLDED
into brands rather than drawn.

A panel shows ten hostnames, but a brand is assembled from all of them: at 200
rows the fold covered 95% of the volume on one sports table and 64% on Open Web
— out of 1,411 distinct hostnames in the window — so every brand total was short
by up to a third and the mirror counts much worse than that.

Measured: 1,411 rows came back in 570ms against 524ms for 200. The grouping
column is indexed and the scan is identical; only the row count changes.
*/
const domainFoldRows = 2000

/*
assetMasterTable is the lookup that knows what every asset is CALLED.

Spelled as a warehouse table because that is the vocabulary the dimension
registry uses (see dimensionCandidates in reportplatforms.go); apiMasterKeyFor
turns it into the key reports_api serves it under, so a master renamed over
there is followed rather than guessed at.
*/
const assetMasterTable = "mediascan.Asset"

/*
slicerValue is one option in a filter dropdown: what it is called, and how much
is behind it in the scope currently on screen.

The COUNT is the part that earns its keep. A slicer built only from values that
have rows is honest but unsearchable — the asset somebody is looking for is
simply absent, with nothing to say whether it does not exist or merely has
nothing this month. A slicer built from the master is searchable but offers
choices that empty the page. Carrying the count gives both: every asset is
listed and findable, and the ones with nothing behind them say so as 0 instead
of being discovered by picking one.
*/
type slicerValue struct {
	name  string
	count int64
}

/*
dimMaster is the lookup a dimension resolves ids against when its own registry
entry names none.

The registry prefers the NAME column wherever a table has one — grouping by
AssetName needs no join and cannot fail because a lookup is out of reach — so
`byAssetName` is declared without a lookup and wins the dedup against `byAsset`,
which has one.

That is right until the name column EXISTS AND IS EMPTY, which is what
Agg_Daily_Telegram_Sports_Raw does: AssetId is populated on all 8,926 rows and
AssetName is NULL on every one of them. reports_api then labels each group with
MIN(AssetName) — null — the merge drops every row for having no label, and a
panel titled "Top 10 Assets" reads "No data." beside a tile saying 267 assets.

So the master is supplied here instead. It costs one cached request and it is
only consulted for rows the dataset could not name itself.
*/
var dimMaster = map[string]string{
	"byAsset":     assetMasterTable,
	"byAssetName": assetMasterTable,

	/* The same trap on every other dimension the warehouse spells two ways.
	   Each of these has a NAME form the registry prefers and an ID form behind
	   it, and reports_api resolves a name column to the id dimension it labels —
	   so a table whose name column is null hands back ids with no names, the
	   values are dropped as unpickable, and the slicer renders empty.

	   Measured on Agg_Daily_Telegram_Sports_Raw: Language came back as two
	   unnamed ids and the slicer was blank. Print Quality did the same on both
	   URL tables. Naming them from the master is the "additional detail" case —
	   the list is still the table's own values, only the words come from
	   elsewhere.

	   No Genre entry: reports_api serves no genre master, and every table that
	   has the dimension carries a readable GenreName. */
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

/*
apiCanGroupBy answers whether the service will actually GROUP BY this column.

A column being returned on a row is not the same as being groupable, and the
registry infers a spec from the column list. dashboards.SportsURLRawData returns
QualityOfPrintId and offers no quality dimension, so Open Web - Sports carried a
Print Quality slicer that could never hold a single value — a control that is
permanently empty and says nothing about why.

Only consulted in API mode; the direct-to-warehouse path groups by any column
the table has, so the question does not arise there.
*/
func apiCanGroupBy(table, col string) bool {
	if !reportsViaAPI() || col == "" {
		return true
	}
	ds, ok := reportsapi.Get().ByTable(context.Background(), table)
	if !ok {
		return false
	}
	_, ok = ds.DimByColumn(col)
	return ok
}

// lookupForDim is the dimension's own lookup, or the fallback above.
func lookupForDim(d dimension) string {
	if d.LookupTable != "" {
		return d.LookupTable
	}
	return dimMaster[d.Key]
}

/*
optionsConcurrency is how many slicer-value requests are in flight at once.

One per (table, slicer): a summary over five platforms with a dozen filters each
is sixty round trips, and they now run on every change to the window rather than
once when a client is picked. Sequentially that is slower than the report they
sit beside. Bounded rather than unbounded because reports_api is a shared
service, and a portal that opens sixty connections to it on every keystroke is
the portal's problem becoming everyone's.
*/
const optionsConcurrency = 8

/*
reportsBackendReady reports whether the engine has SOMETHING to read from.

The gates on the report endpoints used to ask "are warehouse credentials set",
because that was the only possible source. Two sources exist now, and asking the
old question of an install that reads through the API answers "no" and shows the
reader "Reports are temporarily unavailable" while the API sits there answering
perfectly well.
*/
func reportsBackendReady() bool { return reportsViaAPI() || db.ReportsConfigured() }

/*
apiMeasure translates the portal's KPI names into reports_api measure keys.

They differ because they were named at different times for different readers:
the portal's tiles are labelled for a client ("impacted subscribers"), the API's
measures are named for what the column holds ("subscribers"). Rather than rename
either — one would break saved layouts, the other an API in use — the mapping is
written here, once.

A name with NO entry is left absent from the KPI band rather than filled with a
zero. Absent renders as "—", which is the truth: this table does not record it.
A zero would be read as "it happened nothing times".
*/
// Several candidates per name, tried in order, because one portal figure is
// more than one measure across the datasets: an enforcement notification is
// `noticesSent` on the search-engine table and `enforcements` on the unified
// one. First match wins, so the more specific measure is named first.
var apiMeasure = map[string][]string{
	"identified":     {"identified"},
	"removed":        {"removed"},
	"delisted":       {"delisted"},
	"googleDelisted": {"googleDelisted"},
	"bingDelisted":   {"bingDelisted"},
	// The mobile-apps table splits its domain count in two — the store page and
	// the download it leads to — and has no single "domains". The infringing
	// side is the one this tile is about.
	"totalDomains":  {"domains", "infringingDomains"},
	"totalAssets":   {"assets"},
	"totalChannels": {"channels"},

	// ── Mobile apps ──────────────────────────────────────────────────────────
	"totalApps":         {"apps"},
	"totalCategories":   {"categories"},
	"totalDevelopers":   {"developers"},
	"ratings":           {"ratings"},
	"reviews":           {"reviews"},
	"avgStars":          {"avgStars"},
	"enforced":          {"enforced"},
	"sourceRemoved":     {"sourceRemoved"},
	"infringingRemoved": {"infringingRemoved"},
	// `installs` has no counterpart: InstallCount is a column on the table but
	// not a measure the service sums, so the tile is absent rather than zero.
	"channelsSuspended": {"channelsSuspended"},
	"views":             {"views"},
	/* Views on the rows that are now down. Its own measure rather than anything
	   derived here: the narrowing is `RemovalStatus = 'Dead'`, a test on rows
	   this side never reads — the tile receives one summed number. */
	"viewsImpacted": {"viewsImpacted"},
	/* The broadcaster count. `totalChannels` is the channel that carried the
	   stream; this is the station whose feed it was, and one report shows both —
	   so they never share a measure. */
	"totalTVChannels":     {"tvChannels"},
	"viewsSaved":          {"viewsSaved"},
	"impactedSubscribers": {"subscribers"},
	"likes":               {"likes"},
	"comments":            {"comments"},
	"crawled":             {"crawled"},
	/* The DMCA notices a host was sent. `dmcaNotices` is what the sports host
	   dataset declares, verified against the live catalogue; the other two are
	   what other datasets call it. Its absence here is why the provider card's
	   notice count was empty — apiMeasureFor found no match, so the figure was
	   never asked for, and nothing anywhere said so. */
	"notices": {"dmcaNotices", "noticesSent", "enforcements"},
	/* Delisting SUBMISSIONS, not delisted URLs. `delisted` above is how many
	   links an engine dropped; this is how many batches we sent it, and the two
	   sit on the same report — so they are never allowed to share a name. */
	"delistingBatches": {"delistingBatches"},
	// impactedTraffic has no counterpart: no dataset sums a traffic column, so
	// the tile stays empty rather than claiming a number nothing produced.
}

// apiMeasureFor picks the measure this dataset actually answers for, out of the
// candidates a portal figure accepts.
func apiMeasureFor(name string, ds reportsapi.Dataset) (string, bool) {
	for _, m := range apiMeasure[name] {
		if ds.HasMeasure(m) {
			return m, true
		}
	}
	return "", false
}

/*
apiTableShape answers "what columns does this table have" from the catalogue.

reports_api already reports each dataset's column list, so the schema lookup the
engine used to make against information_schema becomes a map read. The list is
the API's OWN column list, which is narrower than the physical table — it is
what the service will actually return — and that is the right answer here: a
spec inferred from a column the API does not serve would produce a panel that is
permanently empty.
*/
func apiTableShape(table string) tableShape {
	shape := tableShape{Table: table, Columns: map[string]string{}}
	c := reportsapi.Get()

	/* The catalogue is fetched FIRST, and its failure is reported as its own
	   thing.

	   Both failures used to say "this table is not one of the datasets
	   reports_api serves", which is a precise and confident sentence about the
	   wrong problem: when the service cannot be reached at all, EVERY table says
	   it, and the reader goes looking for a missing dataset instead of a
	   connection. The two now read differently because they are fixed
	   differently. */
	if _, err := c.Catalog(context.Background()); err != nil {
		shape.Err = fmt.Sprintf("cannot reach reports_api at %s — %v", c.BaseURL(), err)
		return shape
	}

	ds, ok := c.ByTable(context.Background(), table)
	if !ok {
		/* Not a fact table — but it may be a LOOKUP one.

		   inferSpec asks for the shape of mediascan.Asset, mediascan.Language and
		   the rest to decide whether an id column can be turned into a name, and
		   drops the dimension when it cannot. Those are not datasets and never
		   will be, so in API mode every one of them answered "no such table" and
		   every id-based panel — assets, languages, genres, print quality, nature
		   of infringement — was dropped before it was ever queried. reports_api
		   serves them under /v1/masters; that is the answer to the question being
		   asked here, so give it. */
		if m, isMaster := c.MasterByTable(context.Background(), table); isMaster {
			shape.Columns[strings.ToLower(m.IDColumn)] = m.IDColumn
			shape.Columns[strings.ToLower(m.NameColumn)] = m.NameColumn
			return shape
		}
		shape.Err = fmt.Sprintf(
			"%s is neither a dataset nor a master reports_api serves — see GET /v1/sports/datasets and GET /v1/masters at %s",
			table, c.BaseURL())
		return shape
	}
	for _, col := range ds.Columns {
		shape.Columns[strings.ToLower(col)] = col
	}
	addRowOnlyColumns(table, shape.Columns)
	return shape
}

/*
rowOnlyColumns are columns reports_api RETURNS ON ITS ROWS but does not list in
its catalogue.

The two are separate lists over there, and for the sports raw datasets they
disagree: /v1/sports/open-web hands back DelistingBatchId and HSPName on every
row, /v1/sports/open-web-source hands back SourceDMCANoticeId and HSPName, and
neither id appears in the dataset's declared column list.

That gap is invisible and total. apiTableShape builds the shape FROM the
catalogue, inferSpec derives the whole spec from the shape, and a column the
shape does not have is a column that does not exist as far as this portal is
concerned — so the enforcement panels were never built, the action trend card
was never offered, and the report simply had no such visuals. Nothing failed and
nothing was logged, because from the shape's point of view the sports tables
carry no enforcement at all. The same panels drew perfectly on the Internet
datasets, whose catalogue does list the ids, which is exactly what made this
look like a bug in the panels.

READ THIS BEFORE ADDING AN ENTRY. A column named here is only usable by code
that walks the RAW ROWS. The service still will not group by it or aggregate it,
so a breakdown or a measure asked for it comes back empty — see
enforcementByGroup, which counts these off the rows for that reason. Filters are
safe without thinking about it: inferSpec gates those on apiCanGroupBy, which
asks the service rather than the shape.

DELETE AN ENTRY the moment reports_api lists that column. The union below is a
no-op then, and the catalogue is the better authority.
*/
var rowOnlyColumns = map[string][]string{
	// The linking half: the batch submitted to the engines, and the provider
	// answering for the host behind the link.
	"dashboards.SportsURLRawData": {colDelistingBatchID, "HSPName"},
	// The host half: the notice sent to the provider.
	"dashboards.SportsSourceURLRawData": {colSourceNoticeID, "HSPName"},
}

// addRowOnlyColumns unions the list above into a shape's columns, leaving
// anything the catalogue already declared exactly as the catalogue spelled it.
func addRowOnlyColumns(table string, cols map[string]string) {
	for _, col := range rowOnlyColumns[table] {
		if col == "" {
			continue
		}
		// The catalogue wins where the two overlap: its spelling is the one the
		// rows come back keyed by, and overwriting it here would be this file
		// second-guessing the service about its own columns.
		if _, listed := cols[strings.ToLower(col)]; listed {
			continue
		}
		cols[strings.ToLower(col)] = col
	}
}

/*
apiMasterKeyFor names the lookup that resolves a dimension's ids.

The portal's dimension registry declares its lookups as warehouse TABLES —
mediascan.Asset — because that is what the direct-to-warehouse path joins
against. reports_api serves the same lists under keys. This is the one place
the two are matched up, and it goes through the service's own registry rather
than a table written here, so a master renamed over there is followed rather
than guessed at.
*/
func apiMasterKeyFor(lookupTable string) (string, bool) {
	if lookupTable == "" {
		return "", false
	}
	m, ok := reportsapi.Get().MasterByTable(context.Background(), lookupTable)
	if !ok {
		return "", false
	}
	return m.Key, true
}

/*
apiNameRows fills in the labels a breakdown came back without.

A dataset that records a dimension only as an id and carries no name beside it
— dashboards.SocialMediaDashboard is entirely like this — has no labelColumn
for reports_api to read, so every row's label is the id repeated. Drawn as-is
that is a bar chart of GUIDs, which is what a reader is looking at when a panel
"has no details".

Rows whose id is not in the lookup keep the id as their label. That is the
honest outcome: an id with no master row is a fact about the data, and blanking
it would delete a bar that carries real volume.
*/
func apiNameRows(rows []map[string]any, lookupTable, clientID string) {
	key, ok := apiMasterKeyFor(lookupTable)
	if !ok {
		return
	}
	names, err := reportsapi.Get().MasterNames(context.Background(), key, clientID)
	if err != nil || len(names) == 0 {
		return
	}
	for _, r := range rows {
		val := strFromAny(r["value"])
		if val == "" || val == noneLabel {
			continue
		}
		// Only where the service had no name of its own to give. A label that
		// already differs from the id came from the dataset's labelColumn and is
		// the better answer — it is what that row was actually grouped under.
		if lbl := strFromAny(r["label"]); lbl != "" && lbl != val {
			continue
		}
		if name := names[strings.ToLower(val)]; name != "" {
			r["label"] = name
			continue
		}
		/* No master row for this id. Fall back to the id itself rather than
		   leaving the label empty: the merge drops a row with no label, so an
		   empty one does not read as "unnamed" — it deletes a bar carrying real
		   volume and takes the whole panel with it when every row is like that. */
		if strFromAny(r["label"]) == "" {
			r["label"] = val
		}
	}
}

// noneLabel is what reports_api substitutes for a NULL or empty grouping value.
// Matched rather than re-derived so a lookup miss on it is not reported as a
// missing master row.
const noneLabel = "(none)"

/*
pickerTables is what the Data sources picker offers.

THE WAREHOUSE LIST, curated on the Warehouse tab — not the dataset catalogue.

Those are different sets and the difference is the point: the catalogue is the
dozen tables reports_api is configured to answer for, while the warehouse holds
several hundred. Offering only the catalogue meant the Warehouse tab's switches
governed a list nobody was choosing from, which is not a curation screen at all.

Three rules hold it together:

  - A hidden table is dropped, unless a platform already reads it. Opening the
    picker on an existing platform must not silently omit one of its own
    sources — the page saves back what the picker holds, so an omission there is
    a source deleted by opening a dropdown.
  - Every option says whether reports_api actually serves it. A platform pointed
    at a table the service will not answer for saves cleanly and then fails at
    read time, and the picker is the last place that can say so cheaply.
  - If the warehouse cannot be listed at all — /v1/admin/schema is restricted by
    address as well as by key — this falls back to the catalogue rather than
    returning nothing. An empty picker is indistinguishable from an empty
    warehouse, and one of those is a configuration problem the reader can fix.
*/
func pickerTables(ctx context.Context) ([]map[string]any, error) {
	hidden := hiddenTables()

	inUse := map[string]bool{}
	for _, p := range loadPlatforms() {
		for _, t := range p.Tables {
			inUse[strings.ToLower(t)] = true
		}
	}

	// What the service will answer for, by table. Read first so both branches
	// below can mark their options with it.
	servedBy := map[string]string{}
	if sets, err := reportsapi.Get().Catalog(ctx); err == nil {
		for _, d := range sets {
			servedBy[strings.ToLower(d.Table)] = d.Label
		}
	}

	offer := func(table, label string) map[string]any {
		return map[string]any{"name": table, "label": label, "served": label != ""}
	}

	body, err := reportsapi.Get().Schema(ctx, "", "")
	if err != nil {
		/* Fall back to the catalogue. Reported in the log rather than to the
		   caller: the picker still works, and a red banner over a working
		   dropdown sends someone to fix something that is not stopping them. */
		log.Printf("[report-config] warehouse list unavailable, offering the served datasets only: %v", err)
		sets, cerr := reportsapi.Get().Catalog(ctx)
		if cerr != nil {
			return nil, cerr
		}
		out := make([]map[string]any, 0, len(sets))
		for _, d := range sets {
			k := strings.ToLower(d.Table)
			if hidden[k] && !inUse[k] {
				continue
			}
			out = append(out, offer(d.Table, d.Label))
		}
		sort.Slice(out, func(i, j int) bool {
			return strFromAny(out[i]["name"]) < strFromAny(out[j]["name"])
		})
		return out, nil
	}

	schema := strFromAny(body["schema"])
	rows, _ := body["tables"].([]any)
	out := make([]map[string]any, 0, len(rows))
	for _, raw := range rows {
		t, _ := raw.(map[string]any)
		if t == nil {
			continue
		}
		name := strFromAny(t["table"])
		if name == "" {
			continue
		}
		qualified := name
		if schema != "" && !strings.Contains(name, ".") {
			qualified = schema + "." + name
		}
		k := strings.ToLower(qualified)
		if (hidden[k] || hidden[strings.ToLower(name)]) && !inUse[k] {
			continue
		}
		out = append(out, offer(qualified, servedBy[k]))
	}
	sort.Slice(out, func(i, j int) bool {
		return strFromAny(out[i]["name"]) < strFromAny(out[j]["name"])
	})
	return out, nil
}

/*
apiTableList is the set of tables a platform may be pointed at.

In API mode this is not "every table in the warehouse" — it is every table
reports_api will answer for, which is a NARROWER and more useful list. The old
picker offered all two thousand tables in the server, including the ones no
report could ever read; choosing one of those produced a platform that saved
cleanly and then failed at read time. Here the registry is the allowlist, so an
option that appears is an option that works.
*/
func apiTableList() ([]map[string]any, error) {
	sets, err := reportsapi.Get().Catalog(context.Background())
	if err != nil {
		return nil, err
	}
	/* Curated. A table somebody has hidden on the Warehouse tab is dropped from
	   the picker — see handlers/warehousetables.go. Filtered HERE rather than in
	   the page, so a hidden table is not merely undrawn but absent from the
	   response: a picker that filters client-side still shipped the list it was
	   meant to be shortening. */
	hidden := hiddenTables()

	out := make([]map[string]any, 0, len(sets))
	for _, d := range sets {
		if hidden[strings.ToLower(d.Table)] {
			continue
		}
		out = append(out, map[string]any{
			"name": d.Table,
			// What the API calls it, so the picker can say "Sports Telegram"
			// beside the table name rather than only the table name.
			"label":   d.Label,
			"dataset": d.Key,
			"group":   d.Group,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		return strFromAny(out[i]["name"]) < strFromAny(out[j]["name"])
	})
	return out, nil
}

// apiTableColumns is one table's column list, from the same catalogue the
// inference reads. No data TYPES: the API reports the columns it will return,
// not the warehouse's declarations, and inventing a type here would be a fact
// this service does not have.
func apiTableColumns(table string) ([]map[string]any, bool) {
	ds, ok := reportsapi.Get().ByTable(context.Background(), table)
	if !ok {
		return nil, false
	}
	out := make([]map[string]any, 0, len(ds.Columns))
	for _, c := range ds.Columns {
		out = append(out, map[string]any{"name": c, "type": ""})
	}
	return out, true
}

/*
apiScope turns a spec plus the page's query into the parameters reports_api
takes.

Only what the dataset declares is sent. A filter the API does not offer on this
dataset is DROPPED rather than passed through — and that matters: the engine
above already refuses to run a spec that cannot honour an active slicer
(specHonoursFilters), so a filter arriving here that the API will not accept
would otherwise become an unfiltered total added to a filtered figure.
*/
// `except` names a slicer parameter to leave OUT of the scope. Empty for a data
// request, which honours every filter; set when the scope is being built to LIST
// a slicer's own values — a list narrowed by the value already chosen contains
// exactly that one value, which is a dropdown you cannot change your mind in.
func apiScope(s reportSpec, ds reportsapi.Dataset, q map[string]string, except string) url.Values {
	v := url.Values{}
	v.Set("ClientId", strings.TrimSpace(q["clientId"]))

	from, to := strings.TrimSpace(q["from"]), strings.TrimSpace(q["to"])
	if from != "" && to != "" {
		v.Set(ds.DateFromParam, from)
		v.Set(ds.DateToParam, to)
	}

	// The spec's filters are column-based; the API's are dimension keys.
	for param, col := range s.Filters {
		if param == except {
			continue
		}
		val := strings.TrimSpace(q[param])
		if val == "" {
			continue
		}
		if key, ok := ds.DimByColumn(col); ok {
			v.Set(key, val)
		}
	}

	/* ── A sports report on an all-genre table narrows to the genre ──────────

	   Mobile Apps is a sports report by configuration reading a source that
	   holds every genre a client has: a store listing is a store listing
	   whatever it infringes, so the table carries the fixtures and the feature
	   films together. Every other sports report reads a Sports* table its own
	   ETL has already narrowed, and this is skipped for them — see
	   sportsReportOnAllGenreTable, which is what sets the flag.

	   ONE parameter, applied to the SCOPE, and that is the point of putting it
	   here rather than anywhere else. Everything a section draws is built from
	   this url.Values — the KPI summary, the daily trend, every breakdown, the
	   raw rows, and the cross-platform Summary that merges them. Narrowing the
	   scope narrows all of them at once and cannot narrow some and miss others,
	   which is exactly the state this replaces: the Asset slicer and the Assets
	   panel were held to sport while every figure beside them counted films.

	   ── Why the portal does not do this itself ─────────────────────────────

	   It cannot. Genre belongs to the TITLE, recorded in mediascan.AssetGenre,
	   and no fact table repeats it — so there is nothing on the row to compare.
	   The service's dataset filters are single-value equality on a column, so a
	   list of the client's sports asset ids is not expressible either. What is
	   expressible is a PREDICATE, and reports_api now declares one on this
	   dataset: an EXISTS over AssetGenre keyed on the fact table's AssetId. See
	   ExprFilters on the mobile-apps entry in that service's registry.

	   ── The overall report is untouched ────────────────────────────────────

	   A Mobile Apps platform configured WITHOUT "sports" in its key or label
	   reads the same table through the same code and sends no genre at all, so
	   it stays the all-genre report it is meant to be. The two sections differ
	   by this one parameter and nothing else; the flag is derived from the
	   platform's own name, so which of the two a section is follows from what an
	   admin called it.

	   An older reports_api ignores a parameter it does not declare, so a portal
	   ahead of the service degrades to exactly the behaviour it has today. */
	if s.SportsAssetsOnly {
		v.Set(sportsGenreParam, sportsGenreName)
	}

	/* ── How far into the takedown workflow to read ──────────────────────────

	   Applied to the SCOPE, beside the genre above and for the identical reason:
	   everything a section draws is built from this url.Values, so narrowing it
	   narrows the KPI band, the trend, every breakdown, the raw rows and the
	   cross-platform Summary at once — and cannot narrow some and miss others.

	   SENT ONLY WHEN IT NARROWS. monitoringScopeValue returns the end-to-end
	   value as empty, so the whole-engagement report goes to reports_api with no
	   such parameter at all — which keeps it byte-identical to the report served
	   before this slicer existed, cache key included. An unsent filter cannot
	   change a figure, and that is the property that makes this safe to switch
	   on for a client mid-season.

	   The stage lives on mediascan.Asset and no fact table repeats it, so the
	   portal cannot do this itself — the same wall the genre narrowing hits. The
	   predicate is reports_api's; see monitoringScopeFilter in its assetattrs.go.
	   An older service that does not declare the parameter ignores it, so a
	   portal ahead of it degrades to the unnarrowed report rather than erroring. */
	if scope := monitoringScopeValue(q); scope != "" {
		v.Set(monitoringScopeParam, scope)
	}

	/* ── The pirate brand, as the hostnames it actually is ───────────────────

	   The page sends a BRAND; the service is sent DOMAINS. Resolving the one to
	   the other is the whole design — see piratebrand.go — and it happens here
	   because this is the one place every query a section runs is scoped from.

	   `except` is honoured: listing the brand slicer's own values must not be
	   narrowed by the brand already chosen, or the dropdown holds exactly one
	   option and there is no way to change your mind.

	   An unresolved brand sends nothing at all. A stale bookmark naming an
	   operator that has since gone quiet then returns the unfiltered report
	   rather than an empty one — which is the direction every slicer in this
	   product fails in, because an empty report cannot be told apart from a
	   genuinely quiet window. */
	if pirateBrandParam != except && s.Role == "linking" {
		if list := brandDomainList(context.Background(), ds, q, s.DomainCol); list != "" {
			v.Set(brandDomainsParam, list)
		}
	}

	/* ── Values this client has asked not to be reported on ──────────────────

	   Applied to the SCOPE, beside the genre and the workflow ceiling above, and
	   for the identical reason: everything a section draws is built from this
	   url.Values, so subtracting here subtracts from the KPI band, the trend,
	   every breakdown, the raw rows and the cross-platform Summary at once —
	   and cannot subtract from some and miss others. That is the whole of
	   "the calculation follows what is enabled".

	   NOT excepted, unlike the brand above. `except` exists so that listing a
	   slicer's own values is not narrowed by the value already chosen; these are
	   not a chosen value, they are values that do not exist as far as this
	   client is concerned. Excepting them would put a hidden fixture back in the
	   Asset dropdown — offering a choice that empties the page is the one thing
	   the filter pane is built not to do.

	   Sent only when something is hidden, so a client with nothing excluded
	   reaches the service with no such parameter and gets the report it always
	   got, cache key included. See dimexclusions.go. */
	applyDimExclusions(v, strings.TrimSpace(q["clientId"]))
	return v
}

/*
runSpecViaAPI is runSpec's counterpart: the same section, assembled from three
HTTP calls instead of a dozen queries.

It returns the SAME map — same keys, same types — because everything downstream
(runPlatform's merging, the summary's merging, the page itself) reads that shape
and must not be able to tell which path produced it.
*/
func runSpecViaAPI(s reportSpec, q map[string]string, bg bool) map[string]any {
	c := reportsapi.Get()
	ctx := context.Background()
	/* A warm pass is nobody's page. Marking it lets the client hold background
	   traffic to a share of the request budget, so a cold-cache warm slows
	   itself down instead of spending the allowance a reader needs — which is
	   what filled a report with "Some panels could not be loaded". */
	if bg {
		ctx = reportsapi.Background(ctx)
	}

	ds, ok := c.ByTable(ctx, s.Table)
	if !ok {
		return map[string]any{
			"ok": false, "available": true, "type": s.Key, "label": s.Label,
			"table": s.Table, "role": s.Role, "roleLabel": s.RoleLabel,
			"error": s.Table + " is not served by reports_api",
		}
	}
	scope := apiScope(s, ds, q, "")

	/* Guarded, because the panels below are built concurrently. Without this
	   the error count and the notice list are two ordinary maps being written
	   from eight goroutines, which is a data race that shows up as a corrupted
	   report rather than as a crash. */
	var reportMu sync.Mutex

	var failed int
	var firstErr string
	note := func(err error) {
		reportMu.Lock()
		defer reportMu.Unlock()
		failed++
		if firstErr == "" {
			firstErr = err.Error()
		}
		/*
			LOGGED, every one of them.

			The reader's banner says only "Some panels could not be loaded",
			deliberately — the reason is a failed request naming a dataset and a
			column, and the person reading a report cannot act on it. The comment
			on that banner has always said the reason is in the server log for
			whoever can.

			It was not. This counted the failure and kept the first message for
			the warning string, and logged nothing — so the one place the
			explanation was supposed to be was the one place it never appeared,
			and "why does it say some panels could not be loaded" had no answer
			short of reading the JSON in a browser's network tab.

			Every failure, not just the first: `firstErr` is what the reader's
			warning quotes, but a report with six broken panels for six different
			reasons is six things to fix and the log is where they belong.
		*/
		log.Printf("[reports] %s panel failed for %s: %v", s.Key, s.Table, err)
	}

	/* Caveats are NOT failures and must not travel with them.

	   A panel folded from a partial list still drew, still holds real numbers,
	   and needs a sentence saying so. Routing that through `note` counted it as
	   a failed request and put "Some panels could not be loaded" over a report
	   where nothing had failed — which teaches a reader to ignore the banner
	   that exists for when something genuinely has. */
	var notices []string
	notice := func(format string, args ...any) {
		msg := fmt.Sprintf(format, args...)
		reportMu.Lock()
		defer reportMu.Unlock()
		for _, existing := range notices {
			if existing == msg {
				return
			}
		}
		notices = append(notices, msg)
	}

	/* ── The rows, read at most once ─────────────────────────────────────
	   Two things need them — the removal counts this dataset declares no
	   measure for, and the turnaround bands — and they are the same rows. Read
	   lazily, so a dataset that needs neither never pays for them. */
	var (
		rowsOnce   sync.Once
		rowsCache  []map[string]any
		rowsCapped bool
		rowsErr    error
	)
	// sync.Once rather than a bool: the turnaround panel and the removal counts
	// now ask for these from different goroutines, and two concurrent callers
	// finding the flag unset would page the whole window twice.
	allRows := func() ([]map[string]any, bool, error) {
		rowsOnce.Do(func() {
			rowsCache, rowsCapped, rowsErr = scanRows(ctx, c, ds, scope)
		})
		return rowsCache, rowsCapped, rowsErr
	}

	/* ── The asset breakdown, held to this report's own genre ─────────────

	   A sports report reading an all-genre table has to drop the titles that are
	   not sport, and the drop cannot happen after a top-ten: cutting to ten and
	   then removing the films leaves three bars under a title that says ten, and
	   the seven sports titles ranked eleventh onwards — the ones the panel exists
	   to show — never arrive. So the WHOLE list is asked for, narrowed, and cut
	   afterwards.

	   Which also answers "how many titles are in scope" exactly, for free: the
	   length of the narrowed list. That figure replaces the tile below, because a
	   report whose Assets panel shows six titles and whose tile says two hundred
	   and forty is asking the reader to decide which of the two to believe.

	   One request, memoised, and only for the reports that need it — see
	   reportassetgenre.go for which those are and why. */
	sportsAssetDim := ""
	if s.SportsAssetsOnly {
		for _, d := range s.Dimensions {
			if d.Column == "" || DIMFilterParam(d.Key) != assetFilterParam {
				continue
			}
			if key, ok := ds.DimByColumn(d.Column); ok {
				sportsAssetDim = key
				break
			}
		}
	}
	var (
		sportsAssetOnce sync.Once
		sportsAssetRows []map[string]any
		sportsAssetOK   bool
	)
	/* narrowedAssetRows is the breakdown with the non-sports titles removed, or
	   ok=false meaning "narrowing could not be established" — on which every
	   caller must fall through to the unnarrowed behaviour rather than show a
	   short list as a complete one. */
	narrowedAssetRows := func() ([]map[string]any, bool) {
		sportsAssetOnce.Do(func() {
			if sportsAssetDim == "" {
				return
			}
			ids, err := sportsAssetIDs(ctx, strings.TrimSpace(q["clientId"]))
			if err != nil {
				log.Printf("[reports] %s asset panel left unnarrowed: %v", s.Table, err)
				return
			}
			/* Every value, not a top slice, for the reason above. The fallback is
			   the same one the slicer values use: against a service that still
			   caps a breakdown, the commonest N beats nothing — and a capped list
			   is still narrowed correctly, it is only incomplete in the tail. */
			rows, truncated, err := c.BreakdownFull(ctx, ds, scope, sportsAssetDim, reportsapi.BreakdownAll)
			if err != nil {
				rows, truncated, err = c.BreakdownFull(ctx, ds, scope, sportsAssetDim, maxAPIBreakdownRows)
			}
			if err != nil {
				note(err)
				return
			}
			/* The named groups only, which is also what the tile counts: a row
			   whose asset is null is not a title, and letting it into the list
			   would have it counted as one and then reported as a drop. */
			listed := make([]string, 0, len(rows))
			named := make([]map[string]any, 0, len(rows))
			for _, r := range rows {
				grp := strFromAny(r["grp"])
				if grp == "" || grp == noneLabel {
					continue
				}
				listed = append(listed, grp)
				named = append(named, r)
			}
			keep, dropped := keepSportsAssets(ids, listed)
			survives := make(map[string]bool, len(keep))
			for _, id := range keep {
				survives[id] = true
			}
			out := make([]map[string]any, 0, len(keep))
			for _, r := range named {
				if survives[strFromAny(r["grp"])] {
					out = append(out, r)
				}
			}
			/* Ranked here rather than trusted from the service: this list is
			   about to be cut to ten under a title that says "Top 10", and the
			   ordering of an uncapped breakdown is the service's business, not a
			   contract. */
			sort.SliceStable(out, func(i, j int) bool {
				return numOf(out[i]["identified"]) > numOf(out[j]["identified"])
			})
			sportsAssetRows, sportsAssetOK = out, true
			logAssetNarrowing("Assets panel on "+s.Label, strings.TrimSpace(q["clientId"]), dropped, len(out))
			if dropped > 0 {
				/* The whole report is held to the genre now, not just this list —
				   apiScope sends the filter on the scope every panel is built
				   from. The sentence that used to end this notice ("the volume
				   figures are not narrowed") described the half-narrowed state
				   this replaced, and leaving it would have the report deny what
				   it is now doing. */
				notice("This report is held to the %s genre, read from the title master: its "+
					"source records every genre a client has. %d of the %d titles found in this "+
					"window are %s, and every figure on the page counts those titles only.",
					sportsGenreName, len(out), len(listed), sportsGenreName)
			}
			if truncated {
				notice("The %s title list was cut short by the reporting service, so the "+
					"Assets panel and the titles-in-scope figure cover the busiest %d of them.",
					sportsGenreName, maxAPIBreakdownRows)
			}
		})
		return sportsAssetRows, sportsAssetOK
	}

	/* Removals counted from those rows, where the service cannot count them —
	   see rowmetrics.go. Computed before the KPI block so the figures it
	   produces replace the zeroes rather than arriving after them. */
	var (
		rowMx     rowMetrics
		haveRowMx bool
	)
	/* ── The three independent reads, together ───────────────────────────
	   The summary, the daily series and (where they are needed) the raw rows
	   depend on nothing but the scope, and each is roughly 600ms. Run in turn
	   they were most of two seconds before a single panel had been asked for. */
	var (
		sumRes map[string]any
		sumErr error
		tsRes  []map[string]any
		tsErr  error
		phase1 sync.WaitGroup
	)
	/* ── Removals, the cheap way where the dataset allows it ─────────────
	   A dataset with no `removed` measure but a removal-status FILTER answers
	   "how many came down" as an ordinary aggregate: the same query, scoped to
	   the rows that came down. One call of 446ms, against nine sequential page
	   reads for the identical number.

	   That matters most on the sports summary, which reads five tables and
	   thirty-one panels: two of those tables were each paging their whole
	   window before a single panel had been drawn. */
	removalKey, aggRemovals := removalStatusFilter(ds)
	var deadScope url.Values
	if aggRemovals {
		deadScope = reportsapi.CloneValues(scope)
		deadScope.Set(removalKey, removalDeadValue)
	}

	/* Rows are still read, but ONLY for the question that needs them: how many
	   distinct accounts were suspended and what audience the largest snapshot
	   of each had. No aggregate can express a per-profile maximum, and this is
	   the one dataset that carries the columns for it. */
	wantRows := needsRowRemovals(ds) && (hasProfileColumns(ds) || !aggRemovals)

	/* hasChannelColumns is unconditional, unlike the profile term above: a
	   channel-identity table (Telegram) never has RemovalStatus gate this,
	   because a SUM(Subscribers) service measure is wrong for the exact same
	   reason it is wrong on a profile table — one account, counted once per
	   post — whether or not the dataset happens to also declare `removed`.
	   See the KPI block below, which replaces rather than adds. */
	wantRows = wantRows || hasChannelColumns(ds)

	/* Same reasoning, for two more figures no aggregate reaches: views on the
	   rows that came down, and how many distinct channels were suspended.
	   Both are declared on the spec (inferSpec, reportplatforms.go) as SQL
	   the warehouse path would run — meaningless here, where there is no SQL
	   engine to run it against, so the string is read only as "this dataset
	   has the columns for it" and the number itself comes from the row walk
	   instead (computeRowMetrics). A service that later declares its own
	   measure for either is asked FIRST and wins outright — see the KPI
	   block below — so this only forces a read where nothing faster answers
	   it. */
	wantViewsImpacted := s.ExtraKPI["viewsImpacted"] != ""
	if wantViewsImpacted {
		if _, served := apiMeasureFor("viewsImpacted", ds); served {
			wantViewsImpacted = false
		}
	}
	wantChannelsSuspended := s.ExtraKPI["channelsSuspended"] != ""
	if wantChannelsSuspended {
		if _, served := apiMeasureFor("channelsSuspended", ds); served {
			wantChannelsSuspended = false
		}
	}
	wantRows = wantRows || wantViewsImpacted || wantChannelsSuspended

	/* The repeat-offenders panel needs the same rows for a different reason:
	   "how many distinct days did this account appear on" is not a measure the
	   service declares, and a breakdown cannot be grouped by two things at
	   once. On the sports social dataset the rows are already being paged for
	   the figures above, so the panel costs nothing there beyond the walk.

	   Tracked SEPARATELY from wantRows rather than folded into it. wantRows
	   also switches on computeRowMetrics, whose removal count then OVERRIDES
	   the summary's — right for a dataset that declares no `removed` measure,
	   and wrong for one that does, where it would quietly replace the
	   authoritative figure with one counted off a capped page read. */
	wantRepeat := false
	for _, d := range s.Dimensions {
		if d.Key == dimRepeatOffender && d.Column != "" {
			wantRepeat = true
			break
		}
	}

	/* The enforcement figures need the rows for the same shape of reason: they
	   are COUNT(DISTINCT id), and a breakdown has already aggregated the id
	   away. Three figures come off the one walk — the tile, the daily series
	   and the per-counterparty panel — so they are gated together.

	   On the measure, never on the mode: the day reports_api declares
	   `noticesSent` for these datasets, apiMeasureFor starts answering, this
	   goes false, and the rows stop being paged at all. */
	wantAction := s.ActionKey != "" && s.ActionCol != ""
	if wantAction {
		if _, served := apiMeasureFor(s.ActionKey, ds); served {
			wantAction = false
		}
	}
	if !wantAction {
		for _, d := range s.Dimensions {
			// Every enforcement panel — see isActionPanel, which is the one list
			// both this gate and the breakdown below read.
			if !isActionPanel(d.Key) {
				continue
			}
			if d.CountDistinctCol == "" {
				continue
			}
			if _, served := apiMeasureFor(d.APIMeasure, ds); !served {
				wantAction = true
				break
			}
		}
	}
	needRows := wantRows || wantRepeat || wantAction

	/* ── How many distinct TV channels ────────────────────────────────────────

	   Asked as a BREAKDOWN and counted here, rather than waiting for the service
	   to declare a measure for it. The service already groups by this dimension —
	   it is the same call behind any "top channels" panel — so the complete list
	   of values is one query away, and its length is the distinct count.

	   Which also makes the figure scope itself correctly with no further work:
	   the breakdown carries the report's own filters and date range, and each
	   table in a multi-table report answers for itself before runPlatform adds
	   them up. Open Web alone gets Open Web's, Telegram alone gets Telegram's,
	   the summary gets the sum.

	   -1 rather than 0 for "not counted", because 0 is a real answer — a window
	   in which nothing was found — and a tile must not report one as the other.

	   The count is of NAMED values only: see countNamedGroups, which is the
	   difference between this figure and the row count of the breakdown. */
	tvChannels := int64(-1)
	tvDim := tvChannelDim(ds)
	if s.ExtraKPI["totalTVChannels"] == "" {
		tvDim = ""
	}

	var (
		deadSum map[string]any
		deadTS  []map[string]any
	)
	if tvDim != "" {
		phase1.Add(1)
		go func() {
			defer phase1.Done()
			/* Every value, not a top slice: this is a cardinality, and the
			   commonest 200 of 300 channels is not a count of channels. The
			   fallback is for a service that still caps — and a CAPPED list is
			   left unpublished rather than reported as a total, because an
			   undercount on a tile is indistinguishable from the truth. */
			rows, truncated, err := c.BreakdownFull(ctx, ds, scope, tvDim, reportsapi.BreakdownAll)
			if err != nil {
				rows, truncated, err = c.BreakdownFull(ctx, ds, scope, tvDim, maxAPIBreakdownRows)
			}
			if err != nil {
				note(err)
				return
			}
			if truncated {
				return
			}
			atomic.StoreInt64(&tvChannels, countNamedGroups(rows))
		}()
	}
	phase1.Add(2)
	go func() { defer phase1.Done(); sumRes, sumErr = c.Summary(ctx, ds, scope) }()
	go func() { defer phase1.Done(); tsRes, tsErr = c.Timeseries(ctx, ds, scope, "day") }()
	if aggRemovals {
		phase1.Add(2)
		go func() {
			defer phase1.Done()
			if v, err := c.Summary(ctx, ds, deadScope); err == nil {
				deadSum = v
			} else {
				note(err)
			}
		}()
		go func() {
			defer phase1.Done()
			if v, err := c.Timeseries(ctx, ds, deadScope, "day"); err == nil {
				deadTS = v
			} else {
				note(err)
			}
		}()
	}
	if needRows {
		phase1.Add(1)
		go func() { defer phase1.Done(); allRows() }()
	}
	/* Fetched with the summary rather than lazily from a panel, because the KPI
	   band below reads its length: leaving it to the panels would set the tile
	   after the band had already been assembled. */
	if sportsAssetDim != "" {
		phase1.Add(1)
		go func() { defer phase1.Done(); narrowedAssetRows() }()
	}
	phase1.Wait()

	if wantRows {
		if rows, capped, err := allRows(); err != nil {
			note(err)
		} else {
			groupCols := make([]string, 0, len(s.Dimensions))
			for _, d := range s.Dimensions {
				if d.Column == "" {
					continue
				}
				if k, ok := ds.DimByColumn(d.Column); ok {
					if col := ds.ColumnForDim(k); col != "" {
						groupCols = append(groupCols, col)
					}
				}
			}
			rowMx = computeRowMetrics(rows, dateColOf(ds), groupCols)
			haveRowMx = true
			if capped {
				// Not only profile figures any more — views-impacted and
				// channels-suspended are counted off this same capped walk
				// now too (see wantViewsImpacted / wantChannelsSuspended).
				notice("Some figures were counted over the first %d rows of this window.", len(rows))
			}
		}
	}

	/* The aggregate is the AUTHORITY on the removal counts where it exists: it
	   sees the whole window, while a row read can be capped. The row pass keeps
	   only what it alone can answer. */
	var aggRemoved int64
	var aggRemovedByDay map[string]int64
	if aggRemovals && deadSum != nil {
		aggRemoved = numOf(deadSum["identified"])
		aggRemovedByDay = map[string]int64{}
		for _, p := range deadTS {
			aggRemovedByDay[dayKey(strFromAny(p["bucket"]))] = numOf(p["identified"])
		}
	}

	// ── KPI ─────────────────────────────────────────────────────────────────
	kpi := map[string]any{}
	var ident, removed int64
	if sum, err := sumRes, sumErr; err != nil {
		note(err)
	} else {
		ident = numOf(sum["identified"])
		removed = numOf(sum["removed"])
		/* The rows are the only source that HAS this figure for such a dataset,
		   so they win outright rather than filling in a zero. A summary with no
		   removed measure answers 0, which is indistinguishable from a real
		   zero and was being drawn as one. */
		switch {
		case aggRemovals && deadSum != nil:
			removed = aggRemoved
		case haveRowMx:
			removed = rowMx.removed
		}
		kpi["identified"] = ident
		kpi["removed"] = removed
		kpi["pending"] = max64(0, ident-removed)
		pct := 0.0
		if ident > 0 {
			pct = float64(removed) / float64(ident) * 100
		}
		kpi["removalPct"] = roundTo(pct, 2)

		/* ── Views on the rows that came down ─────────────────────────────

		   Free: `deadSum` is the same window under the service's own removal
		   filter, already fetched above to count the removals themselves. Its
		   `views` is therefore views on removed rows by construction — the
		   service's measure under the service's filter — so this figure cannot
		   drift from the Removed tile beside it, which is read off the very same
		   answer.

		   Set before the loop below so a service that later declares a
		   `viewsImpacted` measure of its own takes precedence: both compute the
		   same number, and the one the service publishes is the one it is
		   accountable for. */
		if aggRemovals && deadSum != nil && s.ExtraKPI["viewsImpacted"] != "" {
			if vm, ok := apiMeasureFor("views", ds); ok {
				kpi["viewsImpacted"] = numOf(deadSum[vm])
			}
		}
		/* Neither of the above answered it: no removal-status FILTER on this
		   dataset (aggRemovals false, typically because it already declares
		   its own `removed` measure — the happy path for Removed, and the
		   one case the deadSum shortcut above cannot also cover) and no
		   dedicated measure the service answers under either. The rows are
		   read anyway once that is so — see wantViewsImpacted — so the same
		   SUM comes off that walk instead of being left at zero. */
		if _, already := kpi["viewsImpacted"]; !already && haveRowMx && wantViewsImpacted {
			kpi["viewsImpacted"] = rowMx.viewsImpacted
		}
		if n := atomic.LoadInt64(&tvChannels); n >= 0 {
			kpi["totalTVChannels"] = n
		}

		// The spec's extra tiles, each only where the dataset actually has it.
		for name := range s.ExtraKPI {
			if m, ok := apiMeasureFor(name, ds); ok {
				kpi[name] = numOf(sum[m])
			}
		}
		if s.DelistedExpr != "" && ds.HasMeasure("delisted") {
			kpi["delisted"] = numOf(sum["delisted"])
		}

		/* ── The account behind the post ──────────────────────────────────
		   How many accounts were taken down, and what audience they had.

		   impactedSubscribers is REPLACED, not added: the measure the service
		   offers sums Subscribers over every row, and one account appears on
		   every post it made — so that figure counted the same audience once
		   per post, and read 2.1 billion where the accounts hold 1.4 million.
		   A tile that wrong is worse than an absent one. */
		if haveRowMx && hasProfileColumns(ds) {
			kpi["profilesSuspended"] = rowMx.profilesSuspended
			kpi["impactedSubscribers"] = rowMx.impactedSubscribers
			/* The whole audience, counted the same way and for the same reason —
			   the service's SUM would report one profile's followers once per
			   post it made. Replaced rather than added, like the two above. */
			kpi["totalSubscribers"] = rowMx.totalSubscribers
		} else if haveRowMx && hasChannelColumns(ds) {
			/* The exact same replacement, for a table that records the account
			   as a CHANNEL instead of a PROFILE — Telegram. `else if` because
			   the two identities are never both present on one table (see
			   rowMetrics' own comment on why they are kept as separate
			   fields), so this can never double-write a tile the branch above
			   already set. */
			kpi["impactedSubscribers"] = rowMx.channelImpactedSubscribers
			kpi["totalSubscribers"] = rowMx.channelTotalSubscribers
		}

		/* ── Views impacted, and suspended channels — from the rows ─────────

		   Only where nothing already answered them: the generic loop above
		   already asked the service directly (`wantViewsImpacted` /
		   `wantChannelsSuspended` are false wherever that succeeded), and
		   `viewsImpacted` also has the deadSum-aggregate path below it,
		   which is faster where the dataset offers a removal FILTER — see
		   its own comment. This is the fallback for what is left: a dataset
		   that declares neither a matching measure nor a filter, where the
		   rows are the only place these numbers exist at all. */
		if haveRowMx && wantChannelsSuspended {
			kpi["channelsSuspended"] = rowMx.channelsSuspended
		}

		/* ── Titles in scope, on a report that may only name some of them ──

		   REPLACED, not added. The service's `assets` measure counts every asset
		   the table holds in the window, and on a sports report reading an
		   all-genre source most of them are titles the report is not about — so
		   the tile disagreed with the Assets panel and the Asset slicer beside
		   it, which are both narrowed. Three views of one number, and the two
		   that were right were the ones a reader could check.

		   Only where the tile already exists: a table with no asset column has
		   none, and inventing one here would put a figure on a report that
		   cannot measure it. Same guard, same reasoning, as applyAssetScope —
		   which still overrides this later when the reader has named the titles
		   themselves, and should: what they asked for beats what was found. */
		if _, has := kpi["totalAssets"]; has {
			if rows, ok := narrowedAssetRows(); ok {
				kpi["totalAssets"] = int64(len(rows))
			}
		}
	}

	/* The enforcement-action tile, counted off the rows where reports_api
	   declares no measure for it — one distinct-count over rows already read
	   for the panels below. Falls back to a warehouse query if the rows don't
	   have the enforcement columns. See enforcementactions.go. */
	if wantAction && s.ActionKey != "" {
		if rows, _, err := allRows(); err != nil {
			note(err)
		} else if len(rows) > 0 {
			if count := enforcementTotal(rows, s.ActionCol); count > 0 {
				kpi[s.ActionKey] = count
			} else if db.ReportsConfigured() {
				// Rows don't have the enforcement column; fall back to warehouse.
				where, args := specWhere(s, q)
				if v, err := enforcementViaWarehouse(s.Table, s.ActionCol, where, args); err == nil {
					kpi[s.ActionKey] = v
				} else {
					note(err)
				}
			}
		}
	}

	// ── Daily trend ─────────────────────────────────────────────────────────
	daily := []map[string]any{}
	if pts, err := tsRes, tsErr; err != nil {
		note(err)
	} else {
		wantDelisted := s.DelistedExpr != "" && ds.HasMeasure("delisted")
		for _, p := range pts {
			date := strFromAny(p["bucket"])
			row := map[string]any{
				"date":    date,
				"urls":    numOf(p["identified"]),
				"removed": numOf(p["removed"]),
			}
			// Same substitution as the KPI, per day — otherwise the removal
			// rate stays a flat 0% under a tile that now says 37%.
			switch {
			case aggRemovedByDay != nil:
				row["removed"] = aggRemovedByDay[dayKey(date)]
			case haveRowMx:
				row["removed"] = rowMx.removedByDay[dayKey(date)]
			}
			if wantDelisted {
				row["delisted"] = numOf(p["delisted"])
			}
			/* The action count per bucket, straight off the same points: the
			   service returns EVERY measure it declares per bucket, so a
			   dataset that declares `noticesSent` has already answered this and
			   there is nothing extra to fetch. */
			if s.ActionKey != "" {
				if mk, ok := apiMeasureFor(s.ActionKey, ds); ok {
					row[s.ActionKey] = numOf(p[mk])
				}
			}
			daily = append(daily, row)
		}
	}

	/* The day-wise action counts are a BREAKDOWN panel now (dimNoticesByDay,
	   dimBatchesByDay below), not a patch onto the daily timeseries — the trend
	   card that read the patched values was removed, so patching here would be
	   a row walk and possibly a warehouse query with no card to show for it. */

	// ── Breakdowns ──────────────────────────────────────────────────────────
	breakdowns := map[string]any{}

	/* The hostname breakdown, fetched at most once and shared.

	   Three panels are derived from it — the brand, the mirror count per brand,
	   and how the mirrors are made — and all three used to be their own GROUP BY
	   over a computed expression in reports_api, which could not use an index
	   and cost 22 seconds each against 10 for this one. Folding a single indexed
	   result in memory is the same answer for a third of the work, and the rule
	   that does the folding lives where it can be changed without redeploying
	   the service every other report depends on. See domainroot.go.

	   Deeper than the panels show, because a brand is assembled FROM hostnames:
	   a top 10 of hosts cannot tell you that livetv has 28 of them. */
	hostCache := map[string][]map[string]any{}
	hostMissed := map[string]bool{}
	// Set when the service cut the tail off, so a folded panel can say that its
	// totals cover the busiest hostnames rather than all of them.
	hostTruncated := map[string]bool{}
	/* Keyed on the COLUMN, not on the panel: the three derived panels resolve to
	   the same hostname column on every table that has one, so they share a
	   single result — and a table that somehow carried two would still get the
	   right rows for each. */
	/* Serialised, and deliberately around the FETCH as well as the maps.

	   Three panels fold from one hostname breakdown and they now run at the
	   same time. A lock held only over the map writes would let all three miss
	   together and issue the same expensive query three times — turning one
	   shared result into three of the slowest calls in the report. Held across
	   the fetch, the first caller pays and the other two wait for its answer. */
	var hostMu sync.Mutex
	domainRows := func(col string) ([]map[string]any, bool) {
		hostMu.Lock()
		defer hostMu.Unlock()
		if rows, done := hostCache[col]; done {
			return rows, true
		}
		if hostMissed[col] {
			return nil, false
		}
		dim, ok := ds.DimByColumn(col)
		if !ok {
			hostMissed[col] = true
			return nil, false
		}
		var hostRows []map[string]any
		/* EVERY group, because these rows are added up rather than drawn.

		   A brand total folded from a truncated hostname list is short by
		   whatever was cut, and nothing about the number says so. Measured on
		   this warehouse the tail is not marginal: one client's sports URLs are
		   1,038,971 rows but only 5,376 distinct domains, and at the old cap of
		   200 the fold covered 95% of the volume on one table and 64% on Open
		   Web — so every brand was understated by up to a third.

		   Cardinality is what bounds this, not row count, which is why asking
		   for all of it is reasonable here and would not be on /rows.

		   The fallback is for a service that has not been updated yet: it caps
		   at 200 and refuses more, and a narrowed panel beats an empty one. When
		   that happens the rows ARE truncated and the caller is told. */
		raw, truncated, err := c.BreakdownFull(ctx, ds, scope, dim, reportsapi.BreakdownAll)
		if err != nil {
			raw, truncated, err = c.BreakdownFull(ctx, ds, scope, dim, maxAPIBreakdownRows)
		}
		if err != nil {
			note(err)
			hostMissed[col] = true
			return nil, false
		}
		if truncated {
			hostTruncated[col] = true
		}
		/* The service returns every measure it DECLARES on each row, so the
		   Google count is already in the answer wherever the dataset has one —
		   there is nothing extra to fetch for the de-indexing card. Asked of the
		   catalogue rather than of the row, because a row that happens to read 0
		   is not the same as a dataset that does not carry the measure. */
		google := ds.HasMeasure("googleDelisted")
		for _, r := range raw {
			row := map[string]any{
				"label":   strFromAny(r["label"]),
				"value":   strFromAny(r["grp"]),
				"urls":    numOf(r["identified"]),
				"removed": numOf(r["removed"]),
			}
			if google {
				row["googleDelisted"] = numOf(r["googleDelisted"])
			}
			hostRows = append(hostRows, row)
		}
		hostCache[col] = hostRows
		return hostRows, true
	}

	/*
	   buildPanel produces ONE breakdown and RETURNS it, rather than writing it
	   into the shared map — which is what makes it safe to run several at once.
	*/
	buildPanel := func(d dimension) []map[string]any {

		/* ── The two enforcement panels, counted off the rows ─────────────
		   HSPName against distinct SourceDMCANoticeId, SearchEngineName against
		   distinct DelistingBatchId — the grouping column and the id both taken
		   from the spec, so each side counts the column inferSpec proved its own
		   table has.

		   NOT a breakdown. The service aggregates the id away, leaving one row
		   per group carrying measures it does declare, and a DISTINCT over that
		   is zero for every group — an empty panel that looks exactly like a
		   provider nobody has noticed. The raw rows still carry the id. Falls back
		   to warehouse if reports_api does not return the id columns. */
		if isActionPanel(d.Key) {
			if _, served := apiMeasureFor(d.APIMeasure, ds); !served {
				if d.CountDistinctCol == "" {
					return []map[string]any{}
				}
				// The day panels group by the date column with timestamps folded to
				// their day and the bars in calendar order; the counterparty ones
				// group by a name, busiest first. Same count either way.
				byDay := d.Key == dimNoticesByDay || d.Key == dimBatchesByDay
				rows, capped, err := allRows()
				if err != nil {
					note(err)
					return []map[string]any{}
				}
				var result []map[string]any
				if byDay {
					result = enforcementDayPanel(rows, d.Column, d.CountDistinctCol)
				} else {
					result = enforcementByGroup(rows, d.Column, d.CountDistinctCol, d.Limit)
				}
				// If rows returned no data (empty or missing columns), fall back to warehouse
				if len(result) == 0 && db.ReportsConfigured() {
					where, args := specWhere(s, q)
					var wr []map[string]any
					var werr error
					if byDay {
						wr, werr = enforcementDayPanelViaWarehouse(s.Table, d.Column, d.CountDistinctCol, where, args)
					} else {
						wr, werr = enforcementGroupViaWarehouse(s.Table, d.Column, d.CountDistinctCol, where, args, d.Limit)
					}
					if werr == nil && len(wr) > 0 {
						result = wr
					} else if werr != nil {
						note(werr)
					}
				}
				/* A caveat, not a failure. The cap takes the oldest rows, so a
				   provider first noticed late in the window can be short of
				   actions it genuinely received. */
				if capped && len(result) > 0 {
					notice("%s was counted over the first %d rows of this window, "+
						"so a count can be lower than its true one.", d.Label, len(rows))
				}
				return result
			}
		}

		/* The three derived panels, all folded from the one request above.
		   `mirrors` rides along on every row so the Table view can show the
		   hostname count beside the volume whichever panel is being read. */
		if fold, derived := domainFoldFor(d.Key); derived {
			rows, ok := domainRows(d.Column)
			if !ok {
				return []map[string]any{}
			}
			out := foldDomainRows(rows, fold)
			// The mirror-count panel plots the hostname count, not the volume;
			// everything else about the row is the same.
			if d.Key == dimDomainRootMirrors {
				for _, r := range out {
					r["urls"] = r["mirrors"]
					r["removed"] = int64(0)
				}
				sortRowsByURLs(out)
			}
			/* The LINKING combined card is measured on Google de-indexing, so the
			   Google count becomes its second series outright rather than sitting
			   beside the removal figure as a third.

			   A swap and not an extra column, because everything downstream — the
			   merge, the table twin, the export, the chart — reads one pair of
			   measures per row, and a third would have to be threaded through all
			   four to be drawn once. The panel is registered only where the
			   measure exists (see Needs on the candidate), so this cannot leave a
			   removal count sitting under a de-indexing heading. */
			if d.Key == dimDomainRootAll {
				for _, r := range out {
					r["removed"] = numOf(r["googleDelisted"])
				}
			}
			/* Both combined cards are RANKED, so their order has to be the
			   ranking rather than the order the brands happened to appear in.
			   Sorted before the cut below, or a top-10 is ten arbitrary brands
			   numbered 1 to 10. */
			if d.Key == dimDomainRootAll || d.Key == dimDomainRootSource {
				sortRowsByURLs(out)
			}
			/* The working measure leaves here. It exists to be resolved into
			   `removed` above; carried further it would reach the summary merge,
			   which drops keys it does not name — so a single-table platform and
			   a merged one would disagree about whether the row has it. */
			for _, r := range out {
				delete(r, "googleDelisted")
			}
			if d.Limit > 0 && len(out) > d.Limit {
				out = out[:d.Limit]
			}
			/* Say so rather than quietly under-report. A folded total built on a
			   cut list is not a top-N — it is a wrong number wearing a right
			   one's clothes, and the reader has nothing to go on. */
			hostMu.Lock()
			truncated := hostTruncated[d.Column]
			hostMu.Unlock()
			if truncated {
				notice("%s covers the busiest %d hostnames rather than every one — "+
					"update reports_api to accept limit=all and these totals become exact",
					d.Label, maxAPIBreakdownRows)
			}
			return out
		}

		/* ── Repeat offenders, counted off the rows ───────────────────────
		   The service groups by a column and answers with the measures it
		   declares. "How many distinct days did this account appear on" is
		   neither: it is a count over a second column WITHIN each group, and no
		   breakdown can be asked for it. The rows carry both columns, so the
		   walk happens here — see repeatoffenders.go.

		   The column is the one inferSpec resolved against this dataset's own
		   catalogue, so a table spelling it ProfileURL and one spelling it
		   ChannelURL both land on the right one. */
		if d.Key == dimRepeatOffender {
			rows, capped, err := allRows()
			if err != nil {
				note(err)
				return []map[string]any{}
			}
			/* A CAVEAT, not a failure — the panel drew and its numbers are real
			   for the rows it saw. It matters more here than on most panels:
			   the cap takes the OLDEST rows, so an account that only started
			   posting late in the window can be missing days it genuinely had,
			   and the ranking under-reports it. */
			if capped {
				notice("Repeat offenders were counted over the first %d rows of this window, "+
					"so a profile's repeat count can be lower than its true one.", len(rows))
			}
			/* A pre-aggregated table counts with its own columns rather than
			   with rows — Agg_Daily_Youtube_MasterNew carries ChannelURL, so it
			   gets this panel, and each of its rows stands for a whole day's
			   TotalCount. Resolved from the same measurePairs inferSpec uses,
			   so this panel and the KPI band count the same way. */
			identCol, removedCol := repeatMeasureColumns(ds.Columns)
			/* The removal STAMP, which the repeat count is measured from. A
			   dataset without one cannot say when anything came down, so it
			   cannot say what came after — reported rather than drawn as a
			   panel of zeroes. */
			removalTimeCol := repeatRemovalTimeColumn(ds.Columns)
			if removalTimeCol == "" {
				notice("Repeat offenders needs a removal timestamp, which this source does not carry.")
				return []map[string]any{}
			}
			/* The one PANEL-SCOPED slicer on the page. Applied to the raw rows
			   here rather than to the scope, so the rest of the report stays on
			   every platform it covers — see repeatPlatformParam. */
			return computeRepeatOffenders(
				filterRowsByPlatform(rows, q[repeatPlatformParam]),
				d.Column, dateColOf(ds), identCol, removedCol, removalTimeCol, d.Limit)
		}

		/* ── The accounts with the biggest AUDIENCE ───────────────────────
		   Ranked by followers rather than by volume, and counted here for the
		   same reason the repeat panel is: the audience is a MAX per profile and
		   a breakdown has already aggregated it away. See topprofiles.go. */
		if d.Key == dimTopProfiles {
			rows, capped, err := allRows()
			if err != nil {
				note(err)
				return []map[string]any{}
			}
			/* The same caveat the repeat panel carries, and it bites the same
			   way: the cap takes the OLDEST rows, so an account whose follower
			   count was only crawled late in the window can be ranked on a
			   reading it has since outgrown. */
			if capped {
				notice("%s was ranked over the first %d rows of this window, so an "+
					"account's audience can be lower than its true one.", d.Label, len(rows))
			}
			identCol, removedCol := repeatMeasureColumns(ds.Columns)
			subsCol := firstColumnOf(ds.Columns, []string{colSubscriberCnt})
			if subsCol == "" {
				notice("%s needs a subscriber count, which this source does not carry.", d.Label)
				return []map[string]any{}
			}
			/* The catalogue's answer first, the rows themselves where it comes
			   back empty — see firstColumnPresent. Both the status and the
			   name are read off the ROW there, per profile, so a dataset whose
			   catalogue under-reports one of them still gets it from the
			   payload in hand rather than falling all the way back to "Not
			   Available" or a URL-derived handle. */
			statusCol := firstColumnOf(ds.Columns, []string{colProfileStatus})
			if statusCol == "" {
				statusCol = firstColumnPresent(rows, []string{colProfileStatus})
			}
			nameCol := profileNameColumn(ds.Columns)
			if nameCol == "" {
				nameCol = firstColumnPresent(rows, profileNameColumns)
			}
			/* Which social platform the account is on — optional, same fallback
			   order as name and status. Empty on a single-brand table, which has
			   nothing to disambiguate. */
			platformCol := firstColumnOf(ds.Columns, []string{colPlatform})
			if platformCol == "" {
				platformCol = firstColumnPresent(rows, []string{colPlatform})
			}
			return computeTopProfiles(rows, d.Column, subsCol, statusCol, nameCol, platformCol,
				identCol, removedCol, d.Limit)
		}

		/* ── Turnaround, computed from the timestamps ─────────────────────
		   TATBucket is banded by whatever wrote it, and that was the takedown
		   flow: "0-20 days", "Pending". On a live sports stream those bands say
		   nothing. Measured on this warehouse, a post discovered at 10:37:32 and
		   removed at 11:22:02 — forty-four minutes — is filed under "0-20 days",
		   which is why the panel showed two bands and 85% Pending.

		   Where the table carries both timestamps the bands are computed here
		   instead. Where it does not, this falls through and the panel is what
		   it always was. See tatbuckets.go. */
		if d.Key == dimTAT {
			if foundCol, removedCol, has := tatTimeCols(ds.Columns); has {
				rows, capped, err := allRows()
				if err != nil {
					note(err)
				} else {
					if capped {
						note(fmt.Errorf("turnaround was measured over the first %d rows of this window; "+
							"the bands describe that much of it", len(rows)))
					}
					return bandTATRows(rows, foundCol, removedCol)
				}
			} else {
				/* Logged rather than left as a mystery. "Why is a sports report
				   showing day-scale bands" has one answer — this table records
				   no removal time — and this is where it is visible. */
				log.Printf("[reports] %s has no discovery/removal timestamp pair; the Turnaround "+
					"panel is showing %s as stored. Columns: %s",
					s.Table, d.Column, strings.Join(ds.Columns, ", "))
			}
		}

		key, ok := ds.DimByColumn(d.Column)
		if !ok {
			// Not offered by the API on this dataset. An empty panel is the
			// honest result — better than omitting it, which would look like
			// the dimension had no values.
			return []map[string]any{}
		}
		limit := d.Limit
		if limit <= 0 {
			limit = 200
		}
		/* The asset panel of a genre-narrowed report is cut from the NARROWED
		   list, not asked for fresh — see narrowedAssetRows. Falls through to the
		   ordinary breakdown when the narrowing could not be established, which
		   is the unnarrowed panel this report has always drawn. */
		var (
			rows []map[string]any
			err  error
		)
		if narrowed, ok := narrowedAssetRows(); ok && key == sportsAssetDim {
			rows = narrowed
			if limit > 0 && len(rows) > limit {
				rows = rows[:limit]
			}
		} else if rows, err = c.Breakdown(ctx, ds, scope, key, limit); err != nil {
			note(err)
			return []map[string]any{}
		}
		/* A panel that counts something other than the section's own measure
		   says which — the enforcement-notification cards count notices sent
		   over the same grouping, which is a few hundred against a few million.
		   Where the dataset cannot answer for it the panel is left empty rather
		   than filled with the identified count, which would be the wrong number
		   under a title nobody would think to doubt. */
		identKey, removedKey := "identified", "removed"
		if d.APIMeasure != "" {
			m, ok := apiMeasureFor(d.APIMeasure, ds)
			if !ok {
				return []map[string]any{}
			}
			identKey, removedKey = m, ""
		}
		/* A panel whose REMOVAL means something narrower than the section's.
		   Empty where the dataset cannot answer for it — the panel then draws
		   its removal flat rather than quietly falling back to a measure with a
		   different definition, which is the confusion this field exists to
		   avoid. */
		if d.APIRemoved != "" {
			if m, ok := apiMeasureFor(d.APIRemoved, ds); ok {
				removedKey = m
			} else {
				removedKey = ""
			}
		}
		/* A panel whose REMOVAL means something narrower than the section's.
		   Empty where the dataset cannot answer for it — the panel then draws
		   its removal flat rather than quietly falling back to a measure with a
		   different definition, which is the confusion this field exists to
		   avoid. */
		if d.APIRemoved != "" {
			if m, ok := apiMeasureFor(d.APIRemoved, ds); ok {
				removedKey = m
			} else {
				removedKey = ""
			}
		}

		/* The THIRD figure, where the panel asks for one.

		   Free: a breakdown returns every measure the dataset declares, so this
		   is a key already on the row rather than a second request. Resolved
		   through apiMeasureFor like every other named figure, so a dataset that
		   cannot answer for it leaves the number absent rather than filled with
		   a plausible wrong one — see the note on identKey above. */
		extraKey := ""
		if d.APIExtra != "" {
			if m, ok := apiMeasureFor(d.APIExtra, ds); ok {
				extraKey = m
			}
		}
		// The second, where a panel declares one — see dimension.APIExtra2.
		extraKey2 := ""
		if d.APIExtra2 != "" {
			if m, ok := apiMeasureFor(d.APIExtra2, ds); ok {
				extraKey2 = m
			}
		}

		/*
			── AND WHERE THE SERVICE DECLARES NO SUCH MEASURE ────────────────

			Counted off the RAW ROWS instead, which this bridge already pages for
			these datasets.

			The declaration-only version was wrong in the one way that leaves no
			trace. `apiMeasureFor` answers "does this dataset declare `domains`",
			and where it does not, extraKey stays empty, the figure never lands on
			a row, and the panel draws a heading over nothing. No query fails, no
			notice is raised, and the column simply is not there — which looks
			exactly like a panel that was never asked to show one. Two provider
			cards sat like that through several rounds of me changing labels above
			an empty column.

			So the count no longer depends on the far side having thought of it.
			A distinct count over a column IS the definition — enforcementByGroup
			is the same helper the notice panels use, and the rows are in hand.
		*/
		extraFromRows := map[string]int64{}
		extraFromRows2 := map[string]int64{}
		/* WHICH values, not just how many.

		   The provider cards draw the domain count on its own gauge, and a
		   reader looking at "29 linking domains" wants the twenty-nine. They are
		   already in hand — the walk below builds the distinct set per group and
		   the count is its size — so the list costs nothing beyond carrying it.

		   Only the FIRST extra gets one. The second is a count of notice ids,
		   and a list of GUIDs is not something a reader can act on. */
		extraListFromRows := map[string][]string{}
		extraRowsCapped, extraRowsScanned := false, 0
		setsPerGroup := func(col string) map[string][]string {
			if col == "" {
				return nil
			}
			raw, capped, err := allRows()
			if err != nil {
				note(err)
				return nil
			}
			if capped {
				extraRowsCapped, extraRowsScanned = true, len(raw)
			}
			return enforcementSetsByGroup(raw, d.Column, col)
		}
		countDistinctPerGroup := func(col string) map[string]int64 {
			out := map[string]int64{}
			/* Counted as the SIZE of the same set the list comes from — see
			   enforcementSetsByGroup. Computing the two separately is how a
			   gauge ends up reading 29 over a drawer holding 27. */
			for label, list := range setsPerGroup(col) {
				out[label] = int64(len(list))
			}
			return out
		}
		/* Resolved OR NOT — the row walk is prepared either way, because a
		   measure the catalogue declares is not the same as a measure the
		   BREAKDOWN returns.

		   That distinction was learned the hard way. Both sports datasets
		   declared `domains`, apiMeasureFor resolved it, the panel asked for
		   nothing more — and the breakdown answered per group with identified
		   and removed only, so the key was not on the row. numOf read the
		   absence as 0, every gauge was empty, and the column dropped out,
		   indistinguishable from a measure that does not exist.

		   So the fallback below is keyed on the ANSWER rather than on the
		   declaration: a figure that comes back zero for every group was not
		   really answered, and the rows in hand can answer it exactly.

		   MEASURED 12 September 2026: the breakdown now DOES return `domains`
		   and `dmcaNotices`, so the service branch is the live one and the walk
		   is what supplies the domain LIST beside it. Both roads are kept, and
		   the count/list reconciliation below is what makes it safe not to know
		   which one a given deployment is on. */
		if d.ExtraExpr != "" {
			extraListFromRows = setsPerGroup(distinctColOf(d.ExtraExpr))
			for label, list := range extraListFromRows {
				extraFromRows[label] = int64(len(list))
			}
		}
		if d.ExtraExpr2 != "" {
			extraFromRows2 = countDistinctPerGroup(distinctColOf(d.ExtraExpr2))
		}

		out := make([]map[string]any, 0, len(rows))
		for _, r := range rows {
			row := map[string]any{
				// label is what the reader sees, value is what a click filters
				// on — the same split the panels already expect.
				"label":   strFromAny(r["label"]),
				"value":   strFromAny(r["grp"]),
				"urls":    numOf(r[identKey]),
				"removed": int64(0),
			}
			if removedKey != "" {
				row["removed"] = numOf(r[removedKey])
			}
			/* The service's answer where it gave one, the row walk where it did
			   not. A zero is treated as "did not answer": a provider with no
			   distinct domains at all is not a row this panel would have. */
			if v := numOf(r[extraKey2]); extraKey2 != "" && v != 0 {
				row["extra2"] = v
			} else if v, ok := extraFromRows2[strFromAny(r["label"])]; ok {
				row["extra2"] = v
			}
			if v := numOf(r[extraKey]); extraKey != "" && v != 0 {
				/* ── THE SERVICE'S COUNT, AND THE WALK'S LIST BESIDE IT ────

				   Both halves exist here and they come from different places.
				   The count is the service's exact COUNT(DISTINCT) over the
				   whole window; the list is this bridge's walk over the raw
				   rows, which is capped at a hundred thousand of them.

				   Uncapped, the two are the same set by construction and the
				   list is simply the names behind the number. Capped, the walk
				   saw a subset — eleven names under a gauge reading seventeen.

				   Carried anyway: reconciledList hands back whatever the walk
				   found, and the drawer reads "at least 11 of 17" rather than
				   claiming the eleven are all of them. The gauge keeps the
				   exact figure either way; what varies is whether the drawer
				   can say COMPLETE or only AT LEAST. */
				row["extra"] = v
				if list := reconciledList(extraListFromRows[strFromAny(r["label"])], v); list != nil {
					row["extraDomains"] = list
				}
			} else if v, ok := extraFromRows[strFromAny(r["label"])]; ok {
				/* No service answer, so the walk supplies both — and here they
				   are the same set by definition: the count is len() of the list
				   (see setsPerGroup). Nothing to reconcile. */
				row["extra"] = v
				if list := reconciledList(extraListFromRows[strFromAny(r["label"])], v); list != nil {
					row["extraDomains"] = list
				}
			} else if extraKey != "" {
				row["extra"] = numOf(r[extraKey])
			}
			out = append(out, row)
		}
		/* Table names into store names, label only — see nameAppSourceRows. */
		if d.Key == dimAppSource {
			out = nameAppSourceRows(out)
		}
		/* A CAVEAT THE DRAWERS MAKE NECESSARY.

		   The row walk has always been capped, and every drawer on this panel is
		   built from it. The gauge stays exact regardless — it is the service's
		   own COUNT(DISTINCT) — but a drawer opened from a capped walk can be
		   showing a LOWER BOUND rather than the whole list, and a reader
		   comparing two providers needs to know that before treating "11" as
		   "all of them".

		   Raised only where this panel has domain lists at all. Every other panel
		   the walk feeds is untouched. */
		if extraRowsCapped && len(extraListFromRows) > 0 {
			notice("%s was counted over the first %d rows of this window, so a "+
				"provider's domain list here can be a lower bound rather than the "+
				"whole of what it carries.", d.Label, extraRowsScanned)
		}

		// Where the dataset carries no name beside the id — or carries the column
		// and leaves it null — the names come from the master. See dimMaster.
		apiNameRows(out, lookupForDim(d), strings.TrimSpace(q["clientId"]))
		/* And per group, so a panel's orange bars mean the same thing as the
		   tile above them. Matched on `value` — the raw grouping value the
		   service returned — because the label may have been resolved from a
		   master since.

		   ONLY where the panel has a removed series at all. A panel counting an
		   ACTION does not: `removedKey` was emptied above precisely because a
		   notice, or a de-indexing submission, has no removal figure of its own
		   — what became of the URLs it covered is a different panel. Without
		   this guard both branches below reached in and filled one anyway, off
		   the URLs grouped under the same provider, and the card grew a second
		   series measuring something its own title does not name. Its bars would
		   have read "1,713 submissions, 257,956 removed", which is not a ratio
		   of anything. */
		switch {
		case removedKey == "":
			// Nothing to fill. Named as a case rather than an early return so the
			// two branches below keep reading as the pair they are.
		case aggRemovals:
			/* The same grouping, scoped to what came down. One extra call per
			   panel, run inside the same bounded pool as the panel itself —
			   which is cheaper than it looks beside the alternative of paging
			   the window to derive it. */
			if deadRows, err := c.Breakdown(ctx, ds, deadScope, key, limit); err == nil {
				tally := make(map[string]int64, len(deadRows))
				for _, r := range deadRows {
					tally[groupValue(r["grp"])] = numOf(r[identKey])
				}
				for _, r := range out {
					r["removed"] = tally[groupValue(r["value"])]
				}
			}
		case haveRowMx:
			if col := ds.ColumnForDim(key); col != "" {
				if tally, ok := rowMx.removedByCol[col]; ok {
					for _, r := range out {
						r["removed"] = tally[groupValue(r["value"])]
					}
				}
			}
		}
		/* A turnaround panel is an ORDERED ramp, and the aggregate returns rows
		   by volume. Sorted by the duration each label names — see
		   tatbuckets.go — so the sequence the shading asserts is the sequence
		   the labels read. */
		if d.Key == dimTAT {
			/* This panel got here on the stored TATBucket column, which means
			   the table carries no timestamp pair — see the note above. Whatever
			   spellings that column holds are folded into the same five bands
			   the measured tables use, so the summary can add two platforms
			   together and a reader moving between them is reading one scale.

			   The fold declines only for an EMPTY breakdown, where there is
			   nothing to band and the panel says so. A breakdown holding
			   nothing but "Pending" — which is what the source-URL table's
			   column holds for a live window — comes back as five empty bands
			   rather than as a Pending row, which is what put the last one on
			   the page. */
			if folded := foldTATRows(out); folded != nil {
				return folded
			}
		}
		return out
	}

	/* ── The panels, concurrently ─────────────────────────────────────────
	   Each panel is one query that depends on nothing but the scope, yet they
	   ran strictly in turn. Measured on this warehouse: thirteen panels over
	   two tables is thirty sequential 600ms calls — and a DRILL-DOWN pays all
	   of it on every click, because a filtered scope is not cacheable. That is
	   how one click came to cost between eighteen and a hundred and eight
	   seconds.

	   Bounded, not unbounded. Thirty concurrent aggregates would move the queue
	   out of this process and into the warehouse, which is shared with every
	   live page; eight makes the report fast without making the database the
	   new bottleneck.

	   Results land in a slice indexed by dimension and are folded into the map
	   afterwards, so the panels keep the order the registry declares rather
	   than the order the queries happened to finish in. */
	const panelConcurrency = 8
	gate := make(chan struct{}, panelConcurrency)
	built := make([][]map[string]any, len(s.Dimensions))
	var panelWG sync.WaitGroup

	for i, d := range s.Dimensions {
		// A synthetic panel has no grouping column; the caller assembles it.
		if d.Column == "" {
			continue
		}
		panelWG.Add(1)
		go func(i int, d dimension) {
			defer panelWG.Done()
			gate <- struct{}{}
			defer func() { <-gate }()
			built[i] = buildPanel(d)
		}(i, d)
	}
	panelWG.Wait()

	/* ── How many PIRATE BRANDS this side is carrying ────────────────────────

	   A brand is a site and all its mirrors counted once — livetv.sx,
	   livetv901.me and cdn.livetv872.me are one operator — and the fold that
	   decides it is domainRootBrand, which lives in this codebase rather than in
	   the warehouse because it knows about multi-label suffixes that SQL string
	   surgery does not.

	   FREE, which is why it is computed here and nowhere else. domainRows
	   fetches EVERY domain group for the three derived panels — not a top-N,
	   deliberately, since a brand total folded from a truncated hostname list is
	   short by whatever was cut and nothing about the number says so — and caches
	   it per column for the request. AFTER panelWG.Wait() so that on a report
	   drawing those panels this is a map read rather than a second fetch; on one
	   that draws none, it is the only caller and pays once.

	   Guarded on the spec having a domain column at all: a table with no
	   hostname has no brands, and a zero would read as "no pirates" rather than
	   "this side does not record them".

	   Role-pinned through s.DomainCol, so the host half counts host brands and
	   the linking half counts linking ones — the two figures the report shows
	   side by side, and the pair that would silently become one number if this
	   asked the table for whichever domain column it happened to have. */
	if s.DomainCol != "" {
		if rows, ok := domainRows(s.DomainCol); ok {
			kpi["brands"] = int64(len(foldDomainRows(rows, domainRootBrand)))
		}
	}

	for i, rows := range built {
		if rows != nil {
			breakdowns[s.Dimensions[i].Key] = rows
		}
	}

	out := map[string]any{
		"ok": true, "available": true, "type": s.Key, "label": s.Label,
		"kpi": kpi, "daily": daily, "breakdowns": breakdowns,
		"table": s.Table, "role": s.Role, "roleLabel": s.RoleLabel,
	}
	if len(notices) > 0 {
		out["notices"] = notices
	}
	if failed > 0 {
		out["queryWarning"] = fmt.Sprintf("%d of this report's requests to reports_api failed for %s: %s",
			failed, s.Table, firstErr)
	}
	return out
}

/*
scanRows pages the raw rows the row-level figures are computed from.

The only place in the report engine that reads rows rather than aggregates, and
it is bounded twice over: the service's own page maximum, and a total cap here.

The cap is not a sample. Rows come back in the service's sort order, so the
first N is the OLDEST N — a biased slice, not a representative one. When it
bites, the panel says how many rows it covered rather than presenting a partial
distribution as the whole. A client's busiest month on this warehouse is about
4,250 rows, so one page usually answers it and the cap is a guard against the
outlier, not a working limit.
*/
func scanRows(ctx context.Context, c *reportsapi.Client, ds reportsapi.Dataset, scope url.Values) ([]map[string]any, bool, error) {
	// Twenty pages of five thousand. Past this the panel is describing more rows
	// than anyone reads a distribution over, and the paging costs more than the
	// rest of the report put together.
	const maxRows = 100000

	var (
		out    []map[string]any
		cursor string
	)
	for {
		page, next, more, err := c.Rows(ctx, ds, scope, reportsapi.RowPageMax, cursor)
		if err != nil {
			// A first page that fails has nothing to show; a later one has a
			// partial answer, and partial is worse than the stored column here.
			return nil, false, err
		}
		out = append(out, page...)
		if !more || next == "" || len(page) == 0 {
			return out, false, nil
		}
		if len(out) >= maxRows {
			return out, true, nil
		}
		cursor = next
	}
}

/*
mergeSpecOptionsViaAPI lists each slicer's values across a set of tables.

A slicer value is just a breakdown with its measures ignored, so this is the
same call the panels make. Which is the point: the values a slicer offers and
the rows a panel shows come from one query shape, and a value that appears in
one cannot be missing from the other.
*/
func mergeSpecOptionsViaAPI(specs []reportSpec, clientID string, q map[string]string) map[string]any {
	c := reportsapi.Get()
	ctx := context.Background()

	/* Keyed by the PARAMETER, exactly as optionsForSpec does it — the page reads
	   `options[param]` for each of the spec's filters, so a pluralised or
	   prettified key here is a slicer that renders empty with nothing to
	   explain why.

	   Each parameter maps its VALUE to the NAME shown for it. Both, not one:
	   what a slicer sends has to be what the filter compares against — an id,
	   wherever reports_api groups by one — while what it shows has to be
	   something a person can pick. Sending the name would filter an id column by
	   a title and return nothing, with no error to say so; showing the id gives
	   a dropdown of GUIDs, which is what the Asset slicer was before it stopped
	   being populated at all. */
	flat := map[string]map[string]*slicerValue{}
	// Which lookup, if any, resolves a parameter's ids — recorded as the specs
	// are walked so the master is consulted once per parameter rather than once
	// per table.
	lookupFor := map[string]string{}

	/* One unit of work: list one parameter's values off one table.

	   Collected first and run afterwards, because each is an HTTP round trip and
	   a summary is five platforms' worth of them. Run one after another they add
	   up to longer than the report itself — and this now runs on every change to
	   the window or a slicer, not once when the client is picked. */
	type job struct {
		spec  reportSpec
		ds    reportsapi.Dataset
		param string
		dim   string
	}
	jobs := []job{}

	for _, s := range specs {
		ds, ok := c.ByTable(ctx, s.Table)
		if !ok {
			continue
		}

		// The lookup a dimension declares, by the parameter it filters. Read off
		// the spec's own dimensions, which is where inferSpec resolved it.
		/* Through lookupForDim, not d.LookupTable, so a slicer gets the same
		   naming the PANEL gets. byAssetName declares no lookup — the table has
		   an AssetName column, so nothing should need one — but on
		   Agg_Daily_Telegram_Sports_Raw that column is null on every row, and
		   without the fallback the Asset slicer lists unnamed ids while the
		   panel beside it shows titles. */
		for _, d := range s.Dimensions {
			lk := lookupForDim(d)
			if lk == "" {
				continue
			}
			if p := DIMFilterParam(d.Key); p != "" && lookupFor[p] == "" {
				lookupFor[p] = lk
			}
		}

		for param, col := range s.Filters {
			// A slicer whose values are never listed is never fetched — see
			// unlistedFilterParams. This is one full breakdown per table per
			// change to the window, and on an account-URL column it is every
			// channel and profile the client has, for a dropdown that is not
			// drawn.
			if unlistedFilterParams[param] {
				continue
			}
			if key, ok := ds.DimByColumn(col); ok {
				jobs = append(jobs, job{spec: s, ds: ds, param: param, dim: key})
			}
		}
	}

	results := make([][]map[string]any, len(jobs))
	// Whether the service cut this list short. It decides whether a COUNT can be
	// published at all — see below.
	cut := make([]bool, len(jobs))
	var wg sync.WaitGroup
	gate := make(chan struct{}, optionsConcurrency)
	for i, j := range jobs {
		wg.Add(1)
		go func(i int, j job) {
			defer wg.Done()
			gate <- struct{}{}
			defer func() { <-gate }()

			/* Scoped exactly as the REPORT is — same window, same other slicers
			   — minus this parameter's own value. That is what makes the list
			   honest: a language with no rows in the chosen month is not a
			   language you can usefully pick, and offering it means picking it
			   and getting an empty report with nothing to say why.

			   Its own value is left out so the list does not collapse to the one
			   value already chosen. */
			scope := apiScope(j.spec, j.ds, q, j.param)
			scope.Set("ClientId", clientID)

			/* Every value, so the slicer is the whole list and each count is
			   the whole count. At the old ceiling of 200 a slicer silently
			   became "the 200 commonest values", which reads exactly like a
			   complete list and is not one.

			   The fallback is for a service that still caps at 200 and refuses
			   more: a slicer holding the commonest 200 beats a slicer holding
			   nothing. */
			rows, truncated, err := c.BreakdownFull(ctx, j.ds, scope, j.dim, reportsapi.BreakdownAll)
			if err != nil {
				rows, truncated, err = c.BreakdownFull(ctx, j.ds, scope, j.dim, maxAPIBreakdownRows)
			}
			if err != nil {
				return
			}
			results[i] = rows
			cut[i] = truncated
		}(i, j)
	}
	wg.Wait()

	/* A count may only be published when the list it was counted from was
	   COMPLETE.

	   Against a service that still caps a breakdown at 200, an asset ranked 201st
	   is absent from the result and would be given the master's default of zero —
	   a confident "nothing here" over real data, which is the exact failure this
	   whole slicer has been fixed for twice. So a truncated list publishes names
	   only, and the dropdown shows no number rather than a wrong one. */
	partial := map[string]bool{}
	for i := range results {
		if cut[i] {
			partial[jobs[i].param] = true
		}
	}

	for i, rows := range results {
		param := jobs[i].param
		for _, r := range rows {
			val := strFromAny(r["grp"])
			if val == "" || val == noneLabel {
				continue
			}
			if flat[param] == nil {
				flat[param] = map[string]*slicerValue{}
			}
			v := flat[param][val]
			if v == nil {
				v = &slicerValue{}
				flat[param][val] = v
			}
			// First spec to name a value keeps the name. Two tables spelling
			// the same id differently is not a case worth arbitrating here,
			// and the alternative — last writer wins — is the same guess
			// made less predictably.
			if v.name == "" {
				v.name = strFromAny(r["label"])
			}
			/* Counts ADD across the platform's tables, because that is what the
			   report does: Open Web reads a linking table and a hosting one, and
			   an asset's figure on the page is the sum of both. A slicer that
			   showed one of them would disagree with the page it filters. */
			v.count += numOf(r["identified"])
		}
	}

	/* ── A sports report may only offer sports titles ─────────────────────────

	   Applied to the merged list rather than per table, because that is where
	   the Asset slicer actually is: a platform reading several tables offers the
	   union of what they found, and narrowing one table's contribution would
	   leave the others' films in the dropdown.

	   Before the naming pass below, so the master is not asked to name a title
	   that is about to be dropped. */
	narrowSportsAssetOptions(ctx, specs, clientID, flat)

	/* The names the datasets could not supply. A table that records only an id
	   labels every row with that id, so without this the slicer lists GUIDs —
	   which is the state the reader described as "no details". */
	for param, vals := range flat {
		lookup := lookupFor[param]
		if lookup == "" {
			continue
		}
		needs := false
		for id, v := range vals {
			if v.name == "" || v.name == id {
				needs = true
				break
			}
		}
		if !needs {
			continue
		}
		key, ok := apiMasterKeyFor(lookup)
		if !ok {
			continue
		}
		names, err := reportsapi.Get().MasterNames(ctx, key, clientID)
		if err != nil {
			continue
		}
		for id, v := range vals {
			if v.name != "" && v.name != id {
				continue
			}
			if n := names[strings.ToLower(id)]; n != "" {
				v.name = n
			}
		}
	}

	/* ── EVERY SLICER IS THE TABLE'S OWN VALUES ───────────────────────────────

	   The list a filter offers is exactly what the breakdowns above found, and
	   nothing is added to it from a master.

	   It was, briefly. The Asset slicer was filled from mediascan.Asset — all
	   1,572 titles a client has ever had — because a breakdown was capped at 200
	   groups and the fixture somebody was looking for fell outside the busiest
	   200: real data on the report with no way to filter to it. The master made
	   it findable and cost something worse, a dropdown of a thousand titles that
	   are not in this report and empty the page when picked.

	   The cap was the actual bug. With `limit=all` a breakdown returns every
	   distinct value the table holds in scope, so the table's own list is now
	   the complete one — and it is the RIGHT one, because a filter should offer
	   what the report can show and nothing else.

	   The master is still used, for the one thing it is authoritative about:
	   NAMING an id the fact table records without a readable name beside it.
	   Agg_Daily_Telegram_Sports_Raw carries AssetId on every row and AssetName
	   on none, so its assets are named from the master and its LIST is still its
	   own. Detail from the master, membership from the table. */

	out := map[string]any{"ok": true, "available": true}

	/* The client list comes from its own endpoint, not from the breakdowns.

	   A breakdown is already scoped to one client, so building the list from one
	   could only ever return the client that had already been chosen — which is
	   a picker containing exactly the thing you were trying to change, and an
	   empty one before any choice has been made. That is what "Select client →
	   Nothing matches" was. */
	/* ACTIVE COMPANIES ONLY, from the client master.

	   This used to read /v1/sports/clients, which is derived from FACT ROWS: it
	   answers "which client ids appear in the sports tables", so it carries every
	   company the warehouse has ever held rows for, retired or not. That is 164
	   against the master's 92 — seventy-two companies nobody maintains, offered
	   in a picker as though a report could be run for them.

	   WarehouseClientDirectory is the list that already exists for exactly this
	   question and is what the client-mapping screen chooses from. Using it here
	   means the two pickers in the product cannot disagree about which companies
	   are real. */
	if dir := WarehouseClientDirectory(ctx); len(dir) > 0 {
		list := make([]map[string]any, 0, len(dir))
		for id, name := range dir {
			list = append(list, map[string]any{"id": id, "name": name})
		}
		sort.Slice(list, func(i, j int) bool {
			a, b := strFromAny(list[i]["name"]), strFromAny(list[j]["name"])
			if a == b {
				return strFromAny(list[i]["id"]) < strFromAny(list[j]["id"])
			}
			return a < b
		})
		out["clients"] = list
	} else if list, err := c.Clients(ctx); err == nil {
		/* The master could not be read. Falling back to the fact-derived list
		   offers too much, which is still better than a picker with nothing in
		   it — an empty client slicer is indistinguishable from a broken screen,
		   and this is the moment somebody is looking at it. */
		out["clients"] = list
	} else {
		/* Fall back to the client in hand rather than to nothing: a staff
		   picker is unusable either way, but a CLIENT login already has its
		   company forced by the server and only needs the name to render. */
		clients := []map[string]any{}
		if clientID != "" {
			clients = append(clients, map[string]any{"id": clientID, "name": clientID})
		}
		out["clients"] = clients
		out["clientsError"] = err.Error()
	}

	/* Emitted as id/name pairs, in name order — the shape the page's `asOpts`
	   already reads for the client picker, so the dropdown shows the title and
	   sends the id with no change on that side. Sorted by the NAME, because that
	   is the column being read; sorting by an id would order a list of titles
	   arbitrarily. */
	unresolved := map[string]int{}
	for param, set := range flat {
		pairs := make([]map[string]any, 0, len(set))
		for id, v := range set {
			name := v.name
			/* NAMES ONLY. A value that is still its own id after the master
			   lookup is a dangling reference — an id the fact table records and
			   the lookup table does not have — and it is dropped rather than
			   shown.

			   Dropped, not labelled "Unknown": a slicer exists to be picked
			   from, and a GUID cannot be. Two of them sat between "Bot" and
			   "Clip Pirate Content" in the Infringement Type list, which is
			   also how one slicer came to hold both kinds of value at once.

			   Only where it LOOKS like an id, though. Plenty of dimensions are
			   their own label — "Pending", "0-6 hours", "HDRip" — and those are
			   unresolvable by definition and perfectly pickable. */
			if (name == "" || name == id) && looksLikeID(id) {
				unresolved[param]++
				continue
			}
			if name == "" {
				name = id
			}
			pair := map[string]any{"id": id, "name": name}
			if !partial[param] {
				pair["count"] = v.count
			}
			pairs = append(pairs, pair)
		}
		/* WHAT HAS DATA COMES FIRST, biggest first; everything else follows in
		   name order.

		   Alphabetical across the whole list buries the handful of assets a
		   reader is actually looking at under a thousand fixtures with nothing
		   in this window — the top of the Asset dropdown was four 2024 football
		   matches carrying no rows at all. Ranking by volume puts the report's
		   own subject at the top, and the zero-count tail stays alphabetical so
		   it can still be scanned for a specific title. */
		sort.Slice(pairs, func(i, j int) bool {
			// With no counts to rank by this falls straight through to the name,
			// which is the order the list had before counts existed.
			ci, cj := numOf(pairs[i]["count"]), numOf(pairs[j]["count"])
			if (ci > 0) != (cj > 0) {
				return ci > 0
			}
			if ci != cj && ci > 0 {
				return ci > cj
			}
			a, b := strFromAny(pairs[i]["name"]), strFromAny(pairs[j]["name"])
			if a == b {
				return strFromAny(pairs[i]["id"]) < strFromAny(pairs[j]["id"])
			}
			return a < b
		})
		out[param] = pairs
	}

	/* Reported rather than dropped silently. A slicer that is quietly two
	   values shorter than the data is the kind of thing nobody notices until a
	   total does not add up, so the count travels with the response and the
	   server says which lookup is incomplete. */
	if len(unresolved) > 0 {
		out["unresolvedOptions"] = unresolved
		for param, n := range unresolved {
			log.Printf("[reports] slicer %q: %d value(s) had no name in %s and were left out",
				param, n, lookupFor[param])
		}
	}
	return out
}

/*
looksLikeID answers whether a value is a machine identifier rather than a label.

Deliberately narrow. Anything it wrongly calls an id disappears from a slicer,
so it matches only the two shapes this warehouse actually uses — a GUID and a
32-character hex hash — and treats everything else as a name. "0-6 hours" and
"HDRip" are not ids and must survive.
*/
func looksLikeID(s string) bool {
	s = strings.TrimSpace(s)
	switch len(s) {
	case 36:
		// 8-4-4-4-12, the shape every id in this warehouse takes.
		for i, ch := range s {
			switch i {
			case 8, 13, 18, 23:
				if ch != '-' {
					return false
				}
			default:
				if !isHex(byte(ch)) {
					return false
				}
			}
		}
		return true
	case 32:
		for i := 0; i < len(s); i++ {
			if !isHex(s[i]) {
				return false
			}
		}
		return true
	}
	return false
}

func isHex(c byte) bool {
	return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
}
