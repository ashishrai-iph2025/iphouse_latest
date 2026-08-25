package handlers

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"

	"github.com/ip-house/iphouse-api/activity"
	"github.com/ip-house/iphouse-api/db"
)

// numOf reads an integer column that may arrive as a number or, via the text
// protocol, as a string (see flagOn for why).
func numOf(v any) int64 {
	switch t := v.(type) {
	case int64:
		return t
	case int:
		return int64(t)
	case float64:
		return int64(t)
	case []byte:
		n, _ := strconv.ParseInt(string(t), 10, 64)
		return n
	case string:
		n, _ := strconv.ParseInt(t, 10, 64)
		return n
	}
	return 0
}

// flagOn reads a 0/1 column as a boolean. db.scanRows turns []byte into string,
// and MySQL's text protocol (used for queries with no bound arguments) returns
// every column as []byte — so a flag can arrive as int64 OR as "1"/"0".
// intFromAny only understands the numeric forms and would quietly report 0 for
// the string case, which on a permission check fails OPEN. Handle both.
func flagOn(v any) bool {
	switch t := v.(type) {
	case bool:
		return t
	case int64:
		return t != 0
	case int:
		return t != 0
	case float64:
		return t != 0
	case []byte:
		n, _ := strconv.ParseInt(string(t), 10, 64)
		return n != 0
	case string:
		n, _ := strconv.ParseInt(t, 10, 64)
		return n != 0
	}
	return false
}

// Client Admin — company-scoped user administration.
//
// A Client Admin is an ordinary client login (Role stays 0) that has been
// granted dcp_user_login.is_client_admin for ONE company. It may list the other
// logins attached to that same company and enable/disable them. It gets nothing
// else: no other company's users, no credential access, no role changes, no
// ability to create logins. Admin/Super Admin (role >= 1) reach the same
// endpoints, so support staff can use the page on a client's behalf.
//
// Every query below is scoped by claims.UserID — the company of the CURRENT
// session — never by a company id taken from the request, so a Client Admin
// cannot address another company by tampering with the payload.

// clientAdminAllowed reports whether the session may use these endpoints at all.
func clientAdminAllowed(r *http.Request) bool {
	claims := ClaimsFrom(r)
	if claims == nil {
		return false
	}
	if claims.ClientAdmin {
		return true
	}
	return claims.Role != nil && *claims.Role >= 1
}

/* ── Audit trail ───────────────────────────────────────────────────────────
   Every action here is recorded in user_activity_log — the same table the
   Tracking Report reads — so a Client Admin's actions sit in one timeline
   alongside logins, impersonation and credential reveals, rather than in a
   separate silo. Refusals are logged too: an attempt to reach another
   company's user is exactly what an audit trail exists to show, and a log
   containing only successes cannot evidence that the guards held.

   Metadata carries who was acted on and what changed. It never carries
   credentials. */

const (
	actClientAdminView    = "client_admin_view"
	actClientAdminEnable  = "client_admin_user_enabled"
	actClientAdminDisable = "client_admin_user_disabled"
	actClientAdminDenied  = "client_admin_denied"
)

// logClientAdmin writes one audit row for the current session, always stamped
// with the acting login, its company, and the request's IP/user-agent.
func logClientAdmin(r *http.Request, action string, meta map[string]any) {
	claims := ClaimsFrom(r)
	var actor int64
	if claims != nil {
		actor = claims.LoginID
		if meta == nil {
			meta = map[string]any{}
		}
		meta["companyUserId"] = claims.UserID
		meta["companyName"] = claims.ClientName
		meta["actorUsername"] = claims.LoginUsername
		// Distinguishes a Client Admin acting for themselves from IP House
		// staff acting on the company's behalf — they reach the same endpoint.
		meta["actorIsStaff"] = claims.Role != nil && *claims.Role >= 1
		meta["actorIsClientAdmin"] = claims.ClientAdmin
		if claims.ImpersonatorLoginID != 0 {
			meta["impersonatedBy"] = claims.ImpersonatorEmail
		}
	}
	activity.Log(actor, action, "client-admin/users", activity.GetIP(r), activity.GetUA(r), meta)
}

