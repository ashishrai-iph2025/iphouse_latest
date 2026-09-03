package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strings"
	"sync"

	"github.com/ip-house/iphouse-api/db"
	"github.com/ip-house/iphouse-api/reportsapi"
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
		/*
		  ── A PLATFORM NEED NOT BE A WAREHOUSE QUERY ─────────────────────────

		  Added after the table above existed, so ALTERed rather than declared —
		  CREATE TABLE IF NOT EXISTS does nothing to a table that is already
		  there, and an install created before this would read columns that do
		  not exist and get zero for every platform.

		    source_kind        'table' (the default, and everything that came
		                       before) or 'powerbi'.
		    powerbi_module_id  which dashboard MODULE this platform is, when it
		                       is a Power BI report.

		  The module, not a report id, and that is the whole design. A Power BI
		  report is per CLIENT — ESA's P2P report is not another client's — and
		  those assignments already exist at /admin/dashboards as
		  dcp_user_module_map(userId, moduleId, link). Storing a single report id
		  here would either show every client the same report or need a second
		  per-client table beside the one that already holds exactly this. So the
		  platform records which module it is and the report id is looked up per
		  reader. See powerBIReportFor.
		*/
		for _, alter := range []string{
			"ADD COLUMN source_kind VARCHAR(16) NOT NULL DEFAULT 'table'",
			"ADD COLUMN powerbi_module_id INT NULL DEFAULT NULL",
		} {
			if _, _, err := db.Exec("ALTER TABLE " + platformTable + " " + alter); err != nil {
				if !strings.Contains(strings.ToLower(err.Error()), "duplicate column") {
					log.Printf("[platforms] %s: %v", alter, err)
				}
			}
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
		// Other spellings of Needs. Where one is found it is substituted into
		// Ident, which is then a %s template rather than a finished expression —
		// the column the panel counts and the column it requires are the same
		// one, and writing it twice is how they come to disagree.
		NeedsAlts []string
		// The reports_api measure this panel reads instead of the section's own.
		// The API is asked for a named measure, not an expression, so a panel
		// that counts something else needs to say which — otherwise it silently
		// draws the section's identified count under a title promising notices.
		APIMeasure string
		/* The table SIDE this panel belongs to — "host" or "linking" — for the
		   columns that exist on BOTH halves of a two-table report.

		   Presence is not ownership. The two sports raw tables now share their
		   enforcement columns, and a candidate matched purely on "the column is
		   there" would build the same panel from both tables — after which
		   runPlatform sums the two by label, and a notice whose id is stamped
		   in both tables is one notice reported as two. Empty means any side,
		   which is every panel whose column means the same thing wherever it
		   appears. */
		Role string
	}{
		// ORDER IS THE READING ORDER of the panels on the page — where in the
		// world, against which titles, on which sites, delivered how, found by
		// what. It follows the report these pages replace, so someone who knows
		// the PowerBI sheet finds the same cards in the same sequence.
		{Key: "byCountry", Column: "CountryName", Alts: []string{"Country"},
			Label: "Infringements Breakdown - Country", Viz: "map"},
		// The id form, for the tables that record a country and no name for it —
		// the social dashboard has CountryId and nothing else, so without this
		// there was no country candidate it could match at all and the panel was
		// simply absent from every report built on it.
		{Key: "byCountryId", Column: "CountryId", Label: "Infringements Breakdown - Country", Viz: "map",
			LookupTable: "mediascan.Countries", LookupID: "Id", Name: "Name"},
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
		/* ── What the asset IS, rather than which asset it is ─────────────────
		   A franchise and a match day are properties of the TITLE, recorded once
		   on mediascan.Asset and never repeated on the fact rows — so these are
		   columns the reports API produces by joining the master (see
		   internal/api/assetattrs.go in that service), offered on the four
		   sports tables and on nothing else.

		   Which is exactly why they need no special handling here: a table that
		   does not carry them matches no candidate, and a report that is not
		   about sport shows no such panel rather than an empty one. They sit
		   beside the asset panels because they answer the next question a reader
		   asks of one — this title, and then the fixture it belongs to. */
		{Key: "byFranchise", Column: "FranchiseName",
			Label: "Franchise - Identification & Removal", Viz: "column"},
		{Key: "byMatchDay", Column: "MatchDay",
			Label: "Match Day - Identification & Removal", Viz: "column"},
		/* ── The OPERATOR, before the hostnames it runs ───────────────────────
		   A Top 10 of hostnames counts mirrors, not sites: one operator running
		   livetv.sx, livetv901.me and cdn.livetv872.me appears three times, each
		   a third of its real size, while a single-domain site beside it looks
		   more important than it is. Measured on the live warehouse, "livetv" is
		   131,333 infringements across 28 hostnames — where the hostname panel
		   showed 57,000 and gave no way to find the other 27.

		   So the brand reads FIRST and the hostname panel keeps its place below,
		   which is also the order the question is asked in: which operator, then
		   which of its hosts. Both columns are computed by reports_api from the
		   hostname (see internal/api/domainroot.go in that service), ported from
		   the Power BI model's `Domain Root Brand` and `Domain Mirror Type` so
		   the two reports cannot disagree.

		   Three panels rather than one, because "131,333 infringements" and "28
		   hostnames" are four orders of magnitude apart and a single chart
		   carrying both would need two y-axes — which is the one thing a chart
		   may never have. Same grouping, same cross-filter, one measure each. */
		{Key: "byDomainRoot", Column: "InfringingDomain",
			Alts:  []string{"SourceDomain", "DomainURL", "Domain"},
			Label: "Root Domain - Identification & Removal", Viz: "hbar"},
		// The mirror COUNT per brand: how many hostnames the operator is
		// currently running. One measure, so single-series bars.
		{Key: "byDomainRootMirrors", Column: "InfringingDomain",
			Alts:  []string{"SourceDomain", "DomainURL", "Domain"},
			Label: "Root Domain - Mirror Hostnames", Viz: "value"},
		// "Linking" and "Host" rather than "Infringing" and "Source": a platform
		// that reads both tables shows both panels, and the pair only makes sense
		// named for what each side of the enforcement actually is.
		{Key: "byDomain", Column: "InfringingDomain", Label: "Top 10 Linking Websites", Viz: "hbar"},
		{Key: "byDomainSource", Column: "SourceDomain", Label: "Top 10 Host Websites", Viz: "hbar"},
		/* SOCIAL platforms, and the name has to say so.

		   It groups by the `Platform` column, which only the social/UGC tables
		   carry — so on a platform that also reads the open web, Telegram or the
		   app stores, this panel lists a strict SUBSET of where infringements
		   were found while being titled as though it listed all of them. Read as
		   a complete list it invites exactly one question: where is Open Web.

		   Open Web is on bySourcePlatform ("Identification & Removal basis
		   Platform"), which splits the report by CHANNEL and is the panel that
		   answers that. It is not folded in here: these rows are also the
		   Platform slicer's values, and a row nothing can filter on — no table
		   carries `Platform = 'Open Web'`, and the open-web tables declare no
		   platform filter at all — would empty the page when it was clicked.

		   The built-in summary has always called this one "Top 10 Social Media
		   Platforms"; this is the same correction for every other report. */
		{Key: "byPlatform", Column: "Platform", Label: "Social Media Platforms", Viz: "donut"},
		{Key: "byChannel", Column: "ChannelName", Alts: []string{"ChannelOrProfileName"},
			Label: "Top 10 Channels", Viz: "hbar"},
		/* ── The same accounts, ranked by PERSISTENCE rather than volume ──────
		   Directly after the channel list, because it is the second question
		   asked of it: not which account posted the most, but which one keeps
		   coming back day after day. Grouped on the account's URL rather than
		   its name — see repeatoffenders.go, which is also where the distinct-day
		   count is computed, since neither backend has a measure for it. */
		{Key: dimRepeatOffender,
			Column: repeatURLColumns[0], Alts: repeatURLColumns[1:],
			Label: "Repeat Offenders - Top 10 Channels / Profiles", Viz: "repeat"},
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
			Ident: "SUM(%s)", Removed: "0",
			Needs: "NoticeSentCount", NeedsAlts: []string{"NoticeCount", "EnforcementCount"},
			APIMeasure: "notices"},
		// The search terms the infringing pages were found under. A long tail cut
		// to ten; the full list is behind the panel's table view.
		/* ── Enforcement, per counterparty ───────────────────────────────────
		   Who the action went TO, counted in ACTIONS rather than in URLs.

		   Both count DISTINCT ids, and that is the whole point of them. A notice
		   id is stamped on every source URL the notice listed and a batch id on
		   every link in the submission, so the row count answers "how many links
		   were covered" — a number four orders of magnitude larger, already on
		   the page, and easy to mistake for this one. What an enforcement team
		   is measured on is how many notices went out and how many batches were
		   submitted.

		   Single-series bars: a notice has no removal figure of its own. What
		   became of the URLs it covered is the panel above it.

		   Only the two sports raw tables carry these columns, so `Needs` is what
		   keeps the panels off every other report — a table without the id
		   matches no candidate and simply has no such card. */
		{Key: dimHSPNotices, Column: "HSPName", Viz: "value",
			Label: "Enforcement Notices - Hosting Provider",
			Ident: "COUNT(DISTINCT %s)", Removed: "0",
			Needs: colSourceNoticeID, APIMeasure: "notices", Role: "host"},
		/* The same counterparty on the LINKING half, which carries HSPName on
		   every row — 680 distinct providers against the host side's 469.

		   It counts DE-INDEXING SUBMISSIONS, not notices, because that is the
		   action the linking table records: there is no SourceDMCANoticeId on it
		   and never will be, since a notice is sent to a host and a submission
		   goes to the engines that indexed the link. Naming it for the notices
		   panel above would have put two cards called "Enforcement Notices" on
		   one page counting two different actions — the exact confusion
		   actionMeasures pins roles to prevent. Renameable per platform in
		   Report Configuration if a client's own wording differs.

		   Declared HERE rather than at the end so dimensionRank lands it beside
		   the host panel, which is the comparison it exists for. */
		{Key: dimHSPDelisting, Column: "HSPName", Viz: "value",
			Label: "De-Indexing - Hosting Provider",
			Ident: "COUNT(DISTINCT %s)", Removed: "0",
			Needs: colDelistingBatchID, APIMeasure: "delistingBatches", Role: "linking"},
		{Key: dimEngineDelistingBatches, Column: "SearchEngineName", Alts: []string{"SearchEngine"},
			Viz: "value", Label: "De-Indexing - Search Engine",
			Ident: "COUNT(DISTINCT %s)", Removed: "0",
			Needs: colDelistingBatchID, APIMeasure: "delistingBatches", Role: "linking"},
		/* ── Enforcement, per DAY ────────────────────────────────────────────
		   The same distinct counts grouped by URLUploadDate instead of by
		   counterparty — how many notices went out each day, how many batches
		   were submitted each day. Built exactly like the two panels above,
		   because they are the same measure asked "when" instead of "to whom";
		   the timestamps fold to their calendar day and the bars run in date
		   order. These replaced the Day-on-Day action trend cards. */
		{Key: dimNoticesByDay, Column: "URLUploadDate", Viz: "value",
			Label: "Day-wise Enforcement Notices",
			Ident: "COUNT(DISTINCT %s)", Removed: "0",
			Needs: colSourceNoticeID, APIMeasure: "notices", Role: "host"},
		{Key: dimBatchesByDay, Column: "URLUploadDate", Viz: "value",
			Label: "Day-wise De-Indexing",
			Ident: "COUNT(DISTINCT %s)", Removed: "0",
			Needs: colDelistingBatchID, APIMeasure: "delistingBatches", Role: "linking"},
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
		/* `InfringmentTypeId` — without the second `e` — is how the mobile-apps
		   table spells it, matching mediascan.InfringmentType itself. Accepted
		   as an alternate rather than corrected, because the correct spelling
		   names a column that does not exist on that table. */
		{Key: "byInfringementTypeId", Column: "InfringementTypeId", Alts: []string{"InfringmentTypeId"},
			Label: "Nature of Infringements", Viz: "bars",
			LookupTable: "mediascan.InfringmentType", LookupID: "Id", Name: "Name"},
		{Key: "byGroupType", Column: "GroupType", Label: "Group Type", Viz: "bars"},
		// Turnaround buckets are ordered and every row in one has, by
		// definition, already been removed — so "removed vs still live" says
		// nothing here. What the reader wants is the share that landed in each
		// bucket, on a ramp that shows the ordering.
		{Key: "byTAT", Column: "TATBucket", Label: "Turnaround", Viz: "share"},

		/* ── Mobile apps ────────────────────────────────────────────────────
		   A store listing is a different kind of infringement from a link: it
		   has a publisher, a category, a rating and a store it lives in, and
		   none of the dimensions above describe any of that.

		   Every column named here is one reports_api will actually GROUP BY —
		   checked against the mobile-apps dataset's own filter list. A candidate
		   naming a column that exists but is not groupable produces a panel that
		   is permanently and inexplicably empty, which is worse than no panel. */

		// Which of the four feeds the row came from — an app store, or a
		// third-party download site. First among these because most of the
		// metadata below is populated by only some of them, so it is the
		// slicer the rest of this report is usually read through.
		{Key: "bySourceFeed", Column: "SourceTable", Label: "Source Feed", Viz: "donut"},
		// Horizontal: app titles are long, and a column chart angles and cuts
		// the very label being read.
		{Key: "byApp", Column: "AppName", Label: "Top 10 Apps", Viz: "hbar"},
		{Key: "byCategory", Column: "CategoryName", Label: "App Categories", Viz: "column"},
		// Only the two store feeds record a publisher, so this is thin unless
		// the Source Feed slicer is set to one of them.
		{Key: "byDeveloper", Column: "CompanyName", Label: "Top 10 Developers", Viz: "hbar"},
		{Key: "byStoreType", Column: "WrapperType", Label: "Listing Type", Viz: "bars"},
		{Key: "byContentRating", Column: "TrackContentRating", Label: "Content Rating", Viz: "bars"},
		/* The infringing side first: on this table the "source" is the store
		   page and the "infringing" side is the download it leads to, and a
		   removal status that means the listing came down is the one the report
		   is about. */
		{Key: "byRemovalStatus", Column: "InfringingRemovalStatus",
			Alts:  []string{"SourceRemovalStatus", "RemovalStatus"},
			Label: "Removal Status", Viz: "bars"},
		// The id form, for tables that carry no SearchEngineName beside it.
		{Key: "bySearchEngineId", Column: "SearchEngineId", Label: "Search Engine", Viz: "stacked",
			LookupTable: "mediascan.SearchEngine", LookupID: "Id", Name: "Name"},
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
		{"crawled", "SUM(URLCrawledCount)", "URLCrawledCount"},
		// An enforcement notification, spelled three ways. NoticeSentCount is
		// the search-engine table's name for it and EnforcementCount the unified
		// table's; without both, the notices figure — and the two Enforcement
		// Notification cards that read it — never appears at all.
		/* No COUNT(DISTINCT SourceDMCANoticeId) form here, deliberately: the
		   enforcement-action KPIs are ROLE-PINNED and set by the action block
		   in inferSpec, because their columns now exist on both sports raw
		   tables and presence-matching would count the same actions on both
		   sides. The SUM forms below stay — they are the per-row counters the
		   other tables carry, and no second table shares those columns. */
		{"notices", "SUM(NoticeCount)", "NoticeCount"},
		{"notices", "SUM(NoticeSentCount)", "NoticeSentCount"},
		{"notices", "SUM(EnforcementCount)", "EnforcementCount"},
		{"googleDelisted", "COUNT(CASE WHEN IsGoogleDelisted=1 THEN 1 END)", "IsGoogleDelisted"},
		{"bingDelisted", "COUNT(CASE WHEN IsBingDelisted=1 THEN 1 END)", "IsBingDelisted"},
		// The audience the infringing pages were reaching — the Open Web
		// equivalent of a channel's subscribers.
		{"impactedTraffic", "SUM(ImpactedTraffic)", "ImpactedTraffic"},
		{"impactedTraffic", "SUM(Traffic)", "Traffic"},
		{"impactedTraffic", "SUM(MonthlyVisits)", "MonthlyVisits"},

		/* ── Mobile apps ────────────────────────────────────────────────────
		   The figures a store listing has and a link does not. Counted over
		   NAMES rather than ids: no id column identifies an app across all four
		   feeds — AppId is null on the third-party ones and PackageId repeats
		   across thousands of rows — so COUNT(DISTINCT AppId) would report the
		   store apps and label them the whole table. */
		{"totalApps", "COUNT(DISTINCT AppName)", "AppName"},
		{"totalCategories", "COUNT(DISTINCT CategoryName)", "CategoryName"},
		{"totalDevelopers", "COUNT(DISTINCT CompanyName)", "CompanyName"},
		{"installs", "SUM(InstallCount)", "InstallCount"},
		{"ratings", "SUM(RateCount)", "RateCount"},
		{"reviews", "SUM(ReviewCount)", "ReviewCount"},
		/* Averaged over RATED listings only. Zero means never rated, and a few
		   store rows carry a rating COUNT in this column — an unwindowed mean
		   over those reports thousands of stars out of five. */
		{"avgStars", "AVG(CASE WHEN StarsCount > 0 AND StarsCount <= 5 THEN StarsCount END)", "StarsCount"},
		/* Enforcement on any side, counted once. A listing enforced on both its
		   store page and its download counts as one enforced listing; adding the
		   columns counts it twice. */
		{"enforced", "COUNT(CASE WHEN EnforcementDoneAt IS NOT NULL " +
			"OR SourceEnforcementDoneAt IS NOT NULL " +
			"OR InfringingEnforcementDoneAt IS NOT NULL THEN 1 END)", "EnforcementDoneAt"},
		// The two sides separately: which one came down is the difference
		// between a delisted app and a dead download link.
		{"sourceRemoved", "COUNT(CASE WHEN SourceRemovalTime IS NOT NULL THEN 1 END)", "SourceRemovalTime"},
		{"infringingRemoved", "COUNT(CASE WHEN InfringingRemovalTime IS NOT NULL THEN 1 END)", "InfringingRemovalTime"},
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

