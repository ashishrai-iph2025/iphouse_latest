package handlers

// When a password expires, who needs telling, and how they are told.
//
// The rule is one subtraction — password_changed_at plus the policy's days,
// against today — and everything here exists so that the same subtraction is
// used by the banner, the email sweep and the login check. Three copies of it
// would be three chances to disagree about whether a password expiring at
// midnight expires today or tomorrow, and the person reading the banner would
// be the one to find out.

import (
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/ip-house/iphouse-api/db"
	"github.com/ip-house/iphouse-api/email"
)

const passwordNoticeTable = "dcp_password_notice"

// PasswordStatus is everything the page needs to decide what to show.
type PasswordStatus struct {
	// False when expiry is switched off entirely, in which case nothing else
	// here is meaningful and the page shows nothing.
	Enabled bool `json:"enabled"`
	// Whole days until it expires. Negative once it has.
	DaysRemaining int `json:"daysRemaining"`
	// The date it expires, YYYY-MM-DD, for the message.
	ExpiresOn string `json:"expiresOn"`
	Expired   bool   `json:"expired"`
	// True when the reader is inside one of the warning thresholds — the single
	// flag the page keys the banner off, so the thresholds live in one place.
	Warn bool `json:"warn"`
}

/*
passwordStatusFor turns a change date into a status.

Measured in whole DAYS from midnight to midnight, not in elapsed hours. A
password changed at 4pm thirty days ago should read "expires today" all day,
not "expires in 0 days" until 4pm and "expired" after — the reader's mental
model is a date on a calendar, and an hours-based countdown crosses its
thresholds in the middle of the afternoon.
*/
func passwordStatusFor(changedAt time.Time, p SecurityPolicy) PasswordStatus {
	if p.PasswordExpiryDays <= 0 || changedAt.IsZero() {
		return PasswordStatus{Enabled: false}
	}
	expires := changedAt.UTC().AddDate(0, 0, p.PasswordExpiryDays)

	today := truncateDay(time.Now().UTC())
	expiryDay := truncateDay(expires)
	days := int(expiryDay.Sub(today).Hours() / 24)

	st := PasswordStatus{
		Enabled:       true,
		DaysRemaining: days,
		ExpiresOn:     expiryDay.Format("2006-01-02"),
		Expired:       days <= 0,
	}
	for _, w := range p.WarnDays {
		if days <= w {
			st.Warn = true
			break
		}
	}
	// An expired password is always worth saying, whatever the thresholds are.
	if st.Expired {
		st.Warn = true
	}
	return st
}

func truncateDay(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
}

/*
PasswordStatusForAccount reads the change date for one account and grades it.

Staff and client logins live in different tables, so the caller says which. An
account with no recorded change date is treated as NOT expiring rather than as
expiring immediately — the column is backfilled on upgrade, so a NULL here means
a row written by something that did not know about the column, and locking
somebody out over that would be punishing them for our own migration.
*/
func PasswordStatusForAccount(acctType string, acctID int64) PasswordStatus {
	p := Policy()
	if p.PasswordExpiryDays <= 0 || acctID == 0 {
		return PasswordStatus{Enabled: false}
	}
	table, idCol := "dcp_user_login", "loginId"
	if acctType == AcctSuperAdmin {
		table, idCol = "dcp_super_admin", "id"
	}
	row, err := db.QueryOne(
		"SELECT password_changed_at FROM "+table+" WHERE "+idCol+" = ? LIMIT 1", acctID)
	if err != nil || row == nil {
		return PasswordStatus{Enabled: false}
	}
	changed, ok := parseDBTime(row["password_changed_at"])
	if !ok {
		return PasswordStatus{Enabled: false}
	}
	return passwordStatusFor(changed, p)
}

/*
StampPasswordChanged restarts the clock, and clears the warnings already sent.

Both, together, and that is the point of it being one function: a password
changed on the day a "expires in 1 day" email went out must be able to receive
that same email again in thirty days' time, and the notice ledger is keyed by
the expiry date it was sent about. Clearing the rows on change keeps that table
from growing without bound as well.
*/
func StampPasswordChanged(acctType string, acctID int64) {
	if acctID == 0 {
		return
	}
	ensureSecurityPolicySchema()

	table, idCol := "dcp_user_login", "loginId"
	if acctType == AcctSuperAdmin {
		table, idCol = "dcp_super_admin", "id"
	}
	if err := db.MustExec(
		"UPDATE "+table+" SET password_changed_at = UTC_TIMESTAMP() WHERE "+idCol+" = ?", acctID); err != nil {
		log.Printf("[password-expiry] stamp %s/%d: %v", acctType, acctID, err)
	}
	db.Exec("DELETE FROM "+passwordNoticeTable+" WHERE account_type = ? AND account_id = ?", acctType, acctID)

	// A new password is also a clean slate for the lockout ledger — this is the
	// "instant recovery" path the requirement asks for.
	ClearFailures(acctType, acctID)
}

/*
StampPasswordChangedForUsername stamps every ACTIVE login row sharing a
username.

ChangePassword writes the new hash to all of them, because the login query
matches on the username rather than on the selected row — so the clock has to
be restarted on all of them too. Stamping only the one row leaves the others
carrying the old date, and the reader is warned about a password they changed.
*/
func StampPasswordChangedForUsername(username string) {
	username = strings.TrimSpace(username)
	if username == "" {
		return
	}
	ensureSecurityPolicySchema()
	if err := db.MustExec(
		"UPDATE dcp_user_login SET password_changed_at = UTC_TIMESTAMP() WHERE login_username = ? AND is_active = 1",
		username); err != nil {
		log.Printf("[password-expiry] stamp %s: %v", username, err)
		return
	}
	rows, _ := db.Query(
		"SELECT loginId FROM dcp_user_login WHERE login_username = ? AND is_active = 1", username)
	for _, r := range rows {
		id := intFromAny(r["loginId"])
		db.Exec("DELETE FROM "+passwordNoticeTable+" WHERE account_type = ? AND account_id = ?", AcctLogin, id)
		ClearFailures(AcctLogin, id)
	}
}

