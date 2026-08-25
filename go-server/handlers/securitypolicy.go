package handlers

// The security policy: how long a password lives, and what happens when
// somebody gets one wrong too many times.
//
// Stored rather than compiled in, because every number here is a decision that
// gets revisited — an auditor asks for 60 days, an incident asks for 3 attempts
// — and none of them is worth a deploy. One row, edited by a Super Admin, read
// through a short cache so the login path does not pay for a query per attempt.
//
// Everything is expressed so that ZERO MEANS OFF. An install that wants no
// expiry sets 0 days and nothing about the login flow changes; an install that
// wants no lockout sets 0 attempts. That matters more than it looks: the first
// thing anyone does with a policy they do not yet trust is turn part of it off,
// and the alternative to a documented off switch is somebody editing the table
// by hand.

import (
	"fmt"
	"log"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ip-house/iphouse-api/db"
)

const securityPolicyTable = "dcp_security_policy"

// Previous password hashes, so the last N cannot be used again.
const passwordHistoryTable = "dcp_password_history"

// SecurityPolicy is the whole of it. Days and hours rather than durations
// because that is how it is written down in the document this implements.
type SecurityPolicy struct {
	// 0 disables expiry entirely.
	PasswordExpiryDays int
	// Days before expiry that the signed-in user is warned, in the banner.
	WarnDays []int
	// Days before expiry that an email goes out. A subset of the above in
	// practice, but kept separate: being told on screen every day for a week is
	// reasonable, being emailed every day for a week is not.
	EmailWarnDays []int

	// 0 disables lockout.
	MaxFailedLogins int
	LockoutHours    int

	OTPMaxAttempts  int
	OTPLockoutHours int

	/* What a password has to LOOK like.

	   Every count below is a minimum, and 0 means "not required" — the same
	   off-switch the rest of this file uses. Expressed as counts rather than
	   booleans because "at least one digit" and "at least two digits" are the
	   same rule with a different number, and a boolean would need replacing the
	   first time somebody asked for the second. */
	PasswordMinLength  int
	PasswordMinDigits  int
	PasswordMinUpper   int
	PasswordMinLower   int
	PasswordMinSymbols int

	/* How many previous passwords may not be used again. 0 switches reuse
	   checking off; 3 means a new password is refused if it matches any of the
	   last three. */
	PasswordHistory int
}

// DefaultSecurityPolicy is what an install starts with, and what a row that
// cannot be read falls back to. These are the numbers asked for.
func DefaultSecurityPolicy() SecurityPolicy {
	return SecurityPolicy{
		PasswordExpiryDays: 30,
		WarnDays:           []int{3, 2, 1},
		EmailWarnDays:      []int{2, 1},
		MaxFailedLogins:    5,
		LockoutHours:       24,
		OTPMaxAttempts:     5,
		OTPLockoutHours:    24,

		/* Length 8 with one digit is close to what the forms already asked for,
		   so an existing install upgrades without every stored password
		   becoming non-compliant overnight. Case and symbol requirements ship
		   OFF: they are on the screen for an install that wants them, and
		   turning one on is a decision somebody should make deliberately
		   rather than inherit from a default. */
		PasswordMinLength:  8,
		PasswordMinDigits:  1,
		PasswordMinUpper:   0,
		PasswordMinLower:   0,
		PasswordMinSymbols: 0,

		PasswordHistory: 3,
	}
}

var securityPolicyOnce sync.Once

