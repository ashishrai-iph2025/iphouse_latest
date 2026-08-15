// Package notify raises portal notifications for things people do in the
// portal — URL submissions, approval/rejection decisions, download requests and
// data-sharing uploads.
//
// ── Storage model ─────────────────────────────────────────────────────────
// An event is stored ONCE, with the actor and the client company it happened
// on. Who may see it is decided at READ time (see handlers.NotificationFeed),
// not at write time:
//
//	Admin / Super Admin  → every event, every client
//	Client Admin         → every event on their own company
//	Client user          → only the events they themselves caused
//
// Storing once and scoping on read means one event never has to be duplicated
// per recipient, and a person's visibility follows their current role rather
// than whatever it was when the event fired.
//
// Read state is per login (portal_notification_reads), so one viewer clearing
// their bell never hides an event from anyone else.
//
// This is deliberately separate from dcp_notifications, a legacy per-company
// table with no writer. It is also separate from activity.Log: that is the
// immutable audit trail of everything, this is a short actionable feed. Mixing
// them would either bury the feed in page views or force the audit trail to
// carry presentation text.
package notify

import (
	"encoding/json"
	"log"
	"sync"

	"github.com/ip-house/iphouse-api/db"
)

// Event types. Kept short and stable — the UI maps these to icons and labels.
const (
	TypeURLUpload       = "url_upload"
	TypeApprovalAction  = "approval_action"
	TypeDownloadRequest = "download_request"
	TypeDataSharing     = "data_sharing"
	// Raised by the background watcher when MarkScan finishes an extraction,
	// not by a user action — the only event type nobody triggers directly.
	TypeDownloadReady = "download_ready"
)

// Table names. Exported so the read side can't drift from the write side.
const (
	Table      = "portal_notifications"
	ReadsTable = "portal_notification_reads"
)

// Event is one admin-facing notification.
type Event struct {
	Type    string
	Title   string
	Message string

	// Who triggered it.
	ActorLoginID  int64
	ActorName     string
	ActorUsername string

	// Which client company it happened on.
	ClientUserID int64
	ClientName   string

	// Where an admin should go to follow up (optional, relative path).
	Link string

	Meta map[string]any
}

var schemaOnce sync.Once

// tableExists checks the current schema only, so it can never be confused by a
// same-named table in another database on the same server.
func tableExists(name string) bool {
	row, err := db.QueryOne(
		"SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?",
		name)
	if err != nil || row == nil {
		return false
	}
	switch v := row["c"].(type) {
	case int64:
		return v > 0
	case string:
		return v != "0" && v != ""
	case []byte:
		return string(v) != "0" && len(v) > 0
	}
	return false
}

func ensureSchema() {
	schemaOnce.Do(func() {
		// The feed started out admin-only. Carry any existing rows over to the
		// new name rather than stranding them in an orphan table — RENAME is a
		// no-op once the new table exists, so this is safe to run every boot.
		if tableExists("admin_notifications") && !tableExists(Table) {
			if _, _, err := db.Exec("RENAME TABLE admin_notifications TO " + Table); err != nil {
				log.Printf("[notify] rename admin_notifications: %v", err)
			}
		}
		if tableExists("admin_notification_reads") && !tableExists(ReadsTable) {
			if _, _, err := db.Exec("RENAME TABLE admin_notification_reads TO " + ReadsTable); err != nil {
				log.Printf("[notify] rename admin_notification_reads: %v", err)
			}
		}

		if _, _, err := db.Exec(`
			CREATE TABLE IF NOT EXISTS ` + Table + ` (
			  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
			  event_type     VARCHAR(48)  NOT NULL,
			  title          VARCHAR(200) NOT NULL,
			  message        VARCHAR(500) NOT NULL DEFAULT '',
			  actor_login_id INT UNSIGNED NOT NULL DEFAULT 0,
			  actor_name     VARCHAR(191) NOT NULL DEFAULT '',
			  actor_username VARCHAR(191) NOT NULL DEFAULT '',
			  client_user_id INT UNSIGNED NOT NULL DEFAULT 0,
			  client_name    VARCHAR(191) NOT NULL DEFAULT '',
			  link           VARCHAR(255) NOT NULL DEFAULT '',
			  metadata       TEXT         NULL DEFAULT NULL,
			  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
			  KEY idx_portal_notif_created (created_at),
			  KEY idx_portal_notif_type    (event_type),
			  KEY idx_portal_notif_client  (client_user_id),
			  KEY idx_portal_notif_actor   (actor_login_id)
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`); err != nil {
			log.Printf("[notify] create %s: %v", Table, err)
		}
		// Read state per login — the feed is shared, the read marks are not.
		if _, _, err := db.Exec(`
			CREATE TABLE IF NOT EXISTS ` + ReadsTable + ` (
			  notification_id BIGINT UNSIGNED NOT NULL,
			  login_id        INT UNSIGNED    NOT NULL,
			  read_at         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
			  PRIMARY KEY (notification_id, login_id),
			  KEY idx_portal_notif_read_login (login_id)
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`); err != nil {
			log.Printf("[notify] create %s: %v", ReadsTable, err)
		}
	})
}

// EnsureSchema creates the tables up front (called at boot) so the first read
// doesn't race the first write.
func EnsureSchema() { ensureSchema() }

func clip(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

// Push records an event. Fire-and-forget, on its own goroutine, and never
// surfaces an error to the caller: a notification failing must not fail the
// client action that triggered it (a takedown submission is the real work; the
// bell is a convenience).
func Push(ev Event) {
	go func() {
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("[notify] push panicked: %v", rec)
			}
		}()
		ensureSchema()

		var metaJSON *string
		if ev.Meta != nil {
			if b, err := json.Marshal(ev.Meta); err == nil {
				s := string(b)
				metaJSON = &s
			}
		}
		if _, _, err := db.Exec(`
			INSERT INTO `+Table+`
			  (event_type, title, message, actor_login_id, actor_name, actor_username,
			   client_user_id, client_name, link, metadata, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
			clip(ev.Type, 48), clip(ev.Title, 200), clip(ev.Message, 500),
			ev.ActorLoginID, clip(ev.ActorName, 191), clip(ev.ActorUsername, 191),
			ev.ClientUserID, clip(ev.ClientName, 191), clip(ev.Link, 255), metaJSON,
		); err != nil {
			log.Printf("[notify] insert %s failed: %v", ev.Type, err)
		}
	}()
}
