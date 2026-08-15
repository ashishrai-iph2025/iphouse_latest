package handlers

import (
	"fmt"
	"log"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/ip-house/iphouse-api/db"
	"github.com/ip-house/iphouse-api/email"
	"github.com/ip-house/iphouse-api/markscan"
	"github.com/ip-house/iphouse-api/notify"
)

// Download-request watcher.
//
// MarkScan processes a data extraction asynchronously: /api/download returns
// rows whose `processed` flag flips from false to true when the file is ready.
// Nothing pushes that change to us, and the client only learns about it by
// reloading the Download Request page. This background job polls each client's
// list and, on the FIRST time a request turns ready, emails the person who
// asked for it and raises a bell notification.
//
// "First time" is the whole point: state is persisted in download_request_watch
// so a restart, a second poll, or two servers running at once cannot re-notify
// for the same request. The notified_at stamp is written in the same UPDATE
// that flips processed, guarded on it still being NULL, so the transition is
// claimed exactly once.
//
// Attribution: MarkScan's list doesn't say who submitted a request, so
// DownloadTrigger records a claim (who asked, for what) and the watcher matches
// a newly-seen request to the oldest unmatched claim with the same
// platform/asset/date-range. Unmatched requests still notify the company — the
// client admin and IP House staff see them — they just can't be emailed to an
// individual.

const (
	// How often to re-check clients that have a request in flight.
	downloadPollInterval = 30 * time.Second
	// How often to sweep EVERY credentialed client for requests we haven't seen
	// before. The fast loop above only knows about clients with a tracked
	// request or a recent claim, so without this sweep a request that existed
	// before this feature shipped — or one submitted outside the portal — would
	// never be discovered and never notify. Deliberately slower than the poll:
	// it costs one MarkScan call per client.
	downloadDiscoverInterval = 5 * time.Minute
	// Only fast-poll clients with recent activity, so the tight loop's cost
	// tracks usage rather than total client count.
	downloadWatchWindowDays = 45
)

var downloadWatchOnce sync.Once

func ensureDownloadWatchSchema() {
	downloadWatchOnce.Do(func() {
		if _, _, err := db.Exec(`
			CREATE TABLE IF NOT EXISTS download_request_watch (
			  id                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
			  client_user_id     INT UNSIGNED NOT NULL,
			  request_id         VARCHAR(128) NOT NULL,
			  platform           VARCHAR(128) NOT NULL DEFAULT '',
			  asset_name         VARCHAR(191) NOT NULL DEFAULT '',
			  start_date         VARCHAR(32)  NOT NULL DEFAULT '',
			  end_date           VARCHAR(32)  NOT NULL DEFAULT '',
			  processed          TINYINT(1)   NOT NULL DEFAULT 0,
			  requester_login_id INT UNSIGNED NOT NULL DEFAULT 0,
			  requester_email    VARCHAR(191) NOT NULL DEFAULT '',
			  requester_name     VARCHAR(191) NOT NULL DEFAULT '',
			  notified_at        DATETIME     NULL DEFAULT NULL,
			  first_seen_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
			  updated_at         DATETIME     NULL DEFAULT NULL,
			  UNIQUE KEY uniq_download_watch (client_user_id, request_id),
			  KEY idx_download_watch_pending (processed, client_user_id)
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`); err != nil {
			log.Printf("[download-watch] create download_request_watch: %v", err)
		}
		// Claims let a discovered request be traced back to the person who
		// submitted it — MarkScan's own list carries no requester.
		if _, _, err := db.Exec(`
			CREATE TABLE IF NOT EXISTS download_request_claim (
			  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
			  client_user_id INT UNSIGNED NOT NULL,
			  login_id       INT UNSIGNED NOT NULL DEFAULT 0,
			  email          VARCHAR(191) NOT NULL DEFAULT '',
			  name           VARCHAR(191) NOT NULL DEFAULT '',
			  platform       VARCHAR(128) NOT NULL DEFAULT '',
			  asset_name     VARCHAR(191) NOT NULL DEFAULT '',
			  start_date     VARCHAR(32)  NOT NULL DEFAULT '',
			  end_date       VARCHAR(32)  NOT NULL DEFAULT '',
			  matched        TINYINT(1)   NOT NULL DEFAULT 0,
			  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
			  KEY idx_download_claim_open (client_user_id, matched, created_at)
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`); err != nil {
			log.Printf("[download-watch] create download_request_claim: %v", err)
		}
	})
}

