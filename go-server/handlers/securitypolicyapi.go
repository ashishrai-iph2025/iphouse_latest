package handlers

// The security policy over HTTP: read it, change it, and ask where your own
// password stands.

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"

	"github.com/ip-house/iphouse-api/db"
)

/*
GET/PUT /api/admin/security-policy — Super Admin only.

Super Admin rather than a Configuration grant, because this is the one setting
that governs whether anybody can sign in at all. An admin who could set the
lockout threshold to zero has removed the lockout; one who could set the expiry
to a day has locked the building overnight.
*/
func SecurityPolicyConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		p := Policy()
		OK(w, map[string]any{
			"success": true,
			"policy": map[string]any{
				"passwordExpiryDays": p.PasswordExpiryDays,
				"warnDays":           FormatDayList(p.WarnDays),
				"emailWarnDays":      FormatDayList(p.EmailWarnDays),
				"maxFailedLogins":    p.MaxFailedLogins,
				"lockoutHours":       p.LockoutHours,
				"otpMaxAttempts":     p.OTPMaxAttempts,
				"otpLockoutHours":    p.OTPLockoutHours,
				"passwordMinLength":  p.PasswordMinLength,
				"passwordMinDigits":  p.PasswordMinDigits,
				"passwordMinUpper":   p.PasswordMinUpper,
				"passwordMinLower":   p.PasswordMinLower,
				"passwordMinSymbols": p.PasswordMinSymbols,
				"passwordHistory":    p.PasswordHistory,
			},
			// The same rules as sentences, so the screen can show an admin
			// exactly what a user will be told to do — rather than leaving them
			// to translate five numbers into an expectation.
			"requirements": PasswordRequirements(),
			// How many accounts are locked right now, so the screen can say so
			// and offer to release them rather than leaving it to be discovered
			// through a support call.
			"lockedNow": lockedAccountCount(),
		})
		return
	}

	var in struct {
		PasswordExpiryDays int    `json:"passwordExpiryDays"`
		WarnDays           string `json:"warnDays"`
		EmailWarnDays      string `json:"emailWarnDays"`
		MaxFailedLogins    int    `json:"maxFailedLogins"`
		LockoutHours       int    `json:"lockoutHours"`
		OTPMaxAttempts     int    `json:"otpMaxAttempts"`
		OTPLockoutHours    int    `json:"otpLockoutHours"`
		PasswordMinLength  int    `json:"passwordMinLength"`
		PasswordMinDigits  int    `json:"passwordMinDigits"`
		PasswordMinUpper   int    `json:"passwordMinUpper"`
		PasswordMinLower   int    `json:"passwordMinLower"`
		PasswordMinSymbols int    `json:"passwordMinSymbols"`
		PasswordHistory    int    `json:"passwordHistory"`
	}
	json.NewDecoder(r.Body).Decode(&in)

	p := SecurityPolicy{
		PasswordExpiryDays: in.PasswordExpiryDays,
		WarnDays:           ParseDayList(in.WarnDays),
		EmailWarnDays:      ParseDayList(in.EmailWarnDays),
		MaxFailedLogins:    in.MaxFailedLogins,
		LockoutHours:       in.LockoutHours,
		OTPMaxAttempts:     in.OTPMaxAttempts,
		OTPLockoutHours:    in.OTPLockoutHours,
		PasswordMinLength:  in.PasswordMinLength,
		PasswordMinDigits:  in.PasswordMinDigits,
		PasswordMinUpper:   in.PasswordMinUpper,
		PasswordMinLower:   in.PasswordMinLower,
		PasswordMinSymbols: in.PasswordMinSymbols,
		PasswordHistory:    in.PasswordHistory,
	}

	/* A lockout with no duration never lifts. The requirement is that an
	   account unlocks by itself, so this refuses the combination outright
	   rather than storing it and producing permanent locks that look like a
	   bug months later. */
	if p.MaxFailedLogins > 0 && p.LockoutHours <= 0 {
		Fail(w, 422, "A lockout needs a duration — set the lockout hours, or set max attempts to 0 to switch lockout off")
		return
	}
	if p.OTPMaxAttempts > 0 && p.OTPLockoutHours <= 0 {
		Fail(w, 422, "An OTP lockout needs a duration — set the OTP lockout hours, or set OTP max attempts to 0 to switch it off")
		return
	}
	/* The character classes have to FIT in the length.

	   Asking for 12 characters of which 6 digits, 6 capitals and 6 symbols is
	   a policy no password can satisfy, and it would present itself as every
	   password change failing rather than as a settings mistake. Checked
	   against the clamped floor so the message quotes the length that will
	   actually be stored. */
	minLen := clampInt(p.PasswordMinLength, 4, 72)
	if need := p.PasswordMinDigits + p.PasswordMinUpper + p.PasswordMinLower + p.PasswordMinSymbols; need > minLen {
		Fail(w, 422, fmt.Sprintf(
			"Those character rules need at least %d characters, but the minimum length is %d — raise the length or lower the requirements",
			need, minLen))
		return
	}

	// A warning threshold longer than the period itself would fire on the day
	// the password was set, every period, for everybody.
	if p.PasswordExpiryDays > 0 {
		for _, d := range append(append([]int{}, p.WarnDays...), p.EmailWarnDays...) {
			if d >= p.PasswordExpiryDays {
				Fail(w, 422, "A warning day must be fewer than the expiry days — otherwise it fires the moment a password is set")
				return
			}
		}
	}

	who := ""
	if c := ClaimsFrom(r); c != nil {
		who = c.LoginUsername
	}
	if err := SavePolicy(p, who); err != nil {
		Fail(w, 500, err.Error())
		return
	}
	OK(w, map[string]any{"success": true})
}

