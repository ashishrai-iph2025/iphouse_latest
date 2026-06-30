package middleware

import (
	"net"
	"net/http"
	"sync"
	"time"
)

// In-memory per-IP rate limiter for sensitive endpoints (login, OTP, password
// reset). Protects against brute-force and email-flooding. State is per-process;
// for a multi-instance deployment behind a load balancer, move this to Redis.

type rlEntry struct {
	count   int
	resetAt time.Time
}

type rateLimiter struct {
	mu     sync.Mutex
	hits   map[string]*rlEntry
	limit  int
	window time.Duration
}

func newRateLimiter(limit int, window time.Duration) *rateLimiter {
	rl := &rateLimiter{hits: map[string]*rlEntry{}, limit: limit, window: window}
	// Periodically evict stale entries so the map doesn't grow unbounded.
	go func() {
		for range time.Tick(window) {
			now := time.Now()
			rl.mu.Lock()
			for k, e := range rl.hits {
				if now.After(e.resetAt) {
					delete(rl.hits, k)
				}
			}
			rl.mu.Unlock()
		}
	}()
	return rl
}

// allow reports whether the key may proceed, incrementing its counter.
func (rl *rateLimiter) allow(key string) bool {
	now := time.Now()
	rl.mu.Lock()
	defer rl.mu.Unlock()
	e, ok := rl.hits[key]
	if !ok || now.After(e.resetAt) {
		rl.hits[key] = &rlEntry{count: 1, resetAt: now.Add(rl.window)}
		return true
	}
	if e.count >= rl.limit {
		return false
	}
	e.count++
	return true
}

func clientIP(r *http.Request) string {
	// Honour the first hop in X-Forwarded-For when present (Nginx sets this).
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if i := indexComma(xff); i >= 0 {
			return trimSpace(xff[:i])
		}
		return trimSpace(xff)
	}
	if ip, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return ip
	}
	return r.RemoteAddr
}

func indexComma(s string) int {
	for i := 0; i < len(s); i++ {
		if s[i] == ',' {
			return i
		}
	}
	return -1
}

func trimSpace(s string) string {
	start, end := 0, len(s)
	for start < end && (s[start] == ' ' || s[start] == '\t') {
		start++
	}
	for end > start && (s[end-1] == ' ' || s[end-1] == '\t') {
		end--
	}
	return s[start:end]
}

// Default limiter for auth endpoints: 10 requests per minute per IP.
var authLimiter = newRateLimiter(10, time.Minute)

// RateLimitAuth wraps a handler with the auth rate limiter.
func RateLimitAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !authLimiter.allow(clientIP(r)) {
			w.Header().Set("Retry-After", "60")
			http.Error(w, `{"success":false,"error":"Too many requests. Please wait a minute and try again."}`, http.StatusTooManyRequests)
			return
		}
		next.ServeHTTP(w, r)
	})
}
