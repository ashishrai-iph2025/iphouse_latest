package handlers

import (
	"crypto/rand"
	"encoding/json"
	"log"
	"math/big"
	"net/http"
	"strconv"
	"strings"

	"github.com/ip-house/iphouse-api/activity"
	ipauth "github.com/ip-house/iphouse-api/auth"
	"github.com/ip-house/iphouse-api/db"
	"github.com/ip-house/iphouse-api/email"
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
// logins attached to that same company, enable/disable them, create NEW ones
// for that same company, and set which modules those logins may open. It gets
// nothing else: no other company's users, no credential access to an EXISTING
// login, no role changes, and — critically — no path anywhere in this file
// ever sets dcp_user_login.is_client_admin or touches Role/staff status. Those
// stay exclusively with Admin/Super Admin, on go-server/handlers/admin's own
// endpoints. Admin/Super Admin (role >= 1) reach the same endpoints here too,
// so support staff can use the page on a client's behalf.
//
// Every query below is scoped by claims.UserID — the company of the CURRENT
// session — never by a company id taken from the request, so a Client Admin
// cannot address another company by tampering with the payload. A new login's
// userId is bound to claims.UserID at INSERT time for the same reason: there is
// no company field in the create request body at all, so there is nothing to
// tamper with.

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
	actClientAdminView          = "client_admin_view"
	actClientAdminEnable        = "client_admin_user_enabled"
	actClientAdminDisable       = "client_admin_user_disabled"
	actClientAdminDenied        = "client_admin_denied"
	actClientAdminUserCreated   = "client_admin_user_created"
	actClientAdminModulesViewed = "client_admin_modules_viewed"
	actClientAdminModulesSet    = "client_admin_modules_set"
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
// POST /api/client-admin/users — create a NEW login for the session's company
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
	case http.MethodPost:
		clientAdminUsersCreate(w, r)
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

/*
clientAdminGrantableModuleIDs — what the CALLER may hand out to someone else.

A Client Admin may only ever grant a module they hold themselves — nothing
about how module_permission or user_module_permission_test is queried
elsewhere stops them granting one they do not have, so it is enforced here,
in the one place both write paths (create a user, edit an existing user's
permissions) and the read path that populates the picker all go through.

IP House staff (role >= 1), acting on a client's behalf on this same page,
are NOT held to that limit — their authority comes from Role, not from a row
in user_module_permission_test (staff logins are not normally in that table
at all, so applying the same rule to them would leave the picker empty for
every staff session). They may grant any active module, the same authority
admin/modules.go's own picker already gives them.
*/
func clientAdminGrantableModuleIDs(claims *ipauth.Claims) map[int64]bool {
	active := map[int64]bool{}
	if rows, _ := db.Query("SELECT Id FROM module_permission WHERE status = 0"); rows != nil {
		for _, row := range rows {
			active[numOf(row["Id"])] = true
		}
	}
	if claims.Role != nil && *claims.Role >= 1 {
		return active
	}
	own := map[int64]bool{}
	rows, _ := db.Query("SELECT moduleId FROM user_module_permission_test WHERE loginId = ? AND allowed = 1", claims.LoginID)
	for _, row := range rows {
		if mid := numOf(row["moduleId"]); active[mid] {
			own[mid] = true
		}
	}
	return own
}

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

/*
clientAdminUsersCreate — a Client Admin adding a NEW person to their own
company.

Three things this must never let happen, each guarded explicitly rather than
left to fall out of the query shape:

  1. Another company gaining a login. There is no company field in the
     request body at all — userId is bound to claims.UserID at INSERT time,
     the same way every read/write in this file is scoped.
  2. A new login resolving to staff on its next sign-in. Role is derived at
     login by matching login_username against an ACTIVE dcp_super_admin.email
     (see admin.roleSelect) — so a username that happens to collide with a
     staff email would hand that brand-new client login Admin/Super Admin
     access the moment it signed in. Checked and refused before insert.
  3. is_client_admin ever being set here. It is hard-coded to 0 on the INSERT
     below and appears nowhere else in this function — that grant stays
     exclusively on go-server/handlers/admin/clientadmins.go.

Module grants are written in the same request, against the loginId this
INSERT just returned — the only place in the codebase today that creates a
login and assigns its module access in one step (see modules.go's own
UserModulePermissions, which always writes against an ALREADY-existing
loginId). Grantable ids are capped to module_permission rows with status = 0,
the same restriction the admin picker applies, so a Client Admin cannot grant
a module that has been retired or one that never existed.
*/
func clientAdminUsersCreate(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)

	var body struct {
		FirstName     string  `json:"firstName"`
		LastName      string  `json:"lastName"`
		Email         string  `json:"email"`
		LoginUsername string  `json:"loginUsername"`
		LoginPassword string  `json:"loginPassword"`
		ModuleIDs     []int64 `json:"modules"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	body.FirstName = strings.TrimSpace(body.FirstName)
	body.LastName = strings.TrimSpace(body.LastName)
	body.Email = strings.TrimSpace(body.Email)
	body.LoginUsername = strings.TrimSpace(body.LoginUsername)

	if body.FirstName == "" || body.LoginUsername == "" || body.Email == "" {
		Fail(w, 422, "First name, email and username are required")
		return
	}

	if existing, _ := db.QueryOne(
		"SELECT loginId FROM dcp_user_login WHERE login_username = ? LIMIT 1", body.LoginUsername,
	); existing != nil {
		Fail(w, 409, "This username is already taken")
		return
	}

	// Refuse a username that would resolve to Admin/Super Admin on sign-in —
	// see the function comment, point 2. Same collation-normalised join used
	// everywhere these two columns meet (clientAdminStaffJoin, admin.roleJoin).
	if staffRow, _ := db.QueryOne(`
		SELECT id FROM dcp_super_admin
		WHERE CONVERT(email USING utf8mb4) COLLATE utf8mb4_general_ci
		    = CONVERT(? USING utf8mb4) COLLATE utf8mb4_general_ci
		  AND is_active = 1 LIMIT 1`, body.LoginUsername,
	); staffRow != nil {
		logClientAdmin(r, actClientAdminDenied, map[string]any{
			"reason": "requested username belongs to IP House staff", "requestedUsername": body.LoginUsername,
		})
		Fail(w, 422, "This username is not available")
		return
	}

	rawPassword := body.LoginPassword
	if rawPassword == "" {
		rawPassword = genClientAdminPassword(12)
	}
	hashed, err := ipauth.HashPassword(rawPassword)
	if err != nil {
		log.Printf("[client-admin] hash password failed: %v", err)
		Fail(w, 500, "Could not create this user")
		return
	}

	lid, _, err := db.Exec(`
		INSERT INTO dcp_user_login
		  (userId, first_name, last_name, login_username, login_password,
		   login_type, is_active, is_client_admin, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, 0, 1, 0, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
		claims.UserID, body.FirstName, body.LastName, body.LoginUsername, hashed)
	if err != nil {
		log.Printf("[client-admin] create login for userId=%d failed: %v", claims.UserID, err)
		Fail(w, 500, "Could not create this user")
		return
	}

	// Capped to what THIS caller may grant — see clientAdminGrantableModuleIDs.
	// A genuine Client Admin cannot hand the new login a module they do not
	// hold themselves, no matter what the request body asks for.
	grantable := clientAdminGrantableModuleIDs(claims)
	grantedCount := 0
	for _, mid := range body.ModuleIDs {
		if !grantable[mid] {
			continue
		}
		if _, _, err := db.Exec(
			"INSERT INTO user_module_permission_test (loginId, moduleId, allowed) VALUES (?, ?, 1)", lid, mid,
		); err != nil {
			log.Printf("[client-admin] grant module %d to loginId=%d failed: %v", mid, lid, err)
			continue
		}
		grantedCount++
	}

	fullName := strings.TrimSpace(body.FirstName + " " + body.LastName)
	addedBy := strings.TrimSpace(claims.LoginFirstName + " " + claims.LoginLastName)
	if addedBy == "" {
		addedBy = claims.LoginUsername
	}

	logClientAdmin(r, actClientAdminUserCreated, map[string]any{
		"targetLoginId": lid, "targetUser": body.LoginUsername, "moduleCount": grantedCount,
	})
	log.Printf("[client-admin] %s created loginId=%d on userId=%d with %d module(s)",
		claims.LoginUsername, lid, claims.UserID, grantedCount)

	// Fire-and-forget, like every other credentials/notification email in this
	// codebase (see admin/users.go's own usersCreate) — a slow mail server is
	// not a reason to hold the response, and a failure here does not undo the
	// account that was just created.
	go func() {
		if err := email.SendClientAdminUserCreated(
			body.Email, fullName, body.LoginUsername, rawPassword, claims.ClientName, addedBy, email.DashboardURL,
		); err != nil {
			log.Printf("[client-admin] credentials email to %s failed: %v", body.Email, err)
		}
	}()
	go func() {
		if err := email.SendClientAdminUserCreatedNotice(
			fullName, body.Email, body.LoginUsername, claims.ClientName, addedBy,
		); err != nil {
			log.Printf("[client-admin] staff notice email failed: %v", err)
		}
	}()

	OK(w, map[string]any{"success": true, "loginId": lid})
}

// genClientAdminPassword mirrors admin.genStrongPassword (settings.go) — that
// one is unexported in package admin, and package handlers cannot import it
// without an import cycle (admin already imports handlers), so this is a
// small copy rather than a shared dependency. Ambiguous characters excluded
// so the emailed credential is easy to read and type.
func genClientAdminPassword(n int) string {
	const (
		lower  = "abcdefghijkmnopqrstuvwxyz"
		upper  = "ABCDEFGHJKLMNPQRSTUVWXYZ"
		digits = "23456789"
		syms   = "!@#$%*?"
	)
	all := lower + upper + digits + syms
	pick := func(set string) byte {
		idx, _ := rand.Int(rand.Reader, big.NewInt(int64(len(set))))
		return set[idx.Int64()]
	}
	if n < 4 {
		n = 4
	}
	b := make([]byte, n)
	b[0], b[1], b[2], b[3] = pick(lower), pick(upper), pick(digits), pick(syms)
	for i := 4; i < n; i++ {
		b[i] = pick(all)
	}
	for i := len(b) - 1; i > 0; i-- {
		jb, _ := rand.Int(rand.Reader, big.NewInt(int64(i+1)))
		j := int(jb.Int64())
		b[i], b[j] = b[j], b[i]
	}
	return string(b)
}

// GET /api/client-admin/modules — every module the CALLER may grant.
//
// Not every active module in the system — see clientAdminGrantableModuleIDs:
// a genuine Client Admin sees only what their own login already holds, so
// the picker itself can never offer a checkbox this session could not
// actually grant. Staff acting on a client's behalf still see everything
// active, the same list admin/modules.go's own picker shows them.
func ClientAdminModules(w http.ResponseWriter, r *http.Request) {
	if !clientAdminAllowed(r) {
		Fail(w, 403, "Forbidden")
		return
	}
	if r.Method != http.MethodGet {
		Fail(w, 405, "Method not allowed")
		return
	}
	grantable := clientAdminGrantableModuleIDs(ClaimsFrom(r))

	rows, err := db.Query(`SELECT Id, ModuleName, pageName FROM module_permission WHERE status = 0 ORDER BY Id ASC`)
	if err != nil {
		log.Printf("[client-admin] modules query error: %v", err)
	}
	modules := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		if grantable[numOf(row["Id"])] {
			modules = append(modules, row)
		}
	}
	OK(w, map[string]any{"success": true, "modules": modules})
}

