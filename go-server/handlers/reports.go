package handlers

import (
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/ip-house/iphouse-api/db"
	"github.com/ip-house/iphouse-api/reportsapi"
)

// Reports API — reads the analytics warehouse (see db/reports.go), not the
// portal's own schema.
//
// ACCESS: staff only, mounted behind adminAuth in main.go. The report is
// parameterised by an analytics ClientId, and there is no mapping yet from a
// portal login to its row in that warehouse — so exposing this to client logins
// would let any of them pass another company's ClientId and read its data. When
// that mapping exists, the clientId parameter must be forced from the session
// rather than taken from the query string.
//
// Ported from MadiaScanAnalytics/src/app/api/sport-report/route.ts. The SQL is
// kept close to the original so the two stay comparable; the shape returned to
// the browser is identical, which is what lets the page port over unchanged.

// reportTables names the warehouse table and the domain column per report type.
type reportTable struct {
	table     string
	domainCol string
	clientCol string
	assetCol  string
	assetName string
}

func rawURLTable(kind string) (reportTable, bool) {
	switch kind {
	case "infringing":
		return reportTable{
			table: "dashboards.SportsURLRawData", domainCol: "InfringingDomain",
			clientCol: "ClientId", assetCol: "AssetId", assetName: "AssetName",
		}, true
	case "source":
		return reportTable{
			table: "dashboards.SportsSourceURLRawData", domainCol: "SourceDomain",
			clientCol: "ClientId", assetCol: "AssetId", assetName: "AssetName",
		}, true
	}
	return reportTable{}, false
}

// reportsUnavailable answers a missing/unreachable warehouse as a normal payload
// the page can render, rather than a 500 the user cannot act on.
//
// The reason reaches the reader, the address does not. Some of these errors are
// the warehouse's own — a failed statement, quoting the schema and table it ran
// against — and this payload is rendered onto the page verbatim, on screens a
// CLIENT login can open. Super Admins still get it whole; for everyone else the
// qualified names and URLs are replaced. See redactWarehouseNames.
func reportsUnavailable(w http.ResponseWriter, r *http.Request, err error) {
	msg := err.Error()
	if !maySeeWarehouseNames(r) {
		msg = redactWarehouseNames(msg, "the reports warehouse")
	}
	OK(w, map[string]any{
		"ok":        false,
		"available": false,
		"error":     msg,
	})
}

