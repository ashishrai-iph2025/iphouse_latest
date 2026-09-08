package handlers

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	ipauth "github.com/ip-house/iphouse-api/auth"
	"github.com/ip-house/iphouse-api/db"
	"github.com/ip-house/iphouse-api/email"
	"github.com/ip-house/iphouse-api/notify"
)

/*
The client's asset register, and the protection requests raised from it.

── WHAT THIS DOES NOT DO ────────────────────────────────────────────────────

It does not change protection. This service reads mediascan and never writes to
it, so "enable protection" cannot be an UPDATE here however much the button
looks like one. A request is a portal-side record plus two emails plus a bell
notification; a person applies it upstream. Every message this file sends says
so, because a button that appears to act and does not is worse than no button.

── Why the register is not just the calendar's endpoint ─────────────────────

/api/reports/assets serves the programme calendar and is gated on the Calendar
module. This is a different question with a different answer — a client user can
hold the calendar and not be trusted with the title register, or the reverse — so
it has its own grant (asset_user_access) and its own route. Both read the same
master through fetchAssetMaster, so there is one copy of the reading — the
calendar takes it whole, the register pages it (see assetregisterpage.go).
*/

const assetRequestTable = "asset_protection_requests"

var assetRequestOnce sync.Once

func ensureAssetRequestSchema() {
	assetRequestOnce.Do(func() {
		if _, _, err := db.Exec(`
			CREATE TABLE IF NOT EXISTS ` + assetRequestTable + ` (
			  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
			  login_id       INT UNSIGNED NOT NULL,
			  user_id        INT UNSIGNED NOT NULL DEFAULT 0,
			  asset_id       VARCHAR(64)  NOT NULL,
			  asset_name     VARCHAR(255) NOT NULL DEFAULT '',
			  request_action VARCHAR(16)  NOT NULL,
			  note           VARCHAR(1000) NOT NULL DEFAULT '',
			  requested_by   VARCHAR(191) NOT NULL DEFAULT '',
			  client_name    VARCHAR(191) NOT NULL DEFAULT '',
			  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
			  KEY idx_apr_login   (login_id),
			  KEY idx_apr_asset   (asset_id),
			  KEY idx_apr_created (created_at)
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`); err != nil {
			log.Printf("[asset-register] create %s: %v", assetRequestTable, err)
		}
	})
}

// EnsureAssetRequestSchema is called at boot alongside the access table.
func EnsureAssetRequestSchema() { ensureAssetRequestSchema() }

/*
requestDebounce is how long an identical request is treated as the same one.

Without it, a double click sends two emails to the client for one intention, and
the second is indistinguishable from a genuine follow-up. Bounded rather than
permanent because re-asking IS legitimate — a week later, with nothing having
happened, the client should get another message.
*/
const requestDebounce = time.Hour

