package handlers

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/ip-house/iphouse-api/activity"
	ipauth "github.com/ip-house/iphouse-api/auth"
	"github.com/ip-house/iphouse-api/config"
	"github.com/ip-house/iphouse-api/db"
	"github.com/ip-house/iphouse-api/email"
	"github.com/ip-house/iphouse-api/markscan"
)

// ── OTP brute-force protection ───────────────────────────────────────────────
// Per-user wrong-guess counter for the 6-digit login code. Kept in memory: the
// code itself is short-lived, so a counter that resets on restart is acceptable
// (the code is also cleared once the cap is hit). For a multi-instance
// deployment move this to Redis alongside the rate limiter.

const maxOTPAttempts = 5

var otpFails struct {
	sync.Mutex
	m map[int64]int
}

func init() { otpFails.m = map[int64]int{} }

func otpAttemptsExceeded(userID int64) bool {
	otpFails.Lock()
	defer otpFails.Unlock()
	return otpFails.m[userID] >= maxOTPAttempts
}

// registerOTPFailure records a wrong guess and returns the attempts remaining.
func registerOTPFailure(userID int64) int {
	otpFails.Lock()
	defer otpFails.Unlock()
	otpFails.m[userID]++
	return maxOTPAttempts - otpFails.m[userID]
}

func clearOTPAttempts(userID int64) {
	otpFails.Lock()
	defer otpFails.Unlock()
	delete(otpFails.m, userID)
}

// ── Stateless temp tokens ────────────────────────────────────────────────────
// Temp tokens are HMAC-signed payloads (not stored server-side) so they survive
// server restarts and work across multiple instances. Format: base64(json).base64(hmac).

type tempTokenEntry struct {
	LoginID  int64     `json:"l"`
	Username string    `json:"u"`
	Exp      time.Time `json:"e"`
	APIToken string    `json:"a,omitempty"`
}

