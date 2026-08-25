package admin

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	ipauth "github.com/ip-house/iphouse-api/auth"
	"github.com/ip-house/iphouse-api/db"
	"github.com/ip-house/iphouse-api/middleware"
)

/*
isUUID36 checks the canonical 36-character form, 8-4-4-4-12.

Duplicated from handlers.validClientID rather than imported: this package is
imported BY handlers' caller, and reaching back into handlers for one predicate
would couple the two for no gain. The rule is a fixed shape, not a policy that
can drift.
*/
func isUUID36(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, c := range s {
		switch i {
		case 8, 13, 18, 23:
			if c != '-' {
				return false
			}
		default:
			if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
				return false
			}
		}
	}
	return true
}

// GET /api/admin/clients
// POST /api/admin/clients
// PUT /api/admin/clients
// DELETE /api/admin/clients
func Clients(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		clientsList(w, r)
	case http.MethodPost:
		clientsCreate(w, r)
	case http.MethodPut:
		clientsUpdate(w, r)
	case http.MethodDelete:
		clientsDelete(w, r)
	default:
		fail(w, 405, "Method not allowed")
	}
}

func clientsList(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("list") != "" {
		rows, _ := db.Query("SELECT userId, name, email FROM dcp_user WHERE (role IS NULL OR role != 1) AND deleted = 0 ORDER BY name")
		ok(w, map[string]any{"success": true, "items": rows})
		return
	}
	// ClientID_MS3 is the analytics client this company reads in Reports. Listed
	// here because the edit form is populated from this response.
	rows, _ := db.Query("SELECT userId, name, email, role, deleted, createdOn, userLogo, companyLogo, ClientID_MS3 FROM dcp_user WHERE (role IS NULL OR role != 1) ORDER BY userId DESC")
	if rows == nil {
		rows = []map[string]any{}
	}
	activeCount := 0
	for _, r := range rows {
		if intVal(r["deleted"]) == 0 {
			activeCount++
		}
	}
	ok(w, map[string]any{"success": true, "clients": rows, "totalActive": activeCount})
}

// GET /api/admin/client-dashboard?userId=X
func ClientDashboard(w http.ResponseWriter, r *http.Request) {
	uid := r.URL.Query().Get("userId")
	if uid == "" {
		fail(w, 400, "userId is required")
		return
	}
	user, err := db.QueryOne("SELECT name, userLogo, companyLogo FROM dcp_user WHERE userId = ? AND deleted = 0 LIMIT 1", uid)
	if err != nil || user == nil {
		fail(w, 404, "Client not found")
		return
	}
	modules, _ := db.Query(`
		SELECT md.moduleId, md.moduleName, md.moduleIcon, mp.link, mp.noLinkMsg, mp.active, mp.`+"`default`"+`
		FROM dcp_user_module_map mp
		INNER JOIN dcp_module md ON md.moduleId = mp.moduleId
		WHERE mp.userId = ? AND md.deleted = 0
		ORDER BY md.moduleId ASC`, uid)
	if modules == nil {
		modules = []map[string]any{}
	}
	ok(w, map[string]any{"success": true, "user": user, "modules": modules})
}

