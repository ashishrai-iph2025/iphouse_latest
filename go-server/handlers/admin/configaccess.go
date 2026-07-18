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
	"war-room-assets",
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

// HasConfigModule reports whether the request's admin login may use a given
// configuration module. Super Admins (role 2) implicitly hold every module;
// every other admin is default-deny and must have an explicit grant in
// dcp_admin_config_access.
//
// This is the SERVER-SIDE enforcement of the grants that /admin/configuration
// merely renders. Without it, any role>=1 login could call an admin endpoint
// directly (curl) and reach modules — including the plaintext credential
// reveal endpoints — that a Super Admin never shared with them.
func HasConfigModule(r *http.Request, moduleKey string) bool {
	claims := middleware.GetClaims(r)
	if claims == nil || claims.Role == nil {
		return false
	}
	if *claims.Role >= 2 {
		return true
	}
	for _, k := range grantedKeys(claims.LoginID) {
		if k == moduleKey {
			return true
		}
	}
	return false
}

// RequireConfigModule wraps an admin handler so it can only be reached by a
// login actually granted that configuration module.
func RequireConfigModule(moduleKey string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !HasConfigModule(r, moduleKey) {
			fail(w, 403, "You do not have access to this configuration module")
			return
		}
		next(w, r)
	}
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
//
// Identity here is always dcp_super_admin.id — the SAME id that becomes
// claims.LoginID at login time for anyone authenticated via that table
// (handlers.claimsForSuperAdminRow). Earlier this validated against
// dcp_user_login.loginId instead, which breaks for a person granted through
// a shared login (they have many dcp_user_login rows, one per company, but
// only one dcp_super_admin row/id) — that mismatch is fixed here.
//
//   GET                       → { admins: [...] }        every Admin/SuperAdmin (from dcp_super_admin)
//   GET ?loginId=<sa.id>      → { granted: [keys] }       modules currently shared with that person
//   GET ?loginUsername=<email> → { id, role, granted }    resolve a person by email in one call
//   PUT {loginId,moduleKey,grant} → share / unshare one module with that person
func SuperAdminConfigAccess(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		if lu := r.URL.Query().Get("loginUsername"); lu != "" {
			sa := superAdminByEmailPublic(lu)
			if sa == nil {
				ok(w, map[string]any{"success": true, "id": nil, "role": 0, "granted": []string{}}); return
			}
			role := int64(1)
			if strVal(sa["role"]) == "SuperAdmin" {
				role = 2
			}
			ok(w, map[string]any{"success": true, "id": intVal(sa["id"]), "role": role, "granted": grantedKeys(intVal(sa["id"]))}); return
		}
		if lid := r.URL.Query().Get("loginId"); lid != "" {
			ok(w, map[string]any{"success": true, "granted": grantedKeys(lid)}); return
		}
		admins, _ := db.Query(`
			SELECT id AS loginId, name, email AS login_username, role
			FROM dcp_super_admin
			WHERE is_active = 1
			ORDER BY role DESC, name ASC`)
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
		target, _ := db.QueryOne("SELECT id FROM dcp_super_admin WHERE id = ? AND is_active = 1", body.LoginID)
		if target == nil {
			fail(w, 404, "Admin not found"); return
		}
		if body.Grant {
			db.Exec(`INSERT INTO dcp_admin_config_access (loginId, module_key, granted, updated_at)
				VALUES (?, ?, 1, UTC_TIMESTAMP())
				ON DUPLICATE KEY UPDATE granted = 1, updated_at = UTC_TIMESTAMP()`, body.LoginID, body.ModuleKey)
		} else {
			db.Exec("DELETE FROM dcp_admin_config_access WHERE loginId = ? AND module_key = ?", body.LoginID, body.ModuleKey)
		}
		ok(w, map[string]any{"success": true})

	default:
		fail(w, 405, "Method not allowed")
	}
}

// superAdminByEmailPublic is a small local wrapper so this file doesn't need
// to import the handlers package just for its unexported superAdminByEmail.
func superAdminByEmailPublic(email string) map[string]any {
	row, _ := db.QueryOne(`
		SELECT id, name, email, role, is_active
		FROM dcp_super_admin WHERE email = ? AND is_active = 1 LIMIT 1`, email)
	return row
}
