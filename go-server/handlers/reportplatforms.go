package handlers

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strings"
	"sync"

	"github.com/ip-house/iphouse-api/db"
)

// Platforms as data: a platform is a name plus the warehouse tables it reads.
//
// This replaces the earlier "one built-in spec you may override column by
// column" model. Two reasons:
//
//   - A platform's data often lives in more than one table (an infringing-URL
//     table and a source-URL table; a raw table and its daily rollup), so the
//     one-table-per-report assumption was wrong.
//   - Asking an admin for the client column, the date column and two SQL measure
//     expressions per table is asking them to know the warehouse's shape. Those
//     are DERIVED here instead, by reading information_schema and matching
//     against the naming this warehouse already uses.
//
// So the configuration surface is just: platform name, and which tables it uses.
// Everything else is inferred, and what was inferred is reported back so it can
// be checked.

const (
	platformTable      = "report_platform"
	platformTableTable = "report_platform_table"
)

var platformSchemaOnce sync.Once

func ensurePlatformSchema() {
	platformSchemaOnce.Do(func() {
		if _, _, err := db.Exec(`
			CREATE TABLE IF NOT EXISTS ` + platformTable + ` (
			  platform_key VARCHAR(64)  NOT NULL PRIMARY KEY,
			  label        VARCHAR(191) NOT NULL,
			  sort_order   INT          NOT NULL DEFAULT 100,
			  is_enabled   TINYINT(1)   NOT NULL DEFAULT 1,
			  updated_by   VARCHAR(191) NOT NULL DEFAULT '',
			  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`); err != nil {
			log.Printf("[platforms] create %s: %v", platformTable, err)
			return
		}
		if _, _, err := db.Exec(`
			CREATE TABLE IF NOT EXISTS ` + platformTableTable + ` (
			  platform_key VARCHAR(64)  NOT NULL,
			  table_name   VARCHAR(191) NOT NULL,
			  sort_order   INT          NOT NULL DEFAULT 100,
			  PRIMARY KEY (platform_key, table_name)
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`); err != nil {
			log.Printf("[platforms] create %s: %v", platformTableTable, err)
			return
		}
		seedPlatformsFromRegistry()
		adoptSourceURLIntoOpenWeb()
	})
}

/*
adoptSourceURLIntoOpenWeb folds the host-URL table into the Open Web platform on
an install that was seeded when the two were separate reports.

They were separate because the original registry had one table per platform.
That was the wrong cut: Open Web enforcement is two halves of one report — the
pages that LINK to infringing content and the ones that HOST it — and the report
puts their trends and their top-tens side by side. Split across two sidebar
entries, that comparison cannot be made at all.

Guarded on `updated_by = 'seed'`, so this only touches a platform nobody has
edited: an admin who deliberately keeps them apart keeps them apart. Nothing is
deleted — Source URLs is disabled, not dropped, so re-enabling it in Report
Configuration undoes this entirely.
*/
func adoptSourceURLIntoOpenWeb() {
	const from, to = "source-url", "open-web"

	row, err := db.QueryOne(
		"SELECT updated_by, is_enabled FROM "+platformTable+" WHERE platform_key = ? LIMIT 1", from)
	if err != nil || row == nil {
		return
	}
	if strFromAny(row["updated_by"]) != "seed" || numOf(row["is_enabled"]) != 1 {
		return // edited or already disabled — leave it alone
	}
	if dst, err := db.QueryOne(
		"SELECT platform_key FROM "+platformTable+" WHERE platform_key = ? LIMIT 1", to); err != nil || dst == nil {
		return
	}

	tables, err := db.Query(
		"SELECT table_name FROM "+platformTableTable+" WHERE platform_key = ? ORDER BY sort_order", from)
	if err != nil || len(tables) == 0 {
		return
	}
	for i, t := range tables {
		if _, _, err := db.Exec(
			"INSERT IGNORE INTO "+platformTableTable+" (platform_key, table_name, sort_order) VALUES (?, ?, ?)",
			to, strFromAny(t["table_name"]), 100+(i+1)*10); err != nil {
			log.Printf("[platforms] adopt %s into %s: %v", strFromAny(t["table_name"]), to, err)
			return
		}
	}
	if _, _, err := db.Exec(
		"UPDATE "+platformTable+" SET is_enabled = 0, updated_by = 'merged-into-open-web' WHERE platform_key = ?",
		from); err != nil {
		log.Printf("[platforms] disable %s: %v", from, err)
		return
	}
	log.Printf("[platforms] %s now reads %d table(s) from %s; %s disabled — re-enable it in Report Configuration to undo",
		to, len(tables), from, from)
}

// seedPlatformsFromRegistry writes the built-in registry into the tables the
// first time this runs, so an existing install keeps the platforms it had and an
// admin has something to edit rather than an empty page.
func seedPlatformsFromRegistry() {
	row, err := db.QueryOne("SELECT COUNT(*) AS c FROM " + platformTable)
	if err != nil || (row != nil && numOf(row["c"]) > 0) {
		return
	}
	for i, key := range reportSpecOrder {
		s, ok := specFor(key)
		if !ok {
			continue
		}
		if _, _, err := db.Exec(
			"INSERT IGNORE INTO "+platformTable+" (platform_key, label, sort_order, updated_by) VALUES (?, ?, ?, 'seed')",
			key, s.Label, (i+1)*10); err != nil {
			log.Printf("[platforms] seed %s: %v", key, err)
			continue
		}
		for j, t := range append([]string{s.Table}, s.ExtraTables...) {
			db.Exec("INSERT IGNORE INTO "+platformTableTable+" (platform_key, table_name, sort_order) VALUES (?, ?, ?)",
				key, t, (j+1)*10)
		}
	}
	log.Printf("[platforms] seeded %d platform(s) from the built-in registry", len(reportSpecOrder))
}

/* ── Column inference ─────────────────────────────────────────────────────── */

