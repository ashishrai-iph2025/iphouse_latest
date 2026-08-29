package handlers

// Counting failed attempts, and locking the account when there are too many.
//
// One ledger for both kinds of failure — a wrong password and a wrong OTP code
// — because they are the same event from the account's point of view and the
// same policy governs them, but kept as separate ROWS so that five wrong codes
// do not lock an account out over a password nobody got wrong.
//
// The lock EXPIRES rather than being cleared by anybody: `locked_until` is a
// timestamp, and every check compares it to now. There is no unlock job, no
// queue and nothing to go wrong overnight — an account with a lock in the past
// is simply not locked. The "automatically enabled after 24 hours" in the
// requirement is that comparison, and nothing else.

import (
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/ip-house/iphouse-api/db"
	"github.com/ip-house/iphouse-api/email"
)

const lockoutTable = "dcp_account_lockout"

// Account kinds. Two tables hold credentials in this portal and both can be
// locked, so every row says which one it means.
const (
	AcctLogin      = "login"
	AcctSuperAdmin = "super_admin"
)

// Failure kinds.
const (
	FailPassword = "password"
	FailOTP      = "otp"
)

// LockState is what a caller needs to decide whether to let an attempt proceed
// and what to say if not.
type LockState struct {
	Locked      bool
	Until       time.Time
	Fails       int
	Remaining   int // attempts left before the lock; 0 when lockout is off
	LockoutHrs  int
	MaxAttempts int
}

/*
CheckLock reports whether this account is currently locked for this kind of
failure.

Reads the stored timestamp and compares it here rather than asking the database
for "is it locked", so the answer carries WHEN it lifts — which is the only part
of a lockout message that helps the person reading it.
*/
func CheckLock(acctType string, acctID int64, kind string) LockState {
	p := Policy()
	max, hours := p.MaxFailedLogins, p.LockoutHours
	if kind == FailOTP {
		max, hours = p.OTPMaxAttempts, p.OTPLockoutHours
	}
	st := LockState{MaxAttempts: max, LockoutHrs: hours}
	if max <= 0 || acctID == 0 {
		return st // lockout disabled for this kind
	}

	row, err := db.QueryOne(
		"SELECT fail_count, locked_until FROM "+lockoutTable+
			" WHERE account_type = ? AND account_id = ? AND kind = ? LIMIT 1",
		acctType, acctID, kind)
	if err != nil || row == nil {
		st.Remaining = max
		return st
	}
	st.Fails = int(numOf(row["fail_count"]))
	st.Remaining = max - st.Fails
	if st.Remaining < 0 {
		st.Remaining = 0
	}
	if until, ok := parseDBTime(row["locked_until"]); ok && until.After(time.Now().UTC()) {
		st.Locked = true
		st.Until = until
	}
	return st
}

/*
RecordFailure counts one failed attempt and locks the account at the threshold.

Returns the state AFTER the failure, so the caller can tell the person how many
tries are left — a count that only appears once it is exhausted is a count
nobody could have acted on.

A failure recorded against an account already locked does not extend the lock.
Extending it would make a lockout indefinite for as long as somebody keeps
guessing, which turns a 24-hour penalty on the attacker into a permanent one on
the account's owner.
*/
func RecordFailure(acctType string, acctID int64, kind string) LockState {
	p := Policy()
	max, hours := p.MaxFailedLogins, p.LockoutHours
	if kind == FailOTP {
		max, hours = p.OTPMaxAttempts, p.OTPLockoutHours
	}
	if max <= 0 || acctID == 0 {
		return LockState{MaxAttempts: max, LockoutHrs: hours}
	}
	ensureSecurityPolicySchema()

	if st := CheckLock(acctType, acctID, kind); st.Locked {
		return st
	}

	/* The count and the lock are set in ONE statement.

	   Two statements — read the count, then write the lock — is a race that two
	   simultaneous wrong guesses win: both read four, both write five, neither
	   locks. Letting MySQL do the arithmetic and the threshold together means
	   the fifth attempt locks the account whichever request gets there first. */
	if err := db.MustExec(`
		INSERT INTO `+lockoutTable+` (account_type, account_id, kind, fail_count, last_fail_at, locked_until)
		VALUES (?, ?, ?, 1, UTC_TIMESTAMP(), NULL)
		ON DUPLICATE KEY UPDATE
		  fail_count   = fail_count + 1,
		  last_fail_at = UTC_TIMESTAMP(),
		  locked_until = IF(fail_count + 1 >= ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR), locked_until)`,
		acctType, acctID, kind, max, hours); err != nil {
		log.Printf("[lockout] record %s/%d/%s: %v", acctType, acctID, kind, err)
	}

	st := CheckLock(acctType, acctID, kind)
	if st.Locked {
		log.Printf("[lockout] %s %d locked on %s until %s after %d failed attempt(s)",
			acctType, acctID, kind, st.Until.Format(time.RFC3339), st.Fails)
	}
	return st
}

/*
ClearFailures wipes the count for an account.

Called on a SUCCESSFUL sign-in and on a completed password reset. The reset is
the important one: it is the "instant recovery" in the requirement — somebody
locked out for 24 hours who can still read their email does not have to wait,
because resetting the password clears the ledger and the lock with it.
*/
func ClearFailures(acctType string, acctID int64, kinds ...string) {
	if acctID == 0 {
		return
	}
	if len(kinds) == 0 {
		kinds = []string{FailPassword, FailOTP}
	}
	for _, k := range kinds {
		db.Exec("DELETE FROM "+lockoutTable+" WHERE account_type = ? AND account_id = ? AND kind = ?",
			acctType, acctID, k)
	}
}