func ensureSecurityPolicySchema() {
	// Nothing to create without a database, and every db call below would panic
	// on the nil pool rather than return an error. Not memoised through the
	// Once: a caller that runs before Init must not permanently mark the schema
	// as done.
	if !db.Ready() {
		return
	}
	securityPolicyOnce.Do(func() {
		if _, _, err := db.Exec(`
			CREATE TABLE IF NOT EXISTS ` + securityPolicyTable + ` (
			  id                   TINYINT UNSIGNED NOT NULL PRIMARY KEY,
			  password_expiry_days INT NOT NULL DEFAULT 30,
			  warn_days            VARCHAR(64)  NOT NULL DEFAULT '3,2,1',
			  email_warn_days      VARCHAR(64)  NOT NULL DEFAULT '2,1',
			  max_failed_logins    INT NOT NULL DEFAULT 5,
			  lockout_hours        INT NOT NULL DEFAULT 24,
			  otp_max_attempts     INT NOT NULL DEFAULT 5,
			  otp_lockout_hours    INT NOT NULL DEFAULT 24,
			  updated_by           VARCHAR(191) NOT NULL DEFAULT '',
			  updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`); err != nil {
			log.Printf("[security-policy] create %s: %v", securityPolicyTable, err)
			return
		}

		/* The lockout ledger.

		   In the DATABASE, not in memory, which is where the OTP counter used to
		   live. A counter that resets on deploy is a lockout an attacker clears
		   by waiting for one, and a portal behind more than one process never
		   counted correctly in the first place. */
		if _, _, err := db.Exec(`
			CREATE TABLE IF NOT EXISTS ` + lockoutTable + ` (
			  account_type VARCHAR(16)  NOT NULL COMMENT 'login | super_admin',
			  account_id   INT UNSIGNED NOT NULL,
			  kind         VARCHAR(16)  NOT NULL COMMENT 'password | otp',
			  fail_count   INT      NOT NULL DEFAULT 0,
			  locked_until DATETIME NULL,
			  last_fail_at DATETIME NULL,
			  PRIMARY KEY (account_type, account_id, kind),
			  KEY idx_locked (locked_until)
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`); err != nil {
			log.Printf("[security-policy] create %s: %v", lockoutTable, err)
		}

		/* Which warnings have already gone out.

		   Keyed by the expiry date it was sent ABOUT, not by the day it was sent:
		   the sweep runs more than once a day and must not send "expires in 2
		   days" twice, but it must send again for the NEXT expiry once the
		   password has been changed and a new 30 days has started. */
		if _, _, err := db.Exec(`
			CREATE TABLE IF NOT EXISTS ` + passwordNoticeTable + ` (
			  account_type VARCHAR(16)  NOT NULL,
			  account_id   INT UNSIGNED NOT NULL,
			  expires_on   DATE         NOT NULL,
			  warn_day     INT          NOT NULL,
			  sent_at      DATETIME     NOT NULL,
			  PRIMARY KEY (account_type, account_id, expires_on, warn_day)
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`); err != nil {
			log.Printf("[security-policy] create %s: %v", passwordNoticeTable, err)
		}

		/* The complexity and history columns arrived after the table did, and
		   CREATE TABLE IF NOT EXISTS does nothing to a table that already
		   exists. Added with the same values DefaultSecurityPolicy carries, so
		   an upgraded install and a fresh one start from the same policy. */
		for _, c := range []struct{ col, ddl string }{
			{"password_min_length", "INT NOT NULL DEFAULT 8"},
			{"password_min_digits", "INT NOT NULL DEFAULT 1"},
			{"password_min_upper", "INT NOT NULL DEFAULT 0"},
			{"password_min_lower", "INT NOT NULL DEFAULT 0"},
			{"password_min_symbols", "INT NOT NULL DEFAULT 0"},
			{"password_history", "INT NOT NULL DEFAULT 3"},
		} {
			if portalColumnExists(securityPolicyTable, c.col) {
				continue
			}
			if _, _, err := db.Exec(
				"ALTER TABLE " + securityPolicyTable + " ADD COLUMN " + c.col + " " + c.ddl); err != nil {
				log.Printf("[security-policy] add %s.%s: %v", securityPolicyTable, c.col, err)
			}
		}

		/* Previous passwords, so one cannot be used again.

		   HASHES, never the passwords — the point of storing bcrypt is that a
		   leak of this table tells an attacker no more than a leak of the login
		   table does. Reuse is therefore tested by hashing the candidate
		   against each stored salt, not by comparing strings.

		   Keyed by the identity the LOGIN authenticates on: a client's password
		   lives on every active row sharing a username, so keying this by
		   loginId would let the same person cycle a password back by switching
		   accounts. */
		if _, _, err := db.Exec(`
			CREATE TABLE IF NOT EXISTS ` + passwordHistoryTable + ` (
			  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
			  account_type  VARCHAR(16)  NOT NULL COMMENT 'login | super_admin',
			  account_key   VARCHAR(191) NOT NULL COMMENT 'login_username, or the super admin email',
			  password_hash VARCHAR(255) NOT NULL,
			  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
			  KEY idx_acct (account_type, account_key, created_at)
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`); err != nil {
			log.Printf("[security-policy] create %s: %v", passwordHistoryTable, err)
		}

		ensurePasswordChangedColumns()
		seedSecurityEmailEventTypes()

		if _, _, err := db.Exec(
			"INSERT IGNORE INTO " + securityPolicyTable + " (id) VALUES (1)"); err != nil {
			log.Printf("[security-policy] seed row: %v", err)
		}
	})
}

