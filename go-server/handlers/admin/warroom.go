package admin

import (
	"encoding/json"
	"net/http"

	"github.com/ip-house/iphouse-api/db"
)

func ensureWarRoomSettingsTable() {
	db.Exec(`CREATE TABLE IF NOT EXISTS war_room_client_settings (
		user_id            INT NOT NULL PRIMARY KEY,
		comparison_enabled TINYINT(1) NOT NULL DEFAULT 0,
		updated_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
}

// GET/POST /api/admin/warroom-settings — per-client War Room configuration.
// Currently one flag: whether the Asset Comparison tab is visible to that
// client (default off; admins always see it regardless).
func WarRoomSettings(w http.ResponseWriter, r *http.Request) {
	ensureWarRoomSettingsTable()
	switch r.Method {
	case http.MethodGet:
		rows, _ := db.Query(`
			SELECT u.userId, u.name, u.email,
			       COALESCE(s.comparison_enabled, 0) AS comparison_enabled
			FROM dcp_user u
			LEFT JOIN war_room_client_settings s ON s.user_id = u.userId
			WHERE (u.role IS NULL OR u.role != 1) AND u.deleted = 0
			ORDER BY u.name`)
		if rows == nil {
			rows = []map[string]any{}
		}
		ok(w, map[string]any{"success": true, "clients": rows})
	case http.MethodPost:
		var body struct {
			UserID            int64 `json:"userId"`
			ComparisonEnabled bool  `json:"comparisonEnabled"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if body.UserID == 0 {
			fail(w, 422, "userId is required"); return
		}
		v := 0
		if body.ComparisonEnabled {
			v = 1
		}
		db.Exec(`INSERT INTO war_room_client_settings (user_id, comparison_enabled) VALUES (?, ?)
			ON DUPLICATE KEY UPDATE comparison_enabled = ?`, body.UserID, v, v)
		ok(w, map[string]any{"success": true})
	default:
		fail(w, 405, "Method not allowed")
	}
}
