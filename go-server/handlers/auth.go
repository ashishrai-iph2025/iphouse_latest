package handlers

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"

	ipauth "github.com/ip-house/iphouse-api/auth"
	"github.com/ip-house/iphouse-api/activity"
	"github.com/ip-house/iphouse-api/config"
	"github.com/ip-house/iphouse-api/db"
	"github.com/ip-house/iphouse-api/email"
	"github.com/ip-house/iphouse-api/markscan"
)

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
		SELECT id, name, email, password_hash, is_active, role, userId, loginId
		FROM dcp_super_admin WHERE email = ? AND is_active = 1 LIMIT 1`, email)
	return row
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
		Fail(w, 400, "Missing credentials"); return
	}

	// Portal-staff check (Admin or Super Admin — unified in dcp_super_admin)
	if sa := superAdminByEmail(body.Username); sa != nil {
		hash, _ := sa["password_hash"].(string)
		if !ipauth.VerifyPassword(body.Password, hash) {
			OK(w, map[string]any{"success": false, "error": "Invalid username or password"}); return
		}
		upgradeLegacyHash(body.Password, hash, "UPDATE dcp_super_admin SET password_hash = ? WHERE id = ?", intFromAny(sa["id"]))
		claims := claimsForSuperAdminRow(sa)
		OK(w, map[string]any{
			"success": true, "userId": claims.UserID,
			"email": sa["email"], "login_type": 2, "role": *claims.Role,
			"multipleLogins": false, "rows": []any{},
		}); return
	}

	// Regular login
	row, _ := db.QueryOne(`
		SELECT l.loginId, l.userId, l.login_password, l.login_type, l.is_active, u.name, u.role
		FROM dcp_user_login l
		INNER JOIN dcp_user u ON u.userId = l.userId
		WHERE l.login_username = ? AND l.is_active = 1 AND u.deleted = 0 LIMIT 1`, body.Username)
	if row == nil {
		OK(w, map[string]any{"success": false, "error": "Invalid username or password"}); return
	}
	hash, _ := row["login_password"].(string)
	if !ipauth.VerifyPassword(body.Password, hash) {
		OK(w, map[string]any{"success": false, "error": "Invalid username or password"}); return
	}
	upgradeLegacyHash(body.Password, hash, "UPDATE dcp_user_login SET login_password = ? WHERE loginId = ?", intFromAny(row["loginId"]))

	// Multiple logins sharing same username
	multiRows, _ := db.Query(`
		SELECT l.loginId, l.login_username, l.userId, u.name AS account_name,
		       (u.api_user_name IS NOT NULL AND u.api_user_name != '' AND u.api_password IS NOT NULL AND u.api_password != '') AS has_api
		FROM dcp_user_login l
		INNER JOIN dcp_user u ON u.userId = l.userId
		WHERE l.login_username = ? AND l.is_active = 1 AND u.deleted = 0`, body.Username)

	resp := map[string]any{
		"success": true, "userId": intFromAny(row["userId"]),
		"email": body.Username, "login_type": intFromAny(row["login_type"]),
		"role": row["role"], "multipleLogins": len(multiRows) > 1, "rows": multiRows,
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

	// Portal-staff accounts (Admin/Super Admin) live in dcp_super_admin and use
	// their own OTP storage, checked first (matches Login's precedence: a
	// dcp_super_admin email always wins over a same-address client login).
	if body.Email != "" {
		if sa := superAdminByEmail(body.Email); sa != nil {
			digits := genOTPDigits()
			db.Exec("UPDATE dcp_super_admin SET twofa_code = ?, twofa_code_expires = DATE_ADD(NOW(), INTERVAL 10 MINUTE) WHERE id = ?", digits, sa["id"])
			name := strFromAny(sa["name"])
			if name == "" {
				name = body.Email
			}
			if err := email.SendOTP(body.Email, digits, name); err != nil {
				log.Printf("[send-otp] failed to email %s (portal staff): %v", body.Email, err)
				Fail(w, 502, "Could not send the verification email. Please check email settings or try again.")
				return
			}
			log.Printf("[send-otp] OTP sent to %s (portal staff id=%d)", body.Email, intFromAny(sa["id"]))
			OK(w, map[string]any{"success": true, "userId": intFromAny(sa["id"])})
			return
		}
	}

	// Email-based resolution always wins so send/verify target the same row.
	body.UserID = otpUserID(body.Email, body.UserID)
	if body.UserID == 0 {
		Fail(w, 400, "userId or email required"); return
	}

	user, err := db.QueryOne("SELECT userId, name FROM dcp_user WHERE userId = ? LIMIT 1", body.UserID)
	if err != nil || user == nil {
		Fail(w, 404, "User not found"); return
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
			Fail(w, 404, "Login not found"); return
		}
		recipient = strFromAny(loginRow["login_username"])
		loginName = strings.TrimSpace(strFromAny(loginRow["first_name"]) + " " + strFromAny(loginRow["last_name"]))
	}

	digits := genOTPDigits()

	// Use MySQL's own clock for the expiry so verification is timezone-agnostic
	// (the driver uses loc=Asia/Kolkata; mixing Go UTC strings caused false expiries).
	db.Exec("UPDATE dcp_user SET twofa_code = ?, twofa_code_expires = DATE_ADD(NOW(), INTERVAL 10 MINUTE) WHERE userId = ?", digits, body.UserID)

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

// ── POST /api/auth/verify-otp ─────────────────────────────────────────────────

func VerifyOTP(w http.ResponseWriter, r *http.Request) {
	var body struct {
		UserID int64  `json:"userId"`
		Email  string `json:"email"`
		Code   string `json:"code"`
	}
	json.NewDecoder(r.Body).Decode(&body)

	// Portal-staff accounts verify against dcp_super_admin's own OTP columns.
	// Unlike the client flow below (which needs an extra account-selection
	// step), an email in dcp_super_admin maps 1:1 to a login, so a correct
	// code signs the JWT and finishes the login right here.
	if body.Email != "" {
		if sa := superAdminByEmail(body.Email); sa != nil {
			exp, _ := db.QueryOne(`
				SELECT twofa_code, (twofa_code_expires IS NOT NULL AND twofa_code_expires > NOW()) AS not_expired
				FROM dcp_super_admin WHERE id = ? LIMIT 1`, sa["id"])
			storedCode := ""
			notExpired := int64(0)
			if exp != nil {
				storedCode = strFromAny(exp["twofa_code"])
				notExpired = intFromAny(exp["not_expired"])
			}
			if body.Code == "" || storedCode == "" {
				OK(w, map[string]any{"success": false, "error": "No active code"}); return
			}
			if storedCode != body.Code {
				OK(w, map[string]any{"success": false, "error": "Incorrect code"}); return
			}
			if notExpired == 0 {
				OK(w, map[string]any{"success": false, "error": "Code has expired"}); return
			}
			id := intFromAny(sa["id"])
			db.Exec("UPDATE dcp_super_admin SET twofa_code = NULL, twofa_code_expires = NULL WHERE id = ?", id)

			claims := claimsForSuperAdminRow(sa)
			tok, err := ipauth.SignToken(claims)
			if err != nil {
				Fail(w, 500, "Token error"); return
			}
			go db.Exec("UPDATE dcp_super_admin SET last_login = NOW() WHERE id = ?", id)
			go db.Exec("INSERT INTO dcp_login (userId, loginId, loginTime) VALUES (?, ?, NOW())", claims.UserID, claims.LoginID)
			go activity.Log(claims.LoginID, "login", "auth/verify-otp", activity.GetIP(r), activity.GetUA(r), map[string]any{"method": "otp"})
			SetTokenCookie(w, tok)
			OK(w, map[string]any{"success": true, "authenticated": true, "token": tok, "user": sanitizeClaims(claims)})
			return
		}
	}

	// Resolve the same canonical userId the OTP was stored against.
	body.UserID = otpUserID(body.Email, body.UserID)
	if body.UserID == 0 || body.Code == "" {
		Fail(w, 400, "Missing parameters"); return
	}

	// Compute the expiry check in SQL using MySQL's clock — avoids any Go/driver
	// timezone mismatch (loc=Asia/Kolkata) that previously caused false expiries.
	user, _ := db.QueryOne("SELECT userId, twofa_code, (twofa_code_expires IS NOT NULL AND twofa_code_expires > NOW()) AS not_expired FROM dcp_user WHERE userId = ? LIMIT 1", body.UserID)
	if user == nil {
		OK(w, map[string]any{"success": false, "error": "User not found"}); return
	}
	storedCode := strFromAny(user["twofa_code"])
	if storedCode == "" {
		OK(w, map[string]any{"success": false, "error": "No active code"}); return
	}
	if storedCode != body.Code {
		OK(w, map[string]any{"success": false, "error": "Incorrect code"}); return
	}
	if intFromAny(user["not_expired"]) == 0 {
		OK(w, map[string]any{"success": false, "error": "Code has expired"}); return
	}

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
		Fail(w, 404, "Login record not found"); return
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
		Fail(w, 401, "Invalid or expired token"); return
	}
	if time.Now().After(entry.Exp) {
		log.Printf("[select-login] token expired (exp=%s now=%s) user=%q", entry.Exp.Format(time.RFC3339), time.Now().Format(time.RFC3339), body.Username)
		Fail(w, 401, "Invalid or expired token"); return
	}
	if entry.Username != body.Username {
		log.Printf("[select-login] username mismatch: token=%q request=%q", entry.Username, body.Username)
		Fail(w, 401, "Invalid or expired token"); return
	}
	// If loginID is set on the token (OTP flow), it must match the request.
	if entry.LoginID != 0 && entry.LoginID != body.LoginID {
		log.Printf("[select-login] loginID mismatch: token=%d request=%d", entry.LoginID, body.LoginID)
		Fail(w, 401, "Invalid or expired token"); return
	}
	deleteTempToken(body.Password)

	row, _ := db.QueryOne(`
		SELECT l.loginId, l.userId, l.first_name, l.last_name, l.login_username, l.login_type,
		       u.name, u.email, u.role, u.IsSecure, u.api_user_name, u.api_password
		FROM dcp_user_login l
		INNER JOIN dcp_user u ON u.userId = l.userId
		WHERE l.loginId = ? AND l.login_username = ? AND l.is_active = 1 AND u.deleted = 0`,
		body.LoginID, body.Username)
	if row == nil {
		Fail(w, 401, "User not found"); return
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

	go db.Exec("INSERT INTO dcp_login (userId, loginId, loginTime) VALUES (?, ?, NOW())", userID, loginID)
	go db.Exec("UPDATE dcp_user_login SET last_seen_at = NOW() WHERE loginId = ?", loginID)
	go activity.Log(loginID, "login", "auth/login", ip, ua, map[string]any{"method": "select"})

	if apiTok != "" {
		markscan.SetCachedToken(userID, apiTok)
	}

	claims := buildClaims(row, apiTok)
	tok, err := ipauth.SignToken(claims)
	if err != nil {
		Fail(w, 500, "Token error"); return
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
			Fail(w, 401, "Invalid or expired token"); return
		}
		deleteTempToken(body.TempTok)

		row, _ := db.QueryOne(`
			SELECT l.loginId, l.userId, l.first_name, l.last_name, l.login_username, l.login_type,
			       u.name, u.email, u.role, u.IsSecure, u.api_user_name, u.api_password
			FROM dcp_user_login l
			INNER JOIN dcp_user u ON u.userId = l.userId
			WHERE l.loginId = ? AND l.is_active = 1 AND u.deleted = 0`, body.LoginID)
		if row == nil {
			Fail(w, 401, "User not found"); return
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

		go db.Exec("INSERT INTO dcp_login (userId, loginId, loginTime) VALUES (?, ?, NOW())", userID, loginID)
		go db.Exec("UPDATE dcp_user_login SET last_seen_at = NOW() WHERE loginId = ?", loginID)
		go activity.Log(loginID, "login", "auth/login", ip, ua, map[string]any{"method": "select"})

		claims := buildClaims(row, apiTok)
		tok, _ := ipauth.SignToken(claims)
		SetTokenCookie(w, tok)
		OK(w, map[string]any{"success": true, "token": tok, "user": sanitizeClaims(claims)})
		return
	}

	if body.Username == "" || body.Password == "" {
		Fail(w, 400, "Missing credentials"); return
	}

	// Portal-staff login (Admin or Super Admin — unified in dcp_super_admin)
	if sa := superAdminByEmail(body.Username); sa != nil {
		hash, _ := sa["password_hash"].(string)
		if !ipauth.VerifyPassword(body.Password, hash) {
			Fail(w, 401, "Invalid credentials"); return
		}
		id := intFromAny(sa["id"])
		upgradeLegacyHash(body.Password, hash, "UPDATE dcp_super_admin SET password_hash = ? WHERE id = ?", id)
		claims := claimsForSuperAdminRow(sa)
		go db.Exec("UPDATE dcp_super_admin SET last_login = NOW() WHERE id = ?", id)
		go db.Exec("INSERT INTO dcp_login (userId, loginId, loginTime) VALUES (?, ?, NOW())", claims.UserID, claims.LoginID)
		go activity.Log(claims.LoginID, "login", "auth/login", activity.GetIP(r), activity.GetUA(r), map[string]any{"method": "password"})
		tok, _ := ipauth.SignToken(claims)
		SetTokenCookie(w, tok)
		OK(w, map[string]any{"success": true, "token": tok, "user": sanitizeClaims(claims)})
		return
	}

	// Regular user
	row, _ := db.QueryOne(`
		SELECT l.loginId, l.userId, l.first_name, l.last_name, l.login_username, l.login_type,
		       l.login_password, u.name, u.email, u.role, u.IsSecure, u.api_user_name, u.api_password
		FROM dcp_user_login l
		INNER JOIN dcp_user u ON u.userId = l.userId
		WHERE l.login_username = ? AND l.is_active = 1 AND u.deleted = 0 LIMIT 1`, body.Username)
	if row == nil {
		Fail(w, 401, "Invalid credentials"); return
	}
	hash, _ := row["login_password"].(string)
	if !ipauth.VerifyPassword(body.Password, hash) {
		Fail(w, 401, "Invalid credentials"); return
	}
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
	go db.Exec("INSERT INTO dcp_login (userId, loginId, loginTime) VALUES (?, ?, NOW())", userID, loginID)
	go db.Exec("UPDATE dcp_user_login SET last_seen_at = NOW() WHERE loginId = ?", loginID)
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
		Fail(w, 401, "Not authenticated"); return
	}
	OK(w, map[string]any{"success": true, "user": sanitizeClaims(*claims)})
}

// ── POST /api/auth/forgot-password ───────────────────────────────────────────

func ForgotPassword(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email string `json:"email"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if body.Email == "" {
		Fail(w, 400, "Email is required"); return
	}

	user, _ := db.QueryOne("SELECT loginId, login_username, first_name, last_name FROM dcp_user_login WHERE login_username = ? AND is_active = 1 LIMIT 1", body.Email)
	if user == nil {
		Fail(w, 404, "No active account found with this email address"); return
	}

	resetToken := randHex(32)        // raw token — emailed to the user only
	storedToken := hashResetToken(resetToken) // SHA-256 hash — all that touches the DB
	loginID := intFromAny(user["loginId"])
	db.Exec("DELETE FROM dcp_password_resets WHERE userId = ?", loginID)
	if _, _, err := db.Exec("INSERT INTO dcp_password_resets (userId, token, expires_at, used) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE), 0)", loginID, storedToken); err != nil {
		log.Printf("[forgot-password] insert token failed for loginId=%d: %v", loginID, err)
		Fail(w, 500, "Could not create reset token. Please try again."); return
	}

	fn, _ := user["first_name"].(string)
	ln, _ := user["last_name"].(string)
	name := fn
	if ln != "" {
		name += " " + ln
	}
	if name == "" {
		name, _ = user["login_username"].(string)
	}
	go email.SendPasswordReset(body.Email, resetToken, name)

	OK(w, map[string]any{"success": true})
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
		Fail(w, 400, "Reset token required"); return
	}

	row, err := db.QueryOne("SELECT id, userId AS loginId, used, (expires_at > NOW()) AS not_expired FROM dcp_password_resets WHERE token = ? LIMIT 1", hashResetToken(body.ResetToken))
	if err != nil {
		log.Printf("[reset-password] DB error looking up token: %v", err)
		Fail(w, 500, "Database error. Please try again."); return
	}
	if row == nil {
		log.Printf("[reset-password] token not found (len=%d)", len(body.ResetToken))
		Fail(w, 400, "Invalid or already-used reset token"); return
	}
	if intFromAny(row["used"]) != 0 {
		Fail(w, 400, "Token already used"); return
	}
	if intFromAny(row["not_expired"]) == 0 {
		Fail(w, 400, "Reset token has expired"); return
	}
	if len(body.Password) < 8 {
		Fail(w, 422, "Password must be at least 8 characters"); return
	}

	hashed, err := ipauth.HashPassword(body.Password)
	if err != nil {
		Fail(w, 500, "Hash error"); return
	}
	loginID := intFromAny(row["loginId"])
	db.Exec("UPDATE dcp_user_login SET login_password = ? WHERE loginId = ?", hashed, loginID)
	db.Exec("UPDATE dcp_password_resets SET used = 1 WHERE id = ?", intFromAny(row["id"]))
	go activity.Log(loginID, "password_reset", "auth/reset-password", activity.GetIP(r), activity.GetUA(r), map[string]any{"method": "reset_token"})

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
		Fail(w, 400, "Please fill all required fields"); return
	}

	existing, _ := db.QueryOne("SELECT id FROM user_registration_requests WHERE email = ? AND status = 'pending' LIMIT 1", mail)
	if existing != nil {
		OK(w, map[string]any{"success": false, "error": "A pending request with this email already exists"}); return
	}

	_, _, err := db.Exec(`
		INSERT INTO user_registration_requests (first_name, last_name, email, designation, remarks, status, created_at)
		VALUES (?, ?, ?, ?, ?, 'pending', NOW())`,
		fn, ln, mail, trimStr(body.Designation), trimStr(body.Remarks))
	if err != nil {
		Fail(w, 500, "Registration failed"); return
	}
	go email.SendRegistrationReceivedApplicant(fn, ln, mail, trimStr(body.Designation))
	go email.SendRegistrationReceivedAdmin(fn, ln, mail, trimStr(body.Designation), trimStr(body.Remarks))
	OK(w, map[string]any{"success": true})
}

// ── GET/POST /api/auth/switch-account ─────────────────────────────────────────

func SwitchAccount(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	if claims == nil {
		Fail(w, 401, "Not authenticated"); return
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
		       u.name, u.email, u.role, u.IsSecure, u.api_user_name, u.api_password
		FROM dcp_user_login l
		INNER JOIN dcp_user u ON u.userId = l.userId
		WHERE l.loginId = ? AND l.login_username = ? AND l.is_active = 1 AND u.deleted = 0`,
		body.LoginID, claims.LoginUsername)
	if row == nil {
		Fail(w, 404, "Account not found or access denied"); return
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
	}
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
	}
	if c.Role != nil {
		m["role"] = *c.Role
	}
	return m
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
