package admin

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"

	"github.com/ip-house/iphouse-api/activity"
	"github.com/ip-house/iphouse-api/db"
	"github.com/ip-house/iphouse-api/middleware"
)

/* Audit trail — every grant, revoke, refusal and page view lands in
   user_activity_log, the same table the Tracking Report reads, stamped with
   the acting staff login, IP and user agent. */

const (
	actClientAdminListView = "client_admin_list_view"
	actClientAdminGranted  = "client_admin_granted"
	actClientAdminRevoked  = "client_admin_revoked"
	actClientAdminDenied   = "client_admin_grant_denied"
)

func logClientAdmins(r *http.Request, action string, meta map[string]any) {
	var actor int64
	if claims := middleware.GetClaims(r); claims != nil {
		actor = claims.LoginID
		if meta == nil {
			meta = map[string]any{}
		}
		meta["actorUsername"] = claims.LoginUsername
		if claims.Role != nil {
			meta["actorRole"] = *claims.Role
		}
	}
	activity.Log(actor, action, "admin/client-admins", activity.GetIP(r), activity.GetUA(r), meta)
}

// flagOn reads a 0/1 column as a boolean. db.scanRows turns []byte into string,
// and MySQL's text protocol (arg-less queries) returns columns as []byte, so a
// flag can arrive as int64 OR as "1"/"0". intVal only handles the numeric forms
// and would report 0 for the string case — which here would let a staff login
// be marked Client Admin. Handle both.
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

// Client Admins — Admin/Super Admin management of the per-company grant.
//
// The grant lives on dcp_user_login.is_client_admin, one row per
// (person × company), so the same person can be Client Admin of one company and
// an ordinary user of another. See db.Migrate for why this is a flag rather than
// a value on the dcp_user.role ladder.
//
// Granting is staff-only. It is set from the Sign-in pane of the Edit Login
// Account drawer on /admin/registrations and gated as that page is — any
// Admin or Super Admin. It used to be a Configuration module of its own; the
// grant is a fact about one account, and it now sits with the rest of them
// rather than on a roster reached by remembering the roster exists.

// GET /api/admin/client-admins        — logins, optionally filtered by company
// PUT /api/admin/client-admins        — grant or revoke the flag for one login
func ClientAdmins(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		clientAdminsList(w, r)
	case http.MethodPut:
		clientAdminsUpdate(w, r)
	default:
		fail(w, 405, "Method not allowed")
	}
}

func clientAdminsList(w http.ResponseWriter, r *http.Request) {
	userID := r.URL.Query().Get("userId")
	/* The account editor asks for one person's rows by naming them, because
	   "this person" is not a filter the other two express: userId is one
	   company, and no filter at all is every login in the portal. */
	loginIDs := idListOf(r.URL.Query().Get("loginIds"))

	// Staff logins are surfaced but flagged: an Admin/Super Admin already has
	// portal-wide access, so marking them Client Admin would be meaningless and
	// the UI disables the toggle for them.
	//
	// has_api reports whether the COMPANY holds usable MarkScan API credentials
	// — the same "both fields present and non-empty" test the session uses to
	// decide APIAccess. Only presence is exposed here, never the values.
	// Without it, a company can have Client Admins who then find most of the
	// portal empty, because the data pages need that token.
	query := `SELECT l.loginId, l.userId, l.first_name, l.last_name, l.login_username,
			l.login_type, l.is_active, l.is_client_admin,
			u.name AS client_name, u.email AS client_email,
			(sa.id IS NOT NULL) AS is_staff,
			(u.api_user_name IS NOT NULL AND u.api_user_name != ''
			 AND u.api_password IS NOT NULL AND u.api_password != '') AS has_api
		FROM dcp_user_login l
		INNER JOIN dcp_user u ON u.userId = l.userId
		` + roleJoin + `
		WHERE u.deleted = 0` + staffFilter

	var rows []map[string]any
	var err error
	if len(loginIDs) > 0 {
		holes := make([]string, len(loginIDs))
		args := make([]any, len(loginIDs))
		for i, id := range loginIDs {
			holes[i] = "?"
			args[i] = id
		}
		rows, err = db.Query(
			query+" AND l.loginId IN ("+strings.Join(holes, ",")+") ORDER BY u.name ASC",
			args...)
	} else if userID != "" {
		rows, err = db.Query(query+" AND l.userId = ? ORDER BY u.name ASC, l.first_name ASC", userID)
	} else {
		rows, err = db.Query(query + " ORDER BY u.name ASC, l.first_name ASC")
	}
	if err != nil {
		log.Printf("[client-admins] list query error: %v", err)
	}
	if rows == nil {
		rows = []map[string]any{}
	}
	logClientAdmins(r, actClientAdminListView, map[string]any{
		"rowCount": len(rows), "clientFilter": userID, "loginFilter": loginIDs,
	})
	ok(w, map[string]any{"success": true, "users": rows})
}

