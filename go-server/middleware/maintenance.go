package middleware

import (
	"net/http"
	"strings"
	"sync"
	"time"

	ipauth "github.com/ip-house/iphouse-api/auth"
	"github.com/ip-house/iphouse-api/db"
)

// Maintenance mode is stored in dcp_settings (`maintenance_mode` = "1"/"0",
// `maintenance_message` = optional text) and cached in memory so the gate
// doesn't hit the DB on every request.
var maint struct {
	mu        sync.Mutex
	checkedAt time.Time
	on        bool
	message   string
}

const maintenanceCacheTTL = 5 * time.Second

// MaintenanceStatus returns the current flag and message, re-reading
// dcp_settings at most once per cache TTL.
func MaintenanceStatus() (bool, string) {
	maint.mu.Lock()
	defer maint.mu.Unlock()
	if time.Since(maint.checkedAt) < maintenanceCacheTTL {
		return maint.on, maint.message
	}
	on, msg := false, ""
	rows, _ := db.Query("SELECT `key`, `value` FROM dcp_settings WHERE `key` IN ('maintenance_mode', 'maintenance_message')")
	for _, r := range rows {
		k, _ := r["key"].(string)
		v, _ := r["value"].(string)
		switch k {
		case "maintenance_mode":
			on = v == "1" || strings.EqualFold(v, "true") || strings.EqualFold(v, "on")
		case "maintenance_message":
			msg = v
		}
	}
	maint.on, maint.message, maint.checkedAt = on, msg, time.Now()
	return on, msg
}

// InvalidateMaintenanceCache forces the next MaintenanceStatus call to re-read
// the DB — called after an admin toggles the flag so it applies immediately.
func InvalidateMaintenanceCache() {
	maint.mu.Lock()
	maint.checkedAt = time.Time{}
	maint.mu.Unlock()
}

// tokenFromRequest extracts the JWT from the Authorization header or cookie
// (same sources as the JWT middleware) without failing the request.
func tokenFromRequest(r *http.Request) string {
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		return strings.TrimPrefix(h, "Bearer ")
	}
	if c, err := r.Cookie("token"); err == nil {
		return c.Value
	}
	return ""
}

// MaintenanceGate returns 503 for client API calls while maintenance mode is
// on. Static files, the status endpoint, auth routes (staff must be able to
// sign in) and admin routes (role-gated downstream) always pass, and any
// authenticated Admin/Super Admin (role >= 1) bypasses the gate entirely.
func MaintenanceGate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if !strings.HasPrefix(path, "/api/") ||
			path == "/api/maintenance" ||
			strings.HasPrefix(path, "/api/auth/") ||
			strings.HasPrefix(path, "/api/admin/") {
			next.ServeHTTP(w, r)
			return
		}
		on, _ := MaintenanceStatus()
		if !on {
			next.ServeHTTP(w, r)
			return
		}
		if tok := tokenFromRequest(r); tok != "" {
			if claims, err := ipauth.ParseToken(tok); err == nil && claims.Role != nil && *claims.Role >= 1 {
				next.ServeHTTP(w, r)
				return
			}
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		w.Write([]byte(`{"success":false,"error":"The platform is currently under maintenance","maintenance":true}`))
	})
}
