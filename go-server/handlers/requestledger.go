package handlers

import (
	"log"
	"strings"
	"sync"
	"time"

	ipauth "github.com/ip-house/iphouse-api/auth"
	"github.com/ip-house/iphouse-api/db"
)

// Per-user attribution for the two company-shared MarkScan feeds.
//
// One MarkScan API token serves EVERY login attached to a company, so both
// /GetDownloadStatus and /GetInfringementHistory come back company-wide: two
// colleagues sharing an account see each other's requests with no way to tell
// them apart. Upstream carries no requester field, so attribution has to be
// recorded on our side at the moment the request is made, then applied as a
// filter when the list is read back.
//
//	Downloads → download_request_watch.requester_login_id, resolved by the
//	            watcher from download_request_claim (see download_watch.go).
//	Uploads   → url_upload_claim, one row per submitted URL, written here.
//
// Visibility mirrors the notification feed's vocabulary so the two never
// disagree (see scopeFor in notifications.go):
//
//	IP House staff (role >= 1) → every request
//	Client Admin               → every request for their own company
//	Client user                → only the requests they made themselves
//
// A row we cannot attribute — submitted before this ledger existed, or straight
// against the MarkScan API rather than through the portal — is treated as NOT
// the caller's. It stays visible to Client Admins and staff, who can see the
// company's whole history, but a plain user's list only ever shows work that is
// provably theirs.

// seesAllCompanyRequests reports whether this session may see every login's
// requests for the company rather than only its own.
func seesAllCompanyRequests(claims *ipauth.Claims) bool {
	if claims == nil {
		return false
	}
	if claims.Role != nil && *claims.Role >= 1 {
		return true // IP House Admin / Super Admin
	}
	return claims.ClientAdmin
}

// requestScope names what the caller is being shown, for the UI to label.
func requestScope(claims *ipauth.Claims) string {
	if seesAllCompanyRequests(claims) {
		return "company"
	}
	return "self"
}

// How far back a ledger lookup reaches, and the row ceiling on one lookup. A
// bulk upload is one row per URL, so an unbounded read could be very large;
// beyond this the oldest rows fall out of the filter (they stay in the table).
const (
	ledgerLookbackDays = 400
	ledgerMaxRows      = 50000
)

// normURL is the comparison form of a URL: MarkScan echoes back what it stored,
// which may differ from what was submitted in case or surrounding whitespace.
func normURL(u string) string { return strings.ToLower(strings.TrimSpace(u)) }

/* ── Upload ledger ────────────────────────────────────────────────────────── */

var uploadClaimOnce sync.Once

func ensureUploadClaimSchema() {
	uploadClaimOnce.Do(func() {
		// url_key is the indexable prefix of the normalised URL (191 chars keeps
		// it inside the utf8mb4 index limit); matching itself is done in Go on
		// the full value, so a shared prefix never merges two distinct URLs.
		if _, _, err := db.Exec(`
			CREATE TABLE IF NOT EXISTS url_upload_claim (
			  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
			  client_user_id INT UNSIGNED NOT NULL,
			  login_id       INT UNSIGNED NOT NULL DEFAULT 0,
			  email          VARCHAR(191)  NOT NULL DEFAULT '',
			  name           VARCHAR(191)  NOT NULL DEFAULT '',
			  platform       VARCHAR(128)  NOT NULL DEFAULT '',
			  asset_name     VARCHAR(191)  NOT NULL DEFAULT '',
			  url            VARCHAR(2048) NOT NULL,
			  url_key        VARCHAR(191)  NOT NULL DEFAULT '',
			  created_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
			  KEY idx_upload_claim_mine (client_user_id, login_id, created_at),
			  KEY idx_upload_claim_url (client_user_id, url_key)
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`); err != nil {
			log.Printf("[request-ledger] create url_upload_claim: %v", err)
		}
	})
}

// recordUploadClaim writes who submitted which URLs. Fire-and-forget: the
// submission itself has already succeeded upstream, so a ledger failure must not
// turn a good request into an error — it only costs that batch its attribution.
func recordUploadClaim(claims *ipauth.Claims, platform, asset string, urls []string) {
	if claims == nil || len(urls) == 0 {
		return
	}
	clientUserID, loginID := claims.UserID, claims.LoginID
	email := claims.LoginUsername
	name := strings.TrimSpace(claims.LoginFirstName + " " + claims.LoginLastName)
	if name == "" {
		name = email
	}
	// Copy: the caller's slice may be reused once the handler returns.
	list := make([]string, 0, len(urls))
	for _, u := range urls {
		if u = strings.TrimSpace(u); u != "" {
			list = append(list, u)
		}
	}

	go func() {
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("[request-ledger] upload claim panicked: %v", rec)
			}
		}()
		ensureUploadClaimSchema()

		// Chunked multi-row INSERT — a 5,000-URL batch in one statement would
		// blow past max_allowed_packet.
		const chunk = 500
		for start := 0; start < len(list); start += chunk {
			end := start + chunk
			if end > len(list) {
				end = len(list)
			}
			part := list[start:end]

			values := make([]string, 0, len(part))
			args := make([]any, 0, len(part)*8)
			for _, u := range part {
				key := normURL(u)
				if len(key) > 191 {
					key = key[:191]
				}
				values = append(values, "(?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())")
				args = append(args, clientUserID, loginID, email, name, platform, asset, u, key)
			}
			if _, _, err := db.Exec(`
				INSERT INTO url_upload_claim
				  (client_user_id, login_id, email, name, platform, asset_name, url, url_key, created_at)
				VALUES `+strings.Join(values, ","), args...); err != nil {
				log.Printf("[request-ledger] upload claim insert (%d urls): %v", len(part), err)
				return
			}
		}
	}()
}

