package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/ip-house/iphouse-api/activity"
	"github.com/ip-house/iphouse-api/db"
)

/*
POST /api/admin/unlock-login — lift a sign-in lockout by hand.

The lockout exists to make guessing expensive, and it charges the same price to
somebody who simply mistyped their own password five times. Waiting out the
policy's hours is the correct behaviour for an attacker and a poor one for a
colleague on the phone, so an admin can end it.

── Why it clears everything for the person ──────────────────────────────────

A lock is recorded per (account_type, account_id, kind), and one person is
several of those: a login row per company, a dcp_super_admin row if they are
staff, and a password counter beside an OTP counter. "Unlock this account" means
they can sign in, and that is only true when none of those rows is holding them.
Clearing one and leaving the rest would produce an account that reads unlocked
in the list and still refuses at the door.

── Why it lives in package handlers ─────────────────────────────────────────

ClearFailures and the ledger are here, and handlers/admin deliberately does not
import handlers — see the note on isUUID36 in admin/clients.go. Mounted with
adminAuth from main, like the rest of the account screens.
*/
func AdminUnlockLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		LoginUsername string `json:"loginUsername"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	username := strings.TrimSpace(body.LoginUsername)
	if username == "" {
		Fail(w, 422, "loginUsername is required")
		return
	}

	cleared := 0

	// Every company row this person holds.
	rows, _ := db.Query(
		"SELECT loginId FROM dcp_user_login WHERE login_username = ?", username)
	for _, row := range rows {
		if id := numOf(row["loginId"]); id > 0 {
			ClearFailures(AcctLogin, id, FailPassword, FailOTP)
			cleared++
		}
	}

	/* And their staff row, if they have one. A different id space, so it cannot
	   be folded into the loop above — and an Admin locked out of the console is
	   exactly the person least able to unlock themselves. */
	if sa, _ := db.QueryOne(
		"SELECT id FROM dcp_super_admin WHERE email = ? LIMIT 1", username); sa != nil {
		if id := numOf(sa["id"]); id > 0 {
			ClearFailures(AcctSuperAdmin, id, FailPassword, FailOTP)
			cleared++
		}
	}

	if cleared == 0 {
		Fail(w, 404, "No account found for that username")
		return
	}

	// Audited: lifting a lockout is a security decision, and the trail should
	// say who made it — the same table the Tracking Report reads.
	var actor int64
	if claims := ClaimsFrom(r); claims != nil {
		actor = claims.LoginID
	}
	go activity.Log(actor, "login_unlocked", "admin/registrations",
		activity.GetIP(r), activity.GetUA(r),
		map[string]any{"targetUser": username, "rowsCleared": cleared})

	OK(w, map[string]any{"success": true})
}