/*
idListOf parses a comma-separated id list, dropping anything that is not a
positive integer.

Parsed rather than interpolated: these ids reach a SQL IN list, and the only
safe way to build one of variable length is to bind every element. A value that
is not a number is dropped rather than failing the request — the caller is a
checklist, and one stale id in it is not a reason to show the reader nothing.
*/
func idListOf(raw string) []int64 {
	out := []int64{}
	for _, part := range strings.Split(raw, ",") {
		if n, err := strconv.ParseInt(strings.TrimSpace(part), 10, 64); err == nil && n > 0 {
			out = append(out, n)
		}
	}
	return out
}

func clientAdminsUpdate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		LoginID       int64 `json:"loginId"`
		IsClientAdmin *bool `json:"isClientAdmin"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if body.LoginID == 0 || body.IsClientAdmin == nil {
		fail(w, 422, "loginId and isClientAdmin required")
		return
	}

	target, _ := db.QueryOne(`
		SELECT l.loginId, l.login_username, l.userId, l.is_client_admin,
		       u.name AS client_name, (sa.id IS NOT NULL) AS is_staff
		FROM dcp_user_login l
		INNER JOIN dcp_user u ON u.userId = l.userId
		`+roleJoin+`
		WHERE l.loginId = ? AND u.deleted = 0 LIMIT 1`, body.LoginID)
	if target == nil {
		logClientAdmins(r, actClientAdminDenied, map[string]any{
			"reason": "login not found", "targetLoginId": body.LoginID,
		})
		fail(w, 404, "Login not found")
		return
	}
	if flagOn(target["is_staff"]) && *body.IsClientAdmin {
		logClientAdmins(r, actClientAdminDenied, map[string]any{
			"reason":        "target is IP House staff",
			"targetLoginId": body.LoginID,
			"targetUser":    strVal(target["login_username"]),
		})
		fail(w, 422, "This login is IP House staff and already has full access")
		return
	}

	flag := 0
	if *body.IsClientAdmin {
		flag = 1
	}
	wasGranted := flagOn(target["is_client_admin"])
	if _, _, err := db.Exec(
		"UPDATE dcp_user_login SET is_client_admin = ?, updated_at = UTC_TIMESTAMP() WHERE loginId = ?",
		flag, body.LoginID); err != nil {
		log.Printf("[client-admins] update loginId=%d failed: %v", body.LoginID, err)
		logClientAdmins(r, actClientAdminDenied, map[string]any{
			"reason": "database update failed", "targetLoginId": body.LoginID,
		})
		fail(w, 500, "Could not update this login")
		return
	}

	auditAction := actClientAdminRevoked
	if *body.IsClientAdmin {
		auditAction = actClientAdminGranted
	}
	logClientAdmins(r, auditAction, map[string]any{
		"targetLoginId": body.LoginID,
		"targetUser":    strVal(target["login_username"]),
		"companyUserId": intVal(target["userId"]),
		"companyName":   strVal(target["client_name"]),
		"from":          map[bool]string{true: "granted", false: "not granted"}[wasGranted],
		"to":            map[bool]string{true: "granted", false: "not granted"}[*body.IsClientAdmin],
	})

	// The grant is carried in the JWT, so an already-signed-in user keeps their
	// previous state until their session is renewed. Reported back so the UI can
	// say so rather than leaving staff wondering why nothing changed.
	log.Printf("[client-admins] loginId=%d (%s) on userId=%d set is_client_admin=%d",
		body.LoginID, strVal(target["login_username"]), intVal(target["userId"]), flag)
	ok(w, map[string]any{"success": true, "takesEffectOnNextLogin": true})
}