// Candidate names, most specific first. Inference picks the first that the table
// actually has, which is why these are ordered rather than sets.
var (
	clientColCandidates = []string{"ClientId", "ClientMasterId", "ClientID", "Client_Id", "ClientKey"}
	dateColCandidates   = []string{"URLUploadDate", "UploadDate", "DiscoveryDate", "ReportDate", "CreatedAt", "Date"}
	assetColCandidates  = []string{"AssetId", "AssetID", "Asset_Id"}
	clientNameCands     = []string{"ClientName", "CompanyName"}
	assetNameCands      = []string{"AssetName"}

	// Measure pairs: if the first column exists, the table is pre-aggregated and
	// these are the sums to use. Order matters — a table carrying several of
	// these is read with the most specific pair.
	measurePairs = [][2]string{
		{"TotalInfringements", "TotalRemoved"},
		{"IdentifiedCount", "RemovedCount"},
		{"TotalCount", "RemovedCount"},
	}

	// Dimensions worth offering, when present. `Viz` is how the page should draw
	// it — a handful of shapes rather than ten identical bar lists. The lookup
	// columns turn an id column into a readable label: grouping by AssetId alone
	// shows GUIDs, which is no use to anyone reading a report.
	dimensionCandidates = []struct {
		Key, Column, Label, Viz string
		// Other spellings of the same column. The warehouse is not consistent
		// about it — genre is `GenreName` on the social table and plain `Genre` on
		// the Telegram one, and both mean the same panel — so a candidate names
		// the column it prefers and the ones it will accept instead.
		Alts                        []string
		LookupTable, LookupID, Name string
		// Ident/Removed override the section's own measures for this panel alone;
		// Needs is a second column the panel requires beyond the grouping one.
		Ident, Removed, Needs string
	}{
		// ORDER IS THE READING ORDER of the panels on the page — where in the
		// world, against which titles, on which sites, delivered how, found by
		// what. It follows the report these pages replace, so someone who knows
		// the PowerBI sheet finds the same cards in the same sequence.
		{Key: "byCountry", Column: "CountryName", Alts: []string{"Country"},
			Label: "Infringements Breakdown - Country", Viz: "map"},
		/* NAME BEFORE ID, always.
		   Several warehouse tables carry both — SocialMedia_Sports_Raw has
		   AssetId and AssetName, GenreId and GenreName, and so on. When the name
		   is on the row there is nothing to look up: grouping by it is one query
		   instead of a join, it cannot fail because a lookup table is spelled
		   differently or out of reach, and the slicer lists titles rather than
		   GUIDs. The id form below is the fallback for tables that only have the
		   id. Both are declared; inferSpec takes the first that the table has. */
		// Horizontal, because asset titles are long: a column chart has to angle
		// and truncate the very label being read.
		{Key: "byAssetName", Column: "AssetName", Label: "Identification & Removal - Top 10 Assets", Viz: "hbar"},
		{Key: "byAsset", Column: "AssetId", Label: "Identification & Removal - Top 10 Assets", Viz: "hbar",
			LookupTable: "mediascan.Asset", LookupID: "Id", Name: "AssetName"},
		// "Linking" and "Host" rather than "Infringing" and "Source": a platform
		// that reads both tables shows both panels, and the pair only makes sense
		// named for what each side of the enforcement actually is.
		{Key: "byDomain", Column: "InfringingDomain", Label: "Top 10 Linking Websites", Viz: "hbar"},
		{Key: "byDomainSource", Column: "SourceDomain", Label: "Top 10 Host Websites", Viz: "hbar"},
		{Key: "byPlatform", Column: "Platform", Label: "Platforms", Viz: "donut"},
		{Key: "byChannel", Column: "ChannelName", Alts: []string{"ChannelOrProfileName"},
			Label: "Top 10 Channels", Viz: "hbar"},
		// How the infringing copy reaches the viewer — downloadable, streaming,
		// torrent. One measure, so single-series bars rather than a grouped pair.
		{Key: "byDeliveryType", Column: "DeliveryType", Label: "Delivery Type", Viz: "value"},
		{Key: "bySearchEngine", Column: "SearchEngineName", Alts: []string{"SearchEngine"},
			Label: "Search Engine", Viz: "stacked"},
		// The same grouping counted differently: how many enforcement notices
		// went to each engine, rather than how many URLs each turned up. Two
		// panels, because they are two numbers — a few hundred notices covering a
		// few million links.
		{Key: "bySearchEngineNotices", Column: "SearchEngineName", Viz: "value",
			Label: "Search Engine - Enforcement Notification",
			Ident: "SUM(NoticeCount)", Removed: "0", Needs: "NoticeCount"},
		// The search terms the infringing pages were found under. A long tail cut
		// to ten; the full list is behind the panel's table view.
		{Key: "byKeyword", Column: "Keyword", Alts: []string{"KeywordName"},
			Label: "Top 10 Keywords", Viz: "hbar"},
		// Columns: a handful of languages carrying wildly different volumes, where
		// the pair of bars per language is the comparison being made.
		{Key: "byLanguage", Column: "LanguageName", Alts: []string{"Language", "AudioLanguage"},
			Label: "Language - Identification & Removal", Viz: "column"},
		{Key: "byLanguageId", Column: "LanguageId", Label: "Language - Identification & Removal", Viz: "column",
			LookupTable: "mediascan.Language", LookupID: "Id", Name: "Name"},
		{Key: "byGenre", Column: "GenreName", Alts: []string{"Genre"}, Label: "Genre", Viz: "column"},
		{Key: "byGenreId", Column: "GenreId", Label: "Genre", Viz: "column",
			LookupTable: "mediascan.Genre", LookupID: "Id", Name: "Name"},
		// One quality accounts for nearly everything, which a donut renders as a
		// single ring and no information. A ranked list with the numbers beside it
		// survives that skew.
		{Key: "byQuality", Column: "QualityOfPrint", Alts: []string{"QualityOfPrintName"},
			Label: "Print Quality", Viz: "bars"},
		{Key: "byQualityId", Column: "QualityOfPrintId", Label: "Print Quality", Viz: "bars",
			LookupTable: "mediascan.QualityOfPrint", LookupID: "Id", Name: "Name"},
		{Key: "byInfringementType", Column: "InfringementTypeName", Alts: []string{"InfringementType"},
			Label: "Nature of Infringements", Viz: "bars"},
		{Key: "byInfringementTypeId", Column: "InfringementTypeId", Label: "Nature of Infringements", Viz: "bars",
			LookupTable: "mediascan.InfringmentType", LookupID: "Id", Name: "Name"},
		{Key: "byGroupType", Column: "GroupType", Label: "Group Type", Viz: "bars"},
		// Turnaround buckets are ordered and every row in one has, by
		// definition, already been removed — so "removed vs still live" says
		// nothing here. What the reader wants is the share that landed in each
		// bucket, on a ramp that shows the ordering.
		{Key: "byTAT", Column: "TATBucket", Label: "Turnaround", Viz: "share"},
	}

	// Extra KPIs, when the column is there.
	// FIRST MATCH WINS per key — the loop that reads these skips a key it has
	// already filled, so the more specific column is declared first.
	extraKPICandidates = []struct{ Key, Expr, NeedsCol string }{
		{"views", "SUM(TotalViews)", "TotalViews"},
		{"views", "SUM(Views)", "Views"},
		{"viewsSaved", "SUM(ViewsSaved)", "ViewsSaved"},
		{"impactedSubscribers", "SUM(Subscribers)", "Subscribers"},
		{"likes", "SUM(TotalLikes)", "TotalLikes"},
		{"crawled", "SUM(CrawledCount)", "CrawledCount"},
		{"notices", "SUM(NoticeCount)", "NoticeCount"},
		{"googleDelisted", "COUNT(CASE WHEN IsGoogleDelisted=1 THEN 1 END)", "IsGoogleDelisted"},
		{"bingDelisted", "COUNT(CASE WHEN IsBingDelisted=1 THEN 1 END)", "IsBingDelisted"},
		// The audience the infringing pages were reaching — the Open Web
		// equivalent of a channel's subscribers.
		{"impactedTraffic", "SUM(ImpactedTraffic)", "ImpactedTraffic"},
		{"impactedTraffic", "SUM(Traffic)", "Traffic"},
		{"impactedTraffic", "SUM(MonthlyVisits)", "MonthlyVisits"},
	}

	// Sites taken offline entirely, as opposed to individual URLs removed. The
	// warehouse spells this differently per table, so the first form that exists
	// wins — `flag` is the column, `expr` is a %s-template for the domain column
	// it counts distinct values of.
	suspendedSiteForms = []struct{ Flag, Expr string }{
		{"IsWebsiteSuspended", "COUNT(DISTINCT CASE WHEN IsWebsiteSuspended=1 THEN %s END)"},
		{"IsSuspended", "COUNT(DISTINCT CASE WHEN IsSuspended=1 THEN %s END)"},
		{"WebsiteStatus", "COUNT(DISTINCT CASE WHEN WebsiteStatus IN ('Suspended','Dead') THEN %s END)"},
		{"DomainStatus", "COUNT(DISTINCT CASE WHEN DomainStatus IN ('Suspended','Dead') THEN %s END)"},
		{"SiteStatus", "COUNT(DISTINCT CASE WHEN SiteStatus IN ('Suspended','Dead') THEN %s END)"},
	}
)