/*
GET /api/assets/register?page=&pageSize=&q=&genre=&active=

ONE PAGE of the session's client register, filtered across the whole of it —
see assetregisterpage.go for why both halves of that sentence matter.

The reader's own recent requests come with it, so a row can show that it has
already been asked about. One response rather than two calls: the table cannot
render correctly without both, and fetching them separately makes a half-loaded
table a normal state.
*/
func AssetRegister(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	if !mayViewAssets(claims) {
		/* Deliberately the same wording whether the account is unknown to the
		   table or exists and is switched off. Neither reader can act on the
		   difference and only one of them should learn it. */
		Fail(w, 403, "The asset register is not enabled for this account")
		return
	}

	clientID, scoped, why := reportScope(claims, r.URL.Query().Get("clientId"))
	if !scoped {
		Fail(w, 403, why)
		return
	}
	if clientID == "" {
		Fail(w, 422, "A client is required")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()

	f := parseAssetFilter(r.URL.Query().Get)
	upstream, err := queryAssetMaster(ctx, clientID, assetUpstreamQuery(clientID, f))
	if err != nil {
		reportsUnavailable(w, r, err)
		return
	}

	body := assetPageBody(upstream, f)

	/*
		The unfiltered size of the register, asked for ONCE.

		"1,388 match this filter" needs something to be a fraction of, and the
		filtered count cannot supply it. It is a second COUNT upstream, so the page
		asks on mount and remembers the answer rather than paying for it on every
		page turn — the number does not change while somebody is reading.
	*/
	if truthyParam(r.URL.Query().Get("counts")) {
		all := assetUpstreamQuery(clientID, assetFilter{page: 1, pageSize: 1})
		all.Del("facets")
		if tot, terr := queryAssetMaster(ctx, clientID, all); terr == nil {
			body["totalAll"] = assetIntFrom(tot["total"])
		}
	}
	body["ok"] = true
	body["available"] = true
	/* The reader's own requests come with every page rather than only the
	   first: the table marks rows with them, and a mark that appears on page one
	   and vanishes on page two is worse than none. There are at most 200 of
	   them, so this is cheap. */
	body["requests"] = recentRequestsFor(claims.LoginID)
	OK(w, body)
}

// recentRequestsFor is what the table marks its rows with: the caller's own
// requests, newest first. Their own only — a request carries who asked and why,
// and that is not something to hand to a colleague who shares the client.
func recentRequestsFor(loginID int64) []map[string]any {
	ensureAssetRequestSchema()
	rows, err := db.Query(`
		SELECT id, asset_id, asset_name, request_action, note, created_at
		FROM `+assetRequestTable+`
		WHERE login_id = ?
		ORDER BY created_at DESC
		LIMIT 200`, loginID)
	if err != nil || rows == nil {
		return []map[string]any{}
	}
	return rows
}

/*
POST /api/assets/protection-request  { assetId, assetName, action, note }

action is "enable" or "disable" and nothing else — the word reaches two emails
and a notification title, so an unchecked value would be reflected into all
three.
*/
func AssetProtectionRequest(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	if !mayViewAssets(claims) {
		Fail(w, 403, "The asset register is not enabled for this account")
		return
	}
	ensureAssetRequestSchema()

	var body struct {
		AssetID string `json:"assetId"`
		Action  string `json:"action"`
		Note    string `json:"note"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		Fail(w, 400, "Could not read the request")
		return
	}

	assetID := strings.TrimSpace(body.AssetID)
	action := strings.ToLower(strings.TrimSpace(body.Action))
	if assetID == "" {
		Fail(w, 422, "An asset is required")
		return
	}
	if action != "enable" && action != "disable" {
		Fail(w, 422, "The request must be to enable or disable protection")
		return
	}
	note := strings.TrimSpace(body.Note)
	if len(note) > 1000 {
		note = note[:1000]
	}

	clientID, scoped, why := reportScope(claims, "")
	if !scoped || clientID == "" {
		Fail(w, 403, why)
		return
	}

	/*
		THE ASSET IS CHECKED AGAINST THE CLIENT'S OWN LIST, and this is the
		authorisation step rather than a validation nicety.

		assetId arrives from the browser. Without this, any account holding the
		grant could post another company's asset id and have its NAME read back to
		them in the confirmation email — a title-by-title probe of somebody else's
		register. The name is taken from the master here for the same reason: it is
		the client's record of what the title is called, not whatever the caller
		typed.
	*/
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	/* ONE ROW, by id, scoped to this client — not the whole register.

	   The master takes an Id filter for exactly this, so confirming that an asset
	   belongs to the caller costs an indexed lookup rather than a download of
	   everything the client owns. The client scope stays in the query: it is what
	   makes a miss mean "not yours" rather than "not found". */
	one := url.Values{}
	one.Set("ClientMasterId", clientID)
	one.Set("Id", assetID)
	one.Set("limit", "1")
	found, err := queryAssetMaster(ctx, clientID, one)
	if err != nil {
		reportsUnavailable(w, r, err)
		return
	}
	rows, _ := found["rows"].([]any)
	assetName, ok := assetNameIn(rows, assetID)
	if !ok {
		Fail(w, 404, "That asset is not on this account")
		return
	}

	// Already asked, recently, for the same thing — see requestDebounce.
	if row, _ := db.QueryOne(`
		SELECT id FROM `+assetRequestTable+`
		WHERE login_id = ? AND asset_id = ? AND request_action = ?
		  AND created_at > (UTC_TIMESTAMP() - INTERVAL ? SECOND)
		LIMIT 1`,
		claims.LoginID, assetID, action, int(requestDebounce.Seconds())); row != nil {
		OK(w, map[string]any{
			"success": true, "duplicate": true,
			"message": "That request has already been sent.",
		})
		return
	}

	person := strings.TrimSpace(claims.LoginFirstName + " " + claims.LoginLastName)
	if person == "" {
		person = claims.LoginUsername
	}

	if _, _, err := db.Exec(`
		INSERT INTO `+assetRequestTable+`
		  (login_id, user_id, asset_id, asset_name, request_action, note, requested_by, client_name)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		claims.LoginID, claims.UserID, assetID, assetName, action, note, person, claims.ClientName,
	); err != nil {
		log.Printf("[asset-register] record request: %v", err)
		Fail(w, 500, "The request could not be recorded")
		return
	}

	verb := "Start protection"
	if action == "disable" {
		verb = "Stop protection"
	}

	/* The bell. pushNotify fills in the actor and client from the session, and
	   the feed is already scoped so a plain client user sees their own events —
	   which is what makes this land in the requester's bell without a second
	   mechanism. Staff see it too, through the same feed. */
	pushNotify(claims, notify.Event{
		Type:    notify.TypeAssetProtection,
		Title:   verb + ": " + assetName,
		Message: person + " requested that protection be " + action + "d for this title.",
		Link:    "/profile",
		Meta: map[string]any{
			"assetId": assetID, "assetName": assetName,
			"action": action, "note": note,
		},
	})

	// Off the request path: a slow mail server must not make the button hang.
	go sendAssetProtectionEmails(claims, assetName, action, note, person)

	OK(w, map[string]any{"success": true})
}

/*
assetNameIn finds the asset in the client's rows and returns its recorded name.

Searched over the WHOLE register, not the page the reader is looking at. The
caller is authorising a request against an id the browser sent, so scoping the
search to a page would refuse a legitimate request for a title one scroll away.

Rows are []any of map[string]any because that is how the payload is passed
through. Compared case-insensitively: these ids are GUIDs and their case is not
stable across the tables they travel through.
*/
func assetNameIn(rows []any, assetID string) (string, bool) {
	for _, r := range rows {
		row, ok := r.(map[string]any)
		if !ok {
			continue
		}
		if strings.EqualFold(strings.TrimSpace(anyToString(row["Id"])), assetID) {
			name := strings.TrimSpace(anyToString(row["AssetName"]))
			if name == "" {
				name = "(untitled)"
			}
			return name, true
		}
	}
	return "", false
}

func anyToString(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case []byte:
		return string(t)
	default:
		b, err := json.Marshal(t)
		if err != nil {
			return ""
		}
		return strings.Trim(string(b), `"`)
	}
}

