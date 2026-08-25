package handlers

// What a password has to look like, and what it may not go back to.
//
// The rules live in the security policy (see securitypolicy.go) rather than in
// the handlers that set passwords, because there are seven such handlers and a
// rule enforced in six of them is not a rule. Everything here reads Policy(),
// so a Super Admin changing a number on the Security Policy screen changes what
// the next password change accepts — no deploy, no restart.
//
// The two halves answer different questions and are deliberately separate:
//
//	ValidatePassword   is this password acceptable at all?     (cheap, no I/O)
//	PasswordReused     has this account used it before?        (bcrypt per row)
//
// Callers run them in that order. There is no point paying for bcrypt against
// the history of a password that is going to be refused for being six
// characters long.

import (
	"fmt"
	"log"
	"net/http"
	"strings"
	"unicode"

	ipauth "github.com/ip-house/iphouse-api/auth"
	"github.com/ip-house/iphouse-api/db"
)

/*
ValidatePassword checks a proposed password against the configured complexity
rules, returning an error whose text can be shown to the person typing it.

The message names EVERY unmet rule at once, not the first one. Reporting them
one at a time turns a single decision into a guessing game — add a digit, submit,
now add a capital, submit — and the person on the other end has no way to know
how many rounds are left.

Unicode-aware on purpose: a policy that demands "an uppercase letter" should
accept Ä, and one that demands a symbol should not be confused by an em dash.
Anything that is not a letter, a digit or a space counts as a symbol, which is
broader than a fixed punctuation list and cannot silently reject a character
somebody's keyboard produces.
*/
func ValidatePassword(pw string) error {
	p := Policy()

	// Counted in RUNES. len() on a string counts bytes, so a password of eight
	// accented characters would read as sixteen and pass a rule it should not.
	var runes, digits, upper, lower, symbols int
	for _, r := range pw {
		runes++
		switch {
		case unicode.IsDigit(r):
			digits++
		case unicode.IsUpper(r):
			upper++
		case unicode.IsLower(r):
			lower++
		case !unicode.IsSpace(r) && !unicode.IsLetter(r):
			symbols++
		}
	}

	var missing []string
	if runes < p.PasswordMinLength {
		missing = append(missing, fmt.Sprintf("%d characters or more", p.PasswordMinLength))
	}
	for _, req := range []struct {
		got, want int
		one, many string
	}{
		{digits, p.PasswordMinDigits, "a number", "numbers"},
		{upper, p.PasswordMinUpper, "a capital letter", "capital letters"},
		{lower, p.PasswordMinLower, "a lowercase letter", "lowercase letters"},
		{symbols, p.PasswordMinSymbols, "a symbol", "symbols"},
	} {
		if req.want <= 0 || req.got >= req.want {
			continue
		}
		if req.want == 1 {
			missing = append(missing, req.one)
			continue
		}
		missing = append(missing, fmt.Sprintf("at least %d %s", req.want, req.many))
	}

	if len(missing) == 0 {
		return nil
	}
	return fmt.Errorf("Password must contain %s", joinWithAnd(missing))
}

/*
PasswordRequirements is the same rules as a list of sentences, for a form to
show BEFORE somebody types rather than after they submit.

The screens that set passwords are the ones that need this — a rule discovered
by having a submission rejected is a rule the policy failed to communicate.
*/
func PasswordRequirements() []string {
	p := Policy()
	out := []string{fmt.Sprintf("At least %d characters", p.PasswordMinLength)}
	for _, req := range []struct {
		want      int
		one, many string
	}{
		{p.PasswordMinDigits, "At least one number", "At least %d numbers"},
		{p.PasswordMinUpper, "At least one capital letter", "At least %d capital letters"},
		{p.PasswordMinLower, "At least one lowercase letter", "At least %d lowercase letters"},
		{p.PasswordMinSymbols, "At least one symbol (for example ! ? # @)", "At least %d symbols"},
	} {
		switch {
		case req.want <= 0:
		case req.want == 1:
			out = append(out, req.one)
		default:
			out = append(out, fmt.Sprintf(req.many, req.want))
		}
	}
	if p.PasswordHistory > 0 {
		out = append(out, fmt.Sprintf("Not one of your last %d passwords", p.PasswordHistory))
	}
	return out
}

// joinWithAnd renders a list the way a sentence does: "a, b and c".
func joinWithAnd(parts []string) string {
	switch len(parts) {
	case 0:
		return ""
	case 1:
		return parts[0]
	}
	return strings.Join(parts[:len(parts)-1], ", ") + " and " + parts[len(parts)-1]
}

/* ── History ──────────────────────────────────────────────────────────────── */

/*
PasswordReused reports whether pw is one of this account's last N passwords.

`key` is the identity the LOGIN authenticates on — a client's username, a Super
Admin's email — not a row id. A client's password is written to every active row
sharing a username, so a per-row history would let the same person put an old
password back by changing it from a different account.

Fails OPEN. If the history cannot be read, the change is allowed rather than
blocked: refusing every password change because a table is unavailable locks
people out of the one action that clears a lockout, and the cost of the failure
landing the other way is one reused password.
*/
func PasswordReused(acctType, key, pw string) bool {
	p := Policy()
	if p.PasswordHistory <= 0 || pw == "" {
		return false
	}
	key = strings.TrimSpace(key)
	if key == "" {
		return false
	}
	ensureSecurityPolicySchema()

	rows, err := db.Query(
		"SELECT password_hash FROM "+passwordHistoryTable+
			" WHERE account_type = ? AND account_key = ?"+
			" ORDER BY created_at DESC, id DESC LIMIT ?",
		acctType, key, p.PasswordHistory)
	if err != nil {
		log.Printf("[password-history] read %s/%s: %v", acctType, key, err)
		return false
	}
	for _, r := range rows {
		// bcrypt, so this is a hash-and-compare per row, not a string match.
		// Bounded by PasswordHistory, which is why that number is clamped.
		if ipauth.VerifyPassword(pw, strFromAny(r["password_hash"])) {
			return true
		}
	}
	return false
}

