package admin

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/ip-house/iphouse-api/db"
)

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

// GET/POST/PUT/DELETE /api/admin/dashboard-modules — CRUD for the dcp_module table
// (the PowerBI dashboard module catalog: Internet, Social Media, Telegram, etc.).
func DashboardModules(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		showDeleted := r.URL.Query().Get("showDeleted") == "1"
		q := "SELECT moduleId, moduleName, moduleIcon, deleted FROM dcp_module"
		if !showDeleted {
			q += " WHERE deleted = 0"
		}
		q += " ORDER BY moduleId ASC"
		rows, err := db.Query(q)
		if err != nil {
			log.Printf("[dashboard-modules] query failed: %v", err)
			fail(w, 500, "Database error: "+err.Error()); return
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
		}
		json.NewDecoder(r.Body).Decode(&body)
		if body.ModuleName == "" {
			fail(w, 422, "moduleName required"); return
		}
		_, _, err := db.Exec("INSERT INTO dcp_module (moduleName, moduleIcon, deleted) VALUES (?, ?, 0)",
			body.ModuleName, nullStr(body.ModuleIcon))
		if err != nil {
			fail(w, 500, "Could not create module"); return
		}
		ok(w, map[string]any{"success": true})

	case http.MethodPut:
		var body struct {
			ModuleID   int64  `json:"moduleId"`
			ModuleName string `json:"moduleName"`
			ModuleIcon string `json:"moduleIcon"`
			Restore    bool   `json:"restore"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if body.ModuleID == 0 {
			fail(w, 422, "moduleId required"); return
		}
		if body.Restore {
			db.Exec("UPDATE dcp_module SET deleted = 0 WHERE moduleId = ?", body.ModuleID)
		} else {
			if body.ModuleName == "" {
				fail(w, 422, "moduleName required"); return
			}
			db.Exec("UPDATE dcp_module SET moduleName = ?, moduleIcon = ? WHERE moduleId = ?",
				body.ModuleName, nullStr(body.ModuleIcon), body.ModuleID)
		}
		ok(w, map[string]any{"success": true})

	case http.MethodDelete:
		var body struct {
			ModuleID int64 `json:"moduleId"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if body.ModuleID == 0 {
			fail(w, 422, "moduleId required"); return
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
			rows, _ = db.Query("SELECT Id, ModuleName, pageName, status, created, updated FROM module_permission ORDER BY Id ASC")
		} else {
			rows, _ = db.Query("SELECT Id, ModuleName, pageName, status, created, updated FROM module_permission WHERE status = 0 ORDER BY Id ASC")
		}
		if rows == nil { rows = []map[string]any{} }
		ok(w, map[string]any{"success": true, "modules": rows})
	case http.MethodPost:
		var body struct {
			ModuleName string `json:"moduleName"`
			PageName   string `json:"pageName"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if body.ModuleName == "" { fail(w, 422, "moduleName required"); return }
		db.Exec("INSERT INTO module_permission (ModuleName, pageName, status, created, updated) VALUES (?, ?, 0, NOW(), NOW())",
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
		if body.ID == 0 { fail(w, 422, "id required"); return }
		if body.Restore {
			db.Exec("UPDATE module_permission SET status = 0, updated = NOW() WHERE Id = ?", body.ID)
		} else {
			if body.ModuleName == "" { fail(w, 422, "moduleName required"); return }
			db.Exec("UPDATE module_permission SET ModuleName = ?, pageName = ?, updated = NOW() WHERE Id = ?",
				body.ModuleName, body.PageName, body.ID)
		}
		ok(w, map[string]any{"success": true})
	case http.MethodDelete:
		var body struct { ID int64 `json:"id"` }
		json.NewDecoder(r.Body).Decode(&body)
		if body.ID == 0 { fail(w, 422, "id required"); return }
		db.Exec("UPDATE module_permission SET status = 1, updated = NOW() WHERE Id = ?", body.ID)
		ok(w, map[string]any{"success": true})
	default:
		fail(w, 405, "Method not allowed")
	}
}

// GET/POST /api/admin/user-module-permissions
func UserModulePermissions(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
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
		users, _ := db.Query(`
			SELECT u.userId, l.loginId, u.name AS clientName,
			       CONCAT(IFNULL(l.first_name,''),' ',IFNULL(l.last_name,'')) AS name,
			       l.login_username AS username, l.is_active
			FROM dcp_user_login l
			INNER JOIN dcp_user u ON u.userId = l.userId
			WHERE l.is_active = 1 AND u.deleted = 0
			ORDER BY u.name, l.login_username`)
		modules, _ := db.Query(`SELECT Id, ModuleName, pageName, status FROM module_permission WHERE status = 0 ORDER BY Id ASC`)
		if users == nil { users = []map[string]any{} }
		if modules == nil { modules = []map[string]any{} }
		ok(w, map[string]any{"success": true, "users": users, "modules": modules})
		return
	}

	var body struct {
		LoginID   int64   `json:"loginId"`
		ModuleIDs []int64 `json:"modules"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if body.LoginID == 0 {
		fail(w, 422, "loginId required"); return
	}

	db.Exec("DELETE FROM user_module_permission_test WHERE loginId = ?", body.LoginID)
	for _, mid := range body.ModuleIDs {
		db.Exec("INSERT INTO user_module_permission_test (loginId, moduleId, allowed) VALUES (?, ?, 1)", body.LoginID, mid)
	}
	ok(w, map[string]any{"success": true})
}