/*
GET /api/client-admin/user-modules?loginId= — an existing login's current grants
PUT /api/client-admin/user-modules            — set them

The one place a Client Admin manages an ALREADY-existing user's permission
role, as distinct from setting it at creation time above. Same ownership +
staff + self guards as clientAdminUsersUpdate: a Client Admin may not reach
into another company, may not touch an IP House staff login, and may not
change their own permissions (the same reasoning as not being able to disable
their own access — a change that could lock the acting session out of the
one grant it needs to undo it).
*/
func ClientAdminUserModules(w http.ResponseWriter, r *http.Request) {
	if !clientAdminAllowed(r) {
		Fail(w, 403, "Forbidden")
		return
	}
	switch r.Method {
	case http.MethodGet:
		clientAdminUserModulesGet(w, r)
	case http.MethodPut:
		clientAdminUserModulesSet(w, r)
	default:
		Fail(w, 405, "Method not allowed")
	}
}

func clientAdminUserModulesGet(w http.ResponseWriter, r *http.Request) {
	loginID := numOf(r.URL.Query().Get("loginId"))
	if loginID == 0 {
		Fail(w, 422, "loginId required")
		return
	}
	if loginID == ClaimsFrom(r).LoginID {
		Fail(w, 422, "You cannot view your own permissions here")
		return
	}
	target, _ := db.QueryOne(`
		SELECT l.loginId, (sa.id IS NOT NULL) AS is_staff
		FROM dcp_user_login l
		`+clientAdminStaffJoin+`
		WHERE l.loginId = ? AND l.userId = ? LIMIT 1`, loginID, ClaimsFrom(r).UserID)
	if target == nil {
		Fail(w, 404, "User not found for this account")
		return
	}
	if flagOn(target["is_staff"]) {
		Fail(w, 403, "This user is managed by IP House staff")
		return
	}

	rows, _ := db.Query("SELECT moduleId FROM user_module_permission_test WHERE loginId = ? AND allowed = 1", loginID)
	allowed := make([]int64, 0)
	for _, row := range rows {
		allowed = append(allowed, numOf(row["moduleId"]))
	}
	logClientAdmin(r, actClientAdminModulesViewed, map[string]any{"targetLoginId": loginID})
	OK(w, map[string]any{"success": true, "allowed": allowed})
}