/*
otpLockAccount resolves the login row an OTP attempt should be counted against.

The OTP flow is keyed by userId — the person — while the lockout ledger is keyed
by login row, which is what actually gets locked and what a reset unlocks. One
person can own several logins under one email, so the email is tried first and
the userId only as a fallback.

Returns 0 when nothing resolves, and every lockout call treats 0 as "no account,
do not count" — which is the right failure: an unresolvable identity should not
be able to lock a row chosen at random.
*/
func otpLockAccount(email string, userID int64) int64 {
	if e := strings.TrimSpace(email); e != "" {
		if row, _ := db.QueryOne(
			"SELECT loginId FROM dcp_user_login WHERE login_username = ? AND is_active = 1 LIMIT 1", e); row != nil {
			return intFromAny(row["loginId"])
		}
	}
	if userID != 0 {
		if row, _ := db.QueryOne(
			"SELECT loginId FROM dcp_user_login WHERE userId = ? AND is_active = 1 LIMIT 1", userID); row != nil {
			return intFromAny(row["loginId"])
		}
	}
	return 0
}

// LockMessage is what the person who is locked out is told.
//
// It says when it lifts and what to do instead of waiting, because "your
// account is locked" on its own leaves somebody with a support ticket and no
// idea whether it will be answered before the lock expires anyway.
func LockMessage(st LockState) string {
	mins := int(time.Until(st.Until).Minutes())
	switch {
	case mins > 90:
		return fmt.Sprintf(
			"This account is locked after %d incorrect attempts. It unlocks automatically in about %d hours (at %s UTC). "+
				"To get back in now, use Forgot password to reset it.",
			st.Fails, (mins+59)/60, st.Until.Format("15:04"))
	case mins > 1:
		return fmt.Sprintf(
			"This account is locked after %d incorrect attempts. It unlocks automatically in about %d minutes. "+
				"To get back in now, use Forgot password to reset it.",
			st.Fails, mins)
	default:
		return "This account is locked after too many incorrect attempts. It unlocks shortly — " +
			"or use Forgot password to reset it now."
	}
}

/*
failedLoginMessage is what a wrong password says.

It counts DOWN once the account is close to locking, and says nothing before
that. Both halves are deliberate: a portal that announces "4 attempts remaining"
on the first mistake tells an attacker exactly how much room they have, while
one that says nothing at all locks people out with no warning at all. Warning
from two attempts out is late enough to be useless as reconnaissance and early
enough to be a warning.

The credential itself is never described. "Invalid credentials" for a wrong
password and for an unknown user, always, so the response cannot be used to
learn which accounts exist.
*/
/*
failResp is a failed sign-in as the browser receives it: the sentence, plus the
numbers behind it.

Both, deliberately. The sentence is what a person reads and has to stand alone
for a client that ignores the rest; the numbers are so the page can draw "2 of 5
attempts left" as its own element rather than parsing English out of an error
string — which is the kind of coupling that breaks the day somebody rewords the
message.

Omitted entirely when lockout is switched off, so a page cannot render a counter
that counts towards nothing.
*/
func failResp(st LockState, msg string) map[string]any {
	m := map[string]any{"success": false, "error": msg}
	if st.MaxAttempts > 0 {
		m["locked"] = st.Locked
		m["remaining"] = st.Remaining
		m["maxAttempts"] = st.MaxAttempts
		m["lockoutHours"] = st.LockoutHrs
	}
	return m
}

func failedLoginMessage(st LockState) string {
	if st.Locked {
		return LockMessage(st)
	}
	if st.MaxAttempts > 0 && st.Remaining > 0 {
		return fmt.Sprintf(
			"Invalid credentials. %d attempt%s left before this account is locked for %d hours.",
			st.Remaining, map[bool]string{true: "", false: "s"}[st.Remaining == 1], st.LockoutHrs)
	}
	return "Invalid credentials"
}

/*
notifyIfJustLocked emails the account owner the one time it locks.

Guarded on `Fails == MaxAttempts` rather than on `Locked`, so it fires on the
attempt that crossed the line and not on the ones after it. Somebody being
brute-forced is already having a bad day; a message per attempt would be the
portal joining in.

Sent in the background and its failure ignored: an account is locked whether or
not the mail server is reachable, and blocking a login response on SMTP is a
worse outcome than a missing notification.
*/
func notifyIfJustLocked(st LockState, to, name string) {
	if !st.Locked || st.MaxAttempts <= 0 || st.Fails != st.MaxAttempts {
		return
	}
	if strings.TrimSpace(to) == "" {
		return
	}
	go func() {
		if err := email.SendAccountLocked(to, name, st.LockoutHrs, st.Until.Format("2006-01-02 15:04")); err != nil {
			log.Printf("[lockout] notify %s: %v", to, err)
		}
	}()
}

// parseDBTime reads the several shapes a DATETIME arrives in. The driver gives
// a time.Time when parseTime is on and a string when it is not, and this code
// must not depend on which.
func parseDBTime(v any) (time.Time, bool) {
	switch t := v.(type) {
	case nil:
		return time.Time{}, false
	case time.Time:
		if t.IsZero() {
			return time.Time{}, false
		}
		return t.UTC(), true
	case []byte:
		return parseDBTimeString(string(t))
	case string:
		return parseDBTimeString(t)
	}
	return time.Time{}, false
}

func parseDBTimeString(s string) (time.Time, bool) {
	s = strings.TrimSpace(s)
	if s == "" || strings.HasPrefix(s, "0000-00-00") {
		return time.Time{}, false
	}
	for _, layout := range []string{
		"2006-01-02 15:04:05", time.RFC3339, "2006-01-02T15:04:05Z07:00", "2006-01-02",
	} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC(), true
		}
	}
	return time.Time{}, false
}