// recordDownloadClaim is called by DownloadTrigger so a request discovered a
// few minutes later can be attributed to the person who submitted it.
func recordDownloadClaim(clientUserID, loginID int64, name, emailAddr, platform, asset, start, end string) {
	go func() {
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("[download-watch] claim panicked: %v", rec)
			}
		}()
		ensureDownloadWatchSchema()
		if _, _, err := db.Exec(`
			INSERT INTO download_request_claim
			  (client_user_id, login_id, email, name, platform, asset_name, start_date, end_date, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
			clientUserID, loginID, emailAddr, name, platform, asset, start, end); err != nil {
			log.Printf("[download-watch] claim insert failed: %v", err)
		}
	}()
}

// StartDownloadWatcher begins polling. Safe to call once at boot.
//
// Two loops: a fast one over clients with a request in flight, and a slow sweep
// that discovers requests the fast loop has never heard of.
func StartDownloadWatcher() {
	go func() {
		ensureDownloadWatchSchema()
		// Let the server finish coming up before the first pass.
		time.Sleep(10 * time.Second)
		log.Printf("[download-watch] started — polling every %s, discovery every %s",
			downloadPollInterval, downloadDiscoverInterval)

		// Discover first, so anything already outstanding is tracked before the
		// fast loop starts looking for transitions.
		runDownloadDiscoveryPass()

		poll := time.NewTicker(downloadPollInterval)
		defer poll.Stop()
		discover := time.NewTicker(downloadDiscoverInterval)
		defer discover.Stop()

		for {
			select {
			case <-poll.C:
				runDownloadWatchPass()
			case <-discover.C:
				runDownloadDiscoveryPass()
			}
		}
	}()
}

// runDownloadDiscoveryPass sweeps every client that has usable MarkScan
// credentials, so requests submitted before this feature existed (or outside
// the portal) get tracked. Newly-discovered requests are recorded without
// notifying; the fast loop notifies when one later flips to ready.
func runDownloadDiscoveryPass() {
	defer func() {
		if rec := recover(); rec != nil {
			log.Printf("[download-watch] discovery panicked: %v", rec)
		}
	}()

	rows, err := db.Query(`
		SELECT userId FROM dcp_user
		 WHERE deleted = 0
		   AND api_user_name IS NOT NULL AND api_user_name != ''
		   AND api_password IS NOT NULL AND api_password != ''`)
	if err != nil {
		log.Printf("[download-watch] discovery client list: %v", err)
		return
	}
	polled := 0
	for _, r := range rows {
		if id := numOf(r["userId"]); id != 0 {
			pollClientDownloads(id)
			polled++
		}
	}
	log.Printf("[download-watch] discovery pass: %d client(s) with API credentials swept", polled)
}

// runDownloadWatchPass polls every client with recent download activity.
func runDownloadWatchPass() {
	defer func() {
		if rec := recover(); rec != nil {
			log.Printf("[download-watch] pass panicked: %v", rec)
		}
	}()

	rows, err := db.Query(`
		SELECT DISTINCT client_user_id FROM (
			SELECT client_user_id FROM download_request_watch
			 WHERE processed = 0
			   AND first_seen_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)
			UNION
			SELECT client_user_id FROM download_request_claim
			 WHERE created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)
		) t`, downloadWatchWindowDays, downloadWatchWindowDays)
	if err != nil {
		log.Printf("[download-watch] client list: %v", err)
		return
	}
	for _, r := range rows {
		clientID := numOf(r["client_user_id"])
		if clientID == 0 {
			continue
		}
		pollClientDownloads(clientID)
	}
}

// watchDebug enables per-poll logging. Off by default because the fast loop
// runs every 30s; set DOWNLOAD_WATCH_DEBUG=1 to trace what the watcher sees.
var watchDebug = os.Getenv("DOWNLOAD_WATCH_DEBUG") == "1"

// pollClientDownloads reconciles one client's MarkScan download list against
// what we last saw, and notifies on any Pending → Ready transition.
func pollClientDownloads(clientUserID int64) {
	token := TokenForUser(clientUserID)
	if token == "" {
		// No usable API credentials — nothing to poll. Silent by default: at a
		// 30s cadence this would otherwise flood the log for every client whose
		// credentials are unset or wrong.
		if watchDebug {
			log.Printf("[download-watch] client=%d skipped — no MarkScan token", clientUserID)
		}
		return
	}
	raw, err := markscan.GetDownloadStatus(token)
	if err != nil {
		log.Printf("[download-watch] client=%d GetDownloadStatus: %v", clientUserID, err)
		return
	}

	var list []any
	switch v := raw.(type) {
	case []any:
		list = v
	case map[string]any:
		if d, ok := v["data"].([]any); ok {
			list = d
		}
	}
	if watchDebug {
		log.Printf("[download-watch] client=%d returned %d request(s)", clientUserID, len(list))
	}

	for _, item := range list {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		reqID := strings.TrimSpace(fmt.Sprint(coalesce(m, "id", "Id", "requestId")))
		if reqID == "" || reqID == "<nil>" {
			continue
		}
		platform := fmt.Sprint(coalesce(m, "platform", "Platform"))
		asset := fmt.Sprint(coalesce(m, "assetName", "AssetName", "asset_name"))
		start := fmt.Sprint(coalesce(m, "startDate", "StartDate", "start_date"))
		end := fmt.Sprint(coalesce(m, "endDate", "EndDate", "end_date"))
		processed := truthy(coalesce(m, "processed", "Processed"))

		reconcileDownloadRow(clientUserID, reqID, cleanNil(platform), cleanNil(asset),
			cleanNil(start), cleanNil(end), processed)
	}
}

// cleanNil turns fmt.Sprint's "<nil>" back into an empty string.
func cleanNil(s string) string {
	s = strings.TrimSpace(s)
	if s == "<nil>" {
		return ""
	}
	return s
}

// truthy reads MarkScan's processed flag, which arrives as bool, number or
// string depending on the endpoint.
func truthy(v any) bool {
	switch t := v.(type) {
	case bool:
		return t
	case float64:
		return t != 0
	case int64:
		return t != 0
	case string:
		s := strings.ToLower(strings.TrimSpace(t))
		return s == "1" || s == "true" || s == "yes"
	}
	return false
}

func reconcileDownloadRow(clientUserID int64, reqID, platform, asset, start, end string, processed bool) {
	existing, _ := db.QueryOne(`
		SELECT id, processed, notified_at, requester_login_id, requester_email, requester_name
		FROM download_request_watch WHERE client_user_id = ? AND request_id = ? LIMIT 1`,
		clientUserID, reqID)

	if existing == nil {
		// First sighting. Attribute it to the oldest matching open claim.
		loginID, reqEmail, reqName := matchDownloadClaim(clientUserID, platform, asset, start, end)
		p := 0
		if processed {
			p = 1
		}
		if _, _, err := db.Exec(`
			INSERT INTO download_request_watch
			  (client_user_id, request_id, platform, asset_name, start_date, end_date,
			   processed, requester_login_id, requester_email, requester_name,
			   first_seen_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
			clientUserID, reqID, platform, asset, start, end, p, loginID, reqEmail, reqName); err != nil {
			// A duplicate here means a concurrent pass inserted it first; the
			// next pass will handle any transition.
			return
		}
		// A request that is ALREADY ready on first sighting is not a transition
		// we observed — it may have completed long before this feature existed.
		// Recording it without notifying avoids a burst of stale emails the
		// first time the watcher runs.
		if watchDebug {
			state := "pending"
			if processed {
				state = "already ready (recorded, not announced)"
			}
			log.Printf("[download-watch] client=%d request=%s now tracked — %s (requester login=%d)",
				clientUserID, reqID, state, loginID)
		}
		return
	}

	wasProcessed := numOf(existing["processed"]) == 1
	if !processed || wasProcessed {
		return // no transition to act on
	}

	// Claim the transition atomically: only the writer that flips 0 → 1 while
	// notified_at is still NULL gets to notify. Anything else (another pass,
	// another server instance) sees 0 rows affected and stays quiet.
	_, affected, err := db.Exec(`
		UPDATE download_request_watch
		   SET processed = 1, notified_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP()
		 WHERE client_user_id = ? AND request_id = ? AND processed = 0 AND notified_at IS NULL`,
		clientUserID, reqID)
	if err != nil || affected == 0 {
		return
	}

	announceDownloadReady(clientUserID, reqID, platform, asset, start, end,
		numOf(existing["requester_login_id"]),
		strFromAny(existing["requester_email"]),
		strFromAny(existing["requester_name"]))
}

