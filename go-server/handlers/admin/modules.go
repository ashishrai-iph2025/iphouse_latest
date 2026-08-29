package admin

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"

	"github.com/ip-house/iphouse-api/db"
)

// How many logins one grant lookup may ask about. A shared login spans the
// companies one person reads — a handful, not a page of them.
const maxLoginIDsPerLookup = 50

/*
inPlaceholders is "?,?,?" — the bind markers for an IN clause of n values.

Built from the count rather than pasted, because the two have to agree exactly
and database/sql only notices when the statement RUNS: an off-by-one compiles,
vets, passes every test that does not reach a database, and then fails in front
of whoever opened the screen. Ids are still bound as arguments — only the
markers are assembled here, never a value.
*/
func inPlaceholders(n int) string {
	if n <= 0 {
		return ""
	}
	return strings.TrimSuffix(strings.Repeat("?,", n), ",")
}

// GET/POST/PUT/DELETE /api/admin/modules
func Modules(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		rows, _ := db.Query("SELECT * FROM module_permission ORDER BY Id")
		if rows == nil {
			rows = []map[string]any{}
		}
		ok(w, map[string]any{"success": true, "modules": rows})
	case http.MethodPost:
		var body struct {
			ModuleName string `json:"moduleName"`
			PageName   string `json:"pageName"`
			Status     int    `json:"status"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		db.Exec("INSERT INTO module_permission (ModuleName, pageName, status) VALUES (?, ?, ?)",
			body.ModuleName, body.PageName, body.Status)
		ok(w, map[string]any{"success": true})
	case http.MethodPut:
		var body struct {
			ID         int64  `json:"id"`
			ModuleName string `json:"moduleName"`
			PageName   string `json:"pageName"`
			Status     int    `json:"status"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		db.Exec("UPDATE module_permission SET ModuleName=?, pageName=?, status=? WHERE Id=?",
			body.ModuleName, body.PageName, body.Status, body.ID)
		ok(w, map[string]any{"success": true})
	default:
		fail(w, 405, "Method not allowed")
	}
}

/*
dashboardCategories mirrors DASHBOARD_CATEGORIES in lib/dashboardCategories.ts.

Two copies on purpose. The browser one decides what a picker can OFFER; this one
decides what the column may HOLD, and a value the UI cannot offer can still
arrive from a hand-written request. Anything not in this list — bar the empty
string, which is the uncategorised state every existing row starts in — is
refused rather than stored, because a category nothing can filter on is a row
that quietly drops out of every list built on it.
*/
var dashboardCategories = []string{"VOD", "Sports", "War Room"}

// cleanCategory trims a submitted category and returns it with whether it is
// storable. "" is storable and means uncategorised.
func cleanCategory(v string) (string, bool) {
	c := strings.TrimSpace(v)
	if c == "" {
		return "", true
	}
	for _, known := range dashboardCategories {
		// Case-insensitive so "vod" stores as "VOD" rather than as a fourth
		// category that looks identical in a list and matches none of the
		// filters built on the other three.
		if strings.EqualFold(known, c) {
			return known, true
		}
	}
	return "", false
}