func tempSig(payload string) string {
	mac := hmac.New(sha256.New, []byte(config.C.JWTSecret))
	mac.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// issueTempToken returns a signed, self-contained token string.
func issueTempToken(e tempTokenEntry) string {
	raw, _ := json.Marshal(e)
	payload := base64.RawURLEncoding.EncodeToString(raw)
	return payload + "." + tempSig(payload)
}

// getTempToken verifies the signature and returns the decoded entry. The second
// return is false on any tampering or malformed token (expiry is checked by callers).
func getTempToken(tok string) (tempTokenEntry, bool) {
	parts := strings.SplitN(tok, ".", 2)
	if len(parts) != 2 {
		return tempTokenEntry{}, false
	}
	if !hmac.Equal([]byte(parts[1]), []byte(tempSig(parts[0]))) {
		return tempTokenEntry{}, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return tempTokenEntry{}, false
	}
	var e tempTokenEntry
	if json.Unmarshal(raw, &e) != nil {
		return tempTokenEntry{}, false
	}
	return e, true
}

// deleteTempToken is a no-op for stateless tokens (kept for call-site compatibility).
func deleteTempToken(_ string) {}

func randHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// genOTPDigits returns a random 6-digit numeric code.
func genOTPDigits() string {
	var digits string
	for len(digits) < 6 {
		b := make([]byte, 3)
		rand.Read(b)
		for _, c := range b {
			digits += string(rune('0' + int(c)%10))
		}
	}
	return digits[:6]
}

// superAdminByEmail returns an active dcp_super_admin row (Admin or SuperAdmin
// tier) for an email, or nil if none exists. Checked first by Login/OTP so a
// portal-staff email always takes precedence over a matching client login.
func superAdminByEmail(email string) map[string]any {
	row, _ := db.QueryOne(`
		SELECT id, name, email, password_hash, is_active, role, userId, loginId, otp_login_enabled
		FROM dcp_super_admin WHERE email = ? AND is_active = 1 LIMIT 1`, email)
	return row
}

// staffOTPEnabledForRow reports whether a dcp_super_admin row requires OTP login.
func staffOTPEnabledForRow(sa map[string]any) bool {
	return sa != nil && intFromAny(sa["otp_login_enabled"]) == 1
}

// claimsForSuperAdminRow builds JWT claims for a dcp_super_admin row. Admin-tier
// rows carry the real loginId/userId of the account they were granted through
// (so loginId-keyed features like Configuration Access keep working); the
// root Super Admin has neither, so its own id doubles as both.
func claimsForSuperAdminRow(sa map[string]any) ipauth.Claims {
	role := int64(2)
	if strFromAny(sa["role"]) == "Admin" {
		role = 1
	}
	id := intFromAny(sa["id"])
	loginID := intFromAny(sa["loginId"])
	if loginID == 0 {
		loginID = id
	}
	userID := intFromAny(sa["userId"])
	if userID == 0 {
		userID = id
	}
	fullName := strFromAny(sa["name"])
	first, last := fullName, ""
	if i := strings.IndexByte(fullName, ' '); i >= 0 {
		first, last = fullName[:i], strings.TrimSpace(fullName[i+1:])
	}
	return ipauth.Claims{
		LoginID: loginID, UserID: userID, Role: &role, LoginType: 2,
		LoginUsername:  strFromAny(sa["email"]),
		LoginFirstName: first, LoginLastName: last,
		ClientName: fullName,
	}
}

// hashResetToken returns the SHA-256 hex of a reset token. Only the hash is
// stored in the DB, so a leaked database row cannot be used to reset a password
// (the raw token exists only in the user's email).
func hashResetToken(tok string) string {
	sum := sha256.Sum256([]byte(tok))
	return hex.EncodeToString(sum[:])
}

// upgradeLegacyHash transparently re-hashes a legacy MD5 password to bcrypt after
// a successful login. table/column/id identify the row to update. Best-effort:
// failures are logged but never block the login.
func upgradeLegacyHash(plain, stored, updateSQL string, id int64) {
	if !ipauth.IsLegacyHash(stored) {
		return
	}
	newHash, err := ipauth.HashPassword(plain)
	if err != nil {
		log.Printf("[auth] legacy hash upgrade: bcrypt failed for id=%d: %v", id, err)
		return
	}
	if _, _, err := db.Exec(updateSQL, newHash, id); err != nil {
		log.Printf("[auth] legacy hash upgrade: db update failed for id=%d: %v", id, err)
		return
	}
	log.Printf("[auth] upgraded legacy MD5 password to bcrypt for id=%d", id)
}

// ── POST /api/auth/check-multiple-logins ─────────────────────────────────────

func CheckMultipleLogins(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if body.Username == "" || body.Password == "" {
		Fail(w, 400, "Missing credentials")
		return
	}

	// Portal-staff check (Admin or Super Admin — unified in dcp_super_admin)
	if sa := superAdminByEmail(body.Username); sa != nil {
		hash, _ := sa["password_hash"].(string)
		if !ipauth.VerifyPassword(body.Password, hash) {
			OK(w, map[string]any{"success": false, "error": "Invalid username or password"})
			return
		}
		upgradeLegacyHash(body.Password, hash, "UPDATE dcp_super_admin SET password_hash = ? WHERE id = ?", intFromAny(sa["id"]))
		claims := claimsForSuperAdminRow(sa)
		isLegacyHash := ipauth.IsLegacyHash(hash)
		OK(w, map[string]any{
			"success": true, "userId": claims.UserID,
			"email": sa["email"], "login_type": 2, "role": *claims.Role,
			"multipleLogins": false, "rows": []any{},
			// Per-staff setting: this account completes an email OTP after its
			// password only when a Super Admin enabled OTP for THIS row (same
			// flow/template as clients).
			"otpRequired": staffOTPEnabledForRow(sa), "staff": true,
			"md5HashWarning": isLegacyHash, // Flag: this is a legacy MD5 hash that's being upgraded to bcrypt
		})
		return
	}

	// Regular login
	row, _ := db.QueryOne(`
		SELECT l.loginId, l.userId, l.login_password, l.login_type, l.is_active, u.name, u.role
		FROM dcp_user_login l
		INNER JOIN dcp_user u ON u.userId = l.userId
		WHERE l.login_username = ? AND l.is_active = 1 AND u.deleted = 0 LIMIT 1`, body.Username)
	if row == nil {
		// Approved registrants start as a login with no client company yet
		// (userId NULL) and can't sign in until one is assigned — say so
		// instead of "invalid credentials" when their password is right.
		pending, _ := db.QueryOne("SELECT login_password FROM dcp_user_login WHERE login_username = ? AND is_active = 1 AND userId IS NULL LIMIT 1", body.Username)
		if pending != nil {
			if hash, _ := pending["login_password"].(string); ipauth.VerifyPassword(body.Password, hash) {
				OK(w, map[string]any{"success": false, "error": "Your account is approved but not yet assigned to a client account. Please contact your administrator."})
				return
			}
		}
		OK(w, map[string]any{"success": false, "error": "Invalid username or password"})
		return
	}
	hash, _ := row["login_password"].(string)
	if !ipauth.VerifyPassword(body.Password, hash) {
		OK(w, map[string]any{"success": false, "error": "Invalid username or password"})
		return
	}
	upgradeLegacyHash(body.Password, hash, "UPDATE dcp_user_login SET login_password = ? WHERE loginId = ?", intFromAny(row["loginId"]))

	// Multiple logins sharing same username
	multiRows, _ := db.Query(`
		SELECT l.loginId, l.login_username, l.userId, u.name AS account_name,
		       (u.api_user_name IS NOT NULL AND u.api_user_name != '' AND u.api_password IS NOT NULL AND u.api_password != '') AS has_api
		FROM dcp_user_login l
		INNER JOIN dcp_user u ON u.userId = l.userId
		WHERE l.login_username = ? AND l.is_active = 1 AND u.deleted = 0`, body.Username)

	// Flag if this is a legacy MD5 hash being upgraded on login
	isLegacyHash := ipauth.IsLegacyHash(hash)

	resp := map[string]any{
		"success": true, "userId": intFromAny(row["userId"]),
		"email": body.Username, "login_type": intFromAny(row["login_type"]),
		"role": row["role"], "multipleLogins": len(multiRows) > 1, "rows": multiRows,
		"md5HashWarning": isLegacyHash, // Flag: this is a legacy MD5 hash that's being upgraded to bcrypt
	}

	// When multiple accounts exist, issue a short-lived temp token so
	// the client-selection page can call /api/auth/select-login securely.
	if len(multiRows) > 1 {
		resp["tempToken"] = issueTempToken(tempTokenEntry{
			LoginID:  0, // not yet selected
			Username: body.Username,
			Exp:      time.Now().Add(10 * time.Minute),
		})
	}

	OK(w, resp)
}

// ── POST /api/auth/send-otp ───────────────────────────────────────────────────

// otpUserID returns the canonical userId the OTP is stored against. When an email
// is supplied it ALWAYS wins (resolved deterministically), because one email may be
// a login on several client accounts (different userIds) — send and verify must
// agree on the same row or the code won't be found ("No active code").
func otpUserID(email string, fallback int64) int64 {
	if email != "" {
		lr, _ := db.QueryOne("SELECT userId FROM dcp_user_login WHERE login_username = ? AND is_active = 1 ORDER BY userId ASC LIMIT 1", email)
		if lr != nil {
			if id := intFromAny(lr["userId"]); id != 0 {
				return id
			}
		}
	}
	return fallback
}

func SendOTP(w http.ResponseWriter, r *http.Request) {
	var body struct {
		UserID int64  `json:"userId"`
		Email  string `json:"email"`
	}
	json.NewDecoder(r.Body).Decode(&body)

	// Portal staff take precedence over a matching client login (same rule as
	// Login/check-multiple-logins): their code is stored on dcp_super_admin, not
	// dcp_user, so route here before the client path — but only for a staff
	// account that has OTP login enabled for its own row.
	if sa := superAdminByEmail(body.Email); staffOTPEnabledForRow(sa) {
		sendStaffOTP(w, sa)
		return
	}

	// Email-based resolution always wins so send/verify target the same row.
	body.UserID = otpUserID(body.Email, body.UserID)
	if body.UserID == 0 {
		Fail(w, 400, "userId or email required")
		return
	}

	user, err := db.QueryOne("SELECT userId, name FROM dcp_user WHERE userId = ? LIMIT 1", body.UserID)
	if err != nil || user == nil {
		Fail(w, 404, "User not found")
		return
	}

	// The recipient must be the exact login the user entered — a single client
	// (userId) can own several login accounts, so a userId-only lookup may pick
	// the wrong address. Prefer body.Email, validating it belongs to this user.
	// We also pull the login's own first/last name so the OTP greets the person
	// signing in, not the client/company account name.
	recipient := ""
	loginName := ""
	if body.Email != "" {
		vr, _ := db.QueryOne("SELECT login_username, first_name, last_name FROM dcp_user_login WHERE login_username = ? AND userId = ? AND is_active = 1 LIMIT 1", body.Email, body.UserID)
		if vr != nil {
			recipient = strFromAny(vr["login_username"])
			loginName = strings.TrimSpace(strFromAny(vr["first_name"]) + " " + strFromAny(vr["last_name"]))
		}
	}
	if recipient == "" {
		loginRow, _ := db.QueryOne("SELECT login_username, first_name, last_name FROM dcp_user_login WHERE userId = ? AND is_active = 1 LIMIT 1", body.UserID)
		if loginRow == nil {
			Fail(w, 404, "Login not found")
			return
		}
		recipient = strFromAny(loginRow["login_username"])
		loginName = strings.TrimSpace(strFromAny(loginRow["first_name"]) + " " + strFromAny(loginRow["last_name"]))
	}

	digits := genOTPDigits()

	// A newly issued code starts with a clean attempt budget.
	clearOTPAttempts(body.UserID)

	// Use MySQL's own clock (explicitly UTC_TIMESTAMP(), not NOW()) for the expiry
	// so verification never depends on the connection's or server's tz config.
	db.Exec("UPDATE dcp_user SET twofa_code = ?, twofa_code_expires = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 10 MINUTE) WHERE userId = ?", digits, body.UserID)

	// Greet the person signing in (login first/last name). Fall back to the email
	// address, then the client/company name, if no personal name is on the login.
	name := loginName
	if name == "" {
		name = recipient
	}
	if name == "" {
		name, _ = user["name"].(string)
	}

	// Send synchronously so SMTP/configuration failures surface to the user
	// instead of being silently swallowed in a goroutine.
	if err := email.SendOTP(recipient, digits, name); err != nil {
		log.Printf("[send-otp] failed to email %s: %v", recipient, err)
		Fail(w, 502, "Could not send the verification email. Please check email settings or try again.")
		return
	}
	log.Printf("[send-otp] OTP sent to %s (userId=%d)", recipient, body.UserID)

	OK(w, map[string]any{"success": true, "userId": body.UserID})
}

// sendStaffOTP issues and emails a login code for a portal-staff account,
// storing it on dcp_super_admin (staff have no dcp_user.twofa_code row). Uses
// the SAME code generator, attempt budget and email template as clients.
func sendStaffOTP(w http.ResponseWriter, sa map[string]any) {
	id := intFromAny(sa["id"])
	recipient := strFromAny(sa["email"])
	name := strFromAny(sa["name"])
	if name == "" {
		name = recipient
	}

	digits := genOTPDigits()
	// Namespaced key so a staff account whose id collides with a client userId
	// gets its own attempt budget.
	clearOTPAttempts(staffOTPKey(id))

	if err := db.MustExec(
		"UPDATE dcp_super_admin SET twofa_code = ?, twofa_code_expires = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 10 MINUTE) WHERE id = ?",
		digits, id); err != nil {
		Fail(w, 500, "Could not start verification. Please try again.")
		return
	}

	if err := email.SendOTP(recipient, digits, name); err != nil {
		log.Printf("[send-otp] staff email to %s failed: %v", recipient, err)
		Fail(w, 502, "Could not send the verification email. Please check email settings or try again.")
		return
	}
	log.Printf("[send-otp] staff OTP sent to %s (saId=%d)", recipient, id)
	OK(w, map[string]any{"success": true, "staff": true})
}

// staffOTPKey namespaces a dcp_super_admin id in the shared OTP attempt map so
// it can't collide with a dcp_user userId.
func staffOTPKey(saID int64) int64 { return -saID - 1 }

// ── POST /api/auth/verify-otp ─────────────────────────────────────────────────

func VerifyOTP(w http.ResponseWriter, r *http.Request) {
	var body struct {
		UserID int64  `json:"userId"`
		Email  string `json:"email"`
		Code   string `json:"code"`
	}
	json.NewDecoder(r.Body).Decode(&body)

	// Portal staff verify against dcp_super_admin and, on success, get a session
	// straight away (there is no account-selection step for staff). Gated per
	// row, same as send-otp — inert unless OTP is enabled for this account.
	if sa := superAdminByEmail(body.Email); staffOTPEnabledForRow(sa) {
		verifyStaffOTP(w, r, sa, body.Code)
		return
	}

	// Resolve the same canonical userId the OTP was stored against.
	body.UserID = otpUserID(body.Email, body.UserID)
	if body.UserID == 0 || body.Code == "" {
		Fail(w, 400, "Missing parameters")
		return
	}

	// Compute the expiry check in SQL using MySQL's own UTC_TIMESTAMP() — avoids
	// any Go/driver timezone dependency entirely.
	user, _ := db.QueryOne("SELECT userId, twofa_code, (twofa_code_expires IS NOT NULL AND twofa_code_expires > UTC_TIMESTAMP()) AS not_expired FROM dcp_user WHERE userId = ? LIMIT 1", body.UserID)
	if user == nil {
		OK(w, map[string]any{"success": false, "error": "User not found"})
		return
	}
	storedCode := strFromAny(user["twofa_code"])
	if storedCode == "" {
		OK(w, map[string]any{"success": false, "error": "No active code"})
		return
	}

	/* The OTP lockout, alongside the per-code cap below.

	   They answer different questions and both are needed. Burning the code
	   after five wrong guesses stops ONE code being brute-forced; it does not
	   stop somebody requesting a fresh code and starting again, which over an
	   afternoon is the same attack at a slower pace. The lockout counts across
	   codes and is held in the database, so it survives a restart and is shared
	   by every process. */
	otpAcct := otpLockAccount(body.Email, body.UserID)
	if st := CheckLock(AcctLogin, otpAcct, FailOTP); st.Locked {
		OK(w, map[string]any{"success": false, "locked": true, "error": LockMessage(st)})
		return
	}
	// A 6-digit code is only 1e6 wide: without a per-code attempt cap it can be
	// brute-forced (per-IP rate limiting alone is not enough — an attacker with
	// several source addresses still gets there). Burn the code after too many
	// wrong guesses and force the user to request a fresh one.
	if otpAttemptsExceeded(body.UserID) {
		db.Exec("UPDATE dcp_user SET twofa_code = NULL, twofa_code_expires = NULL WHERE userId = ? LIMIT 1", body.UserID)
		clearOTPAttempts(body.UserID)
		OK(w, map[string]any{"success": false, "error": "Too many incorrect attempts. Please request a new code."})
		return
	}
	// Constant-time compare so the response time can't leak the code prefix.
	if subtle.ConstantTimeCompare([]byte(storedCode), []byte(body.Code)) != 1 {
		lock := RecordFailure(AcctLogin, otpAcct, FailOTP)
		if lock.Locked {
			db.Exec("UPDATE dcp_user SET twofa_code = NULL, twofa_code_expires = NULL WHERE userId = ? LIMIT 1", body.UserID)
			clearOTPAttempts(body.UserID)
			notifyIfJustLocked(lock, body.Email, "")
			OK(w, map[string]any{"success": false, "locked": true, "error": LockMessage(lock)})
			return
		}
		left := registerOTPFailure(body.UserID)
		if left <= 0 {
			db.Exec("UPDATE dcp_user SET twofa_code = NULL, twofa_code_expires = NULL WHERE userId = ? LIMIT 1", body.UserID)
			clearOTPAttempts(body.UserID)
			OK(w, map[string]any{"success": false, "error": "Too many incorrect attempts. Please request a new code."})
			return
		}
		OK(w, map[string]any{"success": false, "error": "Incorrect code"})
		return
	}
	if intFromAny(user["not_expired"]) == 0 {
		OK(w, map[string]any{"success": false, "error": "Code has expired"})
		return
	}

	clearOTPAttempts(body.UserID)
	ClearFailures(AcctLogin, otpAcct, FailOTP)
	db.Exec("UPDATE dcp_user SET twofa_code = NULL, twofa_code_expires = NULL WHERE userId = ? LIMIT 1", body.UserID)

	// The username MUST be the exact email the user authenticated with — never
	// re-derived by userId (a client account can have several different logins,
	// so a userId-only LIMIT 1 may return a DIFFERENT person's username).
	username := body.Email
	loginRow, _ := db.QueryOne(`
		SELECT l.loginId
		FROM dcp_user_login l
		INNER JOIN dcp_user u ON u.userId = l.userId
		WHERE l.login_username = ? AND l.is_active = 1 AND u.deleted = 0 LIMIT 1`, username)
	if username == "" || loginRow == nil {
		Fail(w, 404, "Login record not found")
		return
	}
	loginID := intFromAny(loginRow["loginId"])

	// Issue an UNBOUND temp token (loginID=0, no api token): the user may own several
	// accounts under this email and the client-selection page must be able to pick any.
	// The api token is fetched per-account by the downstream select-login handler.
	tempTok := issueTempToken(tempTokenEntry{
		LoginID: 0, Username: username,
		Exp: time.Now().Add(10 * time.Minute),
	})

	OK(w, map[string]any{"success": true, "loginId": loginID, "tempToken": tempTok, "username": username})
}

// verifyStaffOTP checks a portal-staff login code against dcp_super_admin and,
// on success, issues the staff session cookie directly — no client-selection
// step. Mirrors the client verify: attempt cap, constant-time compare, expiry.
func verifyStaffOTP(w http.ResponseWriter, r *http.Request, sa map[string]any, code string) {
	id := intFromAny(sa["id"])
	key := staffOTPKey(id)

	row, _ := db.QueryOne("SELECT twofa_code, (twofa_code_expires IS NOT NULL AND twofa_code_expires > UTC_TIMESTAMP()) AS not_expired FROM dcp_super_admin WHERE id = ? LIMIT 1", id)
	if row == nil {
		OK(w, map[string]any{"success": false, "error": "Account not found"})
		return
	}
	storedCode := strFromAny(row["twofa_code"])
	if storedCode == "" {
		OK(w, map[string]any{"success": false, "error": "No active code"})
		return
	}
	if otpAttemptsExceeded(key) {
		db.Exec("UPDATE dcp_super_admin SET twofa_code = NULL, twofa_code_expires = NULL WHERE id = ?", id)
		clearOTPAttempts(key)
		OK(w, map[string]any{"success": false, "error": "Too many incorrect attempts. Please request a new code."})
		return
	}
	if subtle.ConstantTimeCompare([]byte(storedCode), []byte(code)) != 1 {
		if registerOTPFailure(key) <= 0 {
			db.Exec("UPDATE dcp_super_admin SET twofa_code = NULL, twofa_code_expires = NULL WHERE id = ?", id)
			clearOTPAttempts(key)
			OK(w, map[string]any{"success": false, "error": "Too many incorrect attempts. Please request a new code."})
			return
		}
		OK(w, map[string]any{"success": false, "error": "Incorrect code"})
		return
	}
	if intFromAny(row["not_expired"]) == 0 {
		OK(w, map[string]any{"success": false, "error": "Code has expired"})
		return
	}

	// Success: burn the code and mint the staff session (same claims as the
	// password login path, so role/access are identical).
	clearOTPAttempts(key)
	db.Exec("UPDATE dcp_super_admin SET twofa_code = NULL, twofa_code_expires = NULL WHERE id = ?", id)

	claims := claimsForSuperAdminRow(sa)
	tok, err := ipauth.SignToken(claims)
	if err != nil {
		Fail(w, 500, "Token error")
		return
	}
	go db.Exec("UPDATE dcp_super_admin SET last_login = UTC_TIMESTAMP() WHERE id = ?", id)
	go db.Exec("INSERT INTO dcp_login (userId, loginId, loginTime) VALUES (?, ?, UTC_TIMESTAMP())", claims.UserID, claims.LoginID)
	go activity.Log(claims.LoginID, "login", "auth/verify-otp", activity.GetIP(r), activity.GetUA(r), map[string]any{"method": "otp"})

	SetTokenCookie(w, tok)
	OK(w, map[string]any{"success": true, "staff": true, "token": tok, "user": sanitizeClaims(claims)})
}

// ── POST /api/auth/select-login ───────────────────────────────────────────────

func SelectLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"` // temp token
		LoginID  int64  `json:"loginId"`
	}
	json.NewDecoder(r.Body).Decode(&body)

	entry, ok := getTempToken(body.Password)
	if !ok {
		log.Printf("[select-login] token signature invalid/malformed (len=%d) for user=%q loginId=%d", len(body.Password), body.Username, body.LoginID)
		Fail(w, 401, "Invalid or expired token")
		return
	}
	if time.Now().After(entry.Exp) {
		log.Printf("[select-login] token expired (exp=%s now=%s) user=%q", entry.Exp.Format(time.RFC3339), time.Now().Format(time.RFC3339), body.Username)
		Fail(w, 401, "Invalid or expired token")
		return
	}
	if entry.Username != body.Username {
		log.Printf("[select-login] username mismatch: token=%q request=%q", entry.Username, body.Username)
		Fail(w, 401, "Invalid or expired token")
		return
	}
	// If loginID is set on the token (OTP flow), it must match the request.
	if entry.LoginID != 0 && entry.LoginID != body.LoginID {
		log.Printf("[select-login] loginID mismatch: token=%d request=%d", entry.LoginID, body.LoginID)
		Fail(w, 401, "Invalid or expired token")
		return
	}
	deleteTempToken(body.Password)

	row, _ := db.QueryOne(`
		SELECT l.loginId, l.userId, l.first_name, l.last_name, l.login_username, l.login_type,
		       l.is_client_admin,
		       u.name, u.email, u.role, u.IsSecure, u.api_user_name, u.api_password
		FROM dcp_user_login l
		INNER JOIN dcp_user u ON u.userId = l.userId
		WHERE l.loginId = ? AND l.login_username = ? AND l.is_active = 1 AND u.deleted = 0`,
		body.LoginID, body.Username)
	if row == nil {
		Fail(w, 401, "User not found")
		return
	}

	// Fetch fresh Markscan API token for the selected account
	apiTok := entry.APIToken
	if apiTok == "" {
		apiUser := strFromAny(row["api_user_name"])
		apiPass := strFromAny(row["api_password"])
		if apiUser != "" && apiPass != "" {
			var lerr error
			apiTok, lerr = markscan.Login(apiUser, apiPass)
			if lerr != nil {
				log.Printf("[select-login] markscan login FAILED for %q (apiUser=%q): %v", body.Username, apiUser, lerr)
			} else {
				log.Printf("[select-login] markscan token generated for %q (apiUser=%q, len=%d)", body.Username, apiUser, len(apiTok))
			}
		} else {
			log.Printf("[select-login] no API credentials for selected account loginId=%d → limited access", body.LoginID)
		}
	}

	ip := activity.GetIP(r)
	ua := activity.GetUA(r)
	loginID := intFromAny(row["loginId"])
	userID := intFromAny(row["userId"])

	go db.Exec("INSERT INTO dcp_login (userId, loginId, loginTime) VALUES (?, ?, UTC_TIMESTAMP())", userID, loginID)
	go db.Exec("UPDATE dcp_user_login SET last_seen_at = UTC_TIMESTAMP() WHERE loginId = ?", loginID)
	go activity.Log(loginID, "login", "auth/login", ip, ua, map[string]any{"method": "select"})

	if apiTok != "" {
		markscan.SetCachedToken(userID, apiTok)
	}

	claims := buildClaims(row, apiTok)
	tok, err := ipauth.SignToken(claims)
	if err != nil {
		Fail(w, 500, "Token error")
		return
	}
	SetTokenCookie(w, tok)
	OK(w, map[string]any{"success": true, "token": tok, "user": sanitizeClaims(claims)})
}

