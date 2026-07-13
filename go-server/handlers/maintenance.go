package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/ip-house/iphouse-api/db"
	"github.com/ip-house/iphouse-api/middleware"
)

// GET /api/maintenance — public: the SPA checks this to decide whether to
// show the under-maintenance page.
func MaintenanceStatus(w http.ResponseWriter, r *http.Request) {
	on, msg := middleware.MaintenanceStatus()
	OK(w, map[string]any{"success": true, "maintenance": on, "message": msg})
}

// POST /api/admin/maintenance — Super Admin toggles maintenance mode.
func MaintenanceUpdate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Enabled bool   `json:"enabled"`
		Message string `json:"message"`
	}
	json.NewDecoder(r.Body).Decode(&body)

	val := "0"
	if body.Enabled {
		val = "1"
	}
	upsert := "INSERT INTO dcp_settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = ?"
	if _, _, err := db.Exec(upsert, "maintenance_mode", val, val); err != nil {
		Fail(w, 500, "Failed to save maintenance mode"); return
	}
	db.Exec(upsert, "maintenance_message", body.Message, body.Message)

	middleware.InvalidateMaintenanceCache()
	OK(w, map[string]any{"success": true, "maintenance": body.Enabled, "message": body.Message})
}
