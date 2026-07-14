package middleware

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
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

// trustedProxies lists the peers whose X-Forwarded-For header may be believed,
// from TRUSTED_PROXIES (comma-separated IPs or CIDRs). Anything else is
// ignored: an attacker who can set XFF freely gets a brand-new rate-limit
// bucket per request and defeats brute-force protection entirely, so XFF is
// only honoured when the request actually arrived from our own reverse proxy.
var trustedProxies = func() []*net.IPNet {
	raw := os.Getenv("TRUSTED_PROXIES")
	if raw == "" {
		// Loopback only by default — covers the common "Nginx on the same host"
		// deployment without trusting arbitrary senders.
		raw = "127.0.0.1/32,::1/128"
	}
	var nets []*net.IPNet
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if !strings.Contains(part, "/") {
			if ip := net.ParseIP(part); ip != nil {
				bits := 32
				if ip.To4() == nil {
					bits = 128
				}
				part = fmt.Sprintf("%s/%d", part, bits)
			}
		}
		if _, n, err := net.ParseCIDR(part); err == nil {
			nets = append(nets, n)
		}
	}
	return nets
}()

func isTrustedProxy(ip string) bool {
	parsed := net.ParseIP(ip)
	if parsed == nil {
		return false
	}
	for _, n := range trustedProxies {
		if n.Contains(parsed) {
			return true
		}
	}
	return false
}

// clientIP returns the peer address, substituting the first X-Forwarded-For hop
// ONLY when the immediate peer is a trusted proxy (see trustedProxies).
func clientIP(r *http.Request) string {
	peer := r.RemoteAddr
	if ip, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		peer = ip
	}
	if isTrustedProxy(peer) {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			if i := indexComma(xff); i >= 0 {
				return trimSpace(xff[:i])
			}
			return trimSpace(xff)
		}
	}
	return peer
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