// ── POST /api/auth/login (password-based direct login, issues JWT) ────────────

func Login(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
		LoginID  int64  `json:"loginId"`
		TempTok  string `json:"tempToken"`
	}
	json.NewDecoder(r.Body).Decode(&body)

	ip := activity.GetIP(r)
	ua := activity.GetUA(r)

	// Client-selection flow via temp token
	if body.TempTok != "" && body.LoginID != 0 {
		entry, ok := getTempToken(body.TempTok)
		// A token with loginID==0 is unbound (issued for account selection) and may
		// be used for any of the user's logins; a bound token must match exactly.
		if !ok || time.Now().After(entry.Exp) ||
			(entry.LoginID != 0 && entry.LoginID != body.LoginID) ||
			(entry.Username != "" && entry.Username != body.Username) {
			Fail(w, 401, "Invalid or expired token")
			return
		}
		deleteTempToken(body.TempTok)

		row, _ := db.QueryOne(`
			SELECT l.loginId, l.userId, l.first_name, l.last_name, l.login_username, l.login_type,
			       l.is_client_admin,
			       u.name, u.email, u.role, u.IsSecure, u.api_user_name, u.api_password
			FROM dcp_user_login l
			INNER JOIN dcp_user u ON u.userId = l.userId
			WHERE l.loginId = ? AND l.is_active = 1 AND u.deleted = 0`, body.LoginID)
		if row == nil {
			Fail(w, 401, "User not found")
			return
		}
		loginID := intFromAny(row["loginId"])
		userID := intFromAny(row["userId"])

		// Resolve the Markscan token for the selected account.
		apiTok := entry.APIToken
		if apiTok == "" {
			apiUser := strFromAny(row["api_user_name"])
			apiPass := strFromAny(row["api_password"])
			if apiUser != "" && apiPass != "" {
				apiTok, _ = markscan.Login(apiUser, apiPass)
			}
		}
		if apiTok != "" {
			markscan.SetCachedToken(userID, apiTok)
		}

		go db.Exec("INSERT INTO dcp_login (userId, loginId, loginTime) VALUES (?, ?, UTC_TIMESTAMP())", userID, loginID)
		go db.Exec("UPDATE dcp_user_login SET last_seen_at = UTC_TIMESTAMP() WHERE loginId = ?", loginID)
		go activity.Log(loginID, "login", "auth/login", ip, ua, map[string]any{"method": "select"})

		claims := buildClaims(row, apiTok)
		tok, _ := ipauth.SignToken(claims)
		SetTokenCookie(w, tok)
		OK(w, map[string]any{"success": true, "token": tok, "user": sanitizeClaims(claims)})
		return
	}

	if body.Username == "" || body.Password == "" {
		Fail(w, 400, "Missing credentials")
		return
	}

	// Portal-staff login (Admin or Super Admin — unified in dcp_super_admin)
	if sa := superAdminByEmail(body.Username); sa != nil {
		id := intFromAny(sa["id"])

		/* The lock is checked BEFORE the password, and answers the same way for
		   a right password as for a wrong one. Checking after would let someone
		   confirm a guessed password against a locked account — the lockout
		   would hold the session back while the error message gave away that the
		   credential was correct. */
		if st := CheckLock(AcctSuperAdmin, id, FailPassword); st.Locked {
			go activity.Log(id, "login_blocked", "auth/login", ip, ua, map[string]any{"reason": "locked"})
			Fail(w, 423, LockMessage(st))
			return
		}

		hash, _ := sa["password_hash"].(string)
		if !ipauth.VerifyPassword(body.Password, hash) {
			st := RecordFailure(AcctSuperAdmin, id, FailPassword)
			notifyIfJustLocked(st, strFromAny(sa["email"]), strFromAny(sa["name"]))
			Fail(w, 401, failedLoginMessage(st))
			return
		}
		ClearFailures(AcctSuperAdmin, id, FailPassword)
		upgradeLegacyHash(body.Password, hash, "UPDATE dcp_super_admin SET password_hash = ? WHERE id = ?", id)
		claims := claimsForSuperAdminRow(sa)
		go db.Exec("UPDATE dcp_super_admin SET last_login = UTC_TIMESTAMP() WHERE id = ?", id)
		go db.Exec("INSERT INTO dcp_login (userId, loginId, loginTime) VALUES (?, ?, UTC_TIMESTAMP())", claims.UserID, claims.LoginID)
		go activity.Log(claims.LoginID, "login", "auth/login", activity.GetIP(r), activity.GetUA(r), map[string]any{"method": "password"})
		tok, _ := ipauth.SignToken(claims)
		SetTokenCookie(w, tok)
		OK(w, map[string]any{"success": true, "token": tok, "user": sanitizeClaims(claims)})
		return
	}

	// Regular user
	row, _ := db.QueryOne(`
		SELECT l.loginId, l.userId, l.first_name, l.last_name, l.login_username, l.login_type,
		       l.login_password, l.is_client_admin,
		       u.name, u.email, u.role, u.IsSecure, u.api_user_name, u.api_password
		FROM dcp_user_login l
		INNER JOIN dcp_user u ON u.userId = l.userId
		WHERE l.login_username = ? AND l.is_active = 1 AND u.deleted = 0 LIMIT 1`, body.Username)
	if row == nil {
		Fail(w, 401, "Invalid credentials")
		return
	}

	// Same order and the same reasons as the staff branch above: locked before
	// verified, so the response cannot confirm a guessed password.
	if st := CheckLock(AcctLogin, intFromAny(row["loginId"]), FailPassword); st.Locked {
		go activity.Log(intFromAny(row["loginId"]), "login_blocked", "auth/login", ip, ua,
			map[string]any{"reason": "locked"})
		Fail(w, 423, LockMessage(st))
		return
	}

	hash, _ := row["login_password"].(string)
	if !ipauth.VerifyPassword(body.Password, hash) {
		st := RecordFailure(AcctLogin, intFromAny(row["loginId"]), FailPassword)
		notifyIfJustLocked(st, strFromAny(row["login_username"]),
			strings.TrimSpace(strFromAny(row["first_name"])+" "+strFromAny(row["last_name"])))
		Fail(w, 401, failedLoginMessage(st))
		return
	}
	ClearFailures(AcctLogin, intFromAny(row["loginId"]), FailPassword)
	upgradeLegacyHash(body.Password, hash, "UPDATE dcp_user_login SET login_password = ? WHERE loginId = ?", intFromAny(row["loginId"]))

	// Markscan API token
	var apiTok string
	apiUser, _ := row["api_user_name"].(string)
	apiPass, _ := row["api_password"].(string)
	if apiUser != "" && apiPass != "" {
		apiTok, _ = markscan.Login(apiUser, apiPass)
	}

	loginID := intFromAny(row["loginId"])
	userID := intFromAny(row["userId"])
	go db.Exec("INSERT INTO dcp_login (userId, loginId, loginTime) VALUES (?, ?, UTC_TIMESTAMP())", userID, loginID)
	go db.Exec("UPDATE dcp_user_login SET last_seen_at = UTC_TIMESTAMP() WHERE loginId = ?", loginID)
	go activity.Log(loginID, "login", "auth/login", ip, ua, map[string]any{"method": "password"})

	if apiTok != "" {
		markscan.SetCachedToken(userID, apiTok)
	}

	claims := buildClaims(row, apiTok)
	tok, _ := ipauth.SignToken(claims)
	SetTokenCookie(w, tok)
	OK(w, map[string]any{"success": true, "token": tok, "user": sanitizeClaims(claims)})
}

