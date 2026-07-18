package admin

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"

	ipauth "github.com/ip-house/iphouse-api/auth"
	"github.com/ip-house/iphouse-api/db"
	"github.com/ip-house/iphouse-api/email"
)

// POST /api/admin/users — create login
// PUT  /api/admin/users — update login
func Users(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		usersCreate(w, r)
	case http.MethodPut:
		usersUpdate(w, r)
	case http.MethodGet:
		usersList(w, r)
	default:
		fail(w, 405, "Method not allowed")
	}
}

// roleSelect computes the EFFECTIVE role for a login: dcp_super_admin (matched
// by email) wins if present, exactly mirroring the login precedence in
// handlers.Login/CheckMultipleLogins/SendOTP/VerifyOTP — so what this page
// shows is what actually determines that person's access. Falls back to the
// legacy company-level dcp_user.role when no dcp_super_admin row exists.
// Collation is normalized because dcp_super_admin.email and
// dcp_user_login.login_username were created independently and may not share
// a collation, which otherwise throws "Illegal mix of collations" on join.
const roleSelect = "COALESCE(CASE sa.role WHEN 'SuperAdmin' THEN 2 WHEN 'Admin' THEN 1 END, u.role, 0) AS role"
const roleJoin = `LEFT JOIN dcp_super_admin sa
		ON CONVERT(sa.email USING utf8mb4) COLLATE utf8mb4_general_ci
		 = CONVERT(l.login_username USING utf8mb4) COLLATE utf8mb4_general_ci
		AND sa.is_active = 1`

func usersList(w http.ResponseWriter, r *http.Request) {
	uid := r.URL.Query().Get("userId")
	var rows []map[string]any
	var err error
	if uid != "" {
		rows, err = db.Query(`SELECT l.loginId, l.userId, l.first_name, l.last_name, l.login_username,
			l.login_type, l.is_active, l.created_at, l.updated_at, u.name AS user_name, u.email AS user_email, `+roleSelect+`
			FROM dcp_user_login l INNER JOIN dcp_user u ON u.userId = l.userId
			`+roleJoin+`
			WHERE u.deleted = 0 AND l.userId = ? ORDER BY l.loginId DESC`, uid)
	} else {
		rows, err = db.Query(`SELECT l.loginId, l.userId, l.first_name, l.last_name, l.login_username,
			l.login_type, l.is_active, l.created_at, l.updated_at, u.name AS user_name, u.email AS user_email, `+roleSelect+`
			FROM dcp_user_login l INNER JOIN dcp_user u ON u.userId = l.userId
			`+roleJoin+`
			WHERE u.deleted = 0 ORDER BY l.loginId DESC`)
	}
	if err != nil {
		log.Printf("[users] list query error: %v", err)
	}
	if rows == nil {
		rows = []map[string]any{}
	}
	ok(w, map[string]any{"success": true, "users": rows})
}

// usersCreate creates a login credential directly (no registration/approval
// queue) and attaches it to one or more dcp_user client companies in the same
// step — the same assignment shape as the approval module's shared-logins
// "add" action, just entered from /admin/users/add instead of after approving
// a registration request. Mirrors registrationsUpdate's "approve" branch: a
// password is always generated (even for Email-OTP logins that don't need one
// to sign in) so the credentials email always has something real to show, and
// the email is sent the same way — via email.SendRegistrationApproved.
func usersCreate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		UserIDs       []int64 `json:"userIds"`
		FirstName     string  `json:"firstName"`
		LastName      string  `json:"lastName"`
		Email         string  `json:"email"`
		LoginUsername string  `json:"loginUsername"`
		LoginPassword string  `json:"loginPassword"`
		LoginType     int     `json:"loginType"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	body.Email = strings.TrimSpace(body.Email)
	if len(body.UserIDs) == 0 || body.FirstName == "" || body.LoginUsername == "" || body.Email == "" {
		fail(w, 422, "userIds, firstName, loginUsername, email required"); return
	}

	existing, _ := db.QueryOne("SELECT loginId FROM dcp_user_login WHERE login_username = ? LIMIT 1", body.LoginUsername)
	if existing != nil {
		ok(w, map[string]any{"success": false, "error": "Username already exists"}); return
	}

	rawPassword := body.LoginPassword
	if rawPassword == "" {
		rawPassword = genStrongPassword(12)
	}
	hashed, err := ipauth.HashPassword(rawPassword)
	if err != nil {
		fail(w, 500, "Hash error"); return
	}

	// Every assigned client (dcp_user is always a client — the picker feeding
	// this is filtered to role != staff) shares the same credentials, one
	// dcp_user_login row each, exactly like SharedLogins' "add" action.
	// created_at/updated_at are stamped with UTC_TIMESTAMP() — evaluated by the
	// DB server itself, not passed as a Go time.Time param — so the stored
	// value is always UTC regardless of connection or server time zone config.
	for _, uid := range body.UserIDs {
		db.Exec(
			"INSERT INTO dcp_user_login (userId, first_name, last_name, login_username, login_password, login_type, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, UTC_TIMESTAMP(), UTC_TIMESTAMP())",
			uid, body.FirstName, body.LastName, body.LoginUsername, hashed, body.LoginType,
		)
	}

	fullName := strings.TrimSpace(body.FirstName + " " + body.LastName)
	go func() {
		if err := email.SendRegistrationApproved(body.Email, fullName, body.LoginUsername, rawPassword, email.DashboardURL); err != nil {
			log.Printf("[users] credentials email to %s failed: %v", body.Email, err)
		}
	}()

	ok(w, map[string]any{"success": true})
}

func usersUpdate(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	json.NewDecoder(r.Body).Decode(&body)

	loginID := intVal(body["loginId"])
	if loginID == 0 {
		fail(w, 422, "loginId required"); return
	}

	// Every branch below stamps updated_at = UTC_TIMESTAMP() (server-evaluated,
	// same reasoning as usersCreate) so any edit to a login is timestamped.

	if isActive, has := body["isActive"]; has {
		active := 0
		if b, isBool := isActive.(bool); isBool && b {
			active = 1
		}
		db.Exec("UPDATE dcp_user_login SET is_active = ?, updated_at = UTC_TIMESTAMP() WHERE loginId = ?", active, loginID)
		ok(w, map[string]any{"success": true}); return
	}

	if lt, has := body["loginType"]; has {
		t := int(intVal(lt))
		if t != 0 && t != 1 && t != 2 {
			fail(w, 422, "loginType must be 0, 1, or 2"); return
		}
		db.Exec("UPDATE dcp_user_login SET login_type = ?, updated_at = UTC_TIMESTAMP() WHERE loginId = ?", t, loginID)
		ok(w, map[string]any{"success": true}); return
	}

	if fn, has := body["firstName"]; has {
		firstName := strVal(fn)
		if firstName == "" {
			fail(w, 422, "First name is required"); return
		}
		db.Exec("UPDATE dcp_user_login SET first_name = ?, last_name = ?, updated_at = UTC_TIMESTAMP() WHERE loginId = ?",
			firstName, strVal(body["lastName"]), loginID)
		ok(w, map[string]any{"success": true}); return
	}

	fail(w, 422, "Nothing to update")
}
