package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	ipauth "github.com/ip-house/iphouse-api/auth"
	"github.com/ip-house/iphouse-api/activity"
	"github.com/ip-house/iphouse-api/db"
)

// Admin "view as client" (impersonation). An Admin / Super Admin can search the
// client list and enter a client's portal, seeing exactly what that client sees
// — same modules, permissions, and API access — then exit back to their own
// admin session. Every start/exit is written to the activity log.
//
// Safeguards: only role >= 1 can start; staff accounts (anyone in
// dcp_super_admin) can never be impersonated (prevents privilege escalation);
// the impersonated session is forced to the client role (0) so it can never
// reach admin routes; nesting is refused.

// GET /api/admin/user-search?q= — live login search for the nav search box.
// Searches the login accounts (dcp_user_login) joined to their client company,
// matching the username, the person's name, or the client/company name — so an
// admin can find a login either way. Each row is a (login → client) pairing the
// admin can access.
func AdminUserSearch(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		OK(w, map[string]any{"success": true, "users": []any{}}); return
	}
	like := "%" + q + "%"
	// Clients only — never surface Admin / Super Admin logins in the "access a
	// client" search. dcp_user.role = 0/NULL keeps clients (1 = Admin, 2 = Super
	// Admin), and the NOT EXISTS against dcp_super_admin (the ground-truth staff
	// table the impersonate flow also checks) excludes any staff login whose
	// mirrored dcp_user.role is stale.
	rows, _ := db.Query(`
		SELECT l.loginId, l.userId, l.login_username, l.first_name, l.last_name,
		       l.designation, l.login_type, u.name AS client_name, u.email AS client_email
		FROM dcp_user_login l
		INNER JOIN dcp_user u ON u.userId = l.userId
		WHERE l.is_active = 1 AND u.deleted = 0 AND (u.role IS NULL OR u.role = 0)
		  AND NOT EXISTS (SELECT 1 FROM dcp_super_admin sa
		                  WHERE sa.email = l.login_username COLLATE utf8mb4_general_ci)
		  AND (l.login_username LIKE ? OR u.name LIKE ?
		       OR CONCAT(COALESCE(l.first_name,''), ' ', COALESCE(l.last_name,'')) LIKE ?)
		ORDER BY u.name ASC, l.login_username ASC
		LIMIT 25`, like, like, like)
	if rows == nil {
		rows = []map[string]any{}
	}
	OK(w, map[string]any{"success": true, "users": rows})
}

// POST /api/admin/impersonate  { userId } — enter a client's portal.
func Impersonate(w http.ResponseWriter, r *http.Request) {
	admin := ClaimsFrom(r)
	if admin == nil || admin.Role == nil || *admin.Role < 1 {
		Fail(w, 403, "Forbidden"); return
	}
	if admin.ImpersonatorLoginID != 0 {
		Fail(w, 400, "You are already viewing as a client. Exit first."); return
	}

	var body struct {
		LoginID int64 `json:"loginId"`
		UserID  int64 `json:"userId"` // fallback: first active login for a client
	}
	json.NewDecoder(r.Body).Decode(&body)

	// Resolve the exact login the admin picked (or the client's first active
	// login when only a userId is given).
	var row map[string]any
	switch {
	case body.LoginID != 0:
		row, _ = db.QueryOne(`
			SELECT l.loginId, l.userId, l.first_name, l.last_name, l.login_username, l.login_type,
			       u.name, u.role, u.api_user_name, u.api_password
			FROM dcp_user_login l
			INNER JOIN dcp_user u ON u.userId = l.userId
			WHERE l.loginId = ? AND l.is_active = 1 AND u.deleted = 0 LIMIT 1`, body.LoginID)
	case body.UserID != 0:
		row, _ = db.QueryOne(`
			SELECT l.loginId, l.userId, l.first_name, l.last_name, l.login_username, l.login_type,
			       u.name, u.role, u.api_user_name, u.api_password
			FROM dcp_user_login l
			INNER JOIN dcp_user u ON u.userId = l.userId
			WHERE l.userId = ? AND l.is_active = 1 AND u.deleted = 0
			ORDER BY l.loginId ASC LIMIT 1`, body.UserID)
	default:
		Fail(w, 422, "loginId (or userId) is required"); return
	}
	if row == nil {
		Fail(w, 404, "This login is no longer active or does not exist."); return
	}

	// Never allow impersonating a portal-staff account (would be an escalation
	// path — e.g. an Admin becoming a Super Admin).
	if sa := superAdminByEmail(strFromAny(row["login_username"])); sa != nil {
		Fail(w, 403, "This account is an Admin/Super Admin and cannot be accessed as a client."); return
	}

	targetUserID := intFromAny(row["userId"])
	apiTok := TokenForUser(targetUserID)

	claims := buildClaims(row, apiTok)
	// Force the client role regardless of any stale dcp_user.role, so the
	// impersonated session can never reach admin-only routes.
	zero := int64(0)
	claims.Role = &zero
	claims.ImpersonatorLoginID = admin.LoginID
	claims.ImpersonatorEmail = admin.LoginUsername
	claims.ImpersonatorName = strings.TrimSpace(admin.LoginFirstName + " " + admin.LoginLastName)
	if claims.ImpersonatorName == "" {
		claims.ImpersonatorName = admin.LoginUsername
	}
	if admin.Role != nil {
		claims.ImpersonatorRole = *admin.Role
	}

	tok, err := ipauth.SignToken(claims)
	if err != nil {
		Fail(w, 500, "Token error"); return
	}
	SetTokenCookie(w, tok)
	go activity.Log(admin.LoginID, "impersonate_start", "admin/impersonate",
		activity.GetIP(r), activity.GetUA(r),
		map[string]any{"targetUserId": targetUserID, "targetName": strFromAny(row["name"]), "targetLoginId": intFromAny(row["loginId"]), "targetUsername": strFromAny(row["login_username"])})

	OK(w, map[string]any{"success": true, "user": sanitizeClaims(claims)})
}

// POST /api/admin/impersonate/exit — return to the admin's own session.
// Reachable with the (client-role) impersonation session, so it is JWT-auth,
// not admin-auth; it verifies the session actually carries an impersonator.
func ExitImpersonation(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	if claims == nil || claims.ImpersonatorLoginID == 0 || claims.ImpersonatorEmail == "" {
		Fail(w, 400, "Not currently viewing as a client."); return
	}

	// Rebuild the admin session fresh from dcp_super_admin (works even if the
	// original token would have expired).
	sa := superAdminByEmail(claims.ImpersonatorEmail)
	if sa == nil {
		ClearTokenCookie(w)
		Fail(w, 401, "Your admin session could not be restored — please sign in again."); return
	}
	adminClaims := claimsForSuperAdminRow(sa)
	tok, err := ipauth.SignToken(adminClaims)
	if err != nil {
		Fail(w, 500, "Token error"); return
	}
	SetTokenCookie(w, tok)
	go activity.Log(adminClaims.LoginID, "impersonate_exit", "admin/impersonate",
		activity.GetIP(r), activity.GetUA(r),
		map[string]any{"wasClientLoginId": claims.LoginID})

	OK(w, map[string]any{"success": true, "user": sanitizeClaims(adminClaims)})
}
