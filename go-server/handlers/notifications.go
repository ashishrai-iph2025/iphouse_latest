package handlers

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"

	ipauth "github.com/ip-house/iphouse-api/auth"
	"github.com/ip-house/iphouse-api/db"
	"github.com/ip-house/iphouse-api/notify"
)

// Portal notification feed — available to every authenticated user, scoped to
// what that user is entitled to see.
//
// Events are stored once (see package notify) and filtered here, so one event
// serves every audience and a person's visibility always follows their CURRENT
// role rather than whatever it was when the event fired.
//
//	Admin / Super Admin (role >= 1) → every event, every client
//	Client Admin                    → every event on their own company
//	Client user                     → only events they themselves caused
//
// The scope is derived from the session claims alone. Nothing in the request
// can widen it, so a client cannot ask for another company's feed.

type feedScope struct {
	where string
	args  []any
	label string // shown in the panel header
	kind  string // "all" | "company" | "self"
}

func scopeFor(claims *ipauth.Claims) feedScope {
	if claims.Role != nil && *claims.Role >= 1 {
		return feedScope{where: "", args: nil, label: "All clients", kind: "all"}
	}
	if claims.ClientAdmin {
		return feedScope{
			where: " AND n.client_user_id = ?",
			args:  []any{claims.UserID},
			label: claims.ClientName,
			kind:  "company",
		}
	}
	return feedScope{
		where: " AND n.actor_login_id = ?",
		args:  []any{claims.LoginID},
		label: "Your activity",
		kind:  "self",
	}
}

// GET /api/notifications/feed?limit=&type=&unread=1
func NotificationFeed(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	if claims == nil {
		Fail(w, 401, "Not authenticated")
		return
	}
	scope := scopeFor(claims)

	q := r.URL.Query()
	limit := 30
	if n, err := strconv.Atoi(q.Get("limit")); err == nil && n > 0 && n <= 200 {
		limit = n
	}
	offset := 0
	if n, err := strconv.Atoi(q.Get("offset")); err == nil && n > 0 {
		offset = n
	}

	// The read-marks join is keyed on the viewer's own login, so is_read is
	// per person even though the event row is shared.
	listArgs := append([]any{claims.LoginID}, scope.args...)
	where := scope.where
	if t := q.Get("type"); t != "" {
		where += " AND n.event_type = ?"
		listArgs = append(listArgs, t)
	}
	if q.Get("unread") == "1" {
		where += " AND rd.notification_id IS NULL"
	}
	// Free-text search across the human-readable columns, for the full list page.
	if s := strings.TrimSpace(q.Get("search")); s != "" {
		where += ` AND (n.title LIKE ? OR n.message LIKE ? OR n.client_name LIKE ?
		            OR n.actor_name LIKE ? OR n.actor_username LIKE ?)`
		like := "%" + s + "%"
		listArgs = append(listArgs, like, like, like, like, like)
	}

	// Total in scope for this filter set — drives pagination on the list page.
	total := int64(0)
	countArgs := make([]any, len(listArgs))
	copy(countArgs, listArgs)
	if row, err := db.QueryOne(`
		SELECT COUNT(*) AS c
		FROM `+notify.Table+` n
		LEFT JOIN `+notify.ReadsTable+` rd
		       ON rd.notification_id = n.id AND rd.login_id = ?
		WHERE 1=1`+where, countArgs...); err == nil && row != nil {
		total = numOf(row["c"])
	}

	listArgs = append(listArgs, limit, offset)
	rows, err := db.Query(`
		SELECT n.id, n.event_type, n.title, n.message, n.actor_name, n.actor_username,
		       n.client_user_id, n.client_name, n.link, n.metadata, n.created_at,
		       (rd.notification_id IS NOT NULL) AS is_read
		FROM `+notify.Table+` n
		LEFT JOIN `+notify.ReadsTable+` rd
		       ON rd.notification_id = n.id AND rd.login_id = ?
		WHERE 1=1`+where+`
		ORDER BY n.created_at DESC, n.id DESC
		LIMIT ? OFFSET ?`, listArgs...)
	if err != nil {
		// A missing table just means nothing has been raised yet — the writer
		// creates it on first Push. Report an empty feed, not an error.
		log.Printf("[notifications] list: %v", err)
		OK(w, map[string]any{"success": true, "items": []any{}, "unreadCount": 0, "total": 0,
			"scope": scope.kind, "scopeLabel": scope.label})
		return
	}
	if rows == nil {
		rows = []map[string]any{}
	}

	// Unread count deliberately ignores the search/type filters — the badge must
	// reflect everything unread in scope, not just what is currently listed.
	unread := int64(0)
	unreadArgs := append([]any{claims.LoginID}, scope.args...)
	if row, err := db.QueryOne(`
		SELECT COUNT(*) AS c
		FROM `+notify.Table+` n
		LEFT JOIN `+notify.ReadsTable+` rd
		       ON rd.notification_id = n.id AND rd.login_id = ?
		WHERE rd.notification_id IS NULL`+scope.where, unreadArgs...); err == nil && row != nil {
		unread = numOf(row["c"])
	}

	OK(w, map[string]any{
		"success":     true,
		"items":       rows,
		"total":       total,
		"unreadCount": unread,
		"scope":       scope.kind,
		"scopeLabel":  scope.label,
	})
}

