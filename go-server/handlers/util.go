package handlers

import (
	"encoding/json"
	"net/http"
	"os"

	ipauth "github.com/ip-house/iphouse-api/auth"
	"github.com/ip-house/iphouse-api/config"
	"github.com/ip-house/iphouse-api/db"
	"github.com/ip-house/iphouse-api/markscan"
	"github.com/ip-house/iphouse-api/middleware"
)

func JSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func OK(w http.ResponseWriter, v any) { JSON(w, 200, v) }

func Fail(w http.ResponseWriter, status int, msg string) {
	JSON(w, status, map[string]any{"success": false, "error": msg})
}

// ResolveAPIToken returns the Markscan bearer token for the session user.
func ResolveAPIToken(claims *ipauth.Claims) string {
	if claims == nil {
		return ""
	}
	return TokenForUser(claims.UserID)
}

// TokenForUser resolves the Markscan bearer token for any dcp_user by id: it
// serves a cached token when fresh, else re-authenticates against Markscan using
// that user's stored (encrypted) API credentials and caches the result. Used both
// for the session user (ResolveAPIToken) and, in the admin War Room, for a
// selected client whose token an admin generates on their behalf.
func TokenForUser(userID int64) string {
	if userID == 0 {
		return ""
	}
	// 1. memory cache (populated at login / prior resolve; survives the cache TTL)
	if t := markscan.GetCachedToken(userID); t != "" {
		return t
	}
	// 2. fresh login from DB credentials (cache miss / after a server restart).
	row, err := db.QueryOne("SELECT api_user_name, api_password FROM dcp_user WHERE userId = ? AND deleted = 0", userID)
	if err != nil || row == nil {
		return ""
	}
	apiUser := ipauth.DecryptMain(strFromAny(row["api_user_name"]))
	if apiUser == "" { apiUser = strFromAny(row["api_user_name"]) }
	apiPass := ipauth.DecryptMain(strFromAny(row["api_password"]))
	if apiPass == "" { apiPass = strFromAny(row["api_password"]) }
	if apiUser == "" || apiPass == "" {
		return ""
	}
	t, err := markscan.Login(apiUser, apiPass)
	if err != nil {
		return ""
	}
	markscan.SetCachedToken(userID, t)
	return t
}

// SetTokenCookie sets the JWT as an HttpOnly cookie.
func SetTokenCookie(w http.ResponseWriter, token string) {
	secure := config.C.Port == "443" || os.Getenv("SECURE_COOKIES") == "true"
	http.SetCookie(w, &http.Cookie{
		Name:     "token",
		Value:    token,
		Path:     "/",
		MaxAge:   config.C.SessionIdleSeconds,
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
	})
}

// ClearTokenCookie clears the JWT cookie.
func ClearTokenCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     "token",
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
	})
}

// ClaimsFrom extracts claims from the request context.
func ClaimsFrom(r *http.Request) *ipauth.Claims {
	return middleware.GetClaims(r)
}

func intFromAny(v any) int64 {
	switch t := v.(type) {
	case int64:
		return t
	case float64:
		return int64(t)
	case int:
		return int64(t)
	}
	return 0
}

func strFromAny(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}
