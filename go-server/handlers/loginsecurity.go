package handlers

// Everything the security policy currently says about ONE login account.
//
// Assembled for the editor on /admin/registrations, which is where somebody
// goes when a person says "I can't get in". Three questions get asked in that
// order — when does their password expire, were they told, and are they locked
// — and answering them used to mean three tables and a Super Admin. Here they
// are one request, read-only, for anyone who can already administer the account.
//
// Read-only on purpose. Nothing on this endpoint changes a password, a lock or
// a policy: those all have their own routes with their own gates, and an
// information panel that quietly also acts is how an accidental unlock happens.

import (
	"net/http"
	"strings"
	"time"

	"github.com/ip-house/iphouse-api/db"
)

/*
GET /api/admin/login-security?loginId=N

Keyed by loginId rather than by username because that is what the editor has in
hand. The password itself is shared across every active row with the same
username — the login query matches on username — so the dates are read from the
row the caller named and the sibling rows are reported alongside rather than
hidden: an account whose password reads as unchanged is nearly always one whose
siblings were stamped and it was not.
*/
func LoginSecurityDetail(w http.ResponseWriter, r *http.Request) {
	loginID := int64(0)
	if v := strings.TrimSpace(r.URL.Query().Get("loginId")); v != "" {
		loginID = parseInt64(v)
	}
	if loginID == 0 {
		Fail(w, 422, "A loginId is required")
		return
	}
	ensureSecurityPolicySchema()

	/* SELECT *, not a column list.

	   dcp_user_login has grown columns at different times and not every install
	   has all of them — `last_seen_at` is written by the login path with its
	   error ignored, so it exists on some databases and not others. Naming it
	   here made the whole statement fail on the ones without it, QueryOne
	   returned no row, and this replied "No such login" about an account that
	   was sitting right there. Reading the row and picking fields out of it
	   cannot fail that way; a column that is absent is simply absent. */
	row, err := db.QueryOne("SELECT * FROM dcp_user_login WHERE loginId = ? LIMIT 1", loginID)
	if err != nil {
		// Reported as what it is. The previous 404 sent people looking for a
		// deleted account instead of at the error.
		Fail(w, 500, "Could not read this login: "+err.Error())
		return
	}
	if row == nil {
		Fail(w, 404, "No such login")
		return
	}
	username := strFromAny(row["login_username"])

	p := Policy()
	out := map[string]any{
		"success":  true,
		"loginId":  loginID,
		"username": username,
		"policy": map[string]any{
			"enabled":            p.PasswordExpiryDays > 0,
			"passwordExpiryDays": p.PasswordExpiryDays,
			"warnDays":           p.WarnDays,
			"emailWarnDays":      p.EmailWarnDays,
			"maxFailedLogins":    p.MaxFailedLogins,
			"lockoutHours":       p.LockoutHours,
			"otpMaxAttempts":     p.OTPMaxAttempts,
			"otpLockoutHours":    p.OTPLockoutHours,
		},
		"accountCreated": dbTimeString(row["created_at"]),
		"lastSeen":       dbTimeString(row["last_seen_at"]),
	}

	/* ── The password's own dates ──────────────────────────────────────────
	   Reported even when expiry is switched off: "last changed" is a useful
	   fact about an account whatever the policy is doing, and a panel that goes
	   blank when a policy is disabled reads as a panel that is broken. */
	changed, hasChanged := parseDBTime(row["password_changed_at"])
	out["passwordChangedAt"] = dbTimeString(row["password_changed_at"])
	out["passwordNeverStamped"] = !hasChanged

	st := PasswordStatus{Enabled: false}
	if hasChanged {
		st = passwordStatusFor(changed, p)
		out["passwordAgeDays"] = int(time.Since(changed).Hours() / 24)
	}
	out["expiry"] = st

	/* ── Which warnings actually went out ──────────────────────────────────
	   The question behind "was the notification sent" is almost always "did we
	   tell them before it happened", so each row carries the threshold it was
	   for AND the expiry it was about — a notice from the previous period is
	   not evidence about this one. */
	notices, _ := db.Query(`
		SELECT expires_on, warn_day, sent_at FROM `+passwordNoticeTable+`
		 WHERE account_type = ? AND account_id = ?
		 ORDER BY expires_on DESC, warn_day DESC`, AcctLogin, loginID)
	sent := make([]map[string]any, 0, len(notices))
	for _, n := range notices {
		sent = append(sent, map[string]any{
			"expiresOn": dbDateString(n["expires_on"]),
			"warnDay":   numOf(n["warn_day"]),
			"sentAt":    dbTimeString(n["sent_at"]),
		})
	}
	out["noticesSent"] = sent

	/* Which warnings are still to come for THIS period, so the panel can say
	   "2 days: sent 14 Aug · 1 day: due 16 Aug" rather than only listing what
	   has happened and leaving the rest to be inferred. */
	pending := []map[string]any{}
	if st.Enabled && !st.Expired {
		already := map[int]bool{}
		for _, n := range sent {
			if strFromAny(n["expiresOn"]) == st.ExpiresOn {
				already[int(numOf(n["warnDay"]))] = true
			}
		}
		for _, d := range p.EmailWarnDays {
			if already[d] || d > st.DaysRemaining {
				continue
			}
			pending = append(pending, map[string]any{
				"warnDay": d,
				"dueOn":   truncateDay(time.Now().UTC()).AddDate(0, 0, st.DaysRemaining-d).Format("2006-01-02"),
			})
		}
	}
	out["noticesPending"] = pending

	/* ── Locks ─────────────────────────────────────────────────────────────
	   Both kinds, and the ones that have EXPIRED as well as the ones in force:
	   "locked twice last week and it lifted by itself" is the answer to a
	   different question from "locked now", and the panel is read by someone
	   who does not yet know which they are asking. */
	locks, _ := db.Query(`
		SELECT kind, fail_count, locked_until, last_fail_at,
		       (locked_until IS NOT NULL AND locked_until > UTC_TIMESTAMP()) AS active
		  FROM `+lockoutTable+`
		 WHERE account_type = ? AND account_id = ?`, AcctLogin, loginID)
	lockOut := make([]map[string]any, 0, len(locks))
	anyActive := false
	for _, l := range locks {
		active := numOf(l["active"]) == 1
		anyActive = anyActive || active
		lockOut = append(lockOut, map[string]any{
			"kind":        strFromAny(l["kind"]),
			"failCount":   numOf(l["fail_count"]),
			"lockedUntil": dbTimeString(l["locked_until"]),
			"lastFailAt":  dbTimeString(l["last_fail_at"]),
			"active":      active,
		})
	}
	out["locks"] = lockOut
	out["locked"] = anyActive

	/* ── The sibling rows ──────────────────────────────────────────────────
	   One person, one password, possibly several login rows. Listed with their
	   own stamps so a mismatch is visible rather than being the invisible cause
	   of a warning nobody can explain. */
	if username != "" {
		sib, _ := db.Query(`
			SELECT loginId, password_changed_at FROM dcp_user_login
			 WHERE login_username = ? AND is_active = 1 ORDER BY loginId`, username)
		rows := make([]map[string]any, 0, len(sib))
		mismatch := false
		for _, s := range sib {
			stamp := dbTimeString(s["password_changed_at"])
			if stamp != out["passwordChangedAt"] {
				mismatch = true
			}
			rows = append(rows, map[string]any{
				"loginId":           intFromAny(s["loginId"]),
				"passwordChangedAt": stamp,
			})
		}
		out["siblingLogins"] = rows
		out["siblingMismatch"] = mismatch && len(rows) > 1
	}

	OK(w, out)
}

// dbTimeString renders a DATETIME for display, or "" when it is absent. The
// page formats it; this only has to be unambiguous and parseable.
func dbTimeString(v any) string {
	t, ok := parseDBTime(v)
	if !ok {
		return ""
	}
	return t.Format("2006-01-02 15:04:05")
}

func dbDateString(v any) string {
	t, ok := parseDBTime(v)
	if !ok {
		return ""
	}
	return t.Format("2006-01-02")
}

func parseInt64(s string) int64 {
	var n int64
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0
		}
		n = n*10 + int64(c-'0')
	}
	return n
}