// ── POST /api/auth/logout ─────────────────────────────────────────────────────

func Logout(w http.ResponseWriter, r *http.Request) {
	ClearTokenCookie(w)
	OK(w, map[string]any{"success": true})
}

// ── GET /api/auth/session ─────────────────────────────────────────────────────

func Session(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	if claims == nil {
		Fail(w, 401, "Not authenticated")
		return
	}
	OK(w, map[string]any{"success": true, "user": sanitizeClaims(*claims)})
}

// ── Account lookup by email ──────────────────────────────────────────────────

// resolvedAccount is which account owns an email address.
type resolvedAccount struct {
	Type string // "super_admin" | "login"
	ID   int64  // dcp_super_admin.id or dcp_user_login.loginId
	Name string
}

/*
accountForEmail resolves an email to the account that owns it.

One function, used by BOTH the inline check the page makes while someone is
typing and the reset itself — because two lookups that can disagree is a form
that says "no such account" under a field the reset then happily sends a token
to, or the reverse. Staff (dcp_super_admin) are checked FIRST and always win
over a matching client login, mirroring Login and ChangePassword: the reset must
write to the same table the login flow reads.

Only ACTIVE client logins count. A deactivated account cannot sign in, so
offering to reset its password is offering a door that does not open.
*/
func accountForEmail(email string) (resolvedAccount, bool) {
	email = strings.TrimSpace(email)
	if email == "" {
		return resolvedAccount{}, false
	}
	if sa := superAdminByEmail(email); sa != nil {
		return resolvedAccount{
			Type: "super_admin",
			ID:   intFromAny(sa["id"]),
			Name: strFromAny(sa["name"]),
		}, true
	}
	user, _ := db.QueryOne(
		"SELECT loginId, login_username, first_name, last_name FROM dcp_user_login WHERE login_username = ? AND is_active = 1 LIMIT 1",
		email)
	if user == nil {
		return resolvedAccount{}, false
	}
	name := strings.TrimSpace(strFromAny(user["first_name"]) + " " + strFromAny(user["last_name"]))
	if name == "" {
		name = strFromAny(user["login_username"])
	}
	return resolvedAccount{Type: "login", ID: intFromAny(user["loginId"]), Name: name}, true
}