type tableShape struct {
	Table   string
	Columns map[string]string // lower-cased name → declared name
	Err     string
}

var (
	shapeCache   = map[string]tableShape{}
	shapeCacheMu sync.RWMutex
)

// tableShapeOf reads a table's columns, cached for the process lifetime — the
// warehouse's shape does not change between deploys, and every report query
// would otherwise re-read information_schema.
func tableShapeOf(table string) tableShape {
	shapeCacheMu.RLock()
	if s, ok := shapeCache[table]; ok {
		shapeCacheMu.RUnlock()
		return s
	}
	shapeCacheMu.RUnlock()

	/* In API mode the column list comes from reports_api's own catalogue rather
	   than from information_schema — the portal has no warehouse connection to
	   ask. Cached below exactly as the direct answer is. */
	if reportsViaAPI() {
		shape := apiTableShape(table)
		/* A FAILURE is not cached. The shape cache lives for the life of the
		   process, so caching one would mean that a portal which started while
		   reports_api was still coming up reports "cannot be read" for every
		   table until someone restarts it — with the service healthy the whole
		   time and nothing on the page to suggest a restart would help. */
		if shape.Err == "" {
			shapeCacheMu.Lock()
			shapeCache[table] = shape
			shapeCacheMu.Unlock()
		}
		return shape
	}

	shape := tableShape{Table: table, Columns: map[string]string{}}
	schema, name := splitTable(table)
	rows, err := db.ReportsQuery(`
		SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS
		 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`, schema, name)
	if err != nil {
		shape.Err = err.Error()
	}
	for _, r := range rows {
		c := strFromAny(r["c"])
		shape.Columns[strings.ToLower(c)] = c
	}

	shapeCacheMu.Lock()
	shapeCache[table] = shape
	shapeCacheMu.Unlock()
	return shape
}

func invalidateShapeCache() {
	shapeCacheMu.Lock()
	shapeCache = map[string]tableShape{}
	shapeCacheMu.Unlock()
}

// lookupCandidateFor returns the lookup a dimension DECLARES, whether or not it
// resolved. inferSpec clears an unusable one off the spec so the query still
// runs, which would otherwise leave the diagnostic with nothing to report.
type lookupCandidate struct{ Table, IDCol, NameCol string }

func lookupCandidateFor(dimKey string) (lookupCandidate, bool) {
	for _, d := range dimensionCandidates {
		if d.Key == dimKey && d.LookupTable != "" {
			return lookupCandidate{d.LookupTable, d.LookupID, d.Name}, true
		}
	}
	return lookupCandidate{}, false
}

/*
resolveLookup finds a workable table/id/name for a dimension's lookup.

The registry names ONE table and ONE name column, taken from another project's
SQL — and when either is spelled differently here, the panel and its slicer fall
back to raw ids. A GUID is not a choice anybody can make from a dropdown, so
rather than requiring the exact name up front, the declared one is tried first
and then the spellings this warehouse plausibly uses, checked against
information_schema like every other column in this file.

Returns empty strings when nothing resolves, which drops the join: the panel
then groups by the id and still draws, instead of emitting SQL that fails and
costs the whole panel.
*/
func resolveLookup(table, idCol, nameCol string) (string, string, string) {
	if table == "" {
		return "", "", ""
	}
	// Declared first, then the alternates — a declared pair that works is never
	// second-guessed.
	tables := append([]string{table}, lookupTableAlts[table]...)
	names := append([]string{nameCol}, "Name", "Title", "DisplayName", "Description")
	ids := []string{idCol, "Id", "ID"}

	for _, t := range tables {
		shape := tableShapeOf(t)
		if len(shape.Columns) == 0 {
			continue
		}
		id := shape.firstOf(ids)
		name := shape.firstOf(names)
		if id != "" && name != "" {
			if t != table || name != nameCol {
				log.Printf("[reports] lookup %s.%s resolved as %s.%s", table, nameCol, t, name)
			}
			return t, id, name
		}
	}
	// Nothing worked — say so once, with what the declared table actually has.
	lookupUsable(table, idCol, nameCol)
	return "", "", ""
}