// GET /api/reports/health — is the warehouse configured and reachable?
//
// Exists so the page can say which of the three states it is in instead of just
// showing an empty client list: not configured, configured but unreachable, or
// connected. Deliberately cheap — a ping plus an existence check against
// information_schema, never a COUNT over a warehouse table.
func ReportsHealth(w http.ResponseWriter, r *http.Request) {
	host := envDisplay("REPORTS_DB_HOST")
	name := envDisplay("REPORTS_DB_NAME")
	if name == "" {
		name = "dashboards"
	}

	/* In API mode the warehouse is two hops away, and the two hops fail
	   differently: reports_api unreachable is a deployment problem here, while
	   reports_api reporting its own database down is one over there. The banner
	   is worth telling them apart, so the error text names which hop broke. */
	if reportsViaAPI() {
		c := reportsapi.Get()
		ok, database, err := c.Health(r.Context())
		body := map[string]any{
			"success": true, "configured": true, "connected": ok,
			"via": "reports_api",
		}
		/* Same rule as the connected path below, and it has to be the same on
		   the way OUT too: a health check that hides the address when it works
		   and prints it when it breaks is not hiding it. The service's own
		   error text quotes its base URL and dataset, so that goes through the
		   redactor rather than through unchanged. */
		if maySeeWarehouseNames(r) {
			body["host"] = c.BaseURL()
			body["database"] = database
			if database == "" {
				body["database"] = name
			}
			if err != nil {
				body["error"] = err.Error()
			}
		} else if err != nil {
			body["error"] = redactWarehouseNames(err.Error(), "the reports service")
		}
		OK(w, body)
		return
	}

	/* The three ways this can fail all used to answer with the hostname and the
	   schema attached, to every admin. A driver error is the worst of them: it
	   quotes the DSN, so the reply named the host, the database and the user in
	   one line. They are folded into one helper so the gate cannot be applied to
	   two of the three again. */
	if !db.ReportsConfigured() {
		reportsHealthDown(w, r, false, host, name,
			"No report backend is configured — set REPORTS_API_URL to read through reports_api, or REPORTS_DB_HOST / REPORTS_DB_USER / REPORTS_DB_PASS to query the warehouse directly",
			"No report backend is configured — ask a Super Admin to connect one")
		return
	}

	p, err := db.Reports()
	if err != nil {
		reportsHealthDown(w, r, true, host, name, err.Error(), "")
		return
	}
	if err := p.Ping(); err != nil {
		reportsHealthDown(w, r, true, host, name, err.Error(), "")
		return
	}

	// Which report tables actually exist — a live connection to the wrong schema
	// looks identical to a working one until a query returns nothing.
	tables := map[string]bool{}
	rows, terr := db.ReportsQuery(`
		SELECT TABLE_NAME AS t FROM information_schema.TABLES
		 WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN
		       ('SportsURLRawData','SportsSourceURLRawData',
		        'Agg_Daily_Telegram_Sports_Raw','SocialMedia_Sports_Raw')`, name)
	if terr == nil {
		for _, row := range rows {
			tables[strFromAny(row["t"])] = true
		}
	}

	/* Connected or not is what the page asks and all it draws. The hostname,
	   the schema and the table names are the warehouse's address, and this
	   endpoint is open to every admin — so they go only to a Super Admin, who
	   is the person who would act on them. */
	out := map[string]any{"success": true, "configured": true, "connected": true}
	if maySeeWarehouseNames(r) {
		out["host"] = host
		out["database"] = name
		out["tables"] = tables
	}
	OK(w, out)
}

/*
reportsHealthDown answers an unreachable warehouse without describing it.

`detail` is the real reason, for the Super Admin who can act on it. Everyone
else gets `safe` when one is given and a redacted `detail` otherwise — redacted
rather than blanked, because "cannot connect" and "access denied for this user"
send an admin to different people, and only the identifiers have to go.
*/
func reportsHealthDown(w http.ResponseWriter, r *http.Request, configured bool, host, name, detail, safe string) {
	out := map[string]any{
		"success": true, "configured": configured, "connected": false,
	}
	if maySeeWarehouseNames(r) {
		out["host"] = host
		out["database"] = name
		out["error"] = detail
	} else if safe != "" {
		out["error"] = safe
	} else {
		out["error"] = redactWarehouseNames(detail, "the reports warehouse")
	}
	OK(w, out)
}

// envDisplay reads a non-secret env value for display. Only host/database names
// are ever exposed this way — never the user or password.
func envDisplay(key string) string {
	return strings.TrimSpace(os.Getenv(key))
}

