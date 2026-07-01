package admin

import (
	"encoding/json"
	"log"
	"net/http"

	ipauth "github.com/ip-house/iphouse-api/auth"
	"github.com/ip-house/iphouse-api/db"
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
			l.login_type, l.is_active, u.name AS user_name, u.email AS user_email, `+roleSelect+`
			FROM dcp_user_login l INNER JOIN dcp_user u ON u.userId = l.userId
			`+roleJoin+`
			WHERE u.deleted = 0 AND l.userId = ? ORDER BY l.loginId DESC`, uid)
	} else {
		rows, err = db.Query(`SELECT l.loginId, l.userId, l.first_name, l.last_name, l.login_username,
			l.login_type, l.is_active, u.name AS user_name, u.email AS user_email, `+roleSelect+`
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

func usersCreate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		UserID        int64  `json:"userId"`
		FirstName     string `json:"firstName"`
		LastName      string `json:"lastName"`
		LoginUsername string `json:"loginUsername"`
		LoginPassword string `json:"loginPassword"`
		LoginType     int    `json:"loginType"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if body.UserID == 0 || body.FirstName == "" || body.LoginUsername == "" {
		fail(w, 422, "userId, firstName, loginUsername required"); return
	}

	existing, _ := db.QueryOne("SELECT loginId FROM dcp_user_login WHERE login_username = ? LIMIT 1", body.LoginUsername)
	if existing != nil {
		ok(w, map[string]any{"success": false, "error": "Username already exists"}); return
	}

	hashed := ""
	if body.LoginPassword != "" {
		var err error
		hashed, err = ipauth.HashPassword(body.LoginPassword)
		if err != nil {
			fail(w, 500, "Hash error"); return
		}
	}

	db.Exec(
		"INSERT INTO dcp_user_login (userId, first_name, last_name, login_username, login_password, login_type, is_active) VALUES (?, ?, ?, ?, ?, ?, 1)",
		body.UserID, body.FirstName, body.LastName, body.LoginUsername, hashed, body.LoginType,
	)
	ok(w, map[string]any{"success": true})
}

func usersUpdate(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	json.NewDecoder(r.Body).Decode(&body)

	loginID := intVal(body["loginId"])
	if loginID == 0 {
		fail(w, 422, "loginId required"); return
	}

	if isActive, has := body["isActive"]; has {
		active := 0
		if b, isBool := isActive.(bool); isBool && b {
			active = 1
		}
		db.Exec("UPDATE dcp_user_login SET is_active = ? WHERE loginId = ?", active, loginID)
		ok(w, map[string]any{"success": true}); return
	}

	if lt, has := body["loginType"]; has {
		t := int(intVal(lt))
		if t != 0 && t != 1 && t != 2 {
			fail(w, 422, "loginType must be 0, 1, or 2"); return
		}
		db.Exec("UPDATE dcp_user_login SET login_type = ? WHERE loginId = ?", t, loginID)
		ok(w, map[string]any{"success": true}); return
	}

	if fn, has := body["firstName"]; has {
		firstName := strVal(fn)
		if firstName == "" {
			fail(w, 422, "First name is required"); return
		}
		db.Exec("UPDATE dcp_user_login SET first_name = ?, last_name = ? WHERE loginId = ?",
			firstName, strVal(body["lastName"]), loginID)
		ok(w, map[string]any{"success": true}); return
	}

	fail(w, 422, "Nothing to update")
}