// lookupTableAlts are the other names a lookup table goes by. The warehouse and
// the source project do not always agree on spelling — "InfringmentType" is
// missing an E in one of them, and which one is not knowable from here.
var lookupTableAlts = map[string][]string{
	"mediascan.Asset":           {"mediascan.AssetMaster", "mediascan.Assets"},
	"mediascan.Language":        {"mediascan.LanguageMaster", "mediascan.Languages"},
	"mediascan.Genre":           {"mediascan.GenreMaster", "mediascan.Genres"},
	"mediascan.InfringmentType": {"mediascan.InfringementType", "mediascan.InfringmentTypeMaster"},
	"mediascan.QualityOfPrint":  {"mediascan.QualityOfPrintMaster", "mediascan.PrintQuality"},
}

// lookupUsable reports whether a dimension's lookup table exists and carries
// both the id it joins on and the name it reads. Warned once per table so a
// mis-named lookup is visible in the log rather than only as an empty panel;
// the shape is cached, so the check costs one information_schema read.
var lookupWarned sync.Map

func lookupUsable(table, idCol, nameCol string) bool {
	shape := tableShapeOf(table)
	ok := shape.has(idCol) && shape.has(nameCol)
	if !ok {
		if _, seen := lookupWarned.LoadOrStore(table+"."+nameCol, true); !seen {
			why := "missing " + idCol + " or " + nameCol
			if len(shape.Columns) == 0 {
				why = "table not readable"
				if shape.Err != "" {
					why += ": " + shape.Err
				}
			}
			log.Printf("[reports] lookup %s (%s → %s) unusable — %s; that dimension will show raw ids",
				table, idCol, nameCol, why)
		}
	}
	return ok
}

func (t tableShape) has(col string) bool {
	_, ok := t.Columns[strings.ToLower(col)]
	return ok
}

func (t tableShape) firstOf(cands []string) string {
	for _, c := range cands {
		if t.has(c) {
			return t.Columns[strings.ToLower(c)]
		}
	}
	return ""
}

// inferRole names what a table describes, so a platform reading several of them
// can keep them apart instead of adding them into one undifferentiated total.
//
// Open Web enforcement has two halves — the pages that LINK to infringing
// content and the ones that HOST it — and they are not interchangeable: a link
// is delisted from search results, a host is taken down. The report shows a
// trend and a top-ten for each, which needs to know which table is which.
//
// Derived from the domain column rather than configured, for the same reason
// everything else here is: an admin picking a table should not also have to
// declare what kind of table it is. A table with neither column has no role, and
// its platform simply shows one merged trend.
func inferRole(shape tableShape) (role, label string) {
	switch {
	case shape.has("InfringingDomain"):
		return "linking", "Linking"
	case shape.has("SourceDomain"):
		return "host", "Host"
	}
	return "", ""
}

// roleOrder is the order the per-source trends are drawn in: the link is found
// first and the host behind it, which is also the order the enforcement happens.
var roleOrder = []string{"linking", "host"}

// roleDisplayName is what a role is called on a configuration screen, where the
// panel has to be named before there is any data to title it with.
var roleDisplayName = map[string]string{"linking": "Linking", "host": "Host"}

/*
dimensionRank is the canonical reading order of the panels, taken from
dimensionCandidates plus the synthetic ones that have no candidate row.

A platform reading several tables collects its dimensions table by table, which
would otherwise put the host table's "Top 10 Host Websites" after every panel the
linking table produced — instead of beside "Top 10 Linking Websites", which is
the comparison it exists to support. Sorting by this puts the page back into one
order regardless of how many tables fed it.
*/
var dimensionRank = func() map[string]int {
	out := make(map[string]int, len(dimensionCandidates)+1)
	for i, d := range dimensionCandidates {
		out[d.Key] = i
	}
	// Synthetic panels sit after everything with a grouping column behind it.
	out["byDelistingStatus"] = len(dimensionCandidates)
	return out
}()

// rankOfDim orders a dimension key; anything unrecognised sorts last, in the
// order it arrived.
func rankOfDim(key string) int {
	if r, ok := dimensionRank[key]; ok {
		return r
	}
	return len(dimensionRank) + 1
}

