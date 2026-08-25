package handlers

// Report specifications — one config row per report section.
//
// Ported from the six MadiaScanAnalytics report routes (social-report,
// telegram-report-new, youtube-report, internet-report, social-media-ugc,
// search-engine). Those are six near-identical handlers that differ only in
// which warehouse table they read, what the measure columns are called, and
// which dimensions they group by — so rather than copy six handlers, the
// differences live here as data and one handler (ReportsData) executes them.
//
// Adding a report is a row in this table. Getting a column name wrong shows up
// as an empty panel, not a crash: every query is run independently and a failure
// leaves that panel blank (see the `run` helper in reports.go).
//
// COLUMN NAMES ARE TAKEN FROM THE SOURCE PROJECT'S SQL, not from the live
// schema — they have not been verified against the warehouse. `/api/reports/spec
// -check?type=` compares a spec against information_schema and reports which
// columns are missing, which is the fastest way to correct one of these rows.

type dimension struct {
	Key    string // response key: byLanguage, byPlatform, …
	Column string // column to group by
	Label  string // human label, for the UI
	Limit  int    // 0 → no LIMIT

	// Id columns are useless as labels — an asset reads as a GUID, not a title.
	// When set, the grouped query LEFT JOINs this lookup and groups by the name,
	// falling back to the id when the join misses.
	LookupTable string // e.g. mediascan.Asset
	LookupIDCol string // e.g. Id
	LookupName  string // e.g. AssetName

	// How the page should draw it: bars | donut | table | stacked. Empty → bars.
	Viz string

	// Measure overrides, for a panel that counts something other than the
	// section's own measure. The search-engine notification panel counts notices
	// sent, not URLs found, over the same grouping column — same shape, different
	// number. Empty means the spec's own IdentExpr / RemovedExpr.
	IdentOverride   string
	RemovedOverride string

	// The reports_api measure this panel reads in place of the section's own.
	// Only the API path uses it — the direct-to-warehouse path has the SQL in
	// IdentOverride — and without it a panel titled "Enforcement Notification"
	// draws the identified count, which is a plausible number under a title that
	// promises a different one.
	APIMeasure string

	/* The column this panel counts DISTINCT VALUES of, as resolved against the
	   table — the id in `COUNT(DISTINCT …)`, not the column it groups by.

	   The direct path has it inside IdentOverride, already spelled into the SQL.
	   The API path cannot: a breakdown returns one aggregated row per group, so
	   the id is not on the rows it hands back and the count has to be walked over
	   the RAW rows instead. Naming the column here is what makes that possible —
	   see enforcementactions.go. */
	CountDistinctCol string

	// A dimension with no Column is SYNTHETIC: the page shows a panel for it but
	// there is no GROUP BY behind it, because the rows are assembled from figures
	// the report already has (see byDelistingStatus in runPlatform). The runner
	// skips these; the merge fills them in.
}

type reportSpec struct {
	Key   string // api `type` value
	Label string
	Table string

	// ExtraTables are the other tables this platform reads. Only used when
	// seeding a fresh install (see seedPlatformsFromRegistry) — after that the
	// table list lives in report_platform_table, where an admin can edit it.
	ExtraTables []string

	// What this table describes, when a platform reads more than one kind:
	// "linking" for the pages that link to infringing content, "host" for the
	// ones that serve it. Empty where the distinction does not apply. Derived,
	// never configured — see inferRole.
	Role      string
	RoleLabel string

	ClientCol string // column holding the client id
	DateCol   string // column the date range filters on
	AssetCol  string

	// Human names for the id columns. A warehouse table either carries the name
	// alongside the id (ClientName) or only the id, in which case the name comes
	// from the operational schema — mediascan.ClientMaster.CompanyName for a
	// client, mediascan.Asset.AssetName for an asset. Without this a slicer lists
	// raw ids, which nobody can pick from.
	ClientNameCol    string // name column in this table, if it has one
	AssetNameCol     string // ditto for assets
	JoinClientMaster bool   // resolve client names via mediascan.ClientMaster
	JoinAssetMaster  bool   // resolve asset names via mediascan.Asset
	// Measures. Raw-row tables count rows; the Agg_Daily_* tables carry
	// pre-summed counts, so the expressions differ per report.
	IdentExpr   string
	RemovedExpr string

	// Delisted is a THIRD measure, and only the linking side has it: a link that
	// search engines have dropped is not the same event as a page that came down,
	// and the report tracks both. Empty where the table carries no delisting
	// flags.
	DelistedExpr string

	/* The ENFORCEMENT ACTION this table records — the notice that was sent or
	   the batch that was submitted, counted once each rather than once per URL
	   it covered. See enforcementactions.go.

	   ActionKey is the portal figure it is ("notices", "delistingBatches"),
	   which is also the key the daily rows carry it under and the name the API
	   path asks reports_api for. ActionExpr is the SQL for the direct path, and
	   ActionLabel is what a card calls it. All three empty on a table that
	   records no enforcement action of its own, which is every table but the two
	   sports raw ones. */
	ActionKey   string
	ActionExpr  string
	ActionLabel string
	/* The id column ActionExpr counts distinct values of, on its own. The API
	   path has no aggregate for it — reports_api declares no such measure — so
	   the tile and the daily series are counted over the raw rows, and that walk
	   needs the column NAME rather than the SQL wrapped around it. */
	ActionCol string

	// Optional extra KPI expressions, keyed by the name the UI reads.
	ExtraKPI map[string]string

	// Dimensions offered as breakdown panels and as slicers.
	Dimensions []dimension

	// Columns exposed as filter slicers (query param → column).
	Filters map[string]string
}