func clientAdminUserModulesSet(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)

	var body struct {
		LoginID   int64   `json:"loginId"`
		ModuleIDs []int64 `json:"modules"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if body.LoginID == 0 {
		Fail(w, 422, "loginId required")
		return
	}
	if body.LoginID == claims.LoginID {
		logClientAdmin(r, actClientAdminDenied, map[string]any{
			"reason": "attempted to change own permissions", "targetLoginId": body.LoginID,
		})
		Fail(w, 422, "You cannot change your own permissions")
		return
	}

	target, _ := db.QueryOne(`
		SELECT l.loginId, l.login_username, (sa.id IS NOT NULL) AS is_staff
		FROM dcp_user_login l
		`+clientAdminStaffJoin+`
		WHERE l.loginId = ? AND l.userId = ? LIMIT 1`, body.LoginID, claims.UserID)
	if target == nil {
		logClientAdmin(r, actClientAdminDenied, map[string]any{
			"reason": "target login not found in this company", "targetLoginId": body.LoginID,
		})
		Fail(w, 404, "User not found for this account")
		return
	}
	if flagOn(target["is_staff"]) {
		logClientAdmin(r, actClientAdminDenied, map[string]any{
			"reason": "target is IP House staff", "targetLoginId": body.LoginID,
		})
		Fail(w, 403, "This user is managed by IP House staff")
		return
	}

	// Capped to what THIS caller may grant — see clientAdminGrantableModuleIDs.
	//
	// The delete below is scoped to that same set, deliberately NOT a plain
	// "delete every grant this login has, then reinsert" — the target may
	// already hold a module outside it (one an admin granted directly, or one
	// the Client Admin held themselves at the time but has since lost). That
	// grant has no checkbox on this screen at all — clientAdminGrantableModuleIDs
	// is exactly what ClientAdminModules used to build the picker — so a plain
	// full-table delete would revoke it as a side effect of ticking something
	// else entirely. Scoping the delete to `grantable` means only the modules
	// the caller can actually see and control are ever touched.
	grantable := clientAdminGrantableModuleIDs(claims)
	for mid := range grantable {
		db.Exec("DELETE FROM user_module_permission_test WHERE loginId = ? AND moduleId = ?", body.LoginID, mid)
	}
	granted := 0
	for _, mid := range body.ModuleIDs {
		if !grantable[mid] {
			continue
		}
		if _, _, err := db.Exec(
			"INSERT INTO user_module_permission_test (loginId, moduleId, allowed) VALUES (?, ?, 1)", body.LoginID, mid,
		); err != nil {
			log.Printf("[client-admin] grant module %d to loginId=%d failed: %v", mid, body.LoginID, err)
			continue
		}
		granted++
	}

	logClientAdmin(r, actClientAdminModulesSet, map[string]any{
		"targetLoginId": body.LoginID, "targetUser": strFromAny(target["login_username"]), "moduleCount": granted,
	})
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