// GET /api/reports/options?type=&clientId=
func ReportsOptions(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	if !reportsBackendReady() {
		reportsUnavailable(w, r, fmt.Errorf("no report backend is configured — set REPORTS_API_URL to read through reports_api, or REPORTS_DB_* to query the warehouse directly"))
		return
	}
	if !mayOpenReports(claims) {
		Fail(w, 403, "The Reports module is not enabled for this account")
		return
	}
	q := r.URL.Query()
	kind := strings.ToLower(strings.TrimSpace(q.Get("type")))
	if kind == "" {
		kind = "infringing"
	}
	// Slicer values are scoped the same way the data is — otherwise the asset
	// list would name another company's titles even though the charts could not
	// show them.
	clientID, scoped, why := reportScope(claims, q.Get("clientId"))
	if !scoped {
		Fail(w, 403, why)
		return
	}

	/* The window and the other active slicers travel with the request, so the
	   values offered are the values that have something behind them. A slicer
	   listing everything the client has ever had offers choices that empty the
	   page — and the page cannot then say why, because "no rows" and "no such
	   value in this window" look identical once the choice has been made. */
	scope := flatQuery(q)
	scope["clientId"] = clientID
	/* Held to the sports period for the same reason the charts are: a slicer
	   offering a value that only exists outside the period is a choice that
	   empties the report, and the page cannot then say why. */
	if p, ok := platformByKey(kind); ok {
		if period, governed := sportsPeriodFor(p, clientID); governed {
			clampToSportsPeriod(scope, period)
		}
	}

	// Configured platforms (reportplatforms.go) list their own slicer values,
	// merged across every table the platform reads.
	if p, ok := platformByKey(kind); ok {
		if !maySeeReport(claims, kind) {
			Fail(w, 403, "You do not have access to this report")
			return
		}
		specs, _ := specsForPlatform(p)
		/* The source-type slicer offers its own two values — there is no column
		   behind it to list them from — and it also SCOPES the rest, exactly as
		   every other active slicer does: with the hosting side chosen, the
		   domain dropdown must list host domains and not the linking domains
		   that side of the report does not contain. See sourcetype.go. */
		opts := mergeSpecOptions(specsForSourceType(specs, scope), clientID, scope)
		if platformOffersSourceType(specs) {
			opts[sourceTypeParam] = sourceTypeOptions()
		}
		OK(w, opts)
		return
	}

	// The summary's slicers are the union across every platform it covers, which
	// is exactly the same merge over a longer list of specs.
	if kind == summaryKey && summaryIsBuiltIn() {
		plats := summaryPlatforms(claims)
		if len(plats) == 0 {
			Fail(w, 403, "You do not have access to any reports")
			return
		}
		OK(w, mergeSpecOptions(summarySpecs(plats), clientID, scope))
		return
	}

	t, ok := rawURLTable(kind)
	if !ok {
		OK(w, map[string]any{"ok": true, "available": true, "notImplemented": kind,
			"clients": []any{}, "assets": []any{}, "tatBuckets": []any{}})
		return
	}

	// Client scoping for the asset list is a bound parameter, never interpolated.
	assetWhere := ""
	assetArgs := []any{}
	if clientID != "" {
		assetWhere = " AND " + t.clientCol + " = ?"
		assetArgs = append(assetArgs, clientID)
	}

	clients, err := db.ReportsQuery(`
		SELECT DISTINCT ClientId AS id, ClientName AS name
		  FROM ` + t.table + `
		 WHERE ClientId IS NOT NULL AND ClientName IS NOT NULL
		 ORDER BY ClientName`)
	if err != nil {
		reportsUnavailable(w, r, err)
		return
	}
	assets, _ := db.ReportsQuery(`
		SELECT DISTINCT `+t.assetCol+` AS id, `+t.assetName+` AS name
		  FROM `+t.table+`
		 WHERE `+t.assetCol+` IS NOT NULL AND `+t.assetName+` IS NOT NULL`+assetWhere+`
		 ORDER BY `+t.assetName+` LIMIT 500`, assetArgs...)
	tats, _ := db.ReportsQuery(`
		SELECT DISTINCT TATBucket FROM ` + t.table + `
		 WHERE TATBucket IS NOT NULL ORDER BY TATBucket`)
	langs, _ := db.ReportsQuery(`
		SELECT DISTINCT LanguageName FROM ` + t.table + `
		 WHERE LanguageName IS NOT NULL AND LanguageName != '' ORDER BY LanguageName LIMIT 100`)
	countries, _ := db.ReportsQuery(`
		SELECT DISTINCT CountryName FROM ` + t.table + `
		 WHERE CountryName IS NOT NULL AND CountryName != '' ORDER BY CountryName LIMIT 200`)
	engines, _ := db.ReportsQuery(`
		SELECT DISTINCT SearchEngineName FROM ` + t.table + `
		 WHERE SearchEngineName IS NOT NULL AND SearchEngineName != '' ORDER BY SearchEngineName`)
	notes, _ := db.ReportsQuery(`
		SELECT DISTINCT Note2 FROM ` + t.table + `
		 WHERE Note2 IS NOT NULL AND Note2 != '' AND Note2 NOT IN ('NA','N/A','-')
		 ORDER BY Note2 LIMIT 200`)

	OK(w, map[string]any{
		"ok":            true,
		"available":     true,
		"clients":       idNamePairs(clients),
		"assets":        idNamePairs(assets),
		"tatBuckets":    flatten(tats, "TATBucket"),
		"languages":     flatten(langs, "LanguageName"),
		"countries":     flatten(countries, "CountryName"),
		"searchEngines": flatten(engines, "SearchEngineName"),
		"note2Values":   flatten(notes, "Note2"),
	})
}