// reportSpecs is the registry. Keys are the `type` values the page sends.
var reportSpecs = map[string]reportSpec{

	// ── Open Web: raw infringing-URL rows ────────────────────────────────────
	//
	// TWO tables, because Open Web enforcement has two halves: the pages that
	// LINK to infringing content and the ones that HOST it. They are counted
	// separately (a link is delisted, a host is taken down) and the report shows
	// both trends side by side, so they belong to one platform rather than two —
	// see inferRole and dailyBySource.
	"open-web": {
		Key: "open-web", Label: "Open Web",
		Table:       "dashboards.InternetInfringingURLMainDashboardTable",
		ExtraTables: []string{"dashboards.InternetSourceURLMainDashboardTable"},
		ClientCol:   "ClientId", DateCol: "URLUploadDate", AssetCol: "AssetId",
		ClientNameCol: "ClientName", JoinAssetMaster: true,
		IdentExpr:   "COUNT(*)",
		RemovedExpr: "COUNT(CASE WHEN IsRemoved=1 THEN 1 END)",
		ExtraKPI: map[string]string{
			"googleDelisted": "COUNT(CASE WHEN IsGoogleDelisted=1 THEN 1 END)",
			"bingDelisted":   "COUNT(CASE WHEN IsBingDelisted=1 THEN 1 END)",
			"totalDomains":   "COUNT(DISTINCT InfringingDomain)",
			"totalAssets":    "COUNT(DISTINCT AssetId)",
		},
		Dimensions: []dimension{
			{Key: "byDomain", Column: "InfringingDomain", Label: "Top Domains", Limit: 15},
			{Key: "byAsset", Column: "AssetId", Label: "Assets", Limit: 15},
			{Key: "byLanguage", Column: "LanguageName", Label: "Languages", Limit: 15},
			{Key: "byCountry", Column: "CountryName", Label: "Countries", Limit: 15},
			{Key: "byTAT", Column: "TATBucket", Label: "Turnaround", Limit: 0},
		},
		Filters: map[string]string{
			"assetId": "AssetId", "language": "LanguageName",
			"country": "CountryName", "tatBucket": "TATBucket",
		},
	},

	// ── Source / host URLs ───────────────────────────────────────────────────
	"source-url": {
		Key: "source-url", Label: "Source URLs",
		Table:     "dashboards.InternetSourceURLMainDashboardTable",
		ClientCol: "ClientId", DateCol: "URLUploadDate", AssetCol: "AssetId",
		ClientNameCol: "ClientName", JoinAssetMaster: true,
		IdentExpr:   "COUNT(*)",
		RemovedExpr: "COUNT(CASE WHEN IsRemoved=1 THEN 1 END)",
		ExtraKPI: map[string]string{
			"totalDomains": "COUNT(DISTINCT SourceDomain)",
			"totalAssets":  "COUNT(DISTINCT AssetId)",
		},
		Dimensions: []dimension{
			{Key: "byDomain", Column: "SourceDomain", Label: "Top Domains", Limit: 15},
			{Key: "byAsset", Column: "AssetId", Label: "Assets", Limit: 15},
			{Key: "byTAT", Column: "TATBucket", Label: "Turnaround", Limit: 0},
		},
		Filters: map[string]string{"assetId": "AssetId", "tatBucket": "TATBucket"},
	},

	// ── Search Engine discovery (pre-aggregated daily) ───────────────────────
	"search-engine": {
		Key: "search-engine", Label: "Search Engine",
		Table:     "dashboards.Agg_Daily_InternetSearchEngineDiscovery",
		ClientCol: "ClientId", DateCol: "URLUploadDate", AssetCol: "AssetId",
		JoinClientMaster: true, JoinAssetMaster: true,
		IdentExpr:   "SUM(IdentifiedCount)",
		RemovedExpr: "SUM(RemovedCount)",
		ExtraKPI: map[string]string{
			"crawled": "SUM(CrawledCount)",
			"notices": "SUM(NoticeCount)",
		},
		Dimensions: []dimension{
			{Key: "bySearchEngine", Column: "SearchEngineName", Label: "Search Engines", Limit: 0},
			{Key: "byAsset", Column: "AssetId", Label: "Assets", Limit: 15},
			{Key: "byCountry", Column: "CountryName", Label: "Countries", Limit: 15},
		},
		Filters: map[string]string{"assetId": "AssetId", "searchEngine": "SearchEngineName", "country": "CountryName"},
	},

	// ── YouTube (pre-aggregated daily) ───────────────────────────────────────
	"youtube": {
		Key: "youtube", Label: "YouTube",
		Table:     "dashboards.Agg_Daily_Youtube_MasterNew",
		ClientCol: "ClientId", DateCol: "URLUploadDate", AssetCol: "AssetId",
		JoinClientMaster: true, JoinAssetMaster: true,
		IdentExpr:   "SUM(TotalCount)",
		RemovedExpr: "SUM(RemovedCount)",
		ExtraKPI: map[string]string{
			"views":               "SUM(TotalViews)",
			"viewsSaved":          "SUM(ViewsSaved)",
			"impactedSubscribers": "SUM(Subscribers)",
			"channelsSuspended":   "COUNT(DISTINCT CASE WHEN ChannelStatus LIKE '%Suspend%' THEN ChannelURL END)",
			"totalChannels":       "COUNT(DISTINCT ChannelURL)",
		},
		Dimensions: []dimension{
			{Key: "byChannel", Column: "ChannelName", Label: "Channels", Limit: 15},
			{Key: "byAsset", Column: "AssetId", Label: "Assets", Limit: 15},
			{Key: "byInfringementType", Column: "InfringementType", Label: "Infringement Type", Limit: 15},
		},
		Filters: map[string]string{"assetId": "AssetId", "channel": "ChannelName", "infringementType": "InfringementType"},
	},

	// ── Telegram (pre-aggregated daily) ──────────────────────────────────────
	"telegram": {
		Key: "telegram", Label: "Telegram",
		Table:     "dashboards.Agg_Daily_Telegram_MasterNew",
		ClientCol: "ClientId", DateCol: "URLUploadDate", AssetCol: "AssetId",
		JoinClientMaster: true, JoinAssetMaster: true,
		IdentExpr:   "SUM(TotalCount)",
		RemovedExpr: "SUM(RemovedCount)",
		ExtraKPI: map[string]string{
			"views":               "SUM(TotalViews)",
			"viewsSaved":          "SUM(ViewsSaved)",
			"impactedSubscribers": "SUM(Subscribers)",
			"totalChannels":       "COUNT(DISTINCT ChannelName)",
		},
		Dimensions: []dimension{
			{Key: "byChannel", Column: "ChannelName", Label: "Channels", Limit: 15},
			{Key: "byAsset", Column: "AssetId", Label: "Assets", Limit: 15},
			{Key: "byGroupType", Column: "GroupType", Label: "Group Type", Limit: 0},
			{Key: "byQuality", Column: "QualityOfPrint", Label: "Print Quality", Limit: 0},
			{Key: "byTAT", Column: "TATBucket", Label: "Turnaround", Limit: 0},
		},
		Filters: map[string]string{
			"assetId": "AssetId", "channel": "ChannelName",
			"groupType": "GroupType", "quality": "QualityOfPrint", "tatBucket": "TATBucket",
		},
	},

	// ── Social Media / UGC ───────────────────────────────────────────────────
	"social": {
		Key: "social", Label: "Social Media / UGC",
		Table:     "dashboards.SocialMediaDashboard",
		ClientCol: "ClientMasterId", DateCol: "URLUploadDate", AssetCol: "AssetId",
		JoinClientMaster: true, JoinAssetMaster: true,
		IdentExpr:   "SUM(TotalInfringements)",
		RemovedExpr: "SUM(TotalRemoved)",
		ExtraKPI: map[string]string{
			"views": "SUM(TotalViews)",
			"likes": "SUM(TotalLikes)",
		},
		Dimensions: []dimension{
			{Key: "byPlatform", Column: "Platform", Label: "Platforms", Limit: 0},
			{Key: "byAsset", Column: "AssetId", Label: "Assets", Limit: 15},
			{Key: "byLanguage", Column: "LanguageId", Label: "Languages", Limit: 15},
			{Key: "byGenre", Column: "GenreId", Label: "Genres", Limit: 15},
			{Key: "byInfringementType", Column: "InfringementTypeId", Label: "Infringement Type", Limit: 15},
		},
		Filters: map[string]string{
			"assetId": "AssetId", "platform": "Platform", "language": "LanguageId",
			"genre": "GenreId", "infringementType": "InfringementTypeId",
		},
	},

	// ── Open Web - Sports (enforcement actions) ──────────────────────────────
	//
	// TWO separate tables, treated as two halves of one report by the dashboard:
	// the pages that LINK to infringing content and the ones that HOST it.
	// Both carry enforcement action ids, so they report not just the URLs but
	// the actions themselves, distinct-counted.
	//
	// The linking side (SportsURLRawData) tracks delisting batches.
	// The host side (SportsSourceURLRawData) tracks notices.
	"open-web-sports": {
		Key: "open-web-sports", Label: "Open Web - Sports",
		Table:     "dashboards.SportsURLRawData",
		ClientCol: "ClientId", DateCol: "URLUploadDate", AssetCol: "AssetId",
		IdentExpr:   "COUNT(*)",
		RemovedExpr: "COUNT(CASE WHEN IsRemoved=1 THEN 1 END)",
		// The linking side: delisting batches sent to search engines. A non-empty
		// DelistedExpr forces this side to be "linking"; the absence of it would
		// default to "host" and break the role pinning for the enforcement actions.
		DelistedExpr: "0",
		ActionKey:    "delistingBatches",
		ActionLabel:  "De-Indexing",
		ActionCol:    colDelistingBatchID,
		Dimensions: []dimension{
			{Key: "byDelistingBatchEngine", Column: "SearchEngineName", Label: "Engines - Batches", Limit: 10, CountDistinctCol: colDelistingBatchID},
		},
		Filters: map[string]string{},
	},
	// The host side: notices sent to hosting providers.
	"open-web-sports-source": {
		Key: "open-web-sports-source", Label: "Open Web - Sports (Source)",
		Table:     "dashboards.SportsSourceURLRawData",
		ClientCol: "ClientId", DateCol: "URLUploadDate", AssetCol: "AssetId",
		IdentExpr:   "COUNT(*)",
		RemovedExpr: "COUNT(CASE WHEN IsRemoved=1 THEN 1 END)",
		// No DelistedExpr means this side is "host" — the default role for the
		// host-side table. The action is pinned to this side by role matching.
		ActionKey:   "notices",
		ActionLabel: "Notices sent",
		ActionCol:   colSourceNoticeID,
		Dimensions: []dimension{
			{Key: "byHSPNotices", Column: "HSPName", Label: "Hosts - Notices", Limit: 10, CountDistinctCol: colSourceNoticeID},
		},
		Filters: map[string]string{},
	},
}

// reportSpecOrder is the order a FRESH install's sidebar is seeded in. Note that
// "source-url" is absent: its table is seeded as Open Web's second table instead,
// because the host side is half of the Open Web report rather than a report of
// its own. The entry above is kept so an install that already separated them
// still resolves.
var reportSpecOrder = []string{"open-web", "search-engine", "youtube", "telegram", "social"}

func specFor(kind string) (reportSpec, bool) {
	s, ok := reportSpecs[kind]
	return s, ok
}
