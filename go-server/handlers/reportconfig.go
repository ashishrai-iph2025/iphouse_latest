package handlers

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"

	ipauth "github.com/ip-house/iphouse-api/auth"
	"github.com/ip-house/iphouse-api/db"
)

// Report data-source configuration and per-user platform access.
//
// The built-in registry (reportspecs.go) carries column names copied from the
// source project's SQL, which will not always match this warehouse. Rather than
// require a code change and a deploy to correct one, an admin can remap a report
// to a different table and columns here; the override is stored in the PORTAL's
// own database (never the warehouse, which is read-only to us) and merged over
// the built-in default at query time.
//
// Access control lives here too. A report is a platform's worth of a client's
// data, and not every staff login should see every platform — so a login can be
// restricted to a subset. The default is deliberately "everything": an empty
// allow-list means no restriction, so adding this feature does not silently take
// access away from anyone.

const (
	reportConfigTable = "report_source_config"
	reportAccessTable = "report_user_access"
)

var reportConfigOnce sync.Once

func ensureReportConfigSchema() {
	reportConfigOnce.Do(func() {
		if _, _, err := db.Exec(`
			CREATE TABLE IF NOT EXISTS ` + reportConfigTable + ` (
			  report_key   VARCHAR(64)  NOT NULL PRIMARY KEY,
			  table_name   VARCHAR(191) NOT NULL DEFAULT '',
			  client_col   VARCHAR(128) NOT NULL DEFAULT '',
			  date_col     VARCHAR(128) NOT NULL DEFAULT '',
			  asset_col    VARCHAR(128) NOT NULL DEFAULT '',
			  ident_expr   VARCHAR(512) NOT NULL DEFAULT '',
			  removed_expr VARCHAR(512) NOT NULL DEFAULT '',
			  is_enabled   TINYINT(1)   NOT NULL DEFAULT 1,
			  updated_by   VARCHAR(191) NOT NULL DEFAULT '',
			  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`); err != nil {
			log.Printf("[report-config] create %s: %v", reportConfigTable, err)
		}
		// One row per (login, report) that IS allowed. No rows for a login at all
		// means every report — see reportsAllowedFor.
		if _, _, err := db.Exec(`
			CREATE TABLE IF NOT EXISTS ` + reportAccessTable + ` (
			  login_id   INT UNSIGNED NOT NULL,
			  report_key VARCHAR(64)  NOT NULL,
			  granted_by VARCHAR(191) NOT NULL DEFAULT '',
			  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
			  PRIMARY KEY (login_id, report_key)
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`); err != nil {
			log.Printf("[report-config] create %s: %v", reportAccessTable, err)
		}
	})
}

/* ── Spec resolution ──────────────────────────────────────────────────────── */

// resolvedSpec returns the built-in spec with any stored override applied.
// Only the source fields are overridable; dimensions and filters stay in code,
// because those describe what the report *means*, not where it lives.
func resolvedSpec(kind string) (reportSpec, bool) {
	s, ok := specFor(kind)
	if !ok {
		return s, false
	}
	ensureReportConfigSchema()
	row, err := db.QueryOne(
		"SELECT table_name, client_col, date_col, asset_col, ident_expr, removed_expr, is_enabled FROM "+
			reportConfigTable+" WHERE report_key = ? LIMIT 1", kind)
	if err != nil || row == nil {
		return s, true
	}
	if numOf(row["is_enabled"]) == 0 {
		return s, false // administratively disabled
	}
	set := func(dst *string, v any) {
		if t := strings.TrimSpace(strFromAny(v)); t != "" {
			*dst = t
		}
	}
	set(&s.Table, row["table_name"])
	set(&s.ClientCol, row["client_col"])
	set(&s.DateCol, row["date_col"])
	set(&s.AssetCol, row["asset_col"])
	set(&s.IdentExpr, row["ident_expr"])
	set(&s.RemovedExpr, row["removed_expr"])
	return s, true
}

/* ── Per-user platform access ─────────────────────────────────────────────── */