/*
seedSecurityEmailEventTypes registers the two messages this policy sends, so
they are editable in Configuration → Email Templates like every other one.

Done here as well as in schema.sql because schema.sql runs on a FRESH install
only. Without this, an existing portal gets the emails — the code falls back to
a built-in body — but no row in the template list, so nobody can change the
wording, which was the explicit ask.

INSERT IGNORE on a unique key: running twice writes nothing, and an event type
somebody has since renamed is left exactly as they renamed it.
*/
func seedSecurityEmailEventTypes() {
	rows := []struct {
		key, label, desc, vars string
		order                  int
	}{
		{"password_expiry_warning", "Password Expiry Warning",
			"Sent before a password expires, at each warning threshold in the security policy.",
			"{{user_name}},{{email}},{{days_remaining}},{{days_label}},{{expiry_date}},{{login_url}}", 11},
		{"account_locked", "Account Locked",
			"Sent once when an account is locked after too many failed sign-in attempts.",
			"{{user_name}},{{email}},{{lockout_hours}},{{unlock_at}},{{login_url}}", 12},
	}
	for _, r := range rows {
		if _, _, err := db.Exec(
			"INSERT IGNORE INTO dcp_email_event_types (`key`, label, description, has_notify_email, variables, sort_order, is_active) "+
				"VALUES (?, ?, ?, 0, ?, ?, 1)",
			r.key, r.label, r.desc, r.vars, r.order); err != nil {
			log.Printf("[security-policy] seed event type %s: %v", r.key, err)
		}
	}
}

/*
ensurePasswordChangedColumns adds the column the whole expiry rule is measured
from, and backfills it to NOW rather than to the account's creation date.

That backfill is the important decision. Measuring from creation would expire
every password in the system the moment this ships — including every
administrator's, at once, with the reset flow itself behind a login. Starting
the clock at the upgrade gives everybody a full period to change theirs, which
is what a policy introduction is supposed to do.
*/
func ensurePasswordChangedColumns() {
	for _, t := range []string{"dcp_user_login", "dcp_super_admin"} {
		if portalColumnExists(t, "password_changed_at") {
			continue
		}
		if _, _, err := db.Exec(
			"ALTER TABLE " + t + " ADD COLUMN password_changed_at DATETIME NULL"); err != nil {
			log.Printf("[security-policy] add %s.password_changed_at: %v", t, err)
			continue
		}
		if _, n, err := db.Exec(
			"UPDATE " + t + " SET password_changed_at = UTC_TIMESTAMP() WHERE password_changed_at IS NULL"); err == nil {
			log.Printf("[security-policy] %s.password_changed_at added; %d account(s) start their first period now", t, n)
		}
	}
}

/* ── Reading it ───────────────────────────────────────────────────────────── */

var (
	policyMu     sync.RWMutex
	policyCache  SecurityPolicy
	policyFilled bool
	policyAt     time.Time
)

// policyTTL is short. The login path reads this on every attempt, so it cannot
// be a query each time; a change made on the settings screen has to take hold
// while the person who made it is still looking at the screen.
const policyTTL = 30 * time.Second

// Policy returns the current policy, cached.
func Policy() SecurityPolicy {
	policyMu.RLock()
	if policyFilled && time.Since(policyAt) < policyTTL {
		defer policyMu.RUnlock()
		return policyCache
	}
	policyMu.RUnlock()

	ensureSecurityPolicySchema()
	p := DefaultSecurityPolicy()
	if !db.Ready() {
		// The shipped policy, uncached — so the real row is read as soon as
		// there is a database to read it from.
		return p
	}
	if row, err := db.QueryOne(
		"SELECT * FROM " + securityPolicyTable + " WHERE id = 1 LIMIT 1"); err == nil && row != nil {
		p.PasswordExpiryDays = intOr(row["password_expiry_days"], p.PasswordExpiryDays)
		p.MaxFailedLogins = intOr(row["max_failed_logins"], p.MaxFailedLogins)
		p.LockoutHours = intOr(row["lockout_hours"], p.LockoutHours)
		p.OTPMaxAttempts = intOr(row["otp_max_attempts"], p.OTPMaxAttempts)
		p.OTPLockoutHours = intOr(row["otp_lockout_hours"], p.OTPLockoutHours)
		p.PasswordMinLength = intOr(row["password_min_length"], p.PasswordMinLength)
		p.PasswordMinDigits = intOr(row["password_min_digits"], p.PasswordMinDigits)
		p.PasswordMinUpper = intOr(row["password_min_upper"], p.PasswordMinUpper)
		p.PasswordMinLower = intOr(row["password_min_lower"], p.PasswordMinLower)
		p.PasswordMinSymbols = intOr(row["password_min_symbols"], p.PasswordMinSymbols)
		p.PasswordHistory = intOr(row["password_history"], p.PasswordHistory)
		if v := ParseDayList(strFromAny(row["warn_days"])); len(v) > 0 {
			p.WarnDays = v
		}
		// Not `len(v) > 0`: an EMPTY email-warning list is a real choice — warn
		// on screen, do not email — and defaulting it back to 2,1 would quietly
		// undo that every time the policy is read.
		p.EmailWarnDays = ParseDayList(strFromAny(row["email_warn_days"]))
	}

	policyMu.Lock()
	policyCache, policyFilled, policyAt = p, true, time.Now()
	policyMu.Unlock()
	return p
}