// GET  /api/client-admin/users — logins attached to the session's company
// PUT  /api/client-admin/users — enable/disable one of those logins
func ClientAdminUsers(w http.ResponseWriter, r *http.Request) {
	if !clientAdminAllowed(r) {
		logClientAdmin(r, actClientAdminDenied, map[string]any{
			"reason": "not a client admin for this account",
			"method": r.Method,
		})
		Fail(w, 403, "Forbidden")
		return
	}
	switch r.Method {
	case http.MethodGet:
		clientAdminUsersList(w, r)
	case http.MethodPut:
		clientAdminUsersUpdate(w, r)
	default:
		Fail(w, 405, "Method not allowed")
	}
}

// staffJoin flags logins that are really portal staff (an active dcp_super_admin
// row matched by email). Those are excluded from a Client Admin's reach — a
// client must never be able to disable an Admin or Super Admin. Collation is
// normalised for the same reason as admin.roleJoin: the two columns were created
// independently and may not share one.
const clientAdminStaffJoin = `LEFT JOIN dcp_super_admin sa
		ON CONVERT(sa.email USING utf8mb4) COLLATE utf8mb4_general_ci
		 = CONVERT(l.login_username USING utf8mb4) COLLATE utf8mb4_general_ci
		AND sa.is_active = 1`

func clientAdminUsersList(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)

	rows, err := db.Query(`
		SELECT l.loginId, l.first_name, l.last_name, l.login_username, l.login_type,
		       l.is_active, l.is_client_admin, l.created_at, l.updated_at,
		       (sa.id IS NOT NULL) AS is_staff
		FROM dcp_user_login l
		`+clientAdminStaffJoin+`
		WHERE l.userId = ?
		ORDER BY l.is_active DESC, l.first_name ASC, l.loginId ASC`, claims.UserID)
	if err != nil {
		log.Printf("[client-admin] list query error: %v", err)
	}
	if rows == nil {
		rows = []map[string]any{}
	}

	// The caller's own row is marked so the UI can lock its toggle — a Client
	// Admin disabling itself would lose the page and be unable to undo it.
	// (The server refuses it regardless; this only keeps the UI honest.)
	for _, row := range rows {
		row["isSelf"] = numOf(row["loginId"]) == claims.LoginID
	}

	logClientAdmin(r, actClientAdminView, map[string]any{"userCount": len(rows)})

	OK(w, map[string]any{
		"success":    true,
		"users":      rows,
		"clientName": claims.ClientName,
		"canManage":  true,
	})
}