// reportsAllowedFor returns the report keys a login may see, or nil for "all".
//
// nil (not an empty slice) is the unrestricted case on purpose: an empty result
// set from the table means nobody ever restricted this login, which must read as
// full access rather than none.
func reportsAllowedFor(loginID int64) map[string]bool {
	ensureReportConfigSchema()
	rows, err := db.Query("SELECT report_key FROM "+reportAccessTable+" WHERE login_id = ?", loginID)
	if err != nil || len(rows) == 0 {
		return nil
	}
	out := map[string]bool{}
	for _, r := range rows {
		if k := strings.TrimSpace(strFromAny(r["report_key"])); k != "" {
			out[k] = true
		}
	}
	return out
}

func maySeeReport(claims *ipauth.Claims, kind string) bool {
	if claims == nil {
		return false
	}
	allowed := reportsAllowedFor(claims.LoginID)
	return allowed == nil || allowed[kind]
}

/*
── GET /api/admin/report-config ─────────────────────────────────────────────

	Everything the configuration page needs in one call: the built-in default and
	the stored override per report, plus whether the target table resolves.
*/
func ReportConfigList(w http.ResponseWriter, r *http.Request) {
	ensureReportConfigSchema()

	stored := map[string]map[string]any{}
	if rows, err := db.Query("SELECT * FROM " + reportConfigTable); err == nil {
		for _, row := range rows {
			stored[strFromAny(row["report_key"])] = row
		}
	}

	out := make([]map[string]any, 0, len(reportSpecOrder))
	for _, key := range reportSpecOrder {
		def, ok := specFor(key)
		if !ok {
			continue
		}
		eff, enabled := resolvedSpec(key)
		item := map[string]any{
			"key": key, "label": def.Label, "enabled": enabled,
			"default": map[string]any{
				"table": def.Table, "clientCol": def.ClientCol, "dateCol": def.DateCol,
				"assetCol": def.AssetCol, "identExpr": def.IdentExpr, "removedExpr": def.RemovedExpr,
			},
			"effective": map[string]any{
				"table": eff.Table, "clientCol": eff.ClientCol, "dateCol": eff.DateCol,
				"assetCol": eff.AssetCol, "identExpr": eff.IdentExpr, "removedExpr": eff.RemovedExpr,
			},
			"overridden": stored[key] != nil,
		}
		if s := stored[key]; s != nil {
			item["updatedBy"] = strFromAny(s["updated_by"])
			item["updatedAt"] = s["updated_at"]
		}
		out = append(out, item)
	}
	OK(w, map[string]any{"success": true, "reports": out, "configured": reportsBackendReady()})
}

