package handlers

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"sync"
	"time"

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
/*
Login stampede control.

The token cache is in memory, so every restart empties it — and a single page can
fan out into a dozen Markscan-backed requests at once. Each of those used to miss
the cache and start its OWN login, and Login retried three times, so one restart
turned into a burst of login attempts from one IP. Markscan counts logins per IP
("Rate limit exceeded (LoginIp)"), so the burst tripped the limit, every login
then failed, nothing was ever cached, and the next request did it again. The
lockout sustained itself and the whole portal read as empty.

Two gates fix it:

  · loginGate serialises attempts PER USER, so concurrent requests wait for the
    first login rather than each starting one. The winner caches the token and
    the rest re-read the cache.
  · loginHold is when not to try at all. A 429 is held GLOBALLY because the limit
    is counted per IP — one user's rate-limited login means nobody on this host
    may log in yet — while any other failure is held per user, since that one is
    about those credentials.
*/
var (
	loginMu   sync.Mutex
	loginGate = map[int64]*sync.Mutex{}
	loginHold = map[int64]time.Time{} // key 0 is the global (per-IP) hold
)

func gateFor(userID int64) *sync.Mutex {
	loginMu.Lock()
	defer loginMu.Unlock()
	g, ok := loginGate[userID]
	if !ok {
		g = &sync.Mutex{}
		loginGate[userID] = g
	}
	return g
}

func holding(userID int64) bool {
	loginMu.Lock()
	defer loginMu.Unlock()
	now := time.Now()
	if t, ok := loginHold[0]; ok && now.Before(t) {
		return true
	}
	t, ok := loginHold[userID]
	return ok && now.Before(t)
}

func holdLogin(userID int64, d time.Duration) {
	loginMu.Lock()
	defer loginMu.Unlock()
	loginHold[userID] = time.Now().Add(d)
}

func clearHold(userID int64) {
	loginMu.Lock()
	defer loginMu.Unlock()
	delete(loginHold, userID)
}

func TokenForUser(userID int64) string {
	if userID == 0 {
		return ""
	}
	// 1. memory cache (populated at login / prior resolve; survives the cache TTL)
	if t := markscan.GetCachedToken(userID); t != "" {
		return t
	}

	// 2. one login at a time per user; the losers read what the winner cached.
	gate := gateFor(userID)
	gate.Lock()
	defer gate.Unlock()
	if t := markscan.GetCachedToken(userID); t != "" {
		return t
	}
	if holding(userID) {
		return ""
	}

	// 3. fresh login from DB credentials (cache miss / after a server restart).
	row, err := db.QueryOne("SELECT api_user_name, api_password FROM dcp_user WHERE userId = ? AND deleted = 0", userID)
	if err != nil || row == nil {
		log.Printf("[markscan] no API credentials row for user %d (err=%v)", userID, err)
		holdLogin(userID, 60*time.Second)
		return ""
	}
	apiUser := ipauth.DecryptMain(strFromAny(row["api_user_name"]))
	if apiUser == "" {
		apiUser = strFromAny(row["api_user_name"])
	}
	apiPass := ipauth.DecryptMain(strFromAny(row["api_password"]))
	if apiPass == "" {
		apiPass = strFromAny(row["api_password"])
	}
	if apiUser == "" || apiPass == "" {
		// Not an outage: this login simply holds no Markscan credentials.
		log.Printf("[markscan] user %d has no API username/password stored", userID)
		holdLogin(userID, 5*time.Minute)
		return ""
	}
	t, err := markscan.Login(apiUser, apiPass)
	if err != nil {
		/* LOGGED, always. Every path here used to return "" in silence, so a
		   rate-limited or rejected login looked identical to a client that
		   genuinely has no data — an empty page, no error, nothing in the log to
		   say which. */
		var rl *markscan.RateLimitedError
		if errors.As(err, &rl) {
			// Per IP, so it applies to everyone on this host, not just this user.
			holdLogin(0, rl.RetryAfter)
			log.Printf("[markscan] login rate-limited by upstream; holding ALL logins for %s (user %d)",
				rl.RetryAfter, userID)
		} else {
			holdLogin(userID, 60*time.Second)
			log.Printf("[markscan] login failed for user %d: %v (holding 60s)", userID, err)
		}
		return ""
	}
	clearHold(userID)
	markscan.SetCachedToken(userID, t)
	return t
}

// secureCookies reports whether the session cookie must carry the Secure flag.
//
// Default-secure: the flag is ON unless this is explicitly a local development
// run. The previous rule (on only when the Go port is literally 443) meant a
// production server behind a TLS-terminating reverse proxy — the normal setup,
// where Go listens on 8080 — shipped the session JWT without Secure, so any
// plaintext HTTP request to the domain would leak it.
//
// Set INSECURE_COOKIES=true (or APP_ENV=development) for http://localhost work.
func secureCookies() bool {
	if os.Getenv("SECURE_COOKIES") == "true" {
		return true
	}
	if os.Getenv("INSECURE_COOKIES") == "true" || os.Getenv("APP_ENV") == "development" {
		return false
	}
	return true
}

// SetTokenCookie sets the JWT as an HttpOnly cookie.
func SetTokenCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     "token",
		Value:    token,
		Path:     "/",
		MaxAge:   config.C.SessionIdleSeconds,
		HttpOnly: true,
		Secure:   secureCookies(),
		SameSite: http.SameSiteLaxMode,
	})
}

// ClearTokenCookie clears the JWT cookie. The attributes must match the ones
// used when setting it, or the browser keeps the original cookie.
func ClearTokenCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     "token",
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   secureCookies(),
		SameSite: http.SameSiteLaxMode,
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