// hideUnknownEmail restores the old behaviour — a generic reply whether or not
// the address exists — without a code change. Off by default: this portal
// deliberately tells a client that they typed the wrong address. See the note
// in ForgotPassword for what that costs.
func hideUnknownEmail() bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv("AUTH_HIDE_UNKNOWN_EMAIL")))
	return v == "1" || v == "true" || v == "on" || v == "yes"
}

/*
── POST /api/auth/check-email ───────────────────────────────────────────────

	Does an account exist for this address? Answered on its own so the forgot-
	password form can say so while someone is still in the field, rather than
	after they have submitted and gone to look in an inbox that will stay empty.

	It returns NOTHING but the boolean — no name, no account type, no id. The
	existence of an account is already disclosed by the reset endpoint under the
	current setting; anything more would be new disclosure to an anonymous
	caller.

	Behind the same 10/min/IP limiter as the rest of the auth routes, and it
	honours AUTH_HIDE_UNKNOWN_EMAIL: with the generic reply turned back on this
	endpoint stops answering too, or it would be the enumeration hole the
	setting exists to close.
*/
func CheckEmail(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email string `json:"email"`
	}
	json.NewDecoder(r.Body).Decode(&body)

	email := strings.TrimSpace(body.Email)
	if email == "" {
		Fail(w, 400, "Email is required")
		return
	}
	if hideUnknownEmail() {
		// Not 404: the route existing but declining to distinguish is the
		// honest answer, and a client that treats "unknown" as "carry on" then
		// behaves correctly under either setting.
		OK(w, map[string]any{"success": true, "checked": false})
		return
	}

	_, found := accountForEmail(email)

	/* THREE states, not two. Sign-up and password-reset ask the same question
	   of the same address and need different answers from it:

	     account    already signed up — reset the password, do not register
	     pending    registered already and waiting on an admin — do neither
	     available  neither — registering is the thing to do

	   A pending request is invisible to accountForEmail because approval is
	   what creates the login. Without it /register tells someone the address is
	   free, they submit again, and the duplicate is only noticed by whoever
	   reviews the queue. */
	pending := false
	if !found {
		row, _ := db.QueryOne(
			"SELECT id FROM user_registration_requests WHERE email = ? AND status = 'pending' LIMIT 1", email)
		pending = row != nil
	}

	status := "available"
	switch {
	case found:
		status = "account"
	case pending:
		status = "pending"
	}

	OK(w, map[string]any{
		"success": true, "checked": true,
		// `exists` is unchanged and still means "has a login" — the
		// forgot-password page reads it and must keep working.
		"exists": found, "pending": pending, "status": status,
	})
}