// GET/POST/PUT/DELETE /api/admin/dashboard-modules — CRUD for the dcp_module table
// (the PowerBI dashboard module catalog: Internet, Social Media, Telegram, etc.).
//
// `category` files each module under VOD, Sports or War Room — see migration 006.
// It is what /admin/registrations narrows by when granting a person a subset of
// the report catalogue, so it is carried on every read here rather than fetched
// separately.
func DashboardModules(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		showDeleted := r.URL.Query().Get("showDeleted") == "1"
		q := "SELECT moduleId, moduleName, moduleIcon, category, deleted FROM dcp_module"
		if !showDeleted {
			q += " WHERE deleted = 0"
		}
		q += " ORDER BY moduleId ASC"
		rows, err := db.Query(q)
		if err != nil {
			log.Printf("[dashboard-modules] query failed: %v", err)
			fail(w, 500, "Could not load dashboard modules.")
			return
		}
		if rows == nil {
			rows = []map[string]any{}
		}
		log.Printf("[dashboard-modules] returned %d rows", len(rows))
		ok(w, map[string]any{"success": true, "modules": rows})

	case http.MethodPost:
		var body struct {
			ModuleName string `json:"moduleName"`
			ModuleIcon string `json:"moduleIcon"`
			Category   string `json:"category"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if body.ModuleName == "" {
			fail(w, 422, "moduleName required")
			return
		}
		category, okCat := cleanCategory(body.Category)
		if !okCat {
			fail(w, 422, "Unknown category")
			return
		}
		_, _, err := db.Exec("INSERT INTO dcp_module (moduleName, moduleIcon, category, deleted) VALUES (?, ?, ?, 0)",
			body.ModuleName, nullStr(body.ModuleIcon), category)
		if err != nil {
			fail(w, 500, "Could not create module")
			return
		}
		ok(w, map[string]any{"success": true})

	case http.MethodPut:
		var body struct {
			ModuleID   int64  `json:"moduleId"`
			ModuleName string `json:"moduleName"`
			ModuleIcon string `json:"moduleIcon"`
			Category   string `json:"category"`
			Restore    bool   `json:"restore"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if body.ModuleID == 0 {
			fail(w, 422, "moduleId required")
			return
		}
		if body.Restore {
			db.Exec("UPDATE dcp_module SET deleted = 0 WHERE moduleId = ?", body.ModuleID)
		} else {
			if body.ModuleName == "" {
				fail(w, 422, "moduleName required")
				return
			}
			category, okCat := cleanCategory(body.Category)
			if !okCat {
				fail(w, 422, "Unknown category")
				return
			}
			db.Exec("UPDATE dcp_module SET moduleName = ?, moduleIcon = ?, category = ? WHERE moduleId = ?",
				body.ModuleName, nullStr(body.ModuleIcon), category, body.ModuleID)
		}
		ok(w, map[string]any{"success": true})

	case http.MethodDelete:
		var body struct {
			ModuleID int64 `json:"moduleId"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if body.ModuleID == 0 {
			fail(w, 422, "moduleId required")
			return
		}
		db.Exec("UPDATE dcp_module SET deleted = 1 WHERE moduleId = ?", body.ModuleID)
		ok(w, map[string]any{"success": true})

	default:
		fail(w, 405, "Method not allowed")
	}
}

// GET/POST/PUT/DELETE /api/admin/module-permissions
func ModulePermissions(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		showDeleted := r.URL.Query().Get("showDeleted") == "1"
		var rows []map[string]any
		if showDeleted {
			rows, _ = db.Query("SELECT Id, ModuleName, pageName, status, nav_order, created, updated FROM module_permission ORDER BY nav_order ASC, Id ASC")
		} else {
			rows, _ = db.Query("SELECT Id, ModuleName, pageName, status, nav_order, created, updated FROM module_permission WHERE status = 0 ORDER BY nav_order ASC, Id ASC")
		}
		if rows == nil {
			rows = []map[string]any{}
		}
		ok(w, map[string]any{"success": true, "modules": rows})
	case http.MethodPost:
		var body struct {
			ModuleName string `json:"moduleName"`
			PageName   string `json:"pageName"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if body.ModuleName == "" {
			fail(w, 422, "moduleName required")
			return
		}
		db.Exec("INSERT INTO module_permission (ModuleName, pageName, status, created, updated) VALUES (?, ?, 0, UTC_TIMESTAMP(), UTC_TIMESTAMP())",
			body.ModuleName, body.PageName)
		ok(w, map[string]any{"success": true})
	case http.MethodPut:
		var body struct {
			ID         int64  `json:"id"`
			ModuleName string `json:"moduleName"`
			PageName   string `json:"pageName"`
			Restore    bool   `json:"restore"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if body.ID == 0 {
			fail(w, 422, "id required")
			return
		}
		if body.Restore {
			db.Exec("UPDATE module_permission SET status = 0, updated = UTC_TIMESTAMP() WHERE Id = ?", body.ID)
		} else {
			if body.ModuleName == "" {
				fail(w, 422, "moduleName required")
				return
			}
			db.Exec("UPDATE module_permission SET ModuleName = ?, pageName = ?, updated = UTC_TIMESTAMP() WHERE Id = ?",
				body.ModuleName, body.PageName, body.ID)
		}
		ok(w, map[string]any{"success": true})
	case http.MethodDelete:
		var body struct {
			ID int64 `json:"id"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if body.ID == 0 {
			fail(w, 422, "id required")
			return
		}
		db.Exec("UPDATE module_permission SET status = 1, updated = UTC_TIMESTAMP() WHERE Id = ?", body.ID)
		ok(w, map[string]any{"success": true})
	default:
		fail(w, 405, "Method not allowed")
	}
}

// POST /api/admin/module-permissions/reorder — set the client-nav order.
// Body: { orderedIds: [int] } in the desired top-to-bottom sequence. Every
// listed row gets a sequential nav_order (1..N) so ordering is fully defined.
func ModulePermissionsReorder(w http.ResponseWriter, r *http.Request) {
	var body struct {
		OrderedIds []int64 `json:"orderedIds"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if len(body.OrderedIds) == 0 {
		fail(w, 422, "orderedIds required")
		return
	}
	for i, id := range body.OrderedIds {
		db.Exec("UPDATE module_permission SET nav_order = ?, updated = UTC_TIMESTAMP() WHERE Id = ?", i+1, id)
	}
	ok(w, map[string]any{"success": true})
}

// activeModules is the grantable list — deleted modules excluded, in the order
// the Module Permissions screen shows them, so two pickers cannot disagree
// about what exists or about what order it comes in.
func activeModules() []map[string]any {
	rows, _ := db.Query(`SELECT Id, ModuleName, pageName, status FROM module_permission WHERE status = 0 ORDER BY Id ASC`)
	if rows == nil {
		return []map[string]any{}
	}
	return rows
}

// GET/POST /api/admin/user-module-permissions
func UserModulePermissions(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		/* Several logins at once: ?loginIds=4,9,12 → { success, byLogin: {"4":[…]} }

		   One person's shared login is one row per company they may read, each with
		   its own loginId and its own grants — see the `assignments` column in
		   SharedLogins. The account editor shows all of them together so an admin
		   can see that a login has Reports on one company and nothing on another,
		   which is the state this screen exists to correct and the one that a
		   per-login lookup makes invisible: it answers only about the company you
		   already chose to look at. */
		if raw := r.URL.Query().Get("loginIds"); raw != "" {
			ids := []any{}
			for _, part := range strings.Split(raw, ",") {
				n, err := strconv.ParseInt(strings.TrimSpace(part), 10, 64)
				if err != nil || n <= 0 {
					continue
				}
				ids = append(ids, n)
				// A person is assigned to a handful of companies. A cap keeps this a
				// lookup rather than a way to page the whole grant table out.
				if len(ids) >= maxLoginIDsPerLookup {
					break
				}
			}
			if len(ids) == 0 {
				fail(w, 422, "loginIds must be one or more login ids")
				return
			}
			rows, _ := db.Query("SELECT loginId, moduleId FROM user_module_permission_test"+
				" WHERE allowed = 1 AND loginId IN ("+inPlaceholders(len(ids))+")", ids...)
			// Every id asked for gets a key, present or not: absent and
			// "granted nothing" are the same answer here, and a missing key
			// would leave the caller unable to tell either from "not read yet".
			byLogin := map[string][]int64{}
			for _, id := range ids {
				byLogin[fmt.Sprint(id)] = []int64{}
			}
			for _, row := range rows {
				k := fmt.Sprint(intVal(row["loginId"]))
				byLogin[k] = append(byLogin[k], intVal(row["moduleId"]))
			}
			/* The module list rides along. The caller is a panel inside another
			   screen's drawer and it needs both halves before it can draw a single
			   checkbox — asking twice would put a visible gap between "the list
			   appeared" and "the ticks appeared", which reads as the grants having
			   been cleared. */
			ok(w, map[string]any{"success": true, "byLogin": byLogin, "modules": activeModules()})
			return
		}

		// Single-user permission lookup: ?loginId=X → { success, allowed: []int }
		if lid := r.URL.Query().Get("loginId"); lid != "" {
			rows, _ := db.Query("SELECT moduleId FROM user_module_permission_test WHERE loginId = ? AND allowed = 1", lid)
			allowed := make([]int64, 0)
			for _, row := range rows {
				allowed = append(allowed, intVal(row["moduleId"]))
			}
			ok(w, map[string]any{"success": true, "allowed": allowed})
			return
		}
		// Full list: users + modules for page load
		// roleJoin is needed for staffFilter, which reads sa.role — see users.go.
		users, _ := db.Query(`
			SELECT u.userId, l.loginId, u.name AS clientName,
			       CONCAT(IFNULL(l.first_name,''),' ',IFNULL(l.last_name,'')) AS name,
			       l.login_username AS username, l.is_active
			FROM dcp_user_login l
			INNER JOIN dcp_user u ON u.userId = l.userId
			` + roleJoin + `
			WHERE l.is_active = 1 AND u.deleted = 0` + staffFilter + `
			ORDER BY u.name, l.login_username`)
		if users == nil {
			users = []map[string]any{}
		}
		ok(w, map[string]any{"success": true, "users": users, "modules": activeModules()})
		return
	}

	var body struct {
		LoginID   int64   `json:"loginId"`
		ModuleIDs []int64 `json:"modules"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if body.LoginID == 0 {
		fail(w, 422, "loginId required")
		return
	}

	db.Exec("DELETE FROM user_module_permission_test WHERE loginId = ?", body.LoginID)
	for _, mid := range body.ModuleIDs {
		db.Exec("INSERT INTO user_module_permission_test (loginId, moduleId, allowed) VALUES (?, ?, 1)", body.LoginID, mid)
	}
	ok(w, map[string]any{"success": true})
}