/*
RecordPasswordHistory remembers a hash that has just been set, and forgets the
ones that have fallen out of the window.

Called with the hash rather than the password: nothing here should ever hold a
plaintext password, including for the length of a function call.

Pruning keeps a few more than the policy asks for — the window can be widened on
the settings screen, and having deleted exactly N leaves the new N-plus-two with
nothing to check against until people start changing passwords again.
*/
func RecordPasswordHistory(acctType, key, hash string) {
	key = strings.TrimSpace(key)
	if key == "" || hash == "" {
		return
	}
	ensureSecurityPolicySchema()

	if err := db.MustExec(
		"INSERT INTO "+passwordHistoryTable+" (account_type, account_key, password_hash, created_at) "+
			"VALUES (?, ?, ?, UTC_TIMESTAMP())", acctType, key, hash); err != nil {
		log.Printf("[password-history] write %s/%s: %v", acctType, key, err)
		return
	}

	const keepSpare = 8
	keep := Policy().PasswordHistory + keepSpare

	/* Delete by id below the keep-th newest.

	   Written as a derived table because MySQL refuses a subquery that selects
	   from the same table being deleted from; wrapping it in one materialises
	   the result first, which is the standard way around that restriction.

	   OFFSET counts from the newest, so this keeps exactly `keep` rows and
	   removes whatever is older. */
	if _, _, err := db.Exec(
		"DELETE FROM "+passwordHistoryTable+
			" WHERE account_type = ? AND account_key = ? AND id < ("+
			"  SELECT cutoff FROM ("+
			"    SELECT id AS cutoff FROM "+passwordHistoryTable+
			"     WHERE account_type = ? AND account_key = ?"+
			"     ORDER BY created_at DESC, id DESC LIMIT 1 OFFSET ?"+
			"  ) AS keep_window"+
			")",
		acctType, key, acctType, key, keep); err != nil {
		// Nothing to prune yet is the usual reason the subquery is empty, and
		// an unpruned history is harmless — it only ever holds more hashes than
		// the window reads.
		log.Printf("[password-history] prune %s/%s: %v", acctType, key, err)
	}
}

/*
reusedPasswordMessage is what somebody is told when their new password is one
they have used before.

Says HOW FAR BACK the rule reaches. "Choose a different password" leaves the
person guessing whether the one from last month counts; naming the window tells
them exactly how far to go.
*/
func reusedPasswordMessage() string {
	return fmt.Sprintf(
		"That is one of your last %d passwords. Please choose one you have not used before.",
		Policy().PasswordHistory)
}

/*
historyAcctType maps the reset token's account_type onto the one the history
table uses.

They are spelled the same today. The mapping exists so that a token vocabulary
which grows a third value cannot silently start writing history under a key
nothing reads back.
*/
func historyAcctType(tokenAccountType string) string {
	if tokenAccountType == "super_admin" {
		return AcctSuperAdmin
	}
	return AcctLogin
}

/*
passwordHistoryKey resolves the identity a password reset is FOR.

A reset token names a row; the history is keyed by what the login authenticates
on, which for a client is the username shared across their accounts and for a
Super Admin is the email. Returns "" when the row has gone, which makes both
PasswordReused and RecordPasswordHistory no-ops rather than writing history
under an empty key that would then match every other orphan.
*/
func passwordHistoryKey(tokenAccountType string, targetID int64) string {
	if targetID == 0 {
		return ""
	}
	if tokenAccountType == "super_admin" {
		row, _ := db.QueryOne("SELECT email FROM dcp_super_admin WHERE id = ? LIMIT 1", targetID)
		if row == nil {
			return ""
		}
		return strFromAny(row["email"])
	}
	row, _ := db.QueryOne("SELECT login_username FROM dcp_user_login WHERE loginId = ? LIMIT 1", targetID)
	if row == nil {
		return ""
	}
	return strFromAny(row["login_username"])
}

/*
GET /api/password-policy — what a password has to look like.

UNAUTHENTICATED, because the screens that most need it are: the reset-password
page reached from an email link, and the forgot-password form. Someone who
cannot sign in is exactly the person being asked to invent a password, and
telling them the rules only after they guess wrong is the worst moment to do it.

Safe to publish. These numbers are a floor an attacker already has to satisfy to
have a password accepted, and knowing "at least 8 with a digit" narrows a search
space that the lockout policy is what actually protects. Nothing account-specific
is returned — no history, no hashes, no hint that an account exists.
*/
func PasswordPolicyPublic(w http.ResponseWriter, r *http.Request) {
	p := Policy()
	OK(w, map[string]any{
		"success":      true,
		"requirements": PasswordRequirements(),
		// The raw numbers as well, so a form can enforce the length in the
		// browser rather than only rendering a sentence about it.
		"minLength":  p.PasswordMinLength,
		"minDigits":  p.PasswordMinDigits,
		"minUpper":   p.PasswordMinUpper,
		"minLower":   p.PasswordMinLower,
		"minSymbols": p.PasswordMinSymbols,
		"history":    p.PasswordHistory,
	})
}
