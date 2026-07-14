package admin

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"

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
	// dcp_user.role is kept in sync (0/1/2) whenever an account is granted
	// Admin/Super Admin, so it alone reflects the effective role — the
	// mirrored dcp_super_admin row is only appended for the original,
	// hand-seeded root Super Admin (no backing dcp_user account at all).
	users, _ := db.Query(`
		SELECT userId, name, email, COALESCE(role, 0) AS role, is_active, 'user' AS source
		FROM dcp_user WHERE deleted = 0
		UNION ALL
		SELECT id AS userId, name, email, 2 AS role, is_active, 'super_admin' AS source
		FROM dcp_super_admin
		WHERE userId IS NULL
		ORDER BY role DESC, name ASC`)
	if users == nil {
		users = []map[string]any{}
	}
	ok(w, map[string]any{"success": true, "users": users})
}

// superAdminUpdate changes a role to client/admin/superadmin, either for a
// single staff account (by userId) or for the PERSON behind a shared login
// (by loginUsername — see superAdminUpdateByLogin). Granting Admin or Super
// Admin mirrors into dcp_super_admin (role = 'Admin' | 'SuperAdmin',
// is_active = 1), reusing the existing password hash, so dcp_super_admin is
// the single table the login flow checks for any elevated-privilege account —
// supporting both password and OTP login uniformly.
func superAdminUpdate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		UserID        int64  `json:"userId"`
		LoginUsername string `json:"loginUsername"` // shared-login/person-based grant — takes precedence over userId
		GrantAdmin    bool   `json:"grantAdmin"`     // legacy: true→admin, false→client (used when Role is empty)
		Role          string `json:"role"`           // "client" | "admin" | "superadmin" — takes precedence over grantAdmin
		Source        string `json:"source"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if body.Source == "super_admin" {
		fail(w, 403, "Cannot modify the root super admin"); return
	}

	role := strings.ToLower(strings.TrimSpace(body.Role))
	if role == "" {
		if body.GrantAdmin {
			role = "admin"
		} else {
			role = "client"
		}
	}
	if role != "client" && role != "admin" && role != "superadmin" {
		fail(w, 422, "role must be client, admin or superadmin"); return
	}

	if body.LoginUsername != "" {
		superAdminUpdateByLogin(w, body.LoginUsername, role)
		return
	}

	if body.UserID == 0 {
		fail(w, 422, "userId or loginUsername required"); return
	}
	target, _ := db.QueryOne("SELECT userId FROM dcp_user WHERE userId = ? AND deleted = 0", body.UserID)
	if target == nil {
		fail(w, 404, "User not found"); return
	}

	currentSA, _ := db.QueryOne("SELECT role FROM dcp_super_admin WHERE userId = ? LIMIT 1", body.UserID)
	if currentSA != nil && strVal(currentSA["role"]) == "SuperAdmin" && role != "superadmin" {
		if activeSuperAdminCount() <= 1 {
			fail(w, 422, "At least one Super Admin must remain — promote someone else first"); return
		}
	}

	dcpRole := map[string]int{"client": 0, "admin": 1, "superadmin": 2}[role]
	db.Exec("UPDATE dcp_user SET role = ? WHERE userId = ?", dcpRole, body.UserID)

	if role == "client" {
		db.Exec("DELETE FROM dcp_super_admin WHERE userId = ?", body.UserID)
		ok(w, map[string]any{"success": true}); return
	}

	login, _ := db.QueryOne(`
		SELECT loginId, login_username, login_password, first_name, last_name
		FROM dcp_user_login WHERE userId = ? AND is_active = 1 ORDER BY loginId ASC LIMIT 1`, body.UserID)
	if login == nil {
		fail(w, 422, "This user has no active login to grant portal access through"); return
	}
	name := strings.TrimSpace(strVal(login["first_name"]) + " " + strVal(login["last_name"]))
	if name == "" {
		if u, _ := db.QueryOne("SELECT name FROM dcp_user WHERE userId = ?", body.UserID); u != nil {
			name = strVal(u["name"])
		}
	}
	roleLabel := "Admin"
	if role == "superadmin" {
		roleLabel = "SuperAdmin"
	}
	_, _, err := db.Exec(`
		INSERT INTO dcp_super_admin (name, email, password_hash, is_active, role, userId, loginId)
		VALUES (?, ?, ?, 1, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
			name = VALUES(name), password_hash = VALUES(password_hash),
			is_active = 1, role = VALUES(role), userId = VALUES(userId), loginId = VALUES(loginId)`,
		name, strVal(login["login_username"]), strVal(login["login_password"]), roleLabel, body.UserID, intVal(login["loginId"]))
	if err != nil {
		fail(w, 500, "Failed to grant portal access"); return
	}

	ok(w, map[string]any{"success": true})
}

// activeSuperAdminCount returns how many active Super Admin rows currently
// exist. Used to block the last one from being demoted or revoked, so a
// mistake can never leave the portal with zero Super Admins.
func activeSuperAdminCount() int64 {
	row, _ := db.QueryOne("SELECT COUNT(*) AS c FROM dcp_super_admin WHERE role = 'SuperAdmin' AND is_active = 1")
	if row == nil {
		return 0
	}
	return intVal(row["c"])
}

// superAdminUpdateByLogin grants/revokes portal-staff access to the PERSON
// behind a shared login (identified by login_username/email), independent of
// dcp_user.role. Shared logins can be assigned to many client companies at
// once, so there is no single "owning" company whose role should flip —
// unlike the per-userId path above, this never touches dcp_user at all.
func superAdminUpdateByLogin(w http.ResponseWriter, loginUsername, role string) {
	current, _ := db.QueryOne("SELECT role FROM dcp_super_admin WHERE email = ? LIMIT 1", loginUsername)
	if current != nil && strVal(current["role"]) == "SuperAdmin" && role != "superadmin" {
		if activeSuperAdminCount() <= 1 {
			fail(w, 422, "At least one Super Admin must remain — promote someone else first"); return
		}
	}

	if role == "client" {
		db.Exec("DELETE FROM dcp_super_admin WHERE email = ?", loginUsername)
		ok(w, map[string]any{"success": true}); return
	}

	login, _ := db.QueryOne(`
		SELECT login_username, login_password, first_name, last_name
		FROM dcp_user_login WHERE login_username = ? AND is_active = 1 LIMIT 1`, loginUsername)
	if login == nil {
		fail(w, 404, "No active login found for this username"); return
	}
	name := strings.TrimSpace(strVal(login["first_name"]) + " " + strVal(login["last_name"]))
	if name == "" {
		name = loginUsername
	}
	roleLabel := "Admin"
	if role == "superadmin" {
		roleLabel = "SuperAdmin"
	}
	_, _, err := db.Exec(`
		INSERT INTO dcp_super_admin (name, email, password_hash, is_active, role, userId, loginId)
		VALUES (?, ?, ?, 1, ?, NULL, NULL)
		ON DUPLICATE KEY UPDATE
			name = VALUES(name), password_hash = VALUES(password_hash),
			is_active = 1, role = VALUES(role)`,
		name, loginUsername, strVal(login["login_password"]), roleLabel)
	if err != nil {
		fail(w, 500, "Failed to grant portal access"); return
	}
	ok(w, map[string]any{"success": true})
}

// GET /api/admin/super-admin/accounts  (super admin only)
// The direct, authoritative list of everyone currently holding Admin or
// Super Admin access — every row in dcp_super_admin. This is what the login
// flow actually checks, so it's the ground truth for "who has power right
// now", independent of any client company's dcp_user.role.
func SuperAdminAccounts(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		fail(w, 405, "Method not allowed"); return
	}
	accounts, _ := db.Query(`
		SELECT id, name, email, role, is_active, last_login, created_at,
		       COALESCE(otp_login_enabled, 0) AS otp_login_enabled
		FROM dcp_super_admin
		ORDER BY role DESC, name ASC`)
	if accounts == nil {
		accounts = []map[string]any{}
	}
	ok(w, map[string]any{"success": true, "accounts": accounts, "superAdminCount": activeSuperAdminCount()})
}

// GET /api/admin/super-admin/user-permissions  (super admin only)
// One row per unique person (grouped by login_username), covering every
// login account — clients, admins, and super admins alike — so access can be
// granted or revoked for anyone from a single list, regardless of how many
// client companies share that login. portal_role reflects dcp_super_admin
// (checked first at login time), independent of any one company's dcp_user.role.
func SuperAdminUserPermissions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		fail(w, 405, "Method not allowed"); return
	}
	rows, err := db.Query(`
		SELECT
			MAX(ul.loginId)                                              AS loginId,
			ul.login_username,
			MAX(ul.first_name)                                           AS first_name,
			MAX(ul.last_name)                                            AS last_name,
			MAX(ul.is_active)                                            AS is_active,
			GROUP_CONCAT(DISTINCT u.name ORDER BY u.name SEPARATOR ', ') AS companies,
			MAX(sa.role)                                                 AS portal_role
		FROM dcp_user_login ul
		LEFT JOIN dcp_user u ON u.userId = ul.userId AND u.deleted = 0
		LEFT JOIN dcp_super_admin sa
			ON CONVERT(sa.email USING utf8mb4) COLLATE utf8mb4_general_ci
			 = CONVERT(ul.login_username USING utf8mb4) COLLATE utf8mb4_general_ci
			AND sa.is_active = 1
		WHERE ul.is_active = 1
		GROUP BY ul.login_username
		ORDER BY MAX(ul.first_name) ASC, ul.login_username ASC`)
	if err != nil {
		log.Printf("[user-permissions] query failed: %v", err)
	}
	if rows == nil {
		rows = []map[string]any{}
	}
	ok(w, map[string]any{"success": true, "users": rows})
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