/*
── PUT /api/admin/report-config ─────────────────────────────────────────────

	Body: { reportKey, table, clientCol, dateCol, assetCol, identExpr, removedExpr, enabled }
	An empty field means "keep the built-in default", so a partial remap is
	possible without restating the whole spec.
*/
func ReportConfigSave(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	ensureReportConfigSchema()

	var body struct {
		ReportKey   string `json:"reportKey"`
		Table       string `json:"table"`
		ClientCol   string `json:"clientCol"`
		DateCol     string `json:"dateCol"`
		AssetCol    string `json:"assetCol"`
		IdentExpr   string `json:"identExpr"`
		RemovedExpr string `json:"removedExpr"`
		Enabled     *bool  `json:"enabled"`
		Reset       bool   `json:"reset"`
	}
	json.NewDecoder(r.Body).Decode(&body)

	key := strings.TrimSpace(body.ReportKey)
	if _, ok := specFor(key); !ok {
		Fail(w, 422, "Unknown report: "+key)
		return
	}

	if body.Reset {
		if _, _, err := db.Exec("DELETE FROM "+reportConfigTable+" WHERE report_key = ?", key); err != nil {
			Fail(w, 500, "Could not reset this report")
			return
		}
		OK(w, map[string]any{"success": true, "reset": true})
		return
	}

	// A table name is the one thing that must look like an identifier: it is
	// interpolated into SQL, so anything but [schema.]name with word characters
	// is refused outright rather than escaped.
	if t := strings.TrimSpace(body.Table); t != "" && !validSQLName(t) {
		Fail(w, 422, "Table must be a plain name or schema.name")
		return
	}
	for label, v := range map[string]string{
		"Client column": body.ClientCol, "Date column": body.DateCol, "Asset column": body.AssetCol,
	} {
		if v = strings.TrimSpace(v); v != "" && !validSQLName(v) {
			Fail(w, 422, label+" must be a plain column name")
			return
		}
	}

	enabled := 1
	if body.Enabled != nil && !*body.Enabled {
		enabled = 0
	}
	who := ""
	if claims != nil {
		who = claims.LoginUsername
	}

	if _, _, err := db.Exec(`
		INSERT INTO `+reportConfigTable+`
		  (report_key, table_name, client_col, date_col, asset_col, ident_expr, removed_expr, is_enabled, updated_by)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
		  table_name=VALUES(table_name), client_col=VALUES(client_col), date_col=VALUES(date_col),
		  asset_col=VALUES(asset_col), ident_expr=VALUES(ident_expr), removed_expr=VALUES(removed_expr),
		  is_enabled=VALUES(is_enabled), updated_by=VALUES(updated_by)`,
		key, strings.TrimSpace(body.Table), strings.TrimSpace(body.ClientCol),
		strings.TrimSpace(body.DateCol), strings.TrimSpace(body.AssetCol),
		strings.TrimSpace(body.IdentExpr), strings.TrimSpace(body.RemovedExpr),
		enabled, who); err != nil {
		log.Printf("[report-config] save %s: %v", key, err)
		Fail(w, 500, "Could not save this report's data source")
		return
	}
	OK(w, map[string]any{"success": true})
}

/*
── GET /api/admin/report-config/tables ──────────────────────────────────────

	The warehouse's tables, and on request one table's columns, so the config page
	offers real choices instead of a free-text field.
*/
func ReportConfigTables(w http.ResponseWriter, r *http.Request) {
	table := strings.TrimSpace(r.URL.Query().Get("table"))

	/* In API mode the choices come from reports_api's catalogue rather than
	   from information_schema — the portal has no warehouse connection to
	   enumerate. Without this the picker renders "Nothing matches" and
	   "1 of 0 selected", which reads as an empty warehouse rather than as an
	   endpoint that never asked one. */
	if reportsViaAPI() {
		if table == "" {
			tables, err := apiTableList()
			if err != nil {
				reportsUnavailable(w, err)
				return
			}
			OK(w, map[string]any{"success": true, "tables": tables})
			return
		}
		cols, ok := apiTableColumns(table)
		if !ok {
			Fail(w, 404, table+" is not one of the datasets reports_api serves")
			return
		}
		OK(w, map[string]any{"success": true, "table": table, "columns": cols})
		return
	}

	if !db.ReportsConfigured() {
		reportsUnavailable(w, fmt.Errorf("reports database is not configured"))
		return
	}

	if table == "" {
		rows, err := db.ReportsQuery(`
			SELECT CONCAT(TABLE_SCHEMA,'.',TABLE_NAME) AS name, TABLE_ROWS AS approxRows
			  FROM information_schema.TABLES
			 WHERE TABLE_SCHEMA NOT IN ('information_schema','mysql','performance_schema','sys')
			 ORDER BY name LIMIT 2000`)
		if err != nil {
			reportsUnavailable(w, err)
			return
		}
		OK(w, map[string]any{"success": true, "tables": rows})
		return
	}

	if !validSQLName(table) {
		Fail(w, 422, "Table must be a plain name or schema.name")
		return
	}
	schema, name := splitTable(table)
	rows, err := db.ReportsQuery(`
		SELECT COLUMN_NAME AS name, DATA_TYPE AS type
		  FROM information_schema.COLUMNS
		 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
		 ORDER BY ORDINAL_POSITION`, schema, name)
	if err != nil {
		reportsUnavailable(w, err)
		return
	}
	OK(w, map[string]any{"success": true, "table": table, "columns": rows})
}

