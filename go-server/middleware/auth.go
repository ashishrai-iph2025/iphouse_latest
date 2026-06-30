package middleware

import (
	"context"
	"net/http"
	"strings"

	ipauth "github.com/ip-house/iphouse-api/auth"
)

type contextKey string

const ClaimsKey contextKey = "claims"

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