// GET /api/reports/data?type=&clientId=&from=&to=&assetId=&language=&country=&searchEngine=&tatBucket=&note2=
func ReportsData(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	if !reportsBackendReady() {
		reportsUnavailable(w, r, fmt.Errorf("no report backend is configured — set REPORTS_API_URL to read through reports_api, or REPORTS_DB_* to query the warehouse directly"))
		return
	}
	if !mayOpenReports(claims) {
		Fail(w, 403, "The Reports module is not enabled for this account")
		return
	}
	q := r.URL.Query()
	kind := strings.ToLower(strings.TrimSpace(q.Get("type")))
	if kind == "" {
		kind = "infringing"
	}
	/* A client login reads its OWN company and nothing else: the id comes from
	   the mapping staff set, and whatever the request asked for is discarded.
	   Staff still choose, which is what the client slicer on /admin/reports is.
	   See reportScope. */
	clientID, scoped, why := reportScope(claims, q.Get("clientId"))
	if !scoped {
		Fail(w, 403, why)
		return
	}
	if clientID == "" {
		Fail(w, 422, "A client is required")
		return
	}
	/*
		The RESOLVED client, written back over whatever the request asked for.

		Everything below builds its SQL scope from flatQuery(q) — the raw query
		string — while the check above ran against reportScope's answer. Those
		were two different values, and the gap between them was the whole of the
		access control:

		  · reportScope DISCARDS a client login's requested id and returns the
		    one staff mapped to that account, which is what makes the check pass,
		  · flatQuery then handed the SQL the id from the URL.

		So a client login passing ?clientId=<another company> was authorised as
		itself and queried as them. Reading someone else's report needed no more
		than knowing their id.

		It is also why a request that names NO client returned an empty report
		rather than that login's own: the scope filtered on "", matched nothing,
		and answered ok:true with every figure absent — which is a silent wrong
		answer, and the reason this was found from the wrong end.

		ReportsOptions already did this a hundred lines up; this endpoint did
		not. One line, and the two agree.
	*/
	q.Set("clientId", clientID)

	// Configured platforms (reportplatforms.go): every table the platform reads
	// is queried and the results merged. Access is enforced here as well as in
	// the sections list, so hiding a nav item is not the only guard.
	if p, ok := platformByKey(kind); ok {
		if !maySeeReport(claims, kind) {
			Fail(w, 403, "You do not have access to this report")
			return
		}
		scope := flatQuery(q)
		/* A sports report reads only inside its configured period, whatever the
		   request asked for — see sportsperiod.go. Clamped BEFORE the cache
		   call, so the key describes the window that was actually run: clamping
		   afterwards would file every out-of-period request under its own key
		   and cache the same answer under each of them. */
		period, governed := sportsPeriodFor(p, clientID)
		adjusted := governed && clampToSportsPeriod(scope, period)

		// Through the cache — see reportcachebridge.go. Identical answer, and
		// on a hit, without recomputing eighteen aggregates.
		rep := cachedPlatformReport(p, scope, false, false)
		if governed {
			/* Echoed so the page can pin its calendar to the same window rather
			   than infer it, and can say so when the range it asked for is not
			   the range it is looking at. */
			rep["period"] = map[string]any{
				"start": period.Start, "end": period.End,
				"from": scope["from"], "to": scope["to"],
				"adjusted": adjusted,
			}
		}
		// The figures are the report; the tables behind them are not. See
		// scrubReportPayload — this endpoint answers client logins too.
		if !maySeeWarehouseNames(r) {
			scrubReportPayload(rep)
		}
		OK(w, rep)
		return
	}

	// The summary runs every platform this login may see and merges them — see
	// reportsummary.go. Access is the union of what the reader can already open,
	// so there is nothing extra to check beyond "may see at least one".
	if kind == summaryKey && summaryIsBuiltIn() {
		plats := summaryPlatforms(claims)
		if len(plats) == 0 {
			Fail(w, 403, "You do not have access to any reports")
			return
		}
		sum := runSummary(plats, flatQuery(q))
		if !maySeeWarehouseNames(r) {
			scrubReportPayload(sum)
		}
		OK(w, sum)
		return
	}

	t, ok := rawURLTable(kind)
	if !ok {
		OK(w, map[string]any{"ok": false, "available": true, "notImplemented": kind,
			"error": "This report is not wired up yet"})
		return
	}

	// Every filter is a bound parameter. Only the table and column names are
	// interpolated, and those come from rawURLTable — never from the request.
	conds := []string{"t." + t.clientCol + " = ?"}
	args := []any{clientID}
	addEq := func(col, val string) {
		if v := strings.TrimSpace(val); v != "" {
			conds = append(conds, "t."+col+" = ?")
			args = append(args, v)
		}
	}
	from, to := strings.TrimSpace(q.Get("from")), strings.TrimSpace(q.Get("to"))
	if from != "" && to != "" {
		conds = append(conds, "t.URLUploadDate BETWEEN ? AND ?")
		args = append(args, from, to)
	}
	addEq(t.assetCol, q.Get("assetId"))
	addEq("LanguageName", q.Get("language"))
	addEq("CountryName", q.Get("country"))
	addEq("SearchEngineName", q.Get("searchEngine"))
	addEq("TATBucket", q.Get("tatBucket"))
	addEq("Note2", q.Get("note2"))

	where := "WHERE " + strings.Join(conds, " AND ")
	tbl := t.table + " t"
	dom := "t." + t.domainCol
	removed := "COUNT(CASE WHEN t.IsRemoved=1 THEN 1 END)"

	run := func(sqlStr string) []map[string]any {
		rows, err := db.ReportsQuery(sqlStr, args...)
		if err != nil {
			// One failed panel must not lose the whole report.
			return nil
		}
		return rows
	}

	isInfringing := kind == "infringing"

	kpiExtra := ""
	if isInfringing {
		kpiExtra = `, COUNT(CASE WHEN t.IsGoogleDelisted=1 THEN 1 END) AS google_delisted,
		             COUNT(CASE WHEN t.IsBingDelisted=1 THEN 1 END) AS bing_delisted`
	} else {
		kpiExtra = `, COUNT(DISTINCT t.ChannelId) AS total_channels`
	}

	kpiRow := firstRow(run(`
		SELECT COUNT(*) AS total_urls, ` + removed + ` AS total_removed,
		       COUNT(DISTINCT ` + dom + `) AS total_domains,
		       COUNT(DISTINCT t.` + t.assetCol + `) AS total_assets,
		       COUNT(DISTINCT t.LanguageName) AS total_languages,
		       COUNT(DISTINCT t.CountryName) AS total_countries` + kpiExtra + `
		  FROM ` + tbl + ` ` + where))

	dailyExtra, delistCols := "", ""
	if isInfringing {
		dailyExtra = `, COUNT(CASE WHEN t.IsGoogleDelisted=1 THEN 1 END) AS google,
		               COUNT(CASE WHEN t.IsBingDelisted=1 THEN 1 END) AS bing`
		delistCols = dailyExtra
	}

	daily := run(`
		SELECT DATE(t.URLUploadDate) AS date, COUNT(*) AS urls, ` + removed + ` AS removed` + dailyExtra + `
		  FROM ` + tbl + ` ` + where + `
		 GROUP BY DATE(t.URLUploadDate) ORDER BY date ASC`)

	topDomains := run(`
		SELECT ` + dom + ` AS domain, COUNT(*) AS urls, ` + removed + ` AS removed` + delistCols + `
		  FROM ` + tbl + ` ` + where + ` AND ` + dom + ` IS NOT NULL AND ` + dom + ` != ''
		 GROUP BY ` + dom + ` ORDER BY urls DESC LIMIT 15`)

	byAsset := run(`
		SELECT t.` + t.assetCol + ` AS id, COALESCE(t.` + t.assetName + `, t.` + t.assetCol + `) AS label,
		       COUNT(*) AS urls, ` + removed + ` AS removed
		  FROM ` + tbl + ` ` + where + ` AND t.` + t.assetCol + ` IS NOT NULL
		 GROUP BY t.` + t.assetCol + `, label ORDER BY urls DESC LIMIT 15`)

	bucketQuery := func(col string) []map[string]any {
		return run(`
			SELECT COALESCE(t.` + col + `,'Unknown') AS bucket, COUNT(*) AS urls, ` + removed + ` AS removed
			  FROM ` + tbl + ` ` + where + `
			 GROUP BY t.` + col + ` ORDER BY urls DESC`)
	}
	labelQuery := func(col string, limit int) []map[string]any {
		return run(fmt.Sprintf(`
			SELECT COALESCE(t.%s,'Unknown') AS label, COUNT(*) AS urls, %s AS removed
			  FROM %s %s AND t.%s IS NOT NULL AND t.%s != ''
			 GROUP BY t.%s ORDER BY urls DESC LIMIT %d`,
			col, removed, tbl, where, col, col, col, limit))
	}

	out := map[string]any{
		"ok":             true,
		"available":      true,
		"type":           kind,
		"kpi":            reportKPI(kpiRow, isInfringing),
		"daily":          mapRows(daily, "date", "urls", "removed", "google", "bing"),
		"topDomains":     mapRows(topDomains, "domain", "urls", "removed", "google", "bing"),
		"byAsset":        mapRows(byAsset, "id", "label", "urls", "removed"),
		"byTAT":          mapRows(bucketQuery("TATBucket"), "bucket", "urls", "removed"),
		"byPageNo":       mapRows(bucketQuery("PageNumberBucket"), "bucket", "urls"),
		"byLanguage":     mapRows(labelQuery("LanguageName", 15), "label", "urls", "removed"),
		"byCountry":      mapRows(labelQuery("CountryName", 15), "label", "urls", "removed"),
		"bySearchEngine": mapRows(bucketQuery("SearchEngineName"), "bucket", "urls", "removed"),
		"byNote2":        mapRows(labelQuery("Note2", 15), "label", "urls", "removed"),
	}

	if isInfringing {
		gvb := run(`
			SELECT ` + dom + ` AS domain,
			       COUNT(CASE WHEN t.IsGoogleDelisted=1 THEN 1 END) AS google,
			       COUNT(CASE WHEN t.IsBingDelisted=1 THEN 1 END) AS bing
			  FROM ` + tbl + ` ` + where + ` AND ` + dom + ` IS NOT NULL
			 GROUP BY ` + dom + `
			 ORDER BY (COUNT(CASE WHEN t.IsGoogleDelisted=1 THEN 1 END)
			         + COUNT(CASE WHEN t.IsBingDelisted=1 THEN 1 END)) DESC LIMIT 10`)
		out["googleVsBing"] = mapRows(gvb, "domain", "google", "bing")
	}

	OK(w, out)
}