/*
sendAssetProtectionEmails sends the two messages this process runs on.

The client's address comes from dcp_user — the company row — and the requester's
is their login username, which is an email address on every client account here.
The duplicate guard is the same one sendUploadEmails carries: on a small client
those are frequently the same mailbox, and one person receiving two versions of
the same event reads as a bug in the platform.
*/
func sendAssetProtectionEmails(claims *ipauth.Claims, assetName, action, note, person string) {
	if claims == nil {
		return
	}
	defer func() {
		// A panic in a detached goroutine takes the whole process with it, and
		// this one runs after the response has already been written.
		if rec := recover(); rec != nil {
			log.Printf("[asset-register] email panic: %v", rec)
		}
	}()

	var clientEmail, clientName string
	if row, err := db.QueryOne(
		"SELECT email, name FROM dcp_user WHERE userId = ? LIMIT 1", claims.UserID); err == nil && row != nil {
		clientEmail = strFromAny(row["email"])
		clientName = strFromAny(row["name"])
	}
	if clientName == "" {
		clientName = claims.ClientName
	}

	if clientEmail != "" {
		if err := email.SendAssetProtectionClient(
			clientEmail, clientName, assetName, action, note, person); err != nil {
			log.Printf("[asset-register] client email: %v", err)
		}
	} else {
		/* Logged rather than swallowed. The client's address is where the
		   actionable half of this process goes, so a company row without one
		   means the request reached nobody who can apply it. */
		log.Printf("[asset-register] no email on dcp_user %d — the request for %q reached no client contact",
			claims.UserID, assetName)
	}

	userEmail := claims.LoginUsername
	if userEmail != "" && !strings.EqualFold(userEmail, clientEmail) {
		if err := email.SendAssetProtectionUser(userEmail, person, assetName, action, note); err != nil {
			log.Printf("[asset-register] user email: %v", err)
		}
	}
}

/*
GET /api/assets/access — does THIS session hold the grant.

The profile page asks before drawing the tab. Without it the tab would either
always show, and 403 for most people, or the page would have to infer the answer
from a failed register call, which cannot tell "not allowed" apart from "the
reporting service is down".
*/
func AssetAccessSelf(w http.ResponseWriter, r *http.Request) {
	OK(w, map[string]any{"success": true, "enabled": mayViewAssets(ClaimsFrom(r))})
}