/*
── GET /api/admin/report-config/inventory ───────────────────────────────────

	The "database report": for each report, what its table actually holds. Answers
	"is this platform wired to real data?" without opening a SQL client.
*/
func ReportConfigInventory(w http.ResponseWriter, r *http.Request) {
	if !db.ReportsConfigured() {
		reportsUnavailable(w, fmt.Errorf("reports database is not configured"))
		return
	}
	out := []map[string]any{}
	for _, p := range loadPlatforms() {
		if len(p.Tables) == 0 {
			out = append(out, map[string]any{
				"key": p.Key, "label": p.Label, "table": "",
				"enabled": p.Enabled, "error": "no tables selected for this platform",
			})
			continue
		}
		for _, table := range p.Tables {
			item := map[string]any{
				"key": p.Key, "label": p.Label, "table": table, "enabled": p.Enabled,
			}
			shape := tableShapeOf(table)
			if shape.Err != "" {
				item["error"] = shape.Err
				out = append(out, item)
				continue
			}
			if len(shape.Columns) == 0 {
				item["tableExists"] = false
				out = append(out, item)
				continue
			}
			item["tableExists"] = true

			spec, usable := inferSpec(p.Key, p.Label, table)
			if !usable {
				item["error"] = "no recognisable client or date column"
				out = append(out, item)
				continue
			}
			item["clientCol"] = spec.ClientCol
			item["dateCol"] = spec.DateCol
			item["identExpr"] = spec.IdentExpr

			// Cheap profile: rows, distinct clients, and the span of the date
			// column. Everything here is inferred from the table itself, so a
			// missing column cannot make this query fail.
			if row, err := db.ReportsQueryOne(fmt.Sprintf(
				`SELECT COUNT(*) AS rows_total,
				        COUNT(DISTINCT %s) AS clients,
				        MIN(DATE(%s)) AS first_date,
				        MAX(DATE(%s)) AS last_date
				   FROM %s`, spec.ClientCol, spec.DateCol, spec.DateCol, table)); err == nil && row != nil {
				item["rows"] = numOf(row["rows_total"])
				item["clients"] = numOf(row["clients"])
				item["firstDate"] = isoDay(row["first_date"])
				item["lastDate"] = isoDay(row["last_date"])
			} else if err != nil {
				item["error"] = err.Error()
			}
			out = append(out, item)
		}
	}
	OK(w, map[string]any{"success": true, "reports": out})
}

/* ── User → platform access ───────────────────────────────────────────────── */

// GET /api/admin/report-access — every staff/client login with its allow-list.
func ReportAccessList(w http.ResponseWriter, r *http.Request) {
	ensureReportConfigSchema()

	logins, err := db.Query(`
		SELECT l.loginId, l.first_name, l.last_name, l.login_username, l.is_active,
		       u.name AS client_name
		  FROM dcp_user_login l
		  LEFT JOIN dcp_user u ON u.userId = l.userId
		 WHERE l.deleted = 0
		 ORDER BY u.name, l.first_name, l.last_name
		 LIMIT 1000`)
	if err != nil {
		// deleted column may not exist on older schemas — fall back.
		logins, err = db.Query(`
			SELECT l.loginId, l.first_name, l.last_name, l.login_username, l.is_active,
			       u.name AS client_name
			  FROM dcp_user_login l
			  LEFT JOIN dcp_user u ON u.userId = l.userId
			 ORDER BY u.name LIMIT 1000`)
		if err != nil {
			Fail(w, 500, "Could not list logins")
			return
		}
	}

	grants := map[int64][]string{}
	if rows, err := db.Query("SELECT login_id, report_key FROM " + reportAccessTable); err == nil {
		for _, row := range rows {
			id := numOf(row["login_id"])
			grants[id] = append(grants[id], strFromAny(row["report_key"]))
		}
	}

	reports := []map[string]any{}
	for _, p := range loadPlatforms() {
		reports = append(reports, map[string]any{"key": p.Key, "label": p.Label})
	}

	users := make([]map[string]any, 0, len(logins))
	for _, l := range logins {
		id := numOf(l["loginId"])
		allowed, restricted := grants[id]
		users = append(users, map[string]any{
			"loginId":  id,
			"name":     strings.TrimSpace(strFromAny(l["first_name"]) + " " + strFromAny(l["last_name"])),
			"username": strFromAny(l["login_username"]),
			"client":   strFromAny(l["client_name"]),
			"isActive": numOf(l["is_active"]) == 1,
			// No rows → unrestricted, which is the default for everyone.
			"restricted": restricted,
			"allowed":    allowed,
		})
	}
	OK(w, map[string]any{"success": true, "reports": reports, "users": users})
}