// inferSpec derives a runnable spec for one table. `ok` is false when the table
// has no recognisable client or date column, which means it cannot be reported
// on at all — the caller says so rather than running a broken query.
func inferSpec(platformKey, label, table string) (reportSpec, bool) {
	shape := tableShapeOf(table)
	if len(shape.Columns) == 0 {
		return reportSpec{}, false
	}

	client := shape.firstOf(clientColCandidates)
	date := shape.firstOf(dateColCandidates)
	if client == "" || date == "" {
		return reportSpec{}, false
	}

	s := reportSpec{
		Key: platformKey, Label: label, Table: table,
		ClientCol: client, DateCol: date,
		AssetCol:      shape.firstOf(assetColCandidates),
		ClientNameCol: shape.firstOf(clientNameCands),
		AssetNameCol:  shape.firstOf(assetNameCands),
		IdentExpr:     "COUNT(*)",
		RemovedExpr:   "0",
		ExtraKPI:      map[string]string{},
		Filters:       map[string]string{},
	}
	s.JoinClientMaster = s.ClientNameCol == ""
	s.JoinAssetMaster = s.AssetNameCol == "" && s.AssetCol != ""
	s.Role, s.RoleLabel = inferRole(shape)

	// Measures: a pre-aggregated table sums its count columns; a raw table counts
	// rows and reads a removal flag.
	for _, pair := range measurePairs {
		if shape.has(pair[0]) {
			s.IdentExpr = fmt.Sprintf("SUM(%s)", shape.Columns[strings.ToLower(pair[0])])
			if shape.has(pair[1]) {
				s.RemovedExpr = fmt.Sprintf("SUM(%s)", shape.Columns[strings.ToLower(pair[1])])
			}
			break
		}
	}
	if s.IdentExpr == "COUNT(*)" {
		switch {
		case shape.has("IsRemoved"):
			s.RemovedExpr = "COUNT(CASE WHEN IsRemoved=1 THEN 1 END)"
		case shape.has("RemovalStatus"):
			s.RemovedExpr = "COUNT(CASE WHEN RemovalStatus IN ('Removed','Dead') THEN 1 END)"
		}
	}

	// Delisting is a third measure, and only the linking side has it — a link
	// dropped by a search engine is a different event from a page taken down.
	if shape.has("IsGoogleDelisted") && shape.has("IsBingDelisted") {
		s.DelistedExpr = "COUNT(CASE WHEN IsGoogleDelisted=1 OR IsBingDelisted=1 THEN 1 END)"
	}

	// Distinct-count KPIs that only make sense when the column is there.
	if dom := shape.firstOf([]string{"InfringingDomain", "SourceDomain", "Domain"}); dom != "" {
		s.ExtraKPI["totalDomains"] = fmt.Sprintf("COUNT(DISTINCT %s)", dom)
		for _, form := range suspendedSiteForms {
			if shape.has(form.Flag) {
				s.ExtraKPI["suspendedWebsites"] = fmt.Sprintf(form.Expr, dom)
				break
			}
		}
	}
	if s.AssetCol != "" {
		s.ExtraKPI["totalAssets"] = fmt.Sprintf("COUNT(DISTINCT %s)", s.AssetCol)
	}
	if ch := shape.firstOf([]string{"ChannelURL", "ChannelName"}); ch != "" {
		s.ExtraKPI["totalChannels"] = fmt.Sprintf("COUNT(DISTINCT %s)", ch)
	}
	if shape.has("ChannelStatus") && shape.has("ChannelURL") {
		// 'Dead' is the warehouse's spelling for a suspended channel. It was
		// previously matched as LIKE '%Suspend%', which no row satisfies — hence
		// the tile reading a flat zero.
		s.ExtraKPI["channelsSuspended"] = "COUNT(DISTINCT CASE WHEN ChannelStatus = 'Dead' THEN ChannelURL END)"
	}
	for _, c := range extraKPICandidates {
		if _, filled := s.ExtraKPI[c.Key]; filled {
			continue
		}
		if shape.has(c.NeedsCol) {
			s.ExtraKPI[c.Key] = c.Expr
		}
	}

	// Dimensions and their matching slicers, deduped by response key.
	seen := map[string]bool{}
	/* One dimension per LABEL, not just per key.
	   A table carrying both LanguageName and LanguageId matches two candidates
	   for the same panel. Left unchecked that ran two grouped queries per
	   report, drew whichever won a later dedup, and — because the loop below
	   writes the slicer's column — left the FILTER pointing at the id while the
	   panel showed names. Taking the first candidate only means the name form,
	   declared first, is the one used throughout. */
	labelSeen := map[string]bool{}
	for _, d := range dimensionCandidates {
		if seen[d.Key] || labelSeen[d.Label] {
			continue
		}
		col := shape.firstOf(append([]string{d.Column}, d.Alts...))
		if col == "" {
			continue
		}
		if d.Needs != "" && !shape.has(d.Needs) {
			continue
		}

		/* An id column is only a dimension if something can turn it into a name.
		   Where the lookup does not resolve the panel is DROPPED rather than
		   drawn: a bar list of GUIDs ranks rows nobody can identify, and a slicer
		   of them cannot be picked from at all. Skipping here rather than after
		   the marks below means the id form is passed over cleanly and, if a name
		   column for the same panel appears later in the list, it still gets its
		   turn. */
		lkTable, lkID, lkName := resolveLookup(d.LookupTable, d.LookupID, d.Name)
		if d.LookupTable != "" && lkTable == "" {
			log.Printf("[reports] %s on %s dropped — %s cannot be resolved to a name",
				d.Key, table, col)
			continue
		}

		seen[d.Key] = true
		labelSeen[d.Label] = true
		limit := 15
		switch d.Key {
		// Closed sets — every value is a panel row, so no cut-off.
		case "byTAT", "byGroupType", "byQuality", "bySearchEngine", "byPlatform",
			"byDeliveryType", "byGenre", "byGenreId", "bySearchEngineNotices":
			limit = 0
		// A long tail where the head is the report: the panels say "Top 10" and
		// mean it.
		case "byAsset", "byAssetName", "byKeyword",
			"byDomain", "byDomainSource", "byChannel":
			limit = 10
		}
		s.Dimensions = append(s.Dimensions, dimension{
			Key: d.Key, Column: col, Label: d.Label, Limit: limit, Viz: d.Viz,
			LookupTable: lkTable, LookupIDCol: lkID, LookupName: lkName,
			IdentOverride: d.Ident, RemovedOverride: d.Removed,
		})
		// First candidate to claim a slicer keeps it — so "language" filters on
		// LanguageName rather than being overwritten by LanguageId further down
		// the list, which is what made the dropdown list ids.
		if param := DIMFilterParam(d.Key); param != "" {
			if _, taken := s.Filters[param]; !taken {
				s.Filters[param] = col
			}
		}
	}

	// Synthetic panel: the delisting comparison is three figures the KPI query
	// already returns, not a GROUP BY — so it is declared here (with no column,
	// which the runner skips) and assembled in runPlatform.
	if s.DelistedExpr != "" {
		s.Dimensions = append(s.Dimensions, dimension{
			Key: "byDelistingStatus", Label: "Search Engine Delisting - Identification & Removal",
			Viz: "value",
		})
	}
	return s, true
}

// DIMFilterParam maps a dimension key to the slicer parameter that filters it.
// Mirrors DIM_FILTER in app/admin/reports/page.tsx.
func DIMFilterParam(dimKey string) string {
	switch dimKey {
	case "byAsset", "byAssetName":
		return "assetId"
	case "byLanguage", "byLanguageId":
		return "language"
	case "byCountry":
		return "country"
	case "bySearchEngine", "bySearchEngineNotices":
		return "searchEngine"
	case "byGenre", "byGenreId":
		return "genre"
	case "byDeliveryType":
		return "deliveryType"
	case "byKeyword":
		return "keyword"
	// One slicer for both halves of Open Web: "show me this site" means the same
	// question whether the site links to the content or hosts it, and each table
	// carries only one of the two columns.
	case "byDomain", "byDomainSource":
		return "domain"
	case "byTAT":
		return "tatBucket"
	case "byPlatform":
		return "platform"
	case "byChannel":
		return "channel"
	case "byGroupType":
		return "groupType"
	case "byQuality", "byQualityId":
		return "quality"
	case "byInfringementType", "byInfringementTypeId":
		return "infringementType"
	}
	return ""
}

/* ── Platform store ───────────────────────────────────────────────────────── */

type platformDef struct {
	Key     string
	Label   string
	Order   int64
	Enabled bool
	Tables  []string
}

func loadPlatforms() []platformDef {
	ensurePlatformSchema()
	rows, err := db.Query("SELECT platform_key, label, sort_order, is_enabled FROM " + platformTable + " ORDER BY sort_order, label")
	if err != nil {
		return nil
	}
	tablesBy := map[string][]string{}
	if trows, err := db.Query("SELECT platform_key, table_name FROM " + platformTableTable + " ORDER BY sort_order, table_name"); err == nil {
		for _, t := range trows {
			k := strFromAny(t["platform_key"])
			tablesBy[k] = append(tablesBy[k], strFromAny(t["table_name"]))
		}
	}
	out := make([]platformDef, 0, len(rows))
	for _, r := range rows {
		key := strFromAny(r["platform_key"])
		out = append(out, platformDef{
			Key: key, Label: strFromAny(r["label"]),
			Order: numOf(r["sort_order"]), Enabled: numOf(r["is_enabled"]) == 1,
			Tables: tablesBy[key],
		})
	}
	return out
}