/*
sportsHeadlineKPIs are the two figures the sports reports asked for.

Kept out of extraKPICandidates and out of inferSpec's body for one reason each:

  - `viewsImpacted` needs a PAIR of columns, and that table matches on one. The
    pair matters because of how getting it wrong fails: on a table with views and
    no removal status the CASE has nothing to test, the figure quietly equals
    total views, and the tile reads as "every view was taken down". An absent
    tile is the right answer there; a plausible wrong number is not.

  - the channel counts moved to channelKPIs, which owns both of them because the
    two can collapse into one figure and something has to decide that in one
    place.

The warehouse records "this row came down" in two different spellings and which
one a table uses is not something to assume — see removedRowTest. Whichever it
carries is the one used.

A function rather than inline code so it can be tested without a warehouse — see
sportskpis_test.go.
*/
/*
channelKPIs are the two channel counts, and whether this table has one of them or
both.

	totalChannels     the ACCOUNT — a URL where the table has one, else the name
	totalTVChannels   the STATION — see tvChannelColumn, which is where "which
	                  column is that" is answered for both code paths

Both, on a table that records accounts and stations separately. ONE where they
resolve to the same column, which happens on every table with no ChannelURL: the
two figures would then be the identical number — 326 on Open Web sports — and two
tiles reading 326 under two names is a report inviting the reader to hunt for a
difference that does not exist. The NAMED one survives, because it says what it
counts and it is the tile the sports reports were asked for.
*/
func channelKPIs(shape tableShape) map[string]string {
	out := map[string]string{}
	if ch := shape.firstOf([]string{colChannelURL, colChannelName}); ch != "" {
		out["totalChannels"] = fmt.Sprintf("COUNT(DISTINCT %s)", ch)
	}
	if col := tvChannelColumn(shape.has); col != "" {
		out["totalTVChannels"] = fmt.Sprintf("COUNT(DISTINCT %s)", col)
		if out["totalTVChannels"] == out["totalChannels"] {
			delete(out, "totalChannels")
		}
	}
	return out
}

