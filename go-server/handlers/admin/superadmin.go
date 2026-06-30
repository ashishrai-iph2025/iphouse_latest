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
func SuperAdminPermissions(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		rows, _ := db.Query("SELECT * FROM dcp_super_admin_permissions ORDER BY id")
		if rows == nil {
			rows = []map[string]any{}
		}
		ok(w, map[string]any{"success": true, "permissions": rows})
	case http.MethodPut:
		var body any
		json.NewDecoder(r.Body).Decode(&body)
		ok(w, map[string]any{"success": true})
	default:
		fail(w, 405, "Method not allowed")
	}
}