// matchDownloadClaim finds who submitted a request, by the details they chose.
// Oldest open claim wins, so two identical requests resolve in submission order.
//
// Attribution is what lets the REQUESTER see their own "download ready"
// notification — a plain client user's feed is filtered to actor_login_id, so
// an unattributed event is invisible to the very person who asked for it.
// Comparisons are therefore case- and whitespace-insensitive: MarkScan echoes
// the platform back with its own casing ("chomikuj" vs the "Chomikuj" the user
// picked), and an exact match would silently drop those.
func matchDownloadClaim(clientUserID int64, platform, asset, start, end string) (int64, string, string) {
	const selectClaim = `SELECT id, login_id, email, name FROM download_request_claim
		 WHERE client_user_id = ? AND matched = 0
		   AND LOWER(TRIM(platform)) = LOWER(TRIM(?))
		   AND LOWER(TRIM(asset_name)) = LOWER(TRIM(?))`

	// Most specific first: platform + asset + both dates.
	row, _ := db.QueryOne(selectClaim+`
		   AND TRIM(start_date) = TRIM(?) AND TRIM(end_date) = TRIM(?)
		 ORDER BY created_at ASC LIMIT 1`,
		clientUserID, platform, asset, start, end)

	if row == nil {
		// Then platform + asset alone — MarkScan sometimes normalises or omits
		// the dates it echoes back, which would otherwise lose the match.
		row, _ = db.QueryOne(selectClaim+` ORDER BY created_at ASC LIMIT 1`,
			clientUserID, platform, asset)
	}
	if row == nil {
		return 0, "", ""
	}
	db.Exec("UPDATE download_request_claim SET matched = 1 WHERE id = ?", numOf(row["id"]))
	return numOf(row["login_id"]), strFromAny(row["email"]), strFromAny(row["name"])
}