func platformByKey(key string) (platformDef, bool) {
	for _, p := range loadPlatforms() {
		if p.Key == key {
			return p, true
		}
	}
	return platformDef{}, false
}

// specsForPlatform resolves every table a platform reads into a runnable spec.
// Tables whose shape cannot be inferred are reported separately so the UI can
// say which, instead of quietly returning less data.
func specsForPlatform(p platformDef) (specs []reportSpec, skipped []string) {
	for _, t := range p.Tables {
		if s, ok := inferSpec(p.Key, p.Label, t); ok {
			specs = append(specs, s)
		} else {
			skipped = append(skipped, t)
		}
	}
	return specs, skipped
}

/* ── CRUD: /api/admin/report-platforms ────────────────────────────────────── */

// GET — every platform with its tables, plus what was inferred for each table.
func ReportPlatformsList(w http.ResponseWriter, r *http.Request) {
	ensurePlatformSchema()
	withShape := r.URL.Query().Get("shape") == "1" && reportsBackendReady()

	out := []map[string]any{}
	for _, p := range loadPlatforms() {
		item := map[string]any{
			"key": p.Key, "label": p.Label, "order": p.Order,
			"enabled": p.Enabled, "tables": p.Tables,
		}
		if withShape {
			tables := []map[string]any{}
			for _, t := range p.Tables {
				entry := map[string]any{"table": t}
				if s, ok := inferSpec(p.Key, p.Label, t); ok {
					entry["usable"] = true
					entry["clientCol"] = s.ClientCol
					entry["dateCol"] = s.DateCol
					entry["identExpr"] = s.IdentExpr
					entry["removedExpr"] = s.RemovedExpr
					entry["dimensions"] = len(s.Dimensions)
				} else {
					entry["usable"] = false
					sh := tableShapeOf(t)
					if sh.Err != "" {
						entry["error"] = sh.Err
					} else if len(sh.Columns) == 0 {
						entry["error"] = "table not found in the warehouse"
					} else {
						entry["error"] = "no recognisable client or date column"
					}
				}
				tables = append(tables, entry)
			}
			item["tableDetail"] = tables
		}
		out = append(out, item)
	}
	OK(w, map[string]any{"success": true, "platforms": out, "configured": reportsBackendReady()})
}

// PUT — create or update. Body: { key, label, tables[], enabled, order }
func ReportPlatformSave(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	ensurePlatformSchema()

	var body struct {
		Key     string   `json:"key"`
		Label   string   `json:"label"`
		Tables  []string `json:"tables"`
		Enabled *bool    `json:"enabled"`
		Order   *int64   `json:"order"`
	}
	json.NewDecoder(r.Body).Decode(&body)

	label := strings.TrimSpace(body.Label)
	if label == "" {
		Fail(w, 422, "A platform name is required")
		return
	}
	key := strings.TrimSpace(body.Key)
	if key == "" {
		key = slugify(label)
	}
	if !validPlatformKey(key) {
		Fail(w, 422, "Platform key must be lowercase letters, numbers or hyphens")
		return
	}

	// Table names are interpolated into SQL later, so they are validated here and
	// nowhere else is allowed to invent one.
	clean := []string{}
	for _, t := range body.Tables {
		t = strings.TrimSpace(t)
		if t == "" {
			continue
		}
		if !validSQLName(t) {
			Fail(w, 422, "Not a valid table name: "+t)
			return
		}
		clean = append(clean, t)
	}

	enabled := 1
	if body.Enabled != nil && !*body.Enabled {
		enabled = 0
	}
	// A new platform goes to the end rather than onto the default 100, where it
	// would sort by label among everything else that never had a position set.
	order := int64(0)
	if body.Order != nil {
		order = *body.Order
	} else if row, err := db.QueryOne(
		"SELECT COALESCE(MAX(sort_order),0) AS m FROM " + platformTable); err == nil && row != nil {
		order = numOf(row["m"]) + 10
	}
	if order <= 0 {
		order = 10
	}
	// Editing an existing platform must not move it: keep its current position
	// unless the caller explicitly sent one.
	if body.Order == nil {
		if row, err := db.QueryOne(
			"SELECT sort_order FROM "+platformTable+" WHERE platform_key = ? LIMIT 1", key); err == nil && row != nil {
			order = numOf(row["sort_order"])
		}
	}
	who := ""
	if claims != nil {
		who = claims.LoginUsername
	}

	if _, _, err := db.Exec(`
		INSERT INTO `+platformTable+` (platform_key, label, sort_order, is_enabled, updated_by)
		VALUES (?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE label=VALUES(label), sort_order=VALUES(sort_order),
		  is_enabled=VALUES(is_enabled), updated_by=VALUES(updated_by)`,
		key, label, order, enabled, who); err != nil {
		log.Printf("[platforms] save %s: %v", key, err)
		Fail(w, 500, "Could not save this platform")
		return
	}

	// Replace the table list wholesale — simpler to reason about than diffing,
	// and the set is small.
	if _, _, err := db.Exec("DELETE FROM "+platformTableTable+" WHERE platform_key = ?", key); err != nil {
		Fail(w, 500, "Could not update this platform's tables")
		return
	}
	for i, t := range clean {
		if _, _, err := db.Exec(
			"INSERT IGNORE INTO "+platformTableTable+" (platform_key, table_name, sort_order) VALUES (?, ?, ?)",
			key, t, (i+1)*10); err != nil {
			log.Printf("[platforms] table %s/%s: %v", key, t, err)
		}
	}
	invalidateShapeCache()
	OK(w, map[string]any{"success": true, "key": key})
}

// DELETE /api/admin/report-platforms?key=
func ReportPlatformDelete(w http.ResponseWriter, r *http.Request) {
	ensurePlatformSchema()
	key := strings.TrimSpace(r.URL.Query().Get("key"))
	if key == "" {
		Fail(w, 422, "A platform key is required")
		return
	}
	db.Exec("DELETE FROM "+platformTableTable+" WHERE platform_key = ?", key)
	if _, _, err := db.Exec("DELETE FROM "+platformTable+" WHERE platform_key = ?", key); err != nil {
		Fail(w, 500, "Could not delete this platform")
		return
	}
	// Any per-login grants for it go too, so a re-created key does not inherit
	// permissions from a platform that no longer exists.
	db.Exec("DELETE FROM "+reportAccessTable+" WHERE report_key = ?", key)
	invalidateShapeCache()
	OK(w, map[string]any{"success": true})
}

