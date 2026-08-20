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
	"channelsSuspended":   {"channelsSuspended"},
	"views":               {"views"},
	"viewsSaved":          {"viewsSaved"},
	"impactedSubscribers": {"subscribers"},
	"likes":               {"likes"},
	"comments":            {"comments"},
	"crawled":             {"crawled"},
	"notices":             {"noticesSent", "enforcements"},
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
	return shape
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

	var (
		deadSum map[string]any
		deadTS  []map[string]any
	)
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
	if wantRows {
		phase1.Add(1)
		go func() { defer phase1.Done(); allRows() }()
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
				notice("Profile figures were counted over the first %d rows of this window.", len(rows))
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
			daily = append(daily, row)
		}
	}

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
		for _, r := range raw {
			hostRows = append(hostRows, map[string]any{
				"label":   strFromAny(r["label"]),
				"value":   strFromAny(r["grp"]),
				"urls":    numOf(r["identified"]),
				"removed": numOf(r["removed"]),
			})
		}
		hostCache[col] = hostRows
		return hostRows, true
	}

	/*
	   buildPanel produces ONE breakdown and RETURNS it, rather than writing it
	   into the shared map — which is what makes it safe to run several at once.
	*/
	buildPanel := func(d dimension) []map[string]any {

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
		rows, err := c.Breakdown(ctx, ds, scope, key, limit)
		if err != nil {
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
			out = append(out, row)
		}
		// Where the dataset carries no name beside the id — or carries the column
		// and leaves it null — the names come from the master. See dimMaster.
		apiNameRows(out, lookupForDim(d), strings.TrimSpace(q["clientId"]))
		/* And per group, so a panel's orange bars mean the same thing as the
		   tile above them. Matched on `value` — the raw grouping value the
		   service returned — because the label may have been resolved from a
		   master since. */
		switch {
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
			sortTATRows(out)
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