func sportsHeadlineKPIs(shape tableShape) map[string]string {
	out := map[string]string{}
	/* Both halves or neither.

	   On a table with views and no removal marker the CASE would have nothing to
	   test, the figure would quietly equal total views, and the tile would read
	   "every view was taken down" — a plausible wrong number, which is worse
	   than the absent tile. */
	if v := shape.firstOf([]string{"Views", "TotalViews"}); v != "" {
		if test := removedRowTest(shape); test != "" {
			out["viewsImpacted"] = fmt.Sprintf("SUM(CASE WHEN %s THEN %s ELSE 0 END)", test, v)
		}
	}
	return out
}

/*
removedRowTest is how THIS table says a row came down.

Two spellings exist in the warehouse and a table carries one or the other:

	RemovalStatus = 'Dead'   the social and Telegram raw tables, where the
	                         column also holds 'Active' and empty — checked
	                         against the data, which is why this is an equality
	                         and not a LIKE
	IsRemoved = 1            the Open Web sports raw tables

Empty for a table that records neither, and that is the important case: the
daily ROLLUP tables (Youtube, Telegram master, the social dashboard, the unified
BI table) carry a summed RemovedCount beside a summed TotalViews, and no row-level
marker at all. On those, "views on the rows that came down" is not a number that
exists — a row is "on this day, 100 URLs, 40 of them removed, 1M views" and there
is nothing that says which views belonged to the 40. Returning empty is what keeps
the tile off those reports instead of inventing an attribution. ViewsSaved is the
warehouse's own answer to that question there, and it already has a tile.
*/
func removedRowTest(shape tableShape) string {
	if shape.has("RemovalStatus") {
		return "RemovalStatus = 'Dead'"
	}
	if shape.has("IsRemoved") {
		return "IsRemoved = 1"
	}
	return ""
}

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
	// Sports tables: DelistingBatchId on linking side, SourceDMCANoticeId on host side
	case shape.has("DelistingBatchId"):
		return "linking", "Linking"
	case shape.has("SourceDMCANoticeId"):
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