// ── POST /api/auth/forgot-password ───────────────────────────────────────────

func ForgotPassword(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email string `json:"email"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if body.Email == "" {
		Fail(w, 400, "Email is required")
		return
	}

	const genericReply = "If an account exists for that email address, a password reset link has been sent."

	acct, found := accountForEmail(body.Email)
	if !found {
		/* An unknown address is told so, rather than being answered with the
		   generic reply.

		   This is a DELIBERATE trade and the reason the generic reply existed:
		   an endpoint that distinguishes "no such account" from "sent" lets
		   anyone confirm which addresses hold accounts here, which is how
		   phishing and credential-stuffing target lists get built. It is
		   accepted here because this is a closed client portal where telling
		   someone they typed the wrong address is worth more than the
		   enumeration it costs — the rate limiter on this route (10/min/IP) is
		   what keeps the cost of harvesting non-trivial.

		   Set AUTH_HIDE_UNKNOWN_EMAIL=1 to go back to the generic reply without
		   a code change. */
		if hideUnknownEmail() {
			log.Printf("[forgot-password] no active account for %q — returning generic reply", body.Email)
			OK(w, map[string]any{"success": true, "message": genericReply})
			return
		}
		log.Printf("[forgot-password] no active account for %q — telling the caller", body.Email)
		Fail(w, 404, "No account is registered with that email address.")
		return
	}
	accountType, targetID, name := acct.Type, acct.ID, acct.Name

	resetToken := randHex(32)                 // raw token — emailed to the user only
	storedToken := hashResetToken(resetToken) // SHA-256 hash — all that touches the DB
	// Scope the cleanup to the same account (type + id) so a client and a staff
	// account whose ids happen to collide don't clobber each other's tokens.
	db.Exec("DELETE FROM dcp_password_resets WHERE userId = ? AND account_type = ?", targetID, accountType)
	if _, _, err := db.Exec("INSERT INTO dcp_password_resets (userId, account_type, token, expires_at, used) VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 10 MINUTE), 0)", targetID, accountType, storedToken); err != nil {
		log.Printf("[forgot-password] insert token failed for %s id=%d: %v", accountType, targetID, err)
		Fail(w, 500, "Could not create reset token. Please try again.")
		return
	}

	go email.SendPasswordReset(body.Email, resetToken, name)

	OK(w, map[string]any{"success": true, "message": genericReply})
}

// ── POST /api/auth/verify-reset-otp ──────────────────────────────────────────

func VerifyResetOTP(w http.ResponseWriter, r *http.Request) {
	// alias: same as ForgotPassword confirmation step for some flows
	ForgotPassword(w, r)
}

// ── POST /api/auth/reset-password ─────────────────────────────────────────────

func ResetPassword(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ResetToken string `json:"resetToken"`
		Password   string `json:"password"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if body.ResetToken == "" {
		Fail(w, 400, "Reset token required")
		return
	}

	row, err := db.QueryOne("SELECT id, userId AS targetId, COALESCE(account_type, 'login') AS account_type, used, (expires_at > UTC_TIMESTAMP()) AS not_expired FROM dcp_password_resets WHERE token = ? LIMIT 1", hashResetToken(body.ResetToken))
	if err != nil {
		log.Printf("[reset-password] DB error looking up token: %v", err)
		Fail(w, 500, "Database error. Please try again.")
		return
	}
	if row == nil {
		log.Printf("[reset-password] token not found (len=%d)", len(body.ResetToken))
		Fail(w, 400, "Invalid or already-used reset token")
		return
	}
	if intFromAny(row["used"]) != 0 {
		Fail(w, 400, "Token already used")
		return
	}
	if intFromAny(row["not_expired"]) == 0 {
		Fail(w, 400, "Reset token has expired")
		return
	}
	if err := ValidatePassword(body.Password); err != nil {
		Fail(w, 422, err.Error())
		return
	}

	targetID := intFromAny(row["targetId"])
	accountType := strFromAny(row["account_type"])

	/* The history key is the identity the login authenticates on, which has to
	   be looked up from the token's target id — the token carries a row, and
	   for a client that row is one of several sharing a username.

	   Resolved BEFORE the write so the reuse check can run against it; a reset
	   is a password change like any other, and letting the forgotten-password
	   route around the rule would leave the rule enforced only where people
	   were not trying to get around it. */
	historyKey := passwordHistoryKey(accountType, targetID)
	if PasswordReused(historyAcctType(accountType), historyKey, body.Password) {
		Fail(w, 422, reusedPasswordMessage())
		return
	}

	hashed, err := ipauth.HashPassword(body.Password)
	if err != nil {
		Fail(w, 500, "Hash error")
		return
	}

	// Write the new hash to the table the token was issued against. If the write
	// fails, do NOT burn the token or report success — the user would be locked
	// into believing a password that was never stored.
	var uerr error
	switch accountType {
	case "super_admin":
		// Portal staff: their password lives in dcp_super_admin.password_hash.
		uerr = db.MustExec("UPDATE dcp_super_admin SET password_hash = ? WHERE id = ?", hashed, targetID)
	default: // "login"
		// Clients authenticate by USERNAME (login picks LIMIT 1 across all the
		// email's accounts), so write to EVERY active row sharing that username
		// — same as ChangePassword — otherwise the change lands on a row the
		// login query never reads.
		if lg, _ := db.QueryOne("SELECT login_username FROM dcp_user_login WHERE loginId = ? LIMIT 1", targetID); lg != nil && strFromAny(lg["login_username"]) != "" {
			uerr = db.MustExec("UPDATE dcp_user_login SET login_password = ? WHERE login_username = ? AND is_active = 1", hashed, strFromAny(lg["login_username"]))
		} else {
			uerr = db.MustExec("UPDATE dcp_user_login SET login_password = ? WHERE loginId = ?", hashed, targetID)
		}
	}
	if uerr != nil {
		Fail(w, 500, "Could not update your password. Please try again.")
		return
	}

	db.Exec("UPDATE dcp_password_resets SET used = 1 WHERE id = ?", intFromAny(row["id"]))
	RecordPasswordHistory(historyAcctType(accountType), historyKey, hashed)

	/* The clock restarts and the lockout clears, together.

	   This is the "instant recovery" half of the policy: somebody locked out for
	   24 hours who can still read their email does not have to wait it out. The
	   reset is proof of control of the mailbox, which is a stronger claim than
	   the one the lock was protecting against, so holding the lock afterwards
	   would punish the owner and nobody else. */
	if accountType == "super_admin" {
		StampPasswordChanged(AcctSuperAdmin, targetID)
	} else if lg, _ := db.QueryOne(
		"SELECT login_username FROM dcp_user_login WHERE loginId = ? LIMIT 1", targetID); lg != nil &&
		strFromAny(lg["login_username"]) != "" {
		StampPasswordChangedForUsername(strFromAny(lg["login_username"]))
	} else {
		StampPasswordChanged(AcctLogin, targetID)
	}

	go activity.Log(targetID, "password_reset", "auth/reset-password", activity.GetIP(r), activity.GetUA(r), map[string]any{"method": "reset_token", "accountType": accountType})

	OK(w, map[string]any{"success": true})
}