func clientAdminUsersUpdate(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)

	var body struct {
		LoginID  int64 `json:"loginId"`
		IsActive *bool `json:"isActive"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if body.LoginID == 0 {
		Fail(w, 422, "loginId required")
		return
	}
	if body.IsActive == nil {
		// Activation is the ONLY field a Client Admin may change. Anything else
		// (names, login type, passwords, the Client Admin grant itself) stays
		// with Admin/Super Admin.
		Fail(w, 422, "isActive required — activation is the only editable field")
		return
	}
	if body.LoginID == claims.LoginID {
		logClientAdmin(r, actClientAdminDenied, map[string]any{
			"reason": "attempted to change own access", "targetLoginId": body.LoginID,
		})
		Fail(w, 422, "You cannot change your own access")
		return
	}

	// Ownership + staff check in one go, scoped to the session's company.
	target, _ := db.QueryOne(`
		SELECT l.loginId, l.login_username, l.is_active, (sa.id IS NOT NULL) AS is_staff
		FROM dcp_user_login l
		`+clientAdminStaffJoin+`
		WHERE l.loginId = ? AND l.userId = ? LIMIT 1`, body.LoginID, claims.UserID)
	if target == nil {
		// Same response whether the login doesn't exist or belongs to another
		// company — don't confirm the existence of other companies' logins.
		// Logged as a denial: an attempt to reach outside the company is the
		// single most important thing for this trail to capture.
		logClientAdmin(r, actClientAdminDenied, map[string]any{
			"reason": "target login not found in this company", "targetLoginId": body.LoginID,
		})
		Fail(w, 404, "User not found for this account")
		return
	}
	if flagOn(target["is_staff"]) {
		logClientAdmin(r, actClientAdminDenied, map[string]any{
			"reason":        "target is IP House staff",
			"targetLoginId": body.LoginID,
			"targetUser":    strFromAny(target["login_username"]),
		})
		Fail(w, 403, "This user is managed by IP House staff")
		return
	}

	active := 0
	if *body.IsActive {
		active = 1
	}
	wasActive := flagOn(target["is_active"])
	/* Enabling clears `deleted` for the same reason /admin/users does: the flag
	   means "not a live assignment" and every auth query depends on it implying
	   is_active = 0. Disabling leaves it untouched. */
	stmt := "UPDATE dcp_user_login SET is_active = ?, updated_at = UTC_TIMESTAMP() WHERE loginId = ? AND userId = ?"
	if active == 1 {
		stmt = "UPDATE dcp_user_login SET is_active = ?, deleted = 0, updated_at = UTC_TIMESTAMP() WHERE loginId = ? AND userId = ?"
	}
	if _, _, err := db.Exec(
		stmt,
		active, body.LoginID, claims.UserID); err != nil {
		log.Printf("[client-admin] update loginId=%d failed: %v", body.LoginID, err)
		logClientAdmin(r, actClientAdminDenied, map[string]any{
			"reason": "database update failed", "targetLoginId": body.LoginID,
		})
		Fail(w, 500, "Could not update this user")
		return
	}

	action := actClientAdminDisable
	if *body.IsActive {
		action = actClientAdminEnable
	}
	logClientAdmin(r, action, map[string]any{
		"targetLoginId": body.LoginID,
		"targetUser":    strFromAny(target["login_username"]),
		"from":          boolLabel(wasActive, "active", "inactive"),
		"to":            boolLabel(*body.IsActive, "active", "inactive"),
	})

	log.Printf("[client-admin] %s set loginId=%d active=%d on userId=%d",
		claims.LoginUsername, body.LoginID, active, claims.UserID)
	OK(w, map[string]any{"success": true})
}

func boolLabel(v bool, yes, no string) string {
	if v {
		return yes
	}
	return no
}

// GET /api/client-admin/activity — the audit trail for THIS company.
//
// Scoped by joining the acting login back to its company, so a Client Admin
// sees what every login attached to their own account did — and nothing from
// any other company. IP House staff acting on the company's behalf appear here
// too, deliberately: the client should be able to see who touched their
// account, not just their own people.
//
// The feed covers ALL recorded actions for those logins — sign-ins, password
// resets, impersonation, credential reveals and the Client Admin changes made
// on this page. It was previously narrowed to 'client_admin_%', which made the
// panel look like a log of the current user's page actions rather than the
// account-wide trail a Client Admin is meant to review.
//
// Query params: ?days=1|7|15|30 (default 7) and ?limit= (default 100, max 500).
func ClientAdminActivity(w http.ResponseWriter, r *http.Request) {
	if !clientAdminAllowed(r) {
		logClientAdmin(r, actClientAdminDenied, map[string]any{"reason": "activity feed"})
		Fail(w, 403, "Forbidden")
		return
	}
	if r.Method != http.MethodGet {
		Fail(w, 405, "Method not allowed")
		return
	}
	claims := ClaimsFrom(r)

	limit := 100
	if n, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && n > 0 && n <= 500 {
		limit = n
	}

	// Fixed windows only — an arbitrary day count would let a caller widen the
	// scan without bound, and the UI offers exactly these four.
	days := 7
	switch r.URL.Query().Get("days") {
	case "1":
		days = 1
	case "15":
		days = 15
	case "30":
		days = 30
	}

	rows, err := db.Query(`
		SELECT a.id, a.action, a.page_url, a.ip_address, a.metadata, a.created_at,
		       a.user_id AS actor_login_id,
		       COALESCE(NULLIF(TRIM(CONCAT(COALESCE(l.first_name,''),' ',COALESCE(l.last_name,''))),''),
		                l.login_username) AS actor_name,
		       l.login_username AS actor_username
		FROM user_activity_log a
		INNER JOIN dcp_user_login l ON l.loginId = a.user_id
		WHERE l.userId = ?
		  AND a.created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)
		ORDER BY a.created_at DESC, a.id DESC
		LIMIT ?`, claims.UserID, days, limit)
	if err != nil {
		log.Printf("[client-admin] activity query error: %v", err)
	}
	if rows == nil {
		rows = []map[string]any{}
	}
	OK(w, map[string]any{"success": true, "events": rows, "days": days, "limit": limit})
}