func clientsCreate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name        string `json:"name"`
		Email       string `json:"email"`
		Username    string `json:"username"`
		Password    string `json:"password"`
		APIUserName string `json:"apiUserName"`
		APIPassword string `json:"apiPassword"`
		Company     string `json:"company"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if body.Name == "" || body.Email == "" || body.Username == "" || body.Password == "" {
		fail(w, 422, "Required: name, email, username, password")
		return
	}

	existing, _ := db.QueryOne("SELECT userId FROM dcp_user WHERE email = ? LIMIT 1", body.Email)
	if existing != nil {
		ok(w, map[string]any{"success": false, "error": "Email already exists"})
		return
	}

	hashed, err := ipauth.HashPassword(body.Password)
	if err != nil {
		fail(w, 500, "Hash error")
		return
	}

	// SECURITY: New client accounts MUST be created with role=0 (lowest privilege).
	// This enforcement prevents accidental privilege escalation. role=0 is the only
	// valid default for new client accounts; admin roles (1, 2) must be assigned
	// explicitly by Super Admins through separate grant flows.
	lid, _, err := db.Exec(
		"INSERT INTO dcp_user (name, email, role, deleted, api_user_name, api_password, IsSecure, updated_at) VALUES (?, ?, 0, 0, ?, ?, 0, UTC_TIMESTAMP())",
		body.Name, body.Email, body.APIUserName, body.APIPassword,
	)
	if err != nil {
		fail(w, 500, err.Error())
		return
	}
	db.Exec(
		"INSERT INTO dcp_user_login (userId, first_name, login_username, login_password, login_type, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 1, UTC_TIMESTAMP(), UTC_TIMESTAMP())",
		lid, body.Name, body.Username, hashed,
	)
	ok(w, map[string]any{"success": true, "userId": lid})
}

func clientsUpdate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		UserID      int64  `json:"userId"`
		Name        string `json:"name"`
		Email       string `json:"email"`
		APIUserName string `json:"apiUserName"`
		APIPassword string `json:"apiPassword"`
		Deleted     int    `json:"deleted"`
		// The analytics client this company's Reports read. See
		// handlers.ClientIDColumn — a wrong value here shows one company another
		// company's data, which is why it is validated rather than trusted.
		ClientIDMS3 string `json:"clientIdMs3"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if body.UserID == 0 {
		fail(w, 422, "userId required")
		return
	}
	cid := strings.Trim(strings.TrimSpace(body.ClientIDMS3), "{}\"'")
	if cid != "" && !isUUID36(cid) {
		fail(w, 422, "Reporting Client ID must be a 36-character UUID")
		return
	}
	// NULL rather than '' when cleared, so "never set" and "deliberately blank"
	// are not two different empty values to test for later.
	var stored any
	if cid != "" {
		stored = cid
	}
	db.Exec(
		"UPDATE dcp_user SET name=?, email=?, api_user_name=?, api_password=?, deleted=?, ClientID_MS3=?, updated_at=UTC_TIMESTAMP() WHERE userId=?",
		body.Name, body.Email, body.APIUserName, body.APIPassword, body.Deleted, stored, body.UserID,
	)
	ok(w, map[string]any{"success": true})
}

func clientsDelete(w http.ResponseWriter, r *http.Request) {
	var body struct {
		UserID int64 `json:"userId"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if body.UserID == 0 {
		fail(w, 422, "userId required")
		return
	}
	db.Exec("UPDATE dcp_user SET deleted = 1, updated_at = UTC_TIMESTAMP() WHERE userId = ?", body.UserID)
	ok(w, map[string]any{"success": true})
}

// GET /api/admin/clients/loa
func ClientLOA(w http.ResponseWriter, r *http.Request) {
	_ = getClaims(r)
	rows, _ := db.Query("SELECT * FROM dcp_loa ORDER BY created_at DESC")
	if rows == nil {
		rows = []map[string]any{}
	}
	ok(w, map[string]any{"success": true, "items": rows})
}

// ── helpers ───────────────────────────────────────────────────────────────────

func getClaims(r *http.Request) *ipauth.Claims {
	return middleware.GetClaims(r)
}

func ok(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{"success": false, "error": msg})
}

// execOK runs a write and, if it fails, answers the request with an error and
// returns false so the caller can stop instead of reporting a bogus success.
//
// Discarding db.Exec's error and returning {"success":true} regardless is how a
// rejected write (constraint violation, "Data too long", a dropped column) came
// back to the UI as "Saved successfully" while nothing changed. Every write that
// a user is told succeeded must go through this.
func execOK(w http.ResponseWriter, what string, sqlStr string, args ...any) bool {
	if err := db.MustExec(sqlStr, args...); err != nil {
		// db.Exec already logged the driver error and the statement.
		fail(w, 500, "Could not save "+what+". The change was not applied.")
		return false
	}
	return true
}

func intVal(v any) int64 {
	switch t := v.(type) {
	case int64:
		return t
	case float64:
		return int64(t)
	case int:
		return int64(t)
	/* scanRows turns every []byte the driver hands back into a string, and which
	   columns arrive that way is a property of the driver's protocol rather than
	   of the schema — aggregates and CASE expressions in particular. Falling
	   through to 0 for those is indistinguishable from a genuine zero, which is
	   the worst possible failure for a flag column. Parsing here can only fix
	   call sites that were already reading 0. */
	case string:
		n, err := strconv.ParseInt(strings.TrimSpace(t), 10, 64)
		if err != nil {
			return 0
		}
		return n
	case []byte:
		n, err := strconv.ParseInt(strings.TrimSpace(string(t)), 10, 64)
		if err != nil {
			return 0
		}
		return n
	}
	return 0
}

func strVal(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}
