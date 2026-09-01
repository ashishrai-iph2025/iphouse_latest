package handlers

/*
Keepalive has one job and it used to do none of it.

The endpoint returned `expiryMs` — a timestamp thirty minutes out — and set no
cookie, so every caller was told its session had been extended and none of them
had been. The JWT still died thirty minutes after LOGIN, which is how people were
logged out in the middle of a task while the browser cheerfully counted down to a
deadline that had already been decided.

Nothing about that failure was visible: the endpoint answered 200, the body
looked right, and the only symptom was a logout half an hour later. So the thing
worth pinning is the Set-Cookie, not the JSON.
*/

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	ipauth "github.com/ip-house/iphouse-api/auth"
	"github.com/ip-house/iphouse-api/config"
	"github.com/ip-house/iphouse-api/middleware"
)

/*
withClaims builds a request carrying a verified session, the way middleware.JWT
leaves one for the handler.

Through middleware.ClaimsKey rather than a key of this test's own, so that a
handler reading the context the real way sees it — a private key here would make
every assertion below pass against a handler that reads nothing.
*/
func withClaims(c *ipauth.Claims) *http.Request {
	r := httptest.NewRequest("GET", "/api/keepalive", nil)
	return r.WithContext(context.WithValue(r.Context(), middleware.ClaimsKey, c))
}

func jwtNumericDate(t time.Time) *jwt.NumericDate { return jwt.NewNumericDate(t) }

func TestKeepaliveReissuesTheCookie(t *testing.T) {
	config.C.JWTSecret = "test-secret-not-a-real-one"
	config.C.SessionIdleSeconds = 1800

	/* A session already most of the way to its expiry — the state the endpoint
	   exists for. If the slide works, the cookie that comes back is good for a
	   full window again rather than the two minutes this one has left. */
	claims := &ipauth.Claims{LoginID: 7, UserID: 42, LoginUsername: "someone"}
	claims.ExpiresAt = jwtNumericDate(time.Now().Add(2 * time.Minute))

	w := httptest.NewRecorder()
	Keepalive(w, withClaims(claims))

	if w.Code != 200 {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body.String())
	}

	/* THE POINT OF THE ENDPOINT. A 200 with no Set-Cookie is the bug this
	   replaces: the caller is told it has more time and is given none. */
	var token string
	for _, c := range w.Result().Cookies() {
		if c.Name == "token" {
			token = c.Value
		}
	}
	if token == "" {
		t.Fatal("no `token` cookie was set — the session was not actually extended, " +
			"which is exactly the bug that logged people out mid-task")
	}

	// And the new token must be a real session for the SAME person, good for a
	// full window. A slide that loses the identity is a logout with extra steps.
	fresh, err := ipauth.ParseToken(token)
	if err != nil {
		t.Fatalf("the re-issued token does not parse: %v", err)
	}
	if fresh.LoginID != claims.LoginID || fresh.UserID != claims.UserID ||
		fresh.LoginUsername != claims.LoginUsername {
		t.Errorf("the renewed session is a different identity: %+v", fresh)
	}
	if fresh.ExpiresAt == nil {
		t.Fatal("the re-issued token has no expiry")
	}
	if left := time.Until(fresh.ExpiresAt.Time); left < 25*time.Minute {
		t.Errorf("the renewed session has only %s left, want ~30m — it was not "+
			"given a fresh window", left.Round(time.Second))
	}

	// The body's expiry has to describe the cookie that just went out, because
	// the countdown on screen is drawn from it.
	var body struct {
		Data struct {
			Alive    bool  `json:"alive"`
			Extended bool  `json:"extended"`
			ExpiryMs int64 `json:"expiryMs"`
		} `json:"data"`
		Alive    bool  `json:"alive"`
		Extended bool  `json:"extended"`
		ExpiryMs int64 `json:"expiryMs"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("body is not JSON: %s", w.Body.String())
	}
	expiry := body.ExpiryMs
	extended := body.Extended
	if expiry == 0 {
		expiry, extended = body.Data.ExpiryMs, body.Data.Extended
	}
	if !extended {
		t.Error("the response says the session was not extended")
	}
	/* Within a minute of the cookie's own expiry. Not exact: the handler computes
	   the number from the same config value rather than parsing back what it just
	   signed, so the two are a few microseconds apart by construction. */
	drift := time.UnixMilli(expiry).Sub(fresh.ExpiresAt.Time)
	if drift < -time.Minute || drift > time.Minute {
		t.Errorf("reported expiry is %s from the cookie's — the countdown would "+
			"aim at the wrong moment", drift.Round(time.Second))
	}
}

// No session, no renewal. The guard in the browser reads a 401 here as "already
// gone" and goes to the login page, so answering 200 to an unauthenticated
// caller would leave it counting down against nothing.
func TestKeepaliveRefusesWithoutASession(t *testing.T) {
	config.C.JWTSecret = "test-secret-not-a-real-one"
	config.C.SessionIdleSeconds = 1800

	w := httptest.NewRecorder()
	Keepalive(w, httptest.NewRequest("GET", "/api/keepalive", nil))

	if w.Code != 401 {
		t.Errorf("status = %d, want 401", w.Code)
	}
	for _, c := range w.Result().Cookies() {
		if c.Name == "token" && c.Value != "" {
			t.Error("a session cookie was issued to an unauthenticated caller")
		}
	}
}

/*
The cookie's MaxAge and the token's expiry must describe the same moment.

They are set in two different places from one config value, and a mismatch is
silent in the direction that matters: a cookie outliving its token leaves the
browser sending a JWT the server rejects, which reads to the user as a logout
that ignored the countdown they just answered.
*/
func TestCookieLifetimeMatchesTheTokenLifetime(t *testing.T) {
	config.C.JWTSecret = "test-secret-not-a-real-one"
	config.C.SessionIdleSeconds = 900 // deliberately not the default

	claims := &ipauth.Claims{LoginID: 1, UserID: 1}
	claims.ExpiresAt = jwtNumericDate(time.Now().Add(time.Minute))

	w := httptest.NewRecorder()
	Keepalive(w, withClaims(claims))

	var cookie *http.Cookie
	for _, c := range w.Result().Cookies() {
		if c.Name == "token" {
			cookie = c
		}
	}
	if cookie == nil {
		t.Fatal("no token cookie")
	}
	if cookie.MaxAge != config.C.SessionIdleSeconds {
		t.Errorf("cookie MaxAge = %d, want %d", cookie.MaxAge, config.C.SessionIdleSeconds)
	}
	if !cookie.HttpOnly {
		t.Error("the session cookie is readable by scripts")
	}
	tok, err := ipauth.ParseToken(cookie.Value)
	if err != nil {
		t.Fatalf("re-issued token does not parse: %v", err)
	}
	want := time.Duration(config.C.SessionIdleSeconds) * time.Second
	if left := time.Until(tok.ExpiresAt.Time); left < want-time.Minute || left > want+time.Minute {
		t.Errorf("token lifetime %s does not match the configured window %s", left, want)
	}
}

// Ensure the middleware's context key is what the handler reads, so these tests
// exercise the real path rather than a parallel one.
func TestClaimsFromReadsTheMiddlewareContext(t *testing.T) {
	c := &ipauth.Claims{LoginID: 99}
	r := withClaims(c)
	got := ClaimsFrom(r)
	if got == nil || got.LoginID != 99 {
		t.Fatalf("ClaimsFrom returned %+v — these tests would not be exercising "+
			"the handler's real input", got)
	}
	_ = middleware.ClaimsKey
}