// GET /api/notifications/feed/{id} — one notification in full.
//
// Same scope predicate as the list, so an id outside the caller's visibility is
// indistinguishable from one that doesn't exist. The actor's contact details
// are resolved here rather than denormalised at write time, so a renamed user
// reads correctly on old notifications.
func NotificationDetail(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	if claims == nil {
		Fail(w, 401, "Not authenticated")
		return
	}
	scope := scopeFor(claims)

	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if id == 0 {
		Fail(w, 422, "A notification id is required")
		return
	}

	args := append([]any{claims.LoginID, id}, scope.args...)
	row, err := db.QueryOne(`
		SELECT n.id, n.event_type, n.title, n.message, n.actor_login_id,
		       n.actor_name, n.actor_username, n.client_user_id, n.client_name,
		       n.link, n.metadata, n.created_at,
		       (rd.notification_id IS NOT NULL) AS is_read,
		       rd.read_at
		FROM `+notify.Table+` n
		LEFT JOIN `+notify.ReadsTable+` rd
		       ON rd.notification_id = n.id AND rd.login_id = ?
		WHERE n.id = ?`+scope.where+`
		LIMIT 1`, args...)
	if err != nil {
		log.Printf("[notifications] detail id=%d: %v", id, err)
		Fail(w, 500, "Could not load this notification")
		return
	}
	if row == nil {
		Fail(w, 404, "Notification not found")
		return
	}

	// Live actor details. Best-effort: a login that has since been removed just
	// leaves the denormalised name/username on the notification itself.
	actor := map[string]any{
		"name":     strFromAny(row["actor_name"]),
		"username": strFromAny(row["actor_username"]),
	}
	if lid := numOf(row["actor_login_id"]); lid != 0 {
		if a, _ := db.QueryOne(`
			SELECT l.loginId, l.first_name, l.last_name, l.login_username, l.login_type,
			       l.is_active, l.is_client_admin, u.name AS client_name, u.email AS client_email,
			       (sa.id IS NOT NULL) AS is_staff
			FROM dcp_user_login l
			INNER JOIN dcp_user u ON u.userId = l.userId
			LEFT JOIN dcp_super_admin sa
			       ON CONVERT(sa.email USING utf8mb4) COLLATE utf8mb4_general_ci
			        = CONVERT(l.login_username USING utf8mb4) COLLATE utf8mb4_general_ci
			      AND sa.is_active = 1
			WHERE l.loginId = ? LIMIT 1`, lid); a != nil {
			for k, v := range a {
				actor[k] = v
			}
		}
	}

	OK(w, map[string]any{
		"success":      true,
		"notification": row,
		"actor":        actor,
		"scope":        scope.kind,
		"scopeLabel":   scope.label,
	})
}

// POST /api/notifications/feed/read — { "id": 12 } or { "all": true }
func NotificationFeedRead(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	if claims == nil {
		Fail(w, 401, "Not authenticated")
		return
	}
	scope := scopeFor(claims)

	var body struct {
		ID  int64 `json:"id"`
		All bool  `json:"all"`
	}
	json.NewDecoder(r.Body).Decode(&body)

	if body.All {
		// INSERT ... SELECT marks everything in scope this viewer hasn't marked.
		// The scope predicate matters: without it a client user marking "all"
		// would write read rows for events they can't even see. IGNORE covers
		// the race where two tabs mark-all at the same moment.
		args := append([]any{claims.LoginID}, scope.args...)
		if _, _, err := db.Exec(`
			INSERT IGNORE INTO `+notify.ReadsTable+` (notification_id, login_id, read_at)
			SELECT n.id, ?, UTC_TIMESTAMP() FROM `+notify.Table+` n
			WHERE 1=1`+scope.where, args...); err != nil {
			log.Printf("[notifications] mark all read: %v", err)
			Fail(w, 500, "Could not update notifications")
			return
		}
		OK(w, map[string]any{"success": true})
		return
	}

	if body.ID == 0 {
		Fail(w, 422, "id or all required")
		return
	}

	// Marking one still goes through the scope, so an id guessed from outside
	// the caller's visibility silently affects nothing.
	args := append([]any{claims.LoginID, body.ID}, scope.args...)
	if _, _, err := db.Exec(`
		INSERT IGNORE INTO `+notify.ReadsTable+` (notification_id, login_id, read_at)
		SELECT n.id, ?, UTC_TIMESTAMP() FROM `+notify.Table+` n
		WHERE n.id = ?`+scope.where, args...); err != nil {
		log.Printf("[notifications] mark read id=%d: %v", body.ID, err)
		Fail(w, 500, "Could not update this notification")
		return
	}
	OK(w, map[string]any{"success": true})
}
