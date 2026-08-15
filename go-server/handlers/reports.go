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
func reportsUnavailable(w http.ResponseWriter, err error) {
	OK(w, map[string]any{
		"ok":        false,
		"available": false,
		"error":     err.Error(),
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
			"host": c.BaseURL(), "database": database, "via": "reports_api",
		}
		if database == "" {
			body["database"] = name
		}
		if err != nil {
			body["error"] = err.Error()
		}
		OK(w, body)
		return
	}

	if !db.ReportsConfigured() {
		OK(w, map[string]any{
			"success": true, "configured": false, "connected": false,
			"host": host, "database": name,
			"error": "No report backend is configured — set REPORTS_API_URL to read through reports_api, or REPORTS_DB_HOST / REPORTS_DB_USER / REPORTS_DB_PASS to query the warehouse directly",
		})
		return
	}

	p, err := db.Reports()
	if err != nil {
		OK(w, map[string]any{
			"success": true, "configured": true, "connected": false,
			"host": host, "database": name, "error": err.Error(),
		})
		return
	}
	if err := p.Ping(); err != nil {
		OK(w, map[string]any{
			"success": true, "configured": true, "connected": false,
			"host": host, "database": name, "error": err.Error(),
		})
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

	OK(w, map[string]any{
		"success": true, "configured": true, "connected": true,
		"host": host, "database": name, "tables": tables,
	})
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
		reportsUnavailable(w, fmt.Errorf("no report backend is configured — set REPORTS_API_URL to read through reports_api, or REPORTS_DB_* to query the warehouse directly"))
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

	// Configured platforms (reportplatforms.go) list their own slicer values,
	// merged across every table the platform reads.
	if p, ok := platformByKey(kind); ok {
		if !maySeeReport(claims, kind) {
			Fail(w, 403, "You do not have access to this report")
			return
		}
		specs, _ := specsForPlatform(p)
		OK(w, mergeSpecOptions(specs, clientID))
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
		OK(w, mergeSpecOptions(summarySpecs(plats), clientID))
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
		reportsUnavailable(w, err)
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
		reportsUnavailable(w, fmt.Errorf("no report backend is configured — set REPORTS_API_URL to read through reports_api, or REPORTS_DB_* to query the warehouse directly"))
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

	// Configured platforms (reportplatforms.go): every table the platform reads
	// is queried and the results merged. Access is enforced here as well as in
	// the sections list, so hiding a nav item is not the only guard.
	if p, ok := platformByKey(kind); ok {
		if !maySeeReport(claims, kind) {
			Fail(w, 403, "You do not have access to this report")
			return
		}
		OK(w, runPlatform(p, flatQuery(q)))
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
		OK(w, runSummary(plats, flatQuery(q)))
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
			case "urls", "removed", "delisted", "google", "bing":
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