/*
PUT /api/admin/report-access

	{ loginId, allowed: [keys] | null }                 one login
	{ updates: [ { loginId, allowed }, … ] }            many, in one request

`allowed: null` clears the restriction, restoring every report. An explicit
empty list is a real choice too — it means "no reports".

The batch form exists because the configuration screen grants a platform down a
whole column at once. Sent one login at a time that is forty round trips for one
click, each re-reading the platform list and inserting a row at a time; here it
is one request, one platform read, and one multi-row insert.
*/
func ReportAccessSave(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	ensureReportConfigSchema()

	type update struct {
		LoginID int64     `json:"loginId"`
		Allowed *[]string `json:"allowed"`
	}
	var body struct {
		update
		Updates []update `json:"updates"`
	}
	json.NewDecoder(r.Body).Decode(&body)

	updates := body.Updates
	if len(updates) == 0 {
		updates = []update{body.update}
	}
	if len(updates) == 0 || (len(updates) == 1 && updates[0].LoginID == 0) {
		Fail(w, 422, "A login is required")
		return
	}

	// Read the platform list ONCE. platformByKey() runs two queries every call,
	// and this used to call it per key per login — nineteen round trips to tick
	// one checkbox, and hundreds for a column.
	valid := map[string]bool{}
	for _, p := range loadPlatforms() {
		valid[p.Key] = true
	}

	who := ""
	if claims != nil {
		who = claims.LoginUsername
	}

	restricted := 0
	for _, u := range updates {
		if u.LoginID == 0 {
			continue
		}
		if _, _, err := db.Exec("DELETE FROM "+reportAccessTable+" WHERE login_id = ?", u.LoginID); err != nil {
			Fail(w, 500, "Could not update access")
			return
		}
		if u.Allowed == nil {
			continue // unrestricted: the absence of rows IS the state
		}
		restricted++

		keys := *u.Allowed
		if len(keys) == 0 {
			keys = []string{reportAccessNone}
		}
		// One INSERT for the whole login rather than one per platform.
		cols := make([]string, 0, len(keys))
		args := make([]any, 0, len(keys)*3)
		for _, k := range keys {
			k = strings.TrimSpace(k)
			if k == "" {
				continue
			}
			if k != reportAccessNone && !valid[k] {
				continue // unknown key: ignore it rather than failing the save
			}
			cols = append(cols, "(?, ?, ?)")
			args = append(args, u.LoginID, k, who)
		}
		if len(cols) == 0 {
			continue
		}
		if _, _, err := db.Exec(
			"INSERT IGNORE INTO "+reportAccessTable+" (login_id, report_key, granted_by) VALUES "+
				strings.Join(cols, ", "), args...); err != nil {
			log.Printf("[report-config] grant %d: %v", u.LoginID, err)
			Fail(w, 500, "Could not update access")
			return
		}
	}

	OK(w, map[string]any{
		"success": true, "updated": len(updates), "restricted": restricted > 0,
	})
}

// reportAccessNone marks "restricted to nothing", so it is distinguishable from
// a login that was never restricted at all.
const reportAccessNone = "__none__"

// validSQLName allows a bare identifier or schema.identifier. Used for the few
// values that must be interpolated into SQL rather than bound.
func validSQLName(s string) bool {
	s = strings.TrimSpace(s)
	if s == "" || len(s) > 191 {
		return false
	}
	for _, part := range strings.Split(s, ".") {
		if part == "" {
			return false
		}
		for _, c := range part {
			if !(c == '_' || c == '$' ||
				(c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) {
				return false
			}
		}
	}
	return strings.Count(s, ".") <= 1
}