/*
closedSetDims names the panels whose rows are a FIXED list rather than a long
tail, so merging several tables into one platform keeps all of them instead of
cutting to a top 15.

The cut is right for domains, channels and assets, where the fifteenth row is
the fifteenth most infringed of thousands and the rest is a tail nobody reads.
It is wrong for a distribution: a turnaround bucket, a print quality or a match
day that fell off the end is a HOLE in the panel, and the reader has no way to
tell a bucket with no rows from a bucket that was truncated.
*/
var closedSetDims = map[string]bool{
	"byTAT": true, "byGroupType": true, "byQuality": true,
	"byFranchise": true, "byMatchDay": true,
	// One row per channel the platform reads — four of them, and the point is
	// the comparison, so none may be cut.
	dimSourcePlatform: true,
}

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

	/* The ENFORCEMENT ACTION this table records, counted per day beside the
	   volumes — see actionMeasures. One per table by construction: the notice id
	   is on the host table and the batch id on the linking one, which is why the
	   two halves of Open Web each get their own action trend rather than sharing
	   a card that would have to explain which column it was drawing. */
	for _, a := range actionMeasures {
		// Pinned to the table's side, not to whichever column happens to
		// exist: the two raw tables now share these columns, and matching on
		// presence alone would give both sides the FIRST action in this list —
		// the same number drawn twice under two titles.
		if a.Role != "" && a.Role != s.Role {
			continue
		}
		if col := shape.firstOf([]string{a.Column}); col != "" {
			s.ActionKey = a.Key
			s.ActionCol = col
			s.ActionExpr = fmt.Sprintf("COUNT(DISTINCT %s)", col)
			s.ActionLabel = a.Label
			/* And the headline tile, from the same resolution. Declared here
			   rather than in extraKPICandidates because those match on column
			   presence, which is no longer enough to say whose figure it is —
			   one pinned decision drives the tile, the daily series and the
			   trend card, so they cannot disagree. */
			s.ExtraKPI[a.Key] = s.ActionExpr
			break
		}
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
	for k, expr := range channelKPIs(shape) {
		s.ExtraKPI[k] = expr
	}
	for k, expr := range sportsHeadlineKPIs(shape) {
		s.ExtraKPI[k] = expr
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
		// A side-pinned panel matches only the table of its side, however many
		// tables carry its columns — see the Role field above.
		if d.Role != "" && d.Role != s.Role {
			continue
		}
		col := shape.firstOf(append([]string{d.Column}, d.Alts...))
		if col == "" {
			continue
		}
		/* The column this panel MEASURES, as opposed to the one it groups by.
		   Where the candidate declares alternates, Ident is a template and the
		   spelling this table happens to use is filled into it — so the panel
		   counts the column it just proved exists rather than a differently
		   spelled one that does not. */
		ident := d.Ident
		needed := ""
		if d.Needs != "" {
			needed = shape.firstOf(append([]string{d.Needs}, d.NeedsAlts...))
			if needed == "" {
				continue
			}
			if strings.Contains(ident, "%s") {
				ident = fmt.Sprintf(ident, needed)
			}
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
			"byDeliveryType", "byGenre", "byGenreId", "bySearchEngineNotices",
			// Two or three engines, and the point is the comparison between
			// them — a top-N would be the whole list wearing a cut-off's name.
			dimEngineDelistingBatches,
			// Day-wise action counts show every day of the chosen window; a
			// top-N here would silently drop days off the calendar.
			dimNoticesByDay, dimBatchesByDay,
			// A season's fixtures and a league's franchises are both closed
			// lists, and a report asked for "removal per match day" means every
			// match day — a top 15 would silently drop the rest of the season.
			"byFranchise", "byMatchDay":
			limit = 0
		// A long tail where the head is the report: the panels say "Top 10" and
		// mean it.
		case "byAsset", "byAssetName", "byKeyword",
			"byDomain", "byDomainSource", "byChannel",
			// Brands are a long tail too — thousands of them, and the panel
			// says "Top 10" by being one.
			"byDomainRoot", "byDomainRootMirrors",
			// Accounts are the longest tail of the lot, and this panel keeps
			// only the ten most persistent of them.
			dimRepeatOffender:
			limit = 10
		}
		s.Dimensions = append(s.Dimensions, dimension{
			Key: d.Key, Column: col, Label: d.Label, Limit: limit, Viz: d.Viz,
			LookupTable: lkTable, LookupIDCol: lkID, LookupName: lkName,
			IdentOverride: ident, RemovedOverride: d.Removed,
			APIMeasure: d.APIMeasure,
			// The id this panel counts distinct values of, where it counts one at
			// all — carried through so the API path can walk the raw rows for it.
			CountDistinctCol: needed,
		})
		/* First candidate to claim a slicer keeps it — so "language" filters on
		   LanguageName rather than being overwritten by LanguageId further down
		   the list, which is what made the dropdown list ids.

		   And only where the source can actually group by it. A filter the
		   backend will not answer is a control that renders empty forever, which
		   is worse than an absent one: the reader cannot tell it from a filter
		   whose values happen to be missing today. */
		if param := DIMFilterParam(d.Key); param != "" && apiCanGroupBy(table, col) {
			if _, taken := s.Filters[param]; !taken {
				s.Filters[param] = col
			}
		}
	}

	/* The provider slicer, on BOTH halves. The panel that groups by provider
	   is pinned to the host side, but the COLUMN exists on the linking table
	   too — and a filter only one spec declares EXCLUDES the other spec from a
	   filtered report entirely (see specHonoursFilters), so picking a provider
	   would amputate the linking half of the page rather than narrow it. The
	   panel is one side's; the filter belongs to every table that can honour
	   it. */
	if col := shape.firstOf([]string{"HSPName"}); col != "" && apiCanGroupBy(table, col) {
		if _, taken := s.Filters["hspName"]; !taken {
			s.Filters["hspName"] = col
		}
	}

	// Synthetic panel: the delisting comparison is three figures the KPI query
	// already returns, not a GROUP BY — so it is declared here (with no column,
	// which the runner skips) and assembled in runPlatform.
	if s.DelistedExpr != "" {
		s.Dimensions = append(s.Dimensions, dimension{
			Key: "byDelistingStatus", Label: "Search Engine De-Indexing - Identification & Removal",
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
	case "byCountry", "byCountryId":
		return "country"
	case "bySearchEngine", "bySearchEngineNotices", "bySearchEngineId":
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
	/* The provider a notice was sent to. Its own parameter — "domain" is the
	   site the content sits on, which is not the same party as the host that
	   answers the notice for it. */
	case dimHSPNotices, dimHSPDelisting:
		/* ONE slicer for both halves. The two panels count different actions
		   against the same party, and "show me this provider" means the same
		   thing on either — so clicking a bar on one narrows the other, rather
		   than the page carrying two provider filters that can disagree. */
		return "hspName"
	/* The engine a batch went to is the same engine `bySearchEngine` groups by,
	   so the two panels share one slicer and clicking either filters both. */
	case dimEngineDelistingBatches:
		return "searchEngine"
	/* Its own parameter, not "channel": that one filters on the display NAME,
	   and this panel's rows are URLs. Sending a URL to a name filter selects
	   nothing and empties the page. */
	case dimRepeatOffender:
		return "channelUrl"
	case "byGroupType":
		return "groupType"
	case "byQuality", "byQualityId":
		return "quality"
	case "byInfringementType", "byInfringementTypeId":
		return "infringementType"

	// ── Mobile apps ──────────────────────────────────────────────────────
	case "bySourceFeed":
		return "sourceFeed"
	case "byApp":
		return "appName"
	case "byCategory":
		return "category"
	case "byDeveloper":
		return "developer"
	case "byStoreType":
		return "storeType"
	case "byContentRating":
		return "contentRating"
	case "byRemovalStatus":
		return "removalStatus"

	// ── Sports: the asset's own attributes ───────────────────────────────
	// Named as the reports API names its dimensions, so the bridge's
	// column-to-dimension lookup resolves them without a second mapping.
	case "byFranchise":
		return "franchiseName"
	case "byMatchDay":
		return "matchDay"
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
	/*
		What this platform IS: a warehouse query, or an embedded Power BI report.

		Empty is read as "table" everywhere rather than as unset. Every platform
		that existed before this column did is a queried report, and a zero value
		that means the old behaviour is what lets the column be added without a
		migration pass over the rows.
	*/
	SourceKind string
	// The dashboard module a Power BI platform maps to. 0 when it has none,
	// which is a Power BI platform nobody can open yet — see powerBIReportFor.
	PowerBIModuleID int64
}

// A platform is a queried report unless it says otherwise.
func (p platformDef) isPowerBI() bool { return p.SourceKind == sourceKindPowerBI }

const (
	sourceKindTable   = "table"
	sourceKindPowerBI = "powerbi"
)

func loadPlatforms() []platformDef {
	ensurePlatformSchema()
	rows, err := db.Query("SELECT platform_key, label, sort_order, is_enabled, " +
		"COALESCE(source_kind, '') AS source_kind, " +
		"COALESCE(powerbi_module_id, 0) AS powerbi_module_id " +
		"FROM " + platformTable + " ORDER BY sort_order, label")
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
		kind := strings.ToLower(strings.TrimSpace(strFromAny(r["source_kind"])))
		if kind != sourceKindPowerBI {
			// Anything unrecognised is a queried report, which is what every
			// platform written before this column was one.
			kind = sourceKindTable
		}
		out = append(out, platformDef{
			Key: key, Label: strFromAny(r["label"]),
			Order: numOf(r["sort_order"]), Enabled: numOf(r["is_enabled"]) == 1,
			Tables:     tablesBy[key],
			SourceKind: kind, PowerBIModuleID: numOf(r["powerbi_module_id"]),
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

	/* Real names are Super Admin only AND asked for explicitly.

	   Two conditions, not one. Being a Super Admin is permission to see them;
	   it is not a reason to be shown them on every visit. The default view of
	   this screen is the aliased one for everybody, and a name appears only when
	   somebody has said they want it — which is the same shape as revealing an
	   API key, and for the same reason: the routine act (rename a report, hide
	   one from the sidebar) does not need the sensitive value, so it should not
	   put it on screen where it can be read over a shoulder or captured in a
	   screen share.

	   Decided HERE rather than in the page, because a payload the browser is
	   trusted to hide is a payload that was still sent: the names would be in
	   the response, in the network tab, and in anything that logs one. */
	canReveal := maySeeWarehouseNames(r)
	reveal := canReveal && r.URL.Query().Get("reveal") == "1"

	out := []map[string]any{}
	for _, p := range loadPlatforms() {
		item := map[string]any{
			"key": p.Key, "label": p.Label, "order": p.Order,
			"enabled": p.Enabled,
			/* What the platform IS. Reported to everyone who can open this
			   screen, aliased view included: which kind of report a platform is
			   says nothing about a warehouse table, and a page that cannot see
			   it would draw the table controls for a Power BI report. */
			"sourceKind":      p.SourceKind,
			"powerbiModuleId": p.PowerBIModuleID,
			// Always. The aliased view is the default one, whoever is looking.
			"tableCount": len(p.Tables),
			"sources":    sourceSummaryFor(p),
		}
		/* `tables` is what the page saves back, so it is present only when the
		   real names are — a list of aliases here would be a list of aliases
		   written into the platform's configuration the next time anyone
		   renamed it. */
		if reveal {
			item["tables"] = p.Tables
		}
		if withShape && reveal {
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
	/* The dashboards a Power BI platform can point at, sent with the list so the
	   picker needs no second request. Read from dcp_module, which is what
	   /admin/dashboards assigns per client — see reportpowerbi.go. */
	mods := []map[string]any{}
	if rows, err := db.Query(
		"SELECT moduleId, moduleName FROM dcp_module WHERE deleted = 0 ORDER BY moduleName"); err == nil {
		for _, m := range rows {
			mods = append(mods, map[string]any{
				"moduleId": numOf(m["moduleId"]), "moduleName": strFromAny(m["moduleName"]),
			})
		}
	}

	OK(w, map[string]any{
		"success": true, "platforms": out, "configured": reportsBackendReady(),
		"dashboardModules": mods,
		// What the page may offer, decided by the server. A screen that works
		// out its own permissions works them out from what it was sent, and
		// what it was sent is the thing being restricted.
		"canEditSources": canReveal,
		// Whether this response actually carries them, so the page never has to
		// guess which of the two shapes it is holding.
		"revealed": reveal,
	})
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
		/* 'table' or 'powerbi'. Absent is read as 'table', so a caller written
		   before this existed keeps saving queried reports. */
		SourceKind      string `json:"sourceKind"`
		PowerBIModuleID int64  `json:"powerbiModuleId"`
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

	/* An admin who may not SEE the sources may not change them either.
	   Renaming a platform, hiding it from the sidebar and reordering it all
	   stay open — they are what the report-config grant is for — but the table
	   list is carried over from what is stored rather than taken from the
	   request, because the request could not have known it.

	   Silently ignoring the field would be worse than refusing: the page would
	   report a successful save of something it did not save. */
	if !maySeeWarehouseNames(r) {
		stored := storedTablesFor(key)
		if len(stored) == 0 {
			Fail(w, 403, "Only a Super Admin may create a report platform, because it has to name the warehouse sources behind it")
			return
		}
		if len(clean) > 0 && !sameStrings(clean, stored) {
			Fail(w, 403, "Only a Super Admin may change the warehouse sources behind a report")
			return
		}
		clean = stored
	}

	/*
		A queried report unless Power BI is chosen, and the module comes with it.

		Validated as a PAIR rather than separately: 'powerbi' with no module is a
		report nobody can open, and a module with kind 'table' is a value that
		changes nothing and will confuse whoever reads the row next. So the kind
		decides whether the module is kept at all.
	*/
	kind := strings.ToLower(strings.TrimSpace(body.SourceKind))
	if kind != sourceKindPowerBI {
		kind = sourceKindTable
	}
	var moduleID any
	if kind == sourceKindPowerBI {
		if body.PowerBIModuleID <= 0 {
			Fail(w, 422, "Choose which dashboard this Power BI report is")
			return
		}
		/* Checked against dcp_module, because the alternative is a platform
		   pointing at a module id that does not exist — which fails for the
		   READER, on a report page, with nothing to say why. */
		if row, err := db.QueryOne(
			"SELECT moduleId FROM dcp_module WHERE moduleId = ? AND deleted = 0 LIMIT 1",
			body.PowerBIModuleID); err != nil || row == nil {
			Fail(w, 422, "That dashboard no longer exists")
			return
		}
		moduleID = body.PowerBIModuleID
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
		INSERT INTO `+platformTable+`
		  (platform_key, label, sort_order, is_enabled, source_kind, powerbi_module_id, updated_by)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE label=VALUES(label), sort_order=VALUES(sort_order),
		  is_enabled=VALUES(is_enabled), source_kind=VALUES(source_kind),
		  powerbi_module_id=VALUES(powerbi_module_id), updated_by=VALUES(updated_by)`,
		key, label, order, enabled, kind, moduleID, who); err != nil {
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
	/* Deleting a platform discards the mapping to its warehouse sources, and
	   putting it back means naming them again — which only a Super Admin can
	   do. Leaving delete open to everyone else would let a change be made that
	   only somebody else can undo. */
	if !requireWarehouseNames(w, r) {
		return
	}
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
func runPlatform(p platformDef, q map[string]string, bg bool) map[string]any {
	specs, skipped := specsForPlatform(p)

	/* How many sides this platform HAS, counted before the slicer takes one
	   away.

	   The layout is built from the same unfiltered specs — see rolesForPlatform —
	   so it draws a trend card per side whatever the reader has selected. The
	   per-source figures at the bottom of this function therefore have to be
	   emitted on the same test: on what the PLATFORM offers, not on how many
	   sides survived the filter. Keyed off the survivors instead, picking one
	   side left the selected card with nothing in it and the page said "No host
	   data for this period" over a table holding 27,115 rows. */
	platformRoles := rolesIn(specs)

	/* Which SIDE of the open web, where the reader has picked one. Applied
	   HERE, before anything below has run, because this slicer removes a whole
	   table rather than narrowing what one returns: every KPI, trend and
	   breakdown under it is then built from the remaining side alone, and the
	   merge that adds the two together has nothing to add. See sourcetype.go. */
	specs = specsForSourceType(specs, q)
	if len(specs) == 0 {
		return map[string]any{
			"ok": false, "available": true, "type": p.Key, "label": p.Label,
			"error":         "None of this platform's tables can be read — check Report Configuration",
			"skippedTables": skipped,
		}
	}

	/* The configured top-N, applied to the SPEC rather than to the answer.

	   Before a single query runs, because the limit decides how many rows are
	   ASKED for. Trimming the result instead would leave "Top 5" costing
	   exactly what "Top 50" costs, on a warehouse where these are the expensive
	   panels.

	   This changes N and nothing else. A platform reading several tables still
	   takes each table's own top-N and merges them, which is an approximation
	   of the overall top-N — it can miss a value that is eleventh everywhere
	   and first in total. That is how the default already worked at ten; the
	   approximation is not introduced here, and it is no worse at five. */
	if limits := dimRowLimits(p.Key, q["clientId"], sectionDimensions(p)); len(limits) > 0 {
		for i := range specs {
			for j := range specs[i].Dimensions {
				if n, ok := limits[specs[i].Dimensions[j].Key]; ok && n > 0 {
					specs[i].Dimensions[j].Limit = n
				}
			}
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
	// Caveats: things a reader should know about a panel that DID load.
	notices := []string{}
	// Per-channel totals for the synthetic comparison panel — see
	// sourceChannelName. Order is the platform's own table order, kept so a
	// channel with no rows still reads in a predictable place.
	channelKPI := map[string]map[string]int64{}
	channelOrder := []string{}
	ran := 0
	// Per-source, for platforms whose tables are not the same kind of thing.
	roleKPI := map[string]map[string]int64{}
	/* Open Web's share of `removed`, per window, so the live figure can be swapped
	   in for it — see openWebLiveRemoved. Attributed BY TABLE and not by role: the
	   role is inferred from the presence of an InfringingDomain column, which the
	   mobile-apps table also has, and attributing by it put Open Web's 10,263
	   removals onto a Mobile Apps page whose identified count was 0. */
	var openWebETLNow, openWebETLPrev int64
	sawOpenWebTable := false
	roleDaily := map[string]map[string]map[string]int64{}
	roleLabels := map[string]string{}
	// The enforcement action each side records, by role — see
	// enforcementactions.go. At most one per role, because at most one of a
	// role's tables carries an action id at all.
	roleAction := map[string]string{}

	/* ── The platform's tables, together ──────────────────────────────────
	   A platform reading two tables ran them one after the other, so Open Web
	   Sports paid twice the latency of either — on every drill-down, which is
	   not cacheable and therefore pays it every click. The tables are
	   independent reads; only the MERGE below has to be ordered, and it still
	   is, because the parts are collected into a slice indexed by spec and
	   folded together afterwards.

	   The same shape runSummary already uses for platforms. Concurrency is
	   bounded there by summaryConcurrency; here the count is the number of
	   tables a platform reads, which is one or two. */
	parts := make([]map[string]any, len(specs))
	var specWG sync.WaitGroup
	/* Bounded. Each spec runs its own panels concurrently, so unbounded here
	   multiplies: the sports summary reads FIVE tables of thirty-one panels,
	   which would be forty concurrent aggregates from one page load — and the
	   warehouse is shared with every other reader. */
	specGate := make(chan struct{}, 3)
	for i, sp := range specs {
		// A table that cannot apply an active slicer is left out entirely rather
		// than contributing its unfiltered total to a filtered figure.
		if !specHonoursFilters(sp, q) {
			continue
		}
		specWG.Add(1)
		go func(i int, sp reportSpec) {
			defer specWG.Done()
			specGate <- struct{}{}
			defer func() { <-specGate }()
			parts[i] = runSpec(sp, q, bg)
		}(i, sp)
	}
	specWG.Wait()

	for i, s := range specs {
		part := parts[i]
		if part == nil {
			continue
		}
		ran++
		if wv, ok := part["queryWarning"].(string); ok && wv != "" {
			warnings = append(warnings, wv)
		}
		/* Deduped across the platform's tables. A caveat about a panel is about
		   the PANEL, and a platform reading two tables would otherwise say the
		   same sentence twice. */
		for _, n := range asStrings(part["notices"]) {
			if !containsString(notices, n) {
				notices = append(notices, n)
			}
		}
		role := s.Role
		if role != "" {
			roleLabels[role] = s.RoleLabel
			if s.ActionKey != "" {
				roleAction[role] = s.ActionKey
			}
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
				/* Not all of these add up. A distinct count of a dimension the
				   tables SHARE — totalAssets — merges by max, because the same
				   title appears in every table and summing counts the tables.
				   See reportdistinct.go. */
				mergeKPI(kpi, k, numOf(v))
				if role != "" {
					mergeKPI(roleKPI[role], k, numOf(v))
				}
			}
			if isOpenWebSportsTable(s.Table) {
				sawOpenWebTable = true
				openWebETLNow += numOf(pk["removed"])
			}
			/* This source's own share, kept before it is added into the total.
			   Identical channel names merge, which is what folds the linking and
			   hosting halves of the open web into one bar. */
			ch := sourceChannelName(s.Table)
			if channelKPI[ch] == nil {
				channelKPI[ch] = map[string]int64{}
				channelOrder = append(channelOrder, ch)
			}
			channelKPI[ch]["identified"] += numOf(pk["identified"])
			channelKPI[ch]["removed"] += numOf(pk["removed"])
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
			if isOpenWebSportsTable(s.Table) {
				openWebETLPrev += numOf(pp["removed"])
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
			/* The enforcement action, under its own key. Summed like the rest
			   and safe to sum: only ONE table per role records an action, so
			   there is never a second source counting the same notice again. */
			if s.ActionKey != "" {
				roleDaily[role][d][s.ActionKey] += numOf(row[s.ActionKey])
			}
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
					/* Recurrence is a DAY COUNT, so it is merged by taking the
					   largest rather than by adding.

					   Two tables that both saw an account on the same Saturday
					   saw it on one day, not two, and summing them can hand the
					   panel more days than the window holds — a figure the card
					   presents as a fact about the calendar. The largest of the
					   two is the most days any one source can actually vouch
					   for, and it can only understate. Absent from every other
					   panel's rows, where numOf reads the missing key as 0 and
					   this is a no-op. */
					if v := numOf(row["repeats"]); v > breakdowns[key][label]["repeats"] {
						breakdowns[key][label]["repeats"] = v
					}
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

	/* Open Web's removal is the realtime endpoint's, not the ETL's.

	   Everything else on this band is summed exactly as it was. Open Web alone is
	   swapped, because the ETL keeps only the LATEST capture's delisting flag and
	   thereby under-reports takedowns it has a record of — 7,066 against 10,263 on
	   the asset this was measured against. See openWebLiveRemoved for the
	   mechanism, the window it asks for, and why it fails open.

	   Taken out and added back rather than recomputed: the ETL's share is exactly
	   roleKPI linking + host, so the swap cannot disturb any other platform's
	   contribution. `pending` and `removalPct` below are derived from the result,
	   so both follow without being touched here. */
	if sawOpenWebTable {
		if live, ok := openWebLiveRemoved(q["clientId"], q["assetId"], q["from"], q["to"]); ok {
			removed = max64(0, removed-openWebETLNow+live)
		}
	}

	/* The reader named the assets, so the count of titles in scope is how many
	   they named — exact, and needing no query. Applied after the merge so it
	   wins over the estimate above. */
	applyAssetScope(kpi, q)

	kpiOut := map[string]any{}
	for k, v := range kpi {
		kpiOut[k] = v
	}
	// After the swap, or the band would show the ETL figure beside a rate
	// computed from the live one.
	kpiOut["removed"] = removed
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
		// The same swap on the preceding window, so the change arrow compares two
		// figures of one definition. See isOpenWebSportsTable.
		if sawOpenWebTable {
			if live, ok := openWebLiveRemoved(q["clientId"], q["assetId"], prevFrom, prevTo); ok {
				pRemoved = max64(0, pRemoved-openWebETLPrev+live)
				kpiPrevOut["removed"] = pRemoved
			}
		}
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
			if key == dimRepeatOffender {
				row["repeats"] = m["repeats"]
			}
			rows = append(rows, row)
		}
		/* Ranked by RECURRENCE, then cut to ten — the order and the cut this one
		   panel exists for. Sorting it by volume like the others and then taking
		   the top fifteen would keep the fifteen busiest accounts and rank them
		   by a measure the chart does not draw, which is a different card under
		   the same title. */
		if key == dimRepeatOffender {
			sortRepeatRows(rows)
			if len(rows) > repeatOffenderLimit {
				rows = rows[:repeatOffenderLimit]
			}
			bdOut[key] = rows
			continue
		}
		sort.Slice(rows, func(i, j int) bool { return numOf(rows[i]["urls"]) > numOf(rows[j]["urls"]) })
		if len(rows) > 15 && !closedSetDims[key] {
			rows = rows[:15]
		}
		bdOut[key] = rows
	}

	/* The channel comparison, assembled rather than queried.

	   Ranked by volume like every other breakdown, and every channel is kept
	   however small: four bars where one is short is the comparison. A channel
	   that contributed nothing still appears, at zero, because "Telegram found
	   nothing this month" is an answer and an absent bar is not. */
	if len(channelOrder) > 1 {
		rows := make([]map[string]any, 0, len(channelOrder))
		for _, ch := range channelOrder {
			rows = append(rows, map[string]any{
				"label": ch,
				// No `value`: a channel is not a column, so there is nothing a
				// click could filter on.
				"urls":    channelKPI[ch]["identified"],
				"removed": channelKPI[ch]["removed"],
			})
		}
		sort.SliceStable(rows, func(i, j int) bool {
			return numOf(rows[i]["urls"]) > numOf(rows[j]["urls"])
		})
		bdOut[dimSourcePlatform] = rows
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
		/* The enforcement ACTION total this side records, if any. The day-wise
		   figures are breakdown panels now (dimNoticesByDay, dimBatchesByDay), so
		   no actionKey is emitted — emitting it is what made the page draw the
		   Day-on-Day trend cards this replaced. */
		if key := roleAction[role]; key != "" {
			src["actionTotal"] = rk[key]
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
	/* Emitted when the PLATFORM has more than one side, not when more than one
	   survived the slicer — see platformRoles above.

	   The distinction did not exist before the Source Type filter: a report with
	   one role was a single-role platform, whose layout draws one merged trend
	   and wants none of this. Now a two-sided platform can legitimately return
	   one side, and its layout still has both cards to fill. */
	if len(platformRoles) > 1 {
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
			{"label": "De-Indexed Status Bing", "urls": kpi["bingDelisted"]},
			{"label": "De-Indexed Status Google", "urls": kpi["googleDelisted"]},
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
	if len(notices) > 0 {
		merged["notices"] = notices
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

// containsString is the membership test the notice merge needs; a platform
// reading two tables must not say the same caveat twice.
func containsString(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}

/*
dimFilterParamHasPanel says whether any dimension in the registry maps to this
slicer parameter.

It is what lets a slicer follow its panel out of a report without taking the
ones that never had a panel with it: a parameter no dimension names — nothing
in the layout can hide it, so nothing should.
*/
func dimFilterParamHasPanel(param string) bool {
	for _, d := range dimensionCandidates {
		if DIMFilterParam(d.Key) == param {
			return true
		}
	}
	return false
}

/*
── Which CHANNEL a table represents ─────────────────────────────────────────

	A platform that reads several tables reads several kinds of place: Summary -
	Sports covers the open web, social media, Telegram and the app stores, and
	the first question anyone asks of it is how the four compare. Nothing in the
	merged report answers that — the tables are added together and the split is
	gone.

	So each source is given the name of the channel it describes, and identical
	names merge. That last part is the point: the open web arrives as TWO tables,
	the pages that link to infringing content and the ones that host it, and they
	are one channel to a reader comparing the open web against Telegram.

	Matched on the table name, in order, because the warehouse encodes the
	channel there and nowhere else — there is no column on the row and no field
	in the platform configuration that says "this is the Telegram table". The
	specific names are tested before the general one: a mobile-apps table also
	contains "url" columns, and "Sports" appears in all of them.

	A table matching nothing falls back to the label reports_api gives its
	dataset, and then to the table's own name. Both are worse than a channel name
	and neither is wrong — an unrecognised source is shown as itself rather than
	folded into a neighbour or dropped.
*/
var sourceChannelNames = []struct{ Fragment, Name string }{
	{"telegram", "Telegram"},
	{"socialmedia", "Social Media / UGC"},
	{"mobileapps", "Mobile Apps"},
	{"youtube", "YouTube"},
	{"searchengine", "Search Engine"},
	// Last: the URL tables are the open web, and every other table above also
	// holds URLs.
	{"url", "Open Web"},
}

func sourceChannelName(table string) string {
	t := strings.ToLower(table)
	for _, c := range sourceChannelNames {
		if strings.Contains(t, c.Fragment) {
			return c.Name
		}
	}
	if reportsViaAPI() {
		if ds, ok := reportsapi.Get().ByTable(context.Background(), table); ok && ds.Label != "" {
			return ds.Label
		}
	}
	// The bare name, minus the schema, so the panel says something rather than
	// nothing.
	if i := strings.LastIndex(table, "."); i >= 0 && i+1 < len(table) {
		return table[i+1:]
	}
	return table
}

// sourceChannelsFor is the distinct channels a platform covers, in reading
// order. Two or more is what makes the per-channel comparison meaningful — for a
// single-channel platform the panel would be one bar equal to the KPI band.
func sourceChannelsFor(p platformDef) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, t := range p.Tables {
		n := sourceChannelName(t)
		if n == "" || seen[n] {
			continue
		}
		seen[n] = true
		out = append(out, n)
	}
	return out
}

// dimSourcePlatform is the synthetic panel key. Synthetic because there is no
// column to GROUP BY: the rows are each source's own totals, which the merge
// already has in hand.
const dimSourcePlatform = "bySourcePlatform"