/* ── row helpers ──────────────────────────────────────────────────────────── */

// flatQuery narrows a request's query string to one value per parameter, which
// is what the spec runner takes. Repeated parameters are not part of this API —
// a slicer holds one value — so the first is the answer.
func flatQuery(q url.Values) map[string]string {
	out := make(map[string]string, len(q))
	for k := range q {
		out[k] = q.Get(k)
	}
	return out
}

func reportKPI(row map[string]any, isInfringing bool) map[string]any {
	total := numOf(row["total_urls"])
	rem := numOf(row["total_removed"])
	pct := 0.0
	if total > 0 {
		pct = float64(rem) / float64(total) * 100
	}
	kpi := map[string]any{
		"totalURLs":      total,
		"totalRemoved":   rem,
		"removalPct":     roundTo(pct, 2),
		"pendingRemoval": total - rem,
		"totalDomains":   numOf(row["total_domains"]),
		"totalAssets":    numOf(row["total_assets"]),
		"totalLanguages": numOf(row["total_languages"]),
		"totalCountries": numOf(row["total_countries"]),
	}
	if isInfringing {
		kpi["googleDelisted"] = numOf(row["google_delisted"])
		kpi["bingDelisted"] = numOf(row["bing_delisted"])
	} else {
		kpi["totalChannels"] = numOf(row["total_channels"])
	}
	return kpi
}