// InvalidatePolicy drops the cache, so a save takes effect on the next read
// rather than up to policyTTL later.
func InvalidatePolicy() {
	policyMu.Lock()
	policyFilled = false
	policyMu.Unlock()
}

// intOr reads a column that should be a number, keeping the fallback when it is
// absent or zero-and-meaningless. Zero IS meaningful for the "off" switches, so
// only a missing column falls back.
func intOr(v any, def int) int {
	if v == nil {
		return def
	}
	return int(numOf(v))
}

/*
ParseDayList reads "3,2,1" into [3 2 1], sorted high to low and deduplicated.

High to low because that is the order they happen in and the order the
notice-sending sweep needs: the first threshold a password crosses is the
largest one.
*/
func ParseDayList(s string) []int {
	seen := map[int]bool{}
	out := []int{}
	for _, part := range strings.Split(s, ",") {
		n, err := strconv.Atoi(strings.TrimSpace(part))
		if err != nil || n <= 0 || seen[n] {
			continue
		}
		seen[n] = true
		out = append(out, n)
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j] > out[j-1]; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

// FormatDayList is ParseDayList's inverse, for storing and for display.
func FormatDayList(days []int) string {
	parts := make([]string, 0, len(days))
	for _, d := range days {
		parts = append(parts, strconv.Itoa(d))
	}
	return strings.Join(parts, ",")
}

// SavePolicy writes the row and clears the cache. Values are clamped rather
// than rejected: this is an internal settings screen, and silently refusing to
// save because someone typed 400 days is worse than storing something sane.
func SavePolicy(p SecurityPolicy, who string) error {
	ensureSecurityPolicySchema()

	p.PasswordExpiryDays = clampInt(p.PasswordExpiryDays, 0, 3650)
	p.MaxFailedLogins = clampInt(p.MaxFailedLogins, 0, 100)
	p.LockoutHours = clampInt(p.LockoutHours, 0, 720)
	p.OTPMaxAttempts = clampInt(p.OTPMaxAttempts, 0, 100)
	p.OTPLockoutHours = clampInt(p.OTPLockoutHours, 0, 720)

	/* A FLOOR of 4 on the length, not 0. Unlike expiry or lockout, "no minimum
	   length" is not a policy anyone means to set, and a stray 0 left in that
	   box would quietly start accepting one-character passwords. The ceiling is
	   bcrypt's own: it ignores everything past 72 bytes, so a longer minimum
	   would demand characters that make no difference to the hash. */
	p.PasswordMinLength = clampInt(p.PasswordMinLength, 4, 72)
	p.PasswordMinDigits = clampInt(p.PasswordMinDigits, 0, 72)
	p.PasswordMinUpper = clampInt(p.PasswordMinUpper, 0, 72)
	p.PasswordMinLower = clampInt(p.PasswordMinLower, 0, 72)
	p.PasswordMinSymbols = clampInt(p.PasswordMinSymbols, 0, 72)
	p.PasswordHistory = clampInt(p.PasswordHistory, 0, 24)

	if err := db.MustExec(`
		INSERT INTO `+securityPolicyTable+`
		  (id, password_expiry_days, warn_days, email_warn_days,
		   max_failed_logins, lockout_hours, otp_max_attempts, otp_lockout_hours,
		   password_min_length, password_min_digits, password_min_upper,
		   password_min_lower, password_min_symbols, password_history, updated_by)
		VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
		  password_expiry_days=VALUES(password_expiry_days), warn_days=VALUES(warn_days),
		  email_warn_days=VALUES(email_warn_days), max_failed_logins=VALUES(max_failed_logins),
		  lockout_hours=VALUES(lockout_hours), otp_max_attempts=VALUES(otp_max_attempts),
		  otp_lockout_hours=VALUES(otp_lockout_hours),
		  password_min_length=VALUES(password_min_length),
		  password_min_digits=VALUES(password_min_digits),
		  password_min_upper=VALUES(password_min_upper),
		  password_min_lower=VALUES(password_min_lower),
		  password_min_symbols=VALUES(password_min_symbols),
		  password_history=VALUES(password_history), updated_by=VALUES(updated_by)`,
		p.PasswordExpiryDays, FormatDayList(p.WarnDays), FormatDayList(p.EmailWarnDays),
		p.MaxFailedLogins, p.LockoutHours, p.OTPMaxAttempts, p.OTPLockoutHours,
		p.PasswordMinLength, p.PasswordMinDigits, p.PasswordMinUpper,
		p.PasswordMinLower, p.PasswordMinSymbols, p.PasswordHistory, who); err != nil {
		return fmt.Errorf("could not save the security policy: %w", err)
	}
	InvalidatePolicy()
	log.Printf("[security-policy] updated by %s — expiry %dd, lockout %d attempts / %dh",
		who, p.PasswordExpiryDays, p.MaxFailedLogins, p.LockoutHours)
	return nil
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