// ── POST /api/auth/register ───────────────────────────────────────────────────

func Register(w http.ResponseWriter, r *http.Request) {
	var body struct {
		FirstName   string `json:"first_name"`
		LastName    string `json:"last_name"`
		Email       string `json:"email"`
		Designation string `json:"designation"`
		Remarks     string `json:"remarks"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	fn := trimStr(body.FirstName)
	ln := trimStr(body.LastName)
	mail := trimStr(body.Email)
	if fn == "" || ln == "" || mail == "" {
		Fail(w, 400, "Please fill all required fields")
		return
	}

	/* An address that already HOLDS a login cannot register again, and this is
	   checked here as well as in the browser — a form check is a convenience,
	   not a control, and this endpoint is public.

	   It was missing entirely: a registration for an existing login was
	   accepted, queued, and only failed at the far end when an admin approved
	   it and the insert hit the unique username. The person waited days to be
	   told something knowable at submission. */
	if _, found := accountForEmail(mail); found {
		OK(w, map[string]any{
			"success": false,
			"error":   "An account already exists for this email. Sign in instead, or use Forgot password if you cannot get in.",
			"reason":  "account",
		})
		return
	}

	existing, _ := db.QueryOne("SELECT id FROM user_registration_requests WHERE email = ? AND status = 'pending' LIMIT 1", mail)
	if existing != nil {
		OK(w, map[string]any{
			"success": false,
			"error":   "A request for this email is already awaiting review. You will be emailed once it is approved.",
			"reason":  "pending",
		})
		return
	}

	_, _, err := db.Exec(`
		INSERT INTO user_registration_requests (first_name, last_name, email, designation, remarks, status, created_at)
		VALUES (?, ?, ?, ?, ?, 'pending', UTC_TIMESTAMP())`,
		fn, ln, mail, trimStr(body.Designation), trimStr(body.Remarks))
	if err != nil {
		Fail(w, 500, "Registration failed")
		return
	}
	go email.SendRegistrationReceivedApplicant(fn, ln, mail, trimStr(body.Designation))
	go email.SendRegistrationReceivedAdmin(fn, ln, mail, trimStr(body.Designation), trimStr(body.Remarks))
	OK(w, map[string]any{"success": true})
}

// ── GET/POST /api/auth/switch-account ─────────────────────────────────────────

func SwitchAccount(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	if claims == nil {
		Fail(w, 401, "Not authenticated")
		return
	}

	if r.Method == http.MethodGet {
		accounts, _ := db.Query(`
			SELECT l.userId, l.loginId, u.name AS client_name, u.email AS client_email,
			       (u.api_user_name IS NOT NULL AND u.api_user_name != '' AND u.api_password IS NOT NULL AND u.api_password != '') AS has_api
			FROM dcp_user_login l
			JOIN dcp_user u ON u.userId = l.userId
			WHERE l.login_username = ? AND l.is_active = 1 AND u.deleted = 0
			ORDER BY u.name ASC`, claims.LoginUsername)
		if accounts == nil {
			accounts = []map[string]any{}
		}
		OK(w, map[string]any{"success": true, "accounts": accounts, "currentLoginId": claims.LoginID})
		return
	}

	var body struct {
		LoginID int64 `json:"loginId"`
	}
	json.NewDecoder(r.Body).Decode(&body)

	row, _ := db.QueryOne(`
		SELECT l.loginId, l.userId, l.first_name, l.last_name, l.login_username, l.login_type,
		       l.is_client_admin,
		       u.name, u.email, u.role, u.IsSecure, u.api_user_name, u.api_password
		FROM dcp_user_login l
		INNER JOIN dcp_user u ON u.userId = l.userId
		WHERE l.loginId = ? AND l.login_username = ? AND l.is_active = 1 AND u.deleted = 0`,
		body.LoginID, claims.LoginUsername)
	if row == nil {
		Fail(w, 404, "Account not found or access denied")
		return
	}

	// Fetch fresh Markscan API token for the target account
	var apiTok string
	apiUser := strFromAny(row["api_user_name"])
	apiPass := strFromAny(row["api_password"])
	if apiUser != "" && apiPass != "" {
		apiTok, _ = markscan.Login(apiUser, apiPass)
	}
	userID := intFromAny(row["userId"])
	if apiTok != "" {
		markscan.SetCachedToken(userID, apiTok)
	}

	newClaims := buildClaims(row, apiTok)
	tok, _ := ipauth.SignToken(newClaims)
	SetTokenCookie(w, tok)
	OK(w, map[string]any{"success": true, "token": tok, "user": sanitizeClaims(newClaims)})
}

// ─────────────────────────────────────────────────────────────────────────────

func buildClaims(row map[string]any, apiToken string) ipauth.Claims {
	loginID := intFromAny(row["loginId"])
	userID := intFromAny(row["userId"])
	var role *int64
	if rv, ok := row["role"]; ok && rv != nil {
		r := intFromAny(rv)
		role = &r
	}
	return ipauth.Claims{
		LoginID:        loginID,
		UserID:         userID,
		Role:           role,
		LoginType:      intFromAny(row["login_type"]),
		LoginUsername:  strFromAny(row["login_username"]),
		LoginFirstName: strFromAny(row["first_name"]),
		LoginLastName:  strFromAny(row["last_name"]),
		ClientName:     strFromAny(row["name"]),
		APIAccess:      apiToken != "",
		ClientAdmin:    isClientAdminRow(row, loginID),
	}
}

// isClientAdminRow reads the Client Admin grant for the login being signed in.
// Every login query feeding buildClaims selects l.is_client_admin, but the
// column is re-read by loginId when a caller's row doesn't carry it — a login
// path that forgets the column must not silently mint a session with the grant
// resolved to false (or, worse, be assumed true).
func isClientAdminRow(row map[string]any, loginID int64) bool {
	if v, ok := row["is_client_admin"]; ok && v != nil {
		return flagOn(v)
	}
	if loginID == 0 {
		return false
	}
	r, _ := db.QueryOne("SELECT is_client_admin FROM dcp_user_login WHERE loginId = ? LIMIT 1", loginID)
	return r != nil && flagOn(r["is_client_admin"])
}

func sanitizeClaims(c ipauth.Claims) map[string]any {
	m := map[string]any{
		"loginId":        c.LoginID,
		"userId":         c.UserID,
		"loginType":      c.LoginType,
		"loginUsername":  c.LoginUsername,
		"loginFirstName": c.LoginFirstName,
		"loginLastName":  c.LoginLastName,
		"clientName":     c.ClientName,
		"apiAccess":      c.APIAccess,
		"clientAdmin":    c.ClientAdmin,
	}
	if c.Role != nil {
		m["role"] = *c.Role
	}
	if c.ImpersonatorLoginID != 0 {
		m["impersonating"] = true
		m["impersonatorName"] = c.ImpersonatorName
	}

	/* Password age travels with the session, so the banner is decided once by
	   the server and not by the page counting days of its own. It is attached
	   HERE rather than in the login response alone, because a session that has
	   been open across midnight has to start warning without being signed out
	   and back in — which for a portal people leave open all day is most of them.

	   Only when there is something to say. A password with three weeks left adds
	   nothing to every session poll. */
	if st := passwordStatusForClaims(c); st.Enabled && st.Warn {
		m["passwordExpiry"] = st
	}
	return m
}

/*
passwordStatusForClaims grades the signed-in account's password.

Staff and client logins are told apart the same way ChangePassword tells them
apart — a dcp_super_admin row for this email wins — because that is the table
their password actually lives in, and grading the wrong table would warn the
wrong person on the wrong schedule. LoginType cannot be used for this: a client
row uses login_type = 2 to mean "password login", which is not the same claim.
*/
func passwordStatusForClaims(c ipauth.Claims) PasswordStatus {
	if row, _ := db.QueryOne(
		"SELECT id FROM dcp_super_admin WHERE email = ? AND is_active = 1 LIMIT 1",
		c.LoginUsername); row != nil {
		return PasswordStatusForAccount(AcctSuperAdmin, intFromAny(row["id"]))
	}
	return PasswordStatusForAccount(AcctLogin, c.LoginID)
}

func trimStr(s string) string {
	start, end := 0, len(s)
	for start < end && (s[start] == ' ' || s[start] == '\t' || s[start] == '\n') {
		start++
	}
	for end > start && (s[end-1] == ' ' || s[end-1] == '\t' || s[end-1] == '\n') {
		end--
	}
	return s[start:end]
}