// announceDownloadReady sends the completion email and raises the bell
// notification. Both are best-effort and independent: a failing mail server
// must not cost the user their in-app notification.
func announceDownloadReady(clientUserID int64, reqID, platform, asset, start, end string,
	requesterLoginID int64, requesterEmail, requesterName string) {

	// Company name is for display on the notification only. The company's own
	// email address is deliberately NOT used as a recipient — see below.
	clientName := ""
	if row, _ := db.QueryOne("SELECT name FROM dcp_user WHERE userId = ? LIMIT 1", clientUserID); row != nil {
		clientName = strFromAny(row["name"])
	}

	// Display name for the notification and the email; `platform` itself stays
	// the wire value used for matching.
	scope := platformDisplay(platform)
	if scope == "" {
		scope = "All platforms"
	}
	period := ""
	if start != "" || end != "" {
		period = fmt.Sprintf("%s → %s", orDash(start), orDash(end))
	}

	// ── Bell notification ─────────────────────────────────────────────────
	// One row serves every audience: client_user_id makes it visible to the
	// company's Client Admins (and to staff, who see everything), while
	// actor_login_id makes it visible to the requester's own feed.
	notify.Push(notify.Event{
		Type:          notify.TypeDownloadReady,
		Title:         "Download ready",
		Message:       strings.TrimSpace(fmt.Sprintf("%s%s %s", scope, forAsset(asset), period)),
		ActorLoginID:  requesterLoginID,
		ActorName:     requesterName,
		ActorUsername: requesterEmail,
		ClientUserID:  clientUserID,
		ClientName:    clientName,
		Link:          "/download-request",
		Meta: map[string]any{
			"platform": platform, "assetName": asset,
			"startDate": start, "endDate": end,
			"requestId": reqID, "status": "Ready to download",
		},
	})

	// ── Email ─────────────────────────────────────────────────────────────
	// Goes to the LOGGED-IN person who requested the download, never to the
	// company address on dcp_user. The company mailbox is a billing/contact
	// address that may reach people who never asked for this extraction, so a
	// request that can't be attributed is left un-emailed rather than
	// broadcast — the Client Admin and IP House staff still see it in the bell.
	to, name := requesterLogin(requesterLoginID, requesterEmail, requesterName)
	if to == "" {
		log.Printf("[download-watch] client=%d request=%s ready, but the requester could not be identified — no email sent",
			clientUserID, reqID)
		return
	}
	if err := email.SendDownloadReady(to, name, scope, asset, start, end); err != nil {
		log.Printf("[download-watch] ready email to %s failed: %v", to, err)
		return
	}
	log.Printf("[download-watch] client=%d request=%s ready — emailed %s", clientUserID, reqID, to)
}

// requesterLogin resolves the address to email. The live dcp_user_login row
// wins over the address captured when the request was submitted, so a login
// whose username changed in between still receives it; the captured values are
// the fallback for a login that has since been deleted.
func requesterLogin(loginID int64, fallbackEmail, fallbackName string) (string, string) {
	// Named addr, not email — `email` is the imported mail package.
	addr := strings.TrimSpace(fallbackEmail)
	name := strings.TrimSpace(fallbackName)

	if loginID != 0 {
		if row, _ := db.QueryOne(
			"SELECT first_name, last_name, login_username FROM dcp_user_login WHERE loginId = ? LIMIT 1",
			loginID); row != nil {
			if u := strings.TrimSpace(strFromAny(row["login_username"])); u != "" {
				addr = u
			}
			if n := strings.TrimSpace(strFromAny(row["first_name"]) + " " + strFromAny(row["last_name"])); n != "" {
				name = n
			}
		}
	}

	if addr == "" {
		return "", ""
	}
	if name == "" {
		name = addr
	}
	return addr, name
}