// uploadOwner is who submitted a URL, for display on the company-wide view.
type uploadOwner struct {
	loginID int64
	name    string
	email   string
}

// uploadLedger maps normalised URL → submitter. When all is false only the
// caller's own rows are loaded, which is also what makes the map double as the
// visibility filter: a URL absent from it is not theirs.
func uploadLedger(clientUserID, loginID int64, all bool) map[string]uploadOwner {
	ensureUploadClaimSchema()

	q := `SELECT url, login_id, name, email FROM url_upload_claim
	       WHERE client_user_id = ?
	         AND created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)`
	args := []any{clientUserID, ledgerLookbackDays}
	if !all {
		q += " AND login_id = ?"
		args = append(args, loginID)
	}
	q += " ORDER BY id DESC LIMIT ?"
	args = append(args, ledgerMaxRows)

	rows, err := db.Query(q, args...)
	if err != nil {
		log.Printf("[request-ledger] upload ledger read: %v", err)
		return map[string]uploadOwner{}
	}
	out := make(map[string]uploadOwner, len(rows))
	for _, r := range rows {
		u := normURL(strFromAny(r["url"]))
		if u == "" {
			continue
		}
		// ORDER BY id DESC + first-write-wins keeps the most recent submitter.
		if _, seen := out[u]; seen {
			continue
		}
		out[u] = uploadOwner{
			loginID: numOf(r["login_id"]),
			name:    strFromAny(r["name"]),
			email:   strFromAny(r["email"]),
		}
	}
	return out
}

/* ── Download ledger ──────────────────────────────────────────────────────── */

// downloadRequester is the attribution the watcher resolved for one request.
type downloadRequester struct {
	loginID int64
	name    string
	email   string
}

// downloadClaim is a request this login submitted that the watcher has not yet
// matched to a MarkScan row.
type downloadClaim struct{ platform, asset, start, end string }

type downloadLedger struct {
	byRequestID map[string]downloadRequester
	myOpen      []downloadClaim
	myLoginID   int64
}

// downloadLedgerFor loads attribution for one company, plus the caller's own
// unmatched claims.
//
// The open claims close a real gap: the watcher attributes a request on its next
// poll (up to 30s later), but the page reloads its history the moment the
// request is submitted. Without them, a user would submit a download and watch
// it not appear.
func downloadLedgerFor(clientUserID, loginID int64) downloadLedger {
	ensureDownloadWatchSchema()

	l := downloadLedger{byRequestID: map[string]downloadRequester{}, myLoginID: loginID}

	rows, err := db.Query(`
		SELECT request_id, requester_login_id, requester_name, requester_email
		  FROM download_request_watch
		 WHERE client_user_id = ?`, clientUserID)
	if err != nil {
		log.Printf("[request-ledger] download watch read: %v", err)
	}
	for _, r := range rows {
		id := strings.TrimSpace(strFromAny(r["request_id"]))
		if id == "" {
			continue
		}
		l.byRequestID[id] = downloadRequester{
			loginID: numOf(r["requester_login_id"]),
			name:    strFromAny(r["requester_name"]),
			email:   strFromAny(r["requester_email"]),
		}
	}

	open, err := db.Query(`
		SELECT platform, asset_name, start_date, end_date
		  FROM download_request_claim
		 WHERE client_user_id = ? AND login_id = ? AND matched = 0
		   AND created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 DAY)`,
		clientUserID, loginID)
	if err != nil {
		log.Printf("[request-ledger] download claim read: %v", err)
	}
	for _, r := range open {
		l.myOpen = append(l.myOpen, downloadClaim{
			platform: strFromAny(r["platform"]),
			asset:    strFromAny(r["asset_name"]),
			start:    strFromAny(r["start_date"]),
			end:      strFromAny(r["end_date"]),
		})
	}
	return l
}

func (l downloadLedger) requester(reqID string) (downloadRequester, bool) {
	r, ok := l.byRequestID[strings.TrimSpace(reqID)]
	return r, ok
}

// isMine reports whether the caller submitted this request. Attribution by id
// wins; failing that, an unmatched claim of the caller's with the same
// platform + asset counts, since that is what the watcher is about to match.
// Dates are not compared here — MarkScan normalises or omits the ones it echoes
// back, and matchDownloadClaim already falls back the same way.
func (l downloadLedger) isMine(reqID, platform, asset string) bool {
	if r, ok := l.requester(reqID); ok {
		return r.loginID != 0 && r.loginID == l.myLoginID
	}
	for _, c := range l.myOpen {
		if strings.EqualFold(strings.TrimSpace(c.platform), strings.TrimSpace(platform)) &&
			strings.EqualFold(strings.TrimSpace(c.asset), strings.TrimSpace(asset)) {
			return true
		}
	}
	return false
}

// reconcileDownloadsSoon nudges the watcher to attribute a just-submitted
// request instead of waiting for its next tick, so the history the user reloads
// a moment later already shows it.
func reconcileDownloadsSoon(clientUserID int64) {
	go func() {
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("[request-ledger] eager reconcile panicked: %v", rec)
			}
		}()
		// MarkScan needs a moment to register the request before it appears in
		// the status list.
		time.Sleep(3 * time.Second)
		pollClientDownloads(clientUserID)
	}()
}

// ownerLabel renders a submitter for display, preferring the name.
func (o uploadOwner) label() string {
	if n := strings.TrimSpace(o.name); n != "" {
		return n
	}
	return strings.TrimSpace(o.email)
}

func (r downloadRequester) label() string {
	if n := strings.TrimSpace(r.name); n != "" {
		return n
	}
	return strings.TrimSpace(r.email)
}