/* ── The warning sweep ────────────────────────────────────────────────────── */

/*
SendExpiryWarnings emails everyone whose password crosses a warning threshold.

Idempotent by construction: a row is written to the notice table for each
(account, expiry date, threshold) that has been sent, and the insert is what
decides whether the email goes out. Running the sweep twice in a minute sends
nothing the second time, which matters because it runs on a timer AND can be
triggered by hand.

Returns how many were sent, for the log and for the admin screen's "run now".
*/
func SendExpiryWarnings() (sent int) {
	p := Policy()
	if p.PasswordExpiryDays <= 0 || len(p.EmailWarnDays) == 0 {
		return 0
	}
	ensureSecurityPolicySchema()

	type acct struct {
		Type  string
		ID    int64
		Email string
		Name  string
	}
	accounts := []acct{}

	rows, _ := db.Query(`
		SELECT l.loginId AS id, l.login_username AS email,
		       TRIM(CONCAT(l.first_name, ' ', l.last_name)) AS name, l.password_changed_at
		  FROM dcp_user_login l
		  INNER JOIN dcp_user u ON u.userId = l.userId
		 WHERE l.is_active = 1 AND u.deleted = 0
		   AND l.login_username <> '' AND l.password_changed_at IS NOT NULL`)
	changedBy := map[string]time.Time{}
	for _, r := range rows {
		a := acct{Type: AcctLogin, ID: intFromAny(r["id"]),
			Email: strFromAny(r["email"]), Name: strFromAny(r["name"])}
		if t, ok := parseDBTime(r["password_changed_at"]); ok && a.Email != "" {
			accounts = append(accounts, a)
			changedBy[fmt.Sprintf("%s:%d", a.Type, a.ID)] = t
		}
	}

	saRows, _ := db.Query(`
		SELECT id, email, name, password_changed_at FROM dcp_super_admin
		 WHERE is_active = 1 AND email <> '' AND password_changed_at IS NOT NULL`)
	for _, r := range saRows {
		a := acct{Type: AcctSuperAdmin, ID: intFromAny(r["id"]),
			Email: strFromAny(r["email"]), Name: strFromAny(r["name"])}
		if t, ok := parseDBTime(r["password_changed_at"]); ok && a.Email != "" {
			accounts = append(accounts, a)
			changedBy[fmt.Sprintf("%s:%d", a.Type, a.ID)] = t
		}
	}

	for _, a := range accounts {
		st := passwordStatusFor(changedBy[fmt.Sprintf("%s:%d", a.Type, a.ID)], p)
		if !st.Enabled || st.Expired {
			// Nothing is sent AFTER expiry. At that point the login itself says
			// so and forces the change; an email saying "expires in -3 days"
			// helps nobody.
			continue
		}
		threshold := 0
		for _, w := range p.EmailWarnDays {
			if st.DaysRemaining == w {
				threshold = w
				break
			}
		}
		if threshold == 0 {
			continue
		}

		/* The INSERT is the lock. Two sweeps racing each other both try to
		   claim the same (account, date, threshold); one wins and sends, the
		   other gets a duplicate-key error and does not. */
		_, n, err := db.Exec(
			"INSERT IGNORE INTO "+passwordNoticeTable+
				" (account_type, account_id, expires_on, warn_day, sent_at) VALUES (?, ?, ?, ?, UTC_TIMESTAMP())",
			a.Type, a.ID, st.ExpiresOn, threshold)
		if err != nil || n == 0 {
			continue
		}

		name := a.Name
		if strings.TrimSpace(name) == "" {
			name = a.Email
		}
		if err := email.SendPasswordExpiryWarning(
			a.Email, name, st.DaysRemaining, st.ExpiresOn); err != nil {
			log.Printf("[password-expiry] email %s: %v", a.Email, err)
			// The claim is released so the next sweep tries again — a send that
			// failed must not be recorded as one that happened.
			db.Exec("DELETE FROM "+passwordNoticeTable+
				" WHERE account_type = ? AND account_id = ? AND expires_on = ? AND warn_day = ?",
				a.Type, a.ID, st.ExpiresOn, threshold)
			continue
		}
		sent++
	}

	if sent > 0 {
		log.Printf("[password-expiry] %d warning email(s) sent", sent)
	}
	return sent
}

/*
StartPasswordExpiryWatcher runs the sweep on a timer.

Hourly rather than daily, and idempotent, so that the warning lands within an
hour of the threshold being crossed whatever time the server was last restarted
— a daily job fixed at midnight sends nothing at all if the process was down
across it, and nobody notices until an expiry is missed.
*/
func StartPasswordExpiryWatcher() {
	go func() {
		// A short delay so a boot storm does not run this against a database
		// that is still coming up.
		time.Sleep(2 * time.Minute)
		for {
			func() {
				defer func() {
					if rec := recover(); rec != nil {
						log.Printf("[password-expiry] sweep panicked: %v", rec)
					}
				}()
				SendExpiryWarnings()
			}()
			time.Sleep(time.Hour)
		}
	}()
}