/* ── Multi-table execution ────────────────────────────────────────────────── */

// runPlatform executes every table behind a platform and merges the results:
// KPIs add up, the daily trend is summed per date, and breakdowns are summed per
// label. That is what "this platform reads from these tables" has to mean.
//
// The merge is not the whole answer, though. Where a platform's tables describe
// DIFFERENT THINGS — Open Web's linking pages and the hosts behind them — adding
// them up loses the distinction the report is built on, so the per-source
// figures are carried alongside the merged ones (`sources`, `dailyBySource`) and
// the page draws a trend for each. Tables with no role merge as before.
func runPlatform(p platformDef, q map[string]string) map[string]any {
	specs, skipped := specsForPlatform(p)
	if len(specs) == 0 {
		return map[string]any{
			"ok": false, "available": true, "type": p.Key, "label": p.Label,
			"error":         "None of this platform's tables can be read — check Report Configuration",
			"skippedTables": skipped,
		}
	}

	merged := map[string]any{}
	kpi := map[string]int64{}
	// The preceding window, merged exactly as the current one is — a platform
	// reading three tables has to add up its "before" the same way it adds up
	// its "now", or the change on a tile would compare one table against three.
	kpiPrev := map[string]int64{}
	havePrev := false
	prevFrom, prevTo := "", ""
	daily := map[string]map[string]int64{}
	breakdowns := map[string]map[string]map[string]int64{}
	// Lookup dimensions carry the id a click filters on alongside the name shown.
	// Merging is by name — two tables spell the same asset the same way — but the
	// id has to survive it or the panel's cross-filter has nothing to send.
	dimValues := map[string]map[string]string{}
	dimLabels := map[string]string{}
	warnings := []string{}
	ran := 0
	// Per-source, for platforms whose tables are not the same kind of thing.
	roleKPI := map[string]map[string]int64{}
	roleDaily := map[string]map[string]map[string]int64{}
	roleLabels := map[string]string{}

	for _, s := range specs {
		// A table that cannot apply an active slicer is left out entirely rather
		// than contributing its unfiltered total to a filtered figure.
		if !specHonoursFilters(s, q) {
			continue
		}
		ran++
		part := runSpec(s, q)
		if wv, ok := part["queryWarning"].(string); ok && wv != "" {
			warnings = append(warnings, wv)
		}
		role := s.Role
		if role != "" {
			roleLabels[role] = s.RoleLabel
			if roleKPI[role] == nil {
				roleKPI[role] = map[string]int64{}
			}
			if roleDaily[role] == nil {
				roleDaily[role] = map[string]map[string]int64{}
			}
		}

		if pk, ok := part["kpi"].(map[string]any); ok {
			for k, v := range pk {
				// removalPct is derived, not additive — recomputed after merging.
				if k == "removalPct" {
					continue
				}
				kpi[k] += numOf(v)
				if role != "" {
					roleKPI[role][k] += numOf(v)
				}
			}
		}
		if pp, ok := part["kpiPrev"].(map[string]any); ok {
			havePrev = true
			if prevFrom == "" {
				prevFrom, prevTo = strFromAny(pp["from"]), strFromAny(pp["to"])
			}
			for k, v := range pp {
				switch k {
				case "removalPct", "from", "to":
					continue // derived, or the window itself — not summable
				}
				kpiPrev[k] += numOf(v)
			}
		}
		for _, row := range asRows(part["daily"]) {
			d := strFromAny(row["date"])
			if d == "" {
				continue
			}
			if daily[d] == nil {
				daily[d] = map[string]int64{}
			}
			daily[d]["urls"] += numOf(row["urls"])
			daily[d]["removed"] += numOf(row["removed"])
			if role == "" {
				continue
			}
			if roleDaily[role][d] == nil {
				roleDaily[role][d] = map[string]int64{}
			}
			roleDaily[role][d]["urls"] += numOf(row["urls"])
			roleDaily[role][d]["removed"] += numOf(row["removed"])
			roleDaily[role][d]["delisted"] += numOf(row["delisted"])
		}
		if bd, ok := part["breakdowns"].(map[string]any); ok {
			for key, rows := range bd {
				if breakdowns[key] == nil {
					breakdowns[key] = map[string]map[string]int64{}
				}
				for _, row := range asRows(rows) {
					label := strFromAny(row["label"])
					if label == "" {
						continue
					}
					if breakdowns[key][label] == nil {
						breakdowns[key][label] = map[string]int64{}
					}
					breakdowns[key][label]["urls"] += numOf(row["urls"])
					breakdowns[key][label]["removed"] += numOf(row["removed"])
					if v := strFromAny(row["value"]); v != "" {
						if dimValues[key] == nil {
							dimValues[key] = map[string]string{}
						}
						if _, seen := dimValues[key][label]; !seen {
							dimValues[key][label] = v
						}
					}
				}
			}
		}
		for _, d := range s.Dimensions {
			dimLabels[d.Key] = d.Label
		}
	}

	ident, removed := kpi["identified"], kpi["removed"]
	kpiOut := map[string]any{}
	for k, v := range kpi {
		kpiOut[k] = v
	}
	kpiOut["pending"] = max64(0, ident-removed)
	pct := 0.0
	if ident > 0 {
		pct = float64(removed) / float64(ident) * 100
	}
	kpiOut["removalPct"] = roundTo(pct, 2)

	// The same treatment for the preceding window: sum what is additive, then
	// derive pending and the rate from the sums rather than adding either.
	var kpiPrevOut map[string]any
	if havePrev {
		kpiPrevOut = map[string]any{"from": prevFrom, "to": prevTo}
		for k, v := range kpiPrev {
			kpiPrevOut[k] = v
		}
		pIdent, pRemoved := kpiPrev["identified"], kpiPrev["removed"]
		kpiPrevOut["pending"] = max64(0, pIdent-pRemoved)
		pPct := 0.0
		if pIdent > 0 {
			pPct = float64(pRemoved) / float64(pIdent) * 100
		}
		kpiPrevOut["removalPct"] = roundTo(pPct, 2)
	}

	dates := make([]string, 0, len(daily))
	for d := range daily {
		dates = append(dates, d)
	}
	sort.Strings(dates)
	dailyOut := make([]map[string]any, 0, len(dates))
	for _, d := range dates {
		dailyOut = append(dailyOut, map[string]any{
			"date": d, "urls": daily[d]["urls"], "removed": daily[d]["removed"],
		})
	}

	bdOut := map[string]any{}
	for key, byLabel := range breakdowns {
		rows := make([]map[string]any, 0, len(byLabel))
		for label, m := range byLabel {
			row := map[string]any{"label": label, "urls": m["urls"], "removed": m["removed"]}
			if v := dimValues[key][label]; v != "" {
				row["value"] = v
			}
			rows = append(rows, row)
		}
		sort.Slice(rows, func(i, j int) bool { return numOf(rows[i]["urls"]) > numOf(rows[j]["urls"]) })
		if len(rows) > 15 && key != "byTAT" && key != "byGroupType" && key != "byQuality" {
			rows = rows[:15]
		}
		bdOut[key] = rows
	}

	/* ── Per-source figures ───────────────────────────────────────────────────
	   Only meaningful where the platform's tables describe different things, so
	   a single-role platform emits nothing here and the page keeps its one
	   merged trend. */
	sources := []map[string]any{}
	dailyBySource := map[string]any{}
	for _, role := range roleOrder {
		byDate, ok := roleDaily[role]
		if !ok {
			continue
		}
		rDates := make([]string, 0, len(byDate))
		for d := range byDate {
			rDates = append(rDates, d)
		}
		sort.Strings(rDates)
		rows := make([]map[string]any, 0, len(rDates))
		for _, d := range rDates {
			rows = append(rows, map[string]any{
				"date": d, "urls": byDate[d]["urls"],
				"removed": byDate[d]["removed"], "delisted": byDate[d]["delisted"],
			})
		}
		dailyBySource[role] = rows

		rk := roleKPI[role]
		src := map[string]any{
			"role": role, "label": roleLabels[role],
			"identified": rk["identified"], "removed": rk["removed"],
		}
		// Only the linking side has a delisting figure, and it is what its trend
		// is drawn against — so the page is told which second series to use
		// rather than inferring it from the role.
		if _, ok := rk["delisted"]; ok {
			src["delisted"] = rk["delisted"]
			src["secondSeries"] = "delisted"
		} else {
			src["secondSeries"] = "removed"
		}
		sources = append(sources, src)
	}
	if len(sources) > 1 {
		merged["sources"] = sources
		merged["dailyBySource"] = dailyBySource
	}

	/* ── Synthetic panel: search-engine delisting ─────────────────────────────
	   Three figures the KPI query already returned, drawn side by side — how many
	   infringing links were found against how many each engine dropped. There is
	   no GROUP BY behind it, which is why it is assembled here rather than run as
	   a dimension. */
	if _, ok := kpi["delisted"]; ok {
		linking := kpi["identified"]
		if rk, has := roleKPI["linking"]; has {
			// Scoped to the linking table: the host table's rows were never
			// candidates for delisting, so including them would make every engine
			// look worse than it is.
			linking = rk["identified"]
		}
		bdOut["byDelistingStatus"] = []map[string]any{
			{"label": "Infringing URL", "urls": linking},
			{"label": "Delisting Status Bing", "urls": kpi["bingDelisted"]},
			{"label": "Delisting Status Google", "urls": kpi["googleDelisted"]},
		}
	}

	merged["ok"] = true
	merged["available"] = true
	merged["type"] = p.Key
	merged["label"] = p.Label
	merged["kpi"] = kpiOut
	if kpiPrevOut != nil {
		merged["kpiPrev"] = kpiPrevOut
	}
	merged["daily"] = dailyOut
	merged["breakdowns"] = bdOut
	merged["tables"] = tableNamesOf(specs)
	// How many of this platform's tables actually answered. Zero means every one
	// of them lacks a column an active slicer needs — the report is empty on
	// purpose, not broken, and the summary uses this to leave the platform out of
	// its per-platform split rather than drawing it as a real zero.
	merged["specsRun"] = ran
	if len(skipped) > 0 {
		merged["skippedTables"] = skipped
	}
	if len(warnings) > 0 {
		merged["queryWarning"] = strings.Join(warnings, " · ")
	}
	return merged
}

