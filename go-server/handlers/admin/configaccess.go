package admin

import (
	"encoding/json"
	"net/http"

	"github.com/ip-house/iphouse-api/db"
	"github.com/ip-house/iphouse-api/middleware"
)

// configModuleKeys mirrors CONFIG_MODULES in lib/configModules.ts.
// It is the allow-list of module keys that may be stored in dcp_admin_config_access,
// and the full set a Super Admin implicitly has access to.
var configModuleKeys = []string{
	"modules",
	"api-credentials",
	"dashboard-modules",
	"module-permissions",
	"master-api",
	"powerbi-creds",
	"powerbi-workspace",
	"settings",
	"idle-timeout",
	"registration-requests",
	"tracking",
	"asset-access",
	"email-templates",
	"email-event-types",
	"api-playground",
}

func isConfigModuleKey(k string) bool {
	for _, v := range configModuleKeys {
		if v == k {
			return true
		}
	}
	return false
}

// grantedKeys returns the config module keys explicitly shared with an admin login.
// Access is grant-based (default deny): an admin sees only the modules listed here.
// loginID may be an int64 (JWT claim) or a string (query param) — MySQL coerces it.
func grantedKeys(loginID any) []string {
	rows, _ := db.Query(
		"SELECT module_key FROM dcp_admin_config_access WHERE loginId = ? AND granted = 1",
		loginID)
	keys := make([]string, 0, len(rows))
	for _, r := range rows {
		keys = append(keys, strVal(r["module_key"]))
	}
	return keys
}

// GET /api/admin/my-config-access  (any admin)
// Returns the config modules the *current* admin login is allowed to see.
// Super Admins (role 2) implicitly get every module.
func MyConfigAccess(w http.ResponseWriter, r *http.Request) {
	claims := middleware.GetClaims(r)
	if claims == nil {
		fail(w, 401, "Not authenticated"); return
	}
	role := int64(0)
	if claims.Role != nil {
		role = *claims.Role
	}
	if role >= 2 {
		ok(w, map[string]any{"success": true, "role": role, "granted": configModuleKeys}); return
	}
	ok(w, map[string]any{"success": true, "role": role, "granted": grantedKeys(claims.LoginID)})
}

// GET/PUT /api/admin/super-admin/config-access  (super admin only)
//   GET                 → { admins: [...] }              admin logins (role >= 1)
//   GET ?loginId=<id>   → { granted: [keys] }            modules currently shared with that login
//   PUT {loginId,moduleKey,grant} → share / unshare one module with an admin login
func SuperAdminConfigAccess(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		if lid := r.URL.Query().Get("loginId"); lid != "" {
			ok(w, map[string]any{"success": true, "granted": grantedKeys(lid)}); return
		}
		// One row per admin login, so separate logins under the same account
		// are controlled independently (mirrors the Access Control tab).
		admins, _ := db.Query(`
			SELECT l.loginId, l.login_username, l.first_name, l.last_name,
			       u.userId, u.name AS company, u.email,
			       COALESCE(u.role, 0) AS role
			FROM dcp_user_login l
			INNER JOIN dcp_user u ON u.userId = l.userId
			WHERE u.deleted = 0 AND COALESCE(u.role, 0) >= 1
			ORDER BY u.role DESC, l.login_username ASC`)
		if admins == nil {
			admins = []map[string]any{}
		}
		ok(w, map[string]any{"success": true, "admins": admins})

	case http.MethodPut:
		var body struct {
			LoginID   int64  `json:"loginId"`
			ModuleKey string `json:"moduleKey"`
			Grant     bool   `json:"grant"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if body.LoginID == 0 || body.ModuleKey == "" {
			fail(w, 422, "loginId and moduleKey required"); return
		}
		if !isConfigModuleKey(body.ModuleKey) {
			fail(w, 422, "Unknown module key"); return
		}
		// Confirm the login belongs to an admin account.
		target, _ := db.QueryOne(`
			SELECT COALESCE(u.role, 0) AS role
			FROM dcp_user_login l
			INNER JOIN dcp_user u ON u.userId = l.userId
			WHERE l.loginId = ? AND u.deleted = 0`, body.LoginID)
		if target == nil {
			fail(w, 404, "Admin login not found"); return
		}
		if intVal(target["role"]) < 1 {
			fail(w, 422, "Login is not an admin"); return
		}
		if body.Grant {
			db.Exec(`INSERT INTO dcp_admin_config_access (loginId, module_key, granted, updated_at)
				VALUES (?, ?, 1, NOW())
				ON DUPLICATE KEY UPDATE granted = 1, updated_at = NOW()`, body.LoginID, body.ModuleKey)
		} else {
			db.Exec("DELETE FROM dcp_admin_config_access WHERE loginId = ? AND module_key = ?", body.LoginID, body.ModuleKey)
		}
		ok(w, map[string]any{"success": true})

	default:
		fail(w, 405, "Method not allowed")
	}
}
