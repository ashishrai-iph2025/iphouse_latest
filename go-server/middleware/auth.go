package middleware

import (
	"context"
	"net/http"
	"strings"

	ipauth "github.com/ip-house/iphouse-api/auth"
)

type contextKey string

const ClaimsKey contextKey = "claims"

/*
seen is called for every request that carries a valid session.

A hook rather than a direct call because the work belongs to `handlers` — it
writes to the portal database — and `handlers` already imports THIS package for
ClaimsFrom. Importing back would be a cycle, so main.go joins the two ends: see
middleware.OnSeen.

A no-op by default, so a build that never registers one behaves exactly as this
middleware did before.
*/
var seen = func(*ipauth.Claims) {}

// OnSeen registers what to do when an authenticated request arrives. Called once
// at startup; not safe to call afterwards, and there is no reason to.
func OnSeen(fn func(*ipauth.Claims)) {
	if fn != nil {
		seen = fn
	}
}

// JWT reads the JWT from the Authorization header or the "token" cookie.
func JWT(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tokenStr := ""

		// Try Authorization: Bearer <token>
		if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
			tokenStr = strings.TrimPrefix(h, "Bearer ")
		}

		// Fallback: HttpOnly cookie
		if tokenStr == "" {
			if c, err := r.Cookie("token"); err == nil {
				tokenStr = c.Value
			}
		}

		if tokenStr == "" {
			http.Error(w, `{"success":false,"error":"Not authenticated"}`, http.StatusUnauthorized)
			return
		}

		claims, err := ipauth.ParseToken(tokenStr)
		if err != nil {
			http.Error(w, `{"success":false,"error":"Session expired"}`, http.StatusUnauthorized)
			return
		}

		/* This session is alive, whoever it belongs to.

		   Here rather than in the login handlers, because the question the
		   Active Sessions panel asks is "who is using the portal now" and a
		   stamp written once at sign-in cannot answer it — nor did the staff
		   sign-in write one at all. Throttled inside; see TouchLastSeen. */
		seen(claims)

		ctx := context.WithValue(r.Context(), ClaimsKey, claims)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// RequireAdmin checks role >= 1.
func RequireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claims := GetClaims(r)
		if claims == nil || (claims.Role == nil || *claims.Role < 1) {
			http.Error(w, `{"success":false,"error":"Forbidden"}`, http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RequireSuperAdmin checks role == 2.
func RequireSuperAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claims := GetClaims(r)
		if claims == nil || claims.Role == nil || *claims.Role != 2 {
			http.Error(w, `{"success":false,"error":"Forbidden"}`, http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func GetClaims(r *http.Request) *ipauth.Claims {
	c, _ := r.Context().Value(ClaimsKey).(*ipauth.Claims)
	return c
}