// mapRows narrows warehouse rows to the named keys, coercing counts to numbers
// and dates to plain ISO days (the driver hands DATE back as time.Time).
func mapRows(rows []map[string]any, keys ...string) []map[string]any {
	out := make([]map[string]any, 0, len(rows))
	for _, r := range rows {
		m := make(map[string]any, len(keys))
		for _, k := range keys {
			v, present := r[k]
			if !present {
				continue
			}
			switch k {
			case "date":
				m[k] = isoDay(v)
			// `repeats` is the repeat-offenders panel's day count. Numeric like
			// the rest: MySQL's text protocol hands a COUNT() back as []byte,
			// which JSON-encodes as a base64 string the chart cannot plot.
			case "urls", "removed", "delisted", "google", "bing", "repeats",
				// The enforcement action counts — see enforcementactions.go.
				"notices", "delistingBatches":
				m[k] = numOf(v)
			default:
				m[k] = v
			}
		}
		out = append(out, m)
	}
	return out
}

func idNamePairs(rows []map[string]any) []map[string]any {
	out := make([]map[string]any, 0, len(rows))
	for _, r := range rows {
		id := fmt.Sprint(r["id"])
		if id == "" || id == "<nil>" {
			continue
		}
		name := fmt.Sprint(r["name"])
		if name == "" || name == "<nil>" {
			name = id
		}
		out = append(out, map[string]any{"id": id, "name": name})
	}
	return out
}

func flatten(rows []map[string]any, col string) []string {
	out := make([]string, 0, len(rows))
	for _, r := range rows {
		if s := strings.TrimSpace(fmt.Sprint(r[col])); s != "" && s != "<nil>" {
			out = append(out, s)
		}
	}
	return out
}

// isoDay renders a warehouse DATE as a plain YYYY-MM-DD. The driver returns it
// as time.Time (parseTime=true), which would otherwise serialise with a time and
// zone the chart axis has to strip again.
func isoDay(v any) string {
	switch t := v.(type) {
	case time.Time:
		return t.Format("2006-01-02")
	case string:
		if len(t) >= 10 {
			return t[:10]
		}
		return t
	case nil:
		return ""
	}
	s := fmt.Sprint(v)
	if len(s) >= 10 {
		return s[:10]
	}
	return s
}

func firstRow(rows []map[string]any) map[string]any {
	if len(rows) == 0 {
		return map[string]any{}
	}
	return rows[0]
}

func roundTo(v float64, places int) float64 {
	p := 1.0
	for i := 0; i < places; i++ {
		p *= 10
	}
	return float64(int64(v*p+0.5)) / p
}