// lockedAccountCount is how many accounts are serving a lock right now.
func lockedAccountCount() int64 {
	ensureSecurityPolicySchema()
	row, err := db.QueryOne(
		"SELECT COUNT(*) AS c FROM " + lockoutTable + " WHERE locked_until IS NOT NULL AND locked_until > UTC_TIMESTAMP()")
	if err != nil || row == nil {
		return 0
	}
	return numOf(row["c"])
}

/*
GET /api/admin/security-policy/locked — who is locked, and why.

Listed rather than only counted because the first question after "two accounts
are locked" is always "which", and the answer decides whether it is one person
who mistyped or somebody working through the user list.
*/
func SecurityPolicyLocked(w http.ResponseWriter, r *http.Request) {
	ensureSecurityPolicySchema()
	rows, _ := db.Query(`
		SELECT k.account_type, k.account_id, k.kind, k.fail_count, k.locked_until,
		       COALESCE(l.login_username, s.email, '')             AS email,
		       COALESCE(NULLIF(TRIM(CONCAT(l.first_name, ' ', l.last_name)), ''), s.name, '') AS name
		  FROM ` + lockoutTable + ` k
		  LEFT JOIN dcp_user_login  l ON k.account_type = 'login'       AND l.loginId = k.account_id
		  LEFT JOIN dcp_super_admin s ON k.account_type = 'super_admin' AND s.id      = k.account_id
		 WHERE k.locked_until IS NOT NULL AND k.locked_until > UTC_TIMESTAMP()
		 ORDER BY k.locked_until DESC`)

	out := make([]map[string]any, 0, len(rows))
	for _, r := range rows {
		out = append(out, map[string]any{
			"accountType": strFromAny(r["account_type"]),
			"accountId":   intFromAny(r["account_id"]),
			"kind":        strFromAny(r["kind"]),
			"failCount":   numOf(r["fail_count"]),
			"lockedUntil": strFromAny(r["locked_until"]),
			"email":       strFromAny(r["email"]),
			"name":        strFromAny(r["name"]),
		})
	}
	OK(w, map[string]any{"success": true, "locked": out})
}

/*
POST /api/admin/security-policy/unlock — release one account now.

The manual counterpart to the reset flow. A locked user who cannot reach their
email has no self-service route at all, and "wait 24 hours" is not an answer
somebody will accept for an account they need in the next ten minutes.
*/
func SecurityPolicyUnlock(w http.ResponseWriter, r *http.Request) {
	var in struct {
		AccountType string `json:"accountType"`
		AccountID   int64  `json:"accountId"`
	}
	json.NewDecoder(r.Body).Decode(&in)

	t := strings.TrimSpace(in.AccountType)
	if (t != AcctLogin && t != AcctSuperAdmin) || in.AccountID == 0 {
		Fail(w, 422, "An account type and id are required")
		return
	}
	ClearFailures(t, in.AccountID)
	who := ""
	if c := ClaimsFrom(r); c != nil {
		who = c.LoginUsername
	}
	log.Printf("[lockout] %s %d released early by %s", t, in.AccountID, who)
	OK(w, map[string]any{"success": true})
}

/*
POST /api/admin/security-policy/send-warnings — run the expiry sweep now.

The sweep is hourly and idempotent, so this changes nothing about what is sent;
it exists so that somebody who has just changed the thresholds can see the
effect immediately rather than believing the feature is broken for an hour.
*/
func SecurityPolicySendWarnings(w http.ResponseWriter, r *http.Request) {
	sent := SendExpiryWarnings()
	OK(w, map[string]any{"success": true, "sent": sent})
}

/*
GET /api/auth/password-status — where the signed-in account's password stands.

Its own endpoint as well as a field on the session, because the banner has an
action that changes the answer: after Change password succeeds, the page needs
to re-ask without signing out and back in to refresh a token.
*/
func PasswordStatus_(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	if claims == nil {
		Fail(w, 401, "Not authenticated")
		return
	}
	st := passwordStatusForClaims(*claims)
	OK(w, map[string]any{"success": true, "passwordExpiry": st})
}