func tableNamesOf(specs []reportSpec) []string {
	out := make([]string, 0, len(specs))
	for _, s := range specs {
		out = append(out, s.Table)
	}
	return out
}

// asRows narrows the `any` a merged payload carries back to rows.
func asRows(v any) []map[string]any {
	switch t := v.(type) {
	case []map[string]any:
		return t
	case []any:
		out := make([]map[string]any, 0, len(t))
		for _, e := range t {
			if m, ok := e.(map[string]any); ok {
				out = append(out, m)
			}
		}
		return out
	}
	return nil
}

func slugify(s string) string {
	var b strings.Builder
	prevDash := false
	for _, c := range strings.ToLower(strings.TrimSpace(s)) {
		switch {
		case (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'):
			b.WriteRune(c)
			prevDash = false
		default:
			if !prevDash && b.Len() > 0 {
				b.WriteByte('-')
				prevDash = true
			}
		}
	}
	return strings.Trim(b.String(), "-")
}

func validPlatformKey(s string) bool {
	if s == "" || len(s) > 64 {
		return false
	}
	for _, c := range s {
		if !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-') {
			return false
		}
	}
	return true
}

/*
── PUT /api/admin/report-platforms/reorder ──────────────────────────────────

	Body: { keys: ["summary","open-web",…] } — the sidebar order, top first.

	The whole order is rewritten from the list rather than swapping two rows: that
	way the stored positions always match exactly what the admin sees, with no
	drift from repeated moves, and a key the caller omitted keeps a stable place
	after the ones it did send.
*/
func ReportPlatformReorder(w http.ResponseWriter, r *http.Request) {
	ensurePlatformSchema()

	var body struct {
		Keys []string `json:"keys"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if len(body.Keys) == 0 {
		Fail(w, 422, "An ordered list of platform keys is required")
		return
	}

	seen := map[string]bool{}
	pos := 0
	for _, k := range body.Keys {
		k = strings.TrimSpace(k)
		if k == "" || seen[k] {
			continue
		}
		seen[k] = true
		pos += 10
		if _, _, err := db.Exec(
			"UPDATE "+platformTable+" SET sort_order = ? WHERE platform_key = ?", pos, k); err != nil {
			log.Printf("[platforms] reorder %s: %v", k, err)
		}
	}
	// Anything the caller did not mention keeps its relative order, after the
	// list it did send.
	for _, p := range loadPlatforms() {
		if !seen[p.Key] {
			pos += 10
			db.Exec("UPDATE "+platformTable+" SET sort_order = ? WHERE platform_key = ?", pos, p.Key)
		}
	}
	OK(w, map[string]any{"success": true})
}
