package admin

import (
	"encoding/json"
	"net/http"

	"github.com/ip-house/iphouse-api/db"
)

// GET  /api/admin/super-admin — list all users
// PUT  /api/admin/super-admin — grant/revoke admin
func SuperAdmin(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		superAdminList(w, r)
	case http.MethodPut:
		superAdminUpdate(w, r)
	default:
		fail(w, 405, "Method not allowed")
	}
}

func superAdminList(w http.ResponseWriter, r *http.Request) {
	users, _ := db.Query(`
		SELECT userId, name, email, COALESCE(role, 0) AS role, is_active, 'user' AS source
		FROM dcp_user WHERE deleted = 0
		UNION ALL
		SELECT id AS userId, name, email, 2 AS role, is_active, 'super_admin' AS source
		FROM dcp_super_admin
		ORDER BY role DESC, name ASC`)
	if users == nil {
		users = []map[string]any{}
	}
	ok(w, map[string]any{"success": true, "users": users})
}

func superAdminUpdate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		UserID     int64  `json:"userId"`
		GrantAdmin bool   `json:"grantAdmin"`
		Source     string `json:"source"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if body.UserID == 0 {
		fail(w, 422, "userId required"); return
	}
	if body.Source == "super_admin" {
		fail(w, 403, "Cannot modify super admin"); return
	}
	target, _ := db.QueryOne("SELECT COALESCE(role,0) AS role FROM dcp_user WHERE userId = ?", body.UserID)
	if target == nil {
		fail(w, 404, "User not found"); return
	}
	if intVal(target["role"]) == 2 {
		fail(w, 403, "Cannot modify super admin"); return
	}
	newRole := 0
	if body.GrantAdmin {
		newRole = 1
	}
	db.Exec("UPDATE dcp_user SET role = ? WHERE userId = ?", newRole, body.UserID)
	ok(w, map[string]any{"success": true})
}

// GET /api/admin/super-admin/active-sessions
func ActiveSessions(w http.ResponseWriter, r *http.Request) {
	rows, _ := db.Query(`
		SELECT l.loginId, l.login_username, l.last_seen_at, u.name, u.role
		FROM dcp_user_login l
		JOIN dcp_user u ON u.userId = l.userId
		WHERE l.is_active = 1 AND u.deleted = 0
		  AND l.last_seen_at >= DATE_SUB(NOW(), INTERVAL 30 MINUTE)
		ORDER BY l.last_seen_at DESC`)
	if rows == nil {
		rows = []map[string]any{}
	}
	ok(w, map[string]any{"success": true, "sessions": rows})
}

// POST /api/admin/super-admin/force-logout
func ForceLogout(w http.ResponseWriter, r *http.Request) {
	var body struct {
		LoginID int64 `json:"loginId"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if body.LoginID == 0 {
		fail(w, 422, "loginId required"); return
	}
	db.Exec("UPDATE dcp_user_login SET force_logout_at = NOW() WHERE loginId = ?", body.LoginID)
	ok(w, map[string]any{"success": true})
}

// GET/PUT /api/admin/super-admin/permissions
//   GET                 → { users: [...] }    login users + role (Access Control + user picker)
//   GET ?userId=<id>    → { modules: [...] }   dashboard modules with a granted flag for that user
//   PUT {userId,moduleId,grant} → grant/revoke a dashboard module for the user
func SuperAdminPermissions(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		// Per-user dashboard-module grants.
		if uid := r.URL.Query().Get("userId"); uid != "" {
			mods, _ := db.Query(`
				SELECT m.moduleId, m.moduleName, m.moduleIcon,
				       CASE WHEN mp.userId IS NULL THEN 0 ELSE 1 END AS granted
				FROM dcp_module m
				LEFT JOIN dcp_user_module_map mp
				       ON mp.moduleId = m.moduleId AND mp.userId = ?
				WHERE m.deleted = 0
				ORDER BY m.moduleName ASC`, uid)
			if mods == nil {
				mods = []map[string]any{}
			}
			ok(w, map[string]any{"success": true, "modules": mods}); return
		}

		// Full login-user list (with the owning client's role).
		users, _ := db.Query(`
			SELECT l.loginId, u.userId, l.first_name, l.last_name,
			       l.login_username, l.is_active,
			       u.name AS user_name, u.email AS user_email,
			       COALESCE(u.role, 0) AS role
			FROM dcp_user_login l
			INNER JOIN dcp_user u ON u.userId = l.userId
			WHERE u.deleted = 0
			ORDER BY u.name ASC, l.login_username ASC`)
		if users == nil {
			users = []map[string]any{}
		}
		ok(w, map[string]any{"success": true, "users": users})

	case http.MethodPut:
		var body struct {
			UserID   int64 `json:"userId"`
			ModuleID int64 `json:"moduleId"`
			Grant    bool  `json:"grant"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if body.UserID == 0 || body.ModuleID == 0 {
			fail(w, 422, "userId and moduleId required"); return
		}
		if body.Grant {
			existing, _ := db.QueryOne("SELECT userId FROM dcp_user_module_map WHERE userId = ? AND moduleId = ?", body.UserID, body.ModuleID)
			if existing == nil {
				db.Exec("INSERT INTO dcp_user_module_map (userId, moduleId, active, `default`) VALUES (?, ?, 1, 0)", body.UserID, body.ModuleID)
			} else {
				db.Exec("UPDATE dcp_user_module_map SET active = 1 WHERE userId = ? AND moduleId = ?", body.UserID, body.ModuleID)
			}
		} else {
			// Only remove mappings that have no embed link, so configured
			// dashboards are never destroyed by a permission toggle.
			db.Exec("DELETE FROM dcp_user_module_map WHERE userId = ? AND moduleId = ? AND (link IS NULL OR link = '')", body.UserID, body.ModuleID)
		}
		ok(w, map[string]any{"success": true})

	default:
		fail(w, 405, "Method not allowed")
	}
}
