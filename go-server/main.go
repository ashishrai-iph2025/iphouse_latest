package main

import (
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/joho/godotenv"

	"github.com/ip-house/iphouse-api/config"
	"github.com/ip-house/iphouse-api/db"
	"github.com/ip-house/iphouse-api/handlers"
	"github.com/ip-house/iphouse-api/handlers/admin"
	"github.com/ip-house/iphouse-api/middleware"
	"github.com/ip-house/iphouse-api/store"
)

func main() {
	// Load .env.local then .env
	godotenv.Load("../.env.local")
	godotenv.Load("../.env")
	if _, err := os.Stat(".env"); err == nil {
		godotenv.Load(".env")
	}

	config.Load()

	if err := db.Init(); err != nil {
		log.Fatalf("[main] DB connect failed: %v", err)
	}
	db.Migrate()

	// War Room dataset store (Redis-backed, in-memory fallback).
	handlers.SetWarRoomStore(store.New(config.C.RedisAddr))

	// Background scheduler for automatic database backups.
	handlers.StartBackupScheduler()

	mux := http.NewServeMux()

	// ── CORS + maintenance-mode wrappers ─────────────────────────────────────
	handler := corsMiddleware(middleware.MaintenanceGate(mux))

	// ── Public auth routes (no JWT required) ─────────────────────────────────
	// Sensitive endpoints are rate-limited per IP to blunt brute-force and
	// email-flooding. logout/session-less helpers don't need it.
	rl := func(h http.HandlerFunc) http.Handler {
		return middleware.RateLimitAuth(http.HandlerFunc(h))
	}
	mux.Handle("POST /api/auth/login", rl(handlers.Login))
	mux.HandleFunc("POST /api/auth/logout", handlers.Logout)
	mux.Handle("POST /api/auth/check-multiple-logins", rl(handlers.CheckMultipleLogins))
	mux.Handle("POST /api/auth/send-otp", rl(handlers.SendOTP))
	mux.Handle("POST /api/auth/verify-otp", rl(handlers.VerifyOTP))
	mux.Handle("POST /api/auth/select-login", rl(handlers.SelectLogin))
	mux.Handle("POST /api/auth/forgot-password", rl(handlers.ForgotPassword))
	mux.Handle("POST /api/auth/reset-password", rl(handlers.ResetPassword))
	mux.Handle("POST /api/auth/verify-reset-otp", rl(handlers.VerifyResetOTP))
	mux.Handle("POST /api/auth/register", rl(handlers.Register))
	mux.HandleFunc("GET /api/test-db", handlers.TestDB)
	mux.HandleFunc("GET /api/maintenance", handlers.MaintenanceStatus)

	// ── Protected: requires JWT ───────────────────────────────────────────────
	auth := func(h http.HandlerFunc) http.Handler {
		return middleware.JWT(http.HandlerFunc(h))
	}

	mux.Handle("GET /api/auth/session", auth(handlers.Session))
	mux.Handle("GET /api/auth/switch-account", auth(handlers.SwitchAccount))
	mux.Handle("POST /api/auth/switch-account", auth(handlers.SwitchAccount))

	// Client routes
	mux.Handle("POST /api/infringement", auth(handlers.Infringement))
	mux.Handle("POST /api/warroom", auth(handlers.WarRoom))
	mux.Handle("POST /api/warroom/stream", auth(handlers.WarRoomStream))
	mux.Handle("GET /api/warroom/assets", auth(handlers.WarRoomAssets))
	mux.Handle("POST /api/search", auth(handlers.Search))
	mux.Handle("GET /api/download", auth(handlers.DownloadList))
	mux.Handle("POST /api/download", auth(handlers.DownloadTrigger))
	mux.Handle("GET /api/download/{id}", auth(handlers.DownloadByID))
	mux.Handle("GET /api/upload-url", auth(handlers.UploadURL))
	mux.Handle("POST /api/upload-url", auth(handlers.UploadURL))
	mux.Handle("POST /api/enforce", auth(handlers.Enforce))
	mux.Handle("POST /api/qc-urls", auth(handlers.QCUrls))
	mux.Handle("POST /api/qc-enforce", auth(handlers.QCEnforce))
	mux.Handle("POST /api/pending-count", auth(handlers.PendingCount))
	mux.Handle("GET /api/notifications", auth(handlers.Notifications))
	mux.Handle("POST /api/notifications", auth(handlers.Notifications))
	mux.Handle("GET /api/token", auth(handlers.Token))
	mux.Handle("GET /api/embed-token", auth(handlers.EmbedToken))
	mux.Handle("GET /api/keepalive", auth(handlers.Keepalive))
	mux.Handle("GET /api/user/nav", auth(handlers.UserNav))
	mux.Handle("GET /api/user/dashboard-data", auth(handlers.UserDashboardData))
	mux.Handle("GET /api/user/idle-timeout", auth(handlers.UserIdleTimeout))
	mux.Handle("POST /api/profile/change-password", auth(handlers.ChangePassword))
	mux.Handle("POST /api/ip-tracking", auth(handlers.IPTracking))
	mux.Handle("GET /api/ip-tracking/client-details", auth(handlers.IPTrackingClientDetails))
	mux.Handle("POST /api/master-data", auth(handlers.MasterData))
	mux.Handle("GET /api/master-data", auth(handlers.MasterData))

	// ── Admin routes: requires JWT + role >= 1 ────────────────────────────────
	adminAuth := func(h http.HandlerFunc) http.Handler {
		return middleware.JWT(middleware.RequireAdmin(http.HandlerFunc(h)))
	}

	// cfg additionally requires the login to hold a specific Configuration
	// module grant (dcp_admin_config_access). Super Admins hold every module
	// implicitly. Previously these grants were enforced only by hiding cards on
	// /admin/configuration, so any role>=1 login could call the endpoint
	// directly — including the plaintext credential reveal endpoints.
	cfg := func(moduleKey string, h http.HandlerFunc) http.Handler {
		return adminAuth(admin.RequireConfigModule(moduleKey, h))
	}

	mux.Handle("GET /api/admin/clients", adminAuth(admin.Clients))
	mux.Handle("POST /api/admin/clients", adminAuth(admin.Clients))
	mux.Handle("PUT /api/admin/clients", adminAuth(admin.Clients))
	mux.Handle("DELETE /api/admin/clients", adminAuth(admin.Clients))
	mux.Handle("GET /api/admin/clients/loa", adminAuth(admin.ClientLOA))
	mux.Handle("GET /api/admin/client-dashboard", adminAuth(admin.ClientDashboard))

	mux.Handle("GET /api/admin/users", adminAuth(admin.Users))
	mux.Handle("POST /api/admin/users", adminAuth(admin.Users))
	mux.Handle("PUT /api/admin/users", adminAuth(admin.Users))

	mux.Handle("GET /api/admin/modules", cfg("modules", admin.Modules))
	mux.Handle("POST /api/admin/modules", cfg("modules", admin.Modules))
	mux.Handle("PUT /api/admin/modules", cfg("modules", admin.Modules))

	mux.Handle("GET /api/admin/dashboard-modules", cfg("dashboard-modules", admin.DashboardModules))
	mux.Handle("POST /api/admin/dashboard-modules", cfg("dashboard-modules", admin.DashboardModules))
	mux.Handle("PUT /api/admin/dashboard-modules", cfg("dashboard-modules", admin.DashboardModules))
	mux.Handle("DELETE /api/admin/dashboard-modules", cfg("dashboard-modules", admin.DashboardModules))
	mux.Handle("GET /api/admin/module-permissions", cfg("module-permissions", admin.ModulePermissions))
	mux.Handle("POST /api/admin/module-permissions", cfg("module-permissions", admin.ModulePermissions))
	mux.Handle("PUT /api/admin/module-permissions", cfg("module-permissions", admin.ModulePermissions))
	mux.Handle("DELETE /api/admin/module-permissions", cfg("module-permissions", admin.ModulePermissions))
	mux.Handle("GET /api/admin/user-module-permissions", cfg("module-permissions", admin.UserModulePermissions))
	mux.Handle("POST /api/admin/user-module-permissions", cfg("module-permissions", admin.UserModulePermissions))

	mux.Handle("GET /api/admin/dashboards", adminAuth(admin.Dashboards))
	mux.Handle("POST /api/admin/dashboards", adminAuth(admin.Dashboards))
	mux.Handle("PUT /api/admin/dashboards", adminAuth(admin.Dashboards))
	mux.Handle("DELETE /api/admin/dashboards", adminAuth(admin.Dashboards))

	mux.Handle("GET /api/admin/powerbi-creds", cfg("powerbi-creds", admin.PowerBICreds))
	mux.Handle("POST /api/admin/powerbi-creds", cfg("powerbi-creds", admin.PowerBICreds))
	mux.Handle("PUT /api/admin/powerbi-creds", cfg("powerbi-creds", admin.PowerBICreds))
	mux.Handle("DELETE /api/admin/powerbi-creds", cfg("powerbi-creds", admin.PowerBICreds))
	mux.Handle("GET /api/admin/powerbi-creds/reveal", cfg("powerbi-creds", admin.PowerBICredsReveal))
	mux.Handle("GET /api/admin/powerbi-workspace", cfg("powerbi-workspace", admin.PowerBIWorkspace))
	mux.Handle("POST /api/admin/powerbi-workspace", cfg("powerbi-workspace", admin.PowerBIWorkspace))
	mux.Handle("GET /api/admin/powerbi-workspace/activity", cfg("powerbi-workspace", admin.PowerBIWorkspaceActivity))

	mux.Handle("GET /api/admin/email-templates", cfg("email-templates", admin.EmailTemplates))
	mux.Handle("POST /api/admin/email-templates", cfg("email-templates", admin.EmailTemplates))
	mux.Handle("PUT /api/admin/email-templates", cfg("email-templates", admin.EmailTemplates))
	mux.Handle("DELETE /api/admin/email-templates", cfg("email-templates", admin.EmailTemplates))

	mux.Handle("GET /api/admin/email-event-types", cfg("email-event-types", admin.EmailEventTypes))
	mux.Handle("POST /api/admin/email-event-types", cfg("email-event-types", admin.EmailEventTypes))
	mux.Handle("PUT /api/admin/email-event-types", cfg("email-event-types", admin.EmailEventTypes))
	mux.Handle("DELETE /api/admin/email-event-types", cfg("email-event-types", admin.EmailEventTypes))

	// The Email Credentials card (/admin/settings) is the "settings" module.
	mux.Handle("GET /api/admin/email-credentials", cfg("settings", admin.EmailCredentials))
	mux.Handle("POST /api/admin/email-credentials", cfg("settings", admin.EmailCredentials))
	mux.Handle("PUT /api/admin/email-credentials", cfg("settings", admin.EmailCredentials))
	mux.Handle("DELETE /api/admin/email-credentials", cfg("settings", admin.EmailCredentials))
	mux.Handle("GET /api/admin/email-credentials/reveal", cfg("settings", admin.EmailCredentialsReveal))

	mux.Handle("GET /api/admin/api-credentials", cfg("api-credentials", admin.APICredentials))
	mux.Handle("POST /api/admin/api-credentials", cfg("api-credentials", admin.APICredentials))
	mux.Handle("PUT /api/admin/api-credentials", cfg("api-credentials", admin.APICredentials))
	mux.Handle("DELETE /api/admin/api-credentials", cfg("api-credentials", admin.APICredentials))
	mux.Handle("GET /api/admin/api-credentials/reveal", cfg("api-credentials", admin.APICredentialsReveal))

	mux.Handle("GET /api/admin/settings", cfg("settings", admin.Settings))
	mux.Handle("POST /api/admin/settings", cfg("settings", admin.Settings))
	mux.Handle("PUT /api/admin/settings", cfg("settings", admin.Settings))

	mux.Handle("GET /api/admin/idle-timeout", cfg("idle-timeout", admin.AdminIdleTimeout))
	mux.Handle("POST /api/admin/idle-timeout", cfg("idle-timeout", admin.AdminIdleTimeout))
	mux.Handle("DELETE /api/admin/idle-timeout", cfg("idle-timeout", admin.AdminIdleTimeout))

	mux.Handle("GET /api/admin/asset-access", cfg("asset-access", admin.AssetAccess))
	mux.Handle("POST /api/admin/asset-access", cfg("asset-access", admin.AssetAccess))

	mux.Handle("GET /api/admin/warroom-settings", cfg("war-room-assets", admin.WarRoomSettings))
	mux.Handle("POST /api/admin/warroom-settings", cfg("war-room-assets", admin.WarRoomSettings))

	mux.Handle("GET /api/admin/master-api", cfg("master-api", admin.MasterAPI))
	mux.Handle("POST /api/admin/master-api", cfg("master-api", admin.MasterAPI))
	mux.Handle("PUT /api/admin/master-api", cfg("master-api", admin.MasterAPI))

	mux.Handle("GET /api/admin/activity-stats", adminAuth(admin.ActivityStats))
	mux.Handle("GET /api/admin/tracking", cfg("tracking", admin.Tracking))
	mux.Handle("POST /api/admin/tracking", cfg("tracking", admin.Tracking))
	mux.Handle("GET /api/admin/tracking/analytics", cfg("tracking", admin.TrackingAnalytics))
	mux.Handle("GET /api/admin/home-analytics", adminAuth(admin.HomeAnalytics))

	mux.Handle("GET /api/admin/my-config-access", adminAuth(admin.MyConfigAccess))

	// War Room: admin generates a selected client's MarkScan token + asset list.
	mux.Handle("POST /api/warroom/client-token", adminAuth(handlers.WarRoomClientToken))

	mux.Handle("GET /api/admin/registrations", adminAuth(admin.Registrations))
	mux.Handle("PUT /api/admin/registrations", adminAuth(admin.Registrations))
	mux.Handle("GET /api/admin/registration-requests", cfg("registration-requests", admin.RegistrationRequests))
	mux.Handle("GET /api/admin/shared-logins", adminAuth(admin.SharedLogins))
	mux.Handle("POST /api/admin/shared-logins", adminAuth(admin.SharedLogins))

	// ── Super Admin routes: requires JWT + role == 2 ──────────────────────────
	saAuth := func(h http.HandlerFunc) http.Handler {
		return middleware.JWT(middleware.RequireSuperAdmin(http.HandlerFunc(h)))
	}

	mux.Handle("GET /api/admin/super-admin", saAuth(admin.SuperAdmin))
	mux.Handle("PUT /api/admin/super-admin", saAuth(admin.SuperAdmin))
	mux.Handle("GET /api/admin/super-admin/active-sessions", saAuth(admin.ActiveSessions))
	mux.Handle("POST /api/admin/super-admin/force-logout", saAuth(admin.ForceLogout))
	mux.Handle("GET /api/admin/super-admin/permissions", saAuth(admin.SuperAdminPermissions))
	mux.Handle("PUT /api/admin/super-admin/permissions", saAuth(admin.SuperAdminPermissions))
	mux.Handle("GET /api/admin/super-admin/config-access", saAuth(admin.SuperAdminConfigAccess))
	mux.Handle("PUT /api/admin/super-admin/config-access", saAuth(admin.SuperAdminConfigAccess))
	mux.Handle("GET /api/admin/super-admin/accounts", saAuth(admin.SuperAdminAccounts))
	mux.Handle("POST /api/admin/maintenance", saAuth(handlers.MaintenanceUpdate))
	mux.Handle("POST /api/admin/staff-otp", saAuth(handlers.StaffOTPSetting))
	mux.Handle("POST /api/admin/backup/run", saAuth(handlers.RunBackup))
	mux.Handle("GET /api/admin/backup/list", saAuth(handlers.ListBackups))
	mux.Handle("GET /api/admin/backup/schedule", saAuth(handlers.BackupSchedule))
	mux.Handle("POST /api/admin/backup/schedule", saAuth(handlers.BackupSchedule))
	mux.Handle("GET /api/admin/aws-credentials", saAuth(admin.AWSCredentials))
	mux.Handle("POST /api/admin/aws-credentials", saAuth(admin.AWSCredentials))
	mux.Handle("GET /api/admin/aws-credentials/reveal", saAuth(admin.AWSCredentialsReveal))
	mux.Handle("GET /api/admin/super-admin/user-permissions", saAuth(admin.SuperAdminUserPermissions))

	// ── Serve Vite static build (SPA fallback) ───────────────────────────────
	distDir := "../dist"
	if envDist := os.Getenv("STATIC_DIR"); envDist != "" {
		distDir = envDist
	}
	staticFS := http.FileServer(http.Dir(distDir))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// Check if the file exists in dist/
		fPath := distDir + r.URL.Path
		if _, err := os.Stat(fPath); os.IsNotExist(err) {
			// SPA fallback: serve index.html for all non-API paths
			http.ServeFile(w, r, distDir+"/index.html")
			return
		}
		staticFS.ServeHTTP(w, r)
	})

	addr := ":" + config.C.Port
	log.Printf("[main] Go API server listening on %s", addr)
	if err := http.ListenAndServe(addr, handler); err != nil {
		log.Fatalf("[main] Server error: %v", err)
	}
}

// allowedOrigins lists the only origins permitted to send credentialed requests.
var allowedOrigins = func() map[string]bool {
	m := map[string]bool{
		"http://localhost:8080":  true,
		"http://localhost:5173":  true, // Vite dev
		"http://localhost:3000":  true, // Next.js dev
	}
	if extra := os.Getenv("ALLOWED_ORIGINS"); extra != "" {
		for _, o := range strings.Split(extra, ",") {
			if o = strings.TrimSpace(o); o != "" {
				m[o] = true
			}
		}
	}
	return m
}()

// corsMiddleware restricts cross-origin access to an explicit allowlist.
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && allowedOrigins[origin] {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Vary", "Origin")
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}
