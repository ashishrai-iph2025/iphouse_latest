package admin

// Where the portal's reports come from, as configuration rather than as an
// environment variable.
//
// The base URL and the API key used to live only in .env.local, which meant
// rotating a key was a file edit, a rebuild and a restart — and in a container
// deployment, a redeploy. They are stored here instead, so the pair can be
// changed while the service is running and the next request uses the new one.
//
// The KEY IS ENCRYPTED AT REST with the same AES-256-CBC helper the AWS and SES
// credentials use (ipauth.EncryptMain, random IV per value, ENCRYPTION_KEY).
// It is never returned by the list endpoint — that answers with a mask — and is
// only ever decrypted by the dedicated reveal endpoint, which is Super-Admin
// only and logged.
//
// The environment remains the FALLBACK. An install that sets nothing here
// behaves exactly as it did, and a row saved here overrides it — which is the
// order that lets this be adopted without a migration.

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	ipauth "github.com/ip-house/iphouse-api/auth"
	"github.com/ip-house/iphouse-api/db"
	"github.com/ip-house/iphouse-api/reportsapi"
)

const reportsAPITable = "reports_api_config"

var reportsAPISchemaOnce sync.Once

func ensureReportsAPISchema() {
	reportsAPISchemaOnce.Do(func() {
		/* One row, id = 1. A settings table with a fixed key rather than an
		   auto-increment: there is exactly one reports API, and a table that can
		   hold two invites the question of which one is live. */
		if _, _, err := db.Exec(`
			CREATE TABLE IF NOT EXISTS ` + reportsAPITable + ` (
			  id         TINYINT UNSIGNED NOT NULL PRIMARY KEY,
			  base_url   VARCHAR(255) NOT NULL DEFAULT '',
			  api_key    TEXT         NULL,
			  rate_limit INT          NOT NULL DEFAULT 480,
			  bg_share   INT          NOT NULL DEFAULT 300,
			  updated_by VARCHAR(191) NOT NULL DEFAULT '',
			  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`); err != nil {
			log.Printf("[reports-api-config] create %s: %v", reportsAPITable, err)
		}
		// The pacing arrived after the table did, and CREATE TABLE IF NOT EXISTS
		// does nothing to a table that already exists.
		for _, alter := range []string{
			"ADD COLUMN rate_limit INT NOT NULL DEFAULT 480",
			"ADD COLUMN bg_share INT NOT NULL DEFAULT 300",
		} {
			if _, _, err := db.Exec("ALTER TABLE " + reportsAPITable + " " + alter); err != nil {
				if !strings.Contains(strings.ToLower(err.Error()), "duplicate column") {
					log.Printf("[reports-api-config] %s: %v", alter, err)
				}
			}
		}
	})
}

/*
maskKey shows enough to recognise WHICH key this is and not enough to use it.

The last four only, and never the first: a key's prefix is often the part that
identifies the issuer or environment, and showing both ends of a 40-character
secret narrows a guess far more than showing one end of it.
*/
func maskKey(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	if len(s) <= 4 {
		return strings.Repeat("•", len(s))
	}
	return strings.Repeat("•", 12) + s[len(s)-4:]
}

/*
── The live values, and the cache behind them ───────────────────────────────

	Read on every outbound request, so it cannot be a database round trip each
	time. Cached for a few seconds and invalidated outright when the row is
	saved: a rotation must take effect immediately, and a few seconds of
	staleness elsewhere costs nothing.
*/
var (
	liveMu      sync.RWMutex
	liveBase    string
	liveKey     string
	liveFetched time.Time
	liveLoaded  bool
)

const liveTTL = 10 * time.Second

// storedConfig reads the row, decrypting the key. Empty strings where there is
// no row, which is how the env fallback is reached.
func storedConfig() (base, key string) {
	ensureReportsAPISchema()
	row, err := db.QueryOne("SELECT base_url, api_key FROM " + reportsAPITable + " WHERE id = 1 LIMIT 1")
	if err != nil || row == nil {
		return "", ""
	}
	base = strings.TrimSpace(strVal(row["base_url"]))
	if enc := strings.TrimSpace(strVal(row["api_key"])); enc != "" {
		key = ipauth.DecryptMain(enc)
	}
	return base, key
}

/*
ReportsAPISource is what reportsapi.SetSource is given at startup.

Stored value wins; environment fills whatever the row leaves empty. Per FIELD,
not per row — so an install can keep the URL in the environment and rotate only
the key from the screen, which is the combination a deployment with a fixed
endpoint actually wants.
*/
func ReportsAPISource() (string, string) {
	liveMu.RLock()
	if liveLoaded && time.Since(liveFetched) < liveTTL {
		b, k := liveBase, liveKey
		liveMu.RUnlock()
		return b, k
	}
	liveMu.RUnlock()

	base, key := storedConfig()

	liveMu.Lock()
	defer liveMu.Unlock()
	liveBase, liveKey = base, key
	liveFetched, liveLoaded = time.Now(), true
	return base, key
}

// InvalidateReportsAPIConfig drops the cache so the next request re-reads the
// row. Called on save, because "I changed the key and it still fails" is the
// bug this prevents.
func InvalidateReportsAPIConfig() {
	liveMu.Lock()
	defer liveMu.Unlock()
	liveLoaded = false
}

/*
── GET/POST /api/admin/reports-api-config ───────────────────────────────────

	GET describes the configuration WITHOUT the key: the base URL, a mask, and
	which of the two sources each value is coming from — the last part matters
	because "why is it still calling the old host" is answered by knowing the
	environment is winning.
*/
func ReportsAPIConfig(w http.ResponseWriter, r *http.Request) {
	ensureReportsAPISchema()

	if r.Method == http.MethodGet {
		row, _ := db.QueryOne("SELECT base_url, api_key, rate_limit, bg_share, updated_by, updated_at FROM " +
			reportsAPITable + " WHERE id = 1 LIMIT 1")

		storedBase, storedKey := "", ""
		updatedBy, updatedAt := "", ""
		rateLimit, bgShare := defaultRateLimit, defaultBGShare
		if row != nil {
			storedBase = strings.TrimSpace(strVal(row["base_url"]))
			if enc := strings.TrimSpace(strVal(row["api_key"])); enc != "" {
				storedKey = ipauth.DecryptMain(enc)
			}
			updatedBy = strVal(row["updated_by"])
			updatedAt = strVal(row["updated_at"])
			if v := int(intVal(row["rate_limit"])); v > 0 {
				rateLimit = v
			}
			if v := int(intVal(row["bg_share"])); v > 0 {
				bgShare = v
			}
		}

		effBase, effKey := ReportsAPISource()

		ok(w, map[string]any{
			"success": true,
			// What is stored here, and therefore editable on this screen.
			"baseUrl":   storedBase,
			"hasKey":    storedKey != "",
			"keyMasked": maskKey(storedKey),
			// What the portal is ACTUALLY using, and where each half came from.
			"effectiveBaseUrl": effBase,
			"effectiveHasKey":  effKey != "",
			"baseUrlSource":    sourceOf(storedBase != ""),
			"keySource":        sourceOf(storedKey != ""),
			"updatedBy":        updatedBy,
			"updatedAt":        updatedAt,
			// The pacing, and what it is currently costing. This is the pair of
			// numbers that decides how long a warm pass takes — see
			// reportsapi/pace.go — so the screen shows them next to the waiting
			// they have caused rather than leaving someone to infer it.
			"rateLimit": rateLimit, "bgShare": bgShare,
			"budget": reportsapi.BudgetStats(),
		})
		return
	}

	var body struct {
		BaseURL string `json:"baseUrl"`
		APIKey  string `json:"apiKey"`
		// True to remove the stored key and fall back to the environment.
		ClearKey  bool `json:"clearKey"`
		RateLimit int  `json:"rateLimit"`
		BGShare   int  `json:"bgShare"`
	}
	json.NewDecoder(r.Body).Decode(&body)

	rateLimit, bgShare := clampBudget(body.RateLimit, body.BGShare)

	base := strings.TrimRight(strings.TrimSpace(body.BaseURL), "/")
	if base != "" && !strings.HasPrefix(base, "http://") && !strings.HasPrefix(base, "https://") {
		fail(w, 422, "The base URL must start with http:// or https://")
		return
	}
	/* Plain http:// is ALLOWED, and warned about where the warning is earned.

	   It used to be refused outright for anything but localhost, which was wrong
	   in the commonest deployment this portal actually has: the reports service
	   is a sibling container and its address is `http://reports_api:8090`. That
	   name resolves only on the Docker network, the traffic never reaches a wire
	   anyone else is on, and terminating TLS between two containers to satisfy a
	   prefix check is ceremony. The refusal did not make that setup safer — it
	   made it unconfigurable, which pushes the key back into a .env file and out
	   of the encrypted column this screen exists to put it in.

	   So the check now asks where the address actually goes rather than which
	   scheme it starts with. A private one saves silently; a PUBLIC one over
	   http still means the key crosses the internet in clear text, so it saves
	   with a warning the screen shows and the log records. */
	warning := httpWarning(base)

	who := adminName(r)

	// The key column is only written when something was actually said about it:
	// an empty field means "leave it alone", which is what lets someone change
	// the URL without re-typing a 70-character secret.
	var (
		setKey bool
		encKey any
	)
	switch {
	case body.ClearKey:
		setKey, encKey = true, nil
	case strings.TrimSpace(body.APIKey) != "":
		setKey, encKey = true, ipauth.EncryptMain(strings.TrimSpace(body.APIKey))
	}

	if setKey {
		if _, _, err := db.Exec(`
			INSERT INTO `+reportsAPITable+` (id, base_url, api_key, rate_limit, bg_share, updated_by)
			VALUES (1, ?, ?, ?, ?, ?)
			ON DUPLICATE KEY UPDATE base_url = VALUES(base_url), api_key = VALUES(api_key),
			  rate_limit = VALUES(rate_limit), bg_share = VALUES(bg_share), updated_by = VALUES(updated_by)`,
			base, encKey, rateLimit, bgShare, who); err != nil {
			log.Printf("[reports-api-config] save: %v", err)
			fail(w, 500, "Could not save the configuration")
			return
		}
	} else {
		if _, _, err := db.Exec(`
			INSERT INTO `+reportsAPITable+` (id, base_url, rate_limit, bg_share, updated_by)
			VALUES (1, ?, ?, ?, ?)
			ON DUPLICATE KEY UPDATE base_url = VALUES(base_url),
			  rate_limit = VALUES(rate_limit), bg_share = VALUES(bg_share), updated_by = VALUES(updated_by)`,
			base, rateLimit, bgShare, who); err != nil {
			log.Printf("[reports-api-config] save: %v", err)
			fail(w, 500, "Could not save the configuration")
			return
		}
	}

	InvalidateReportsAPIConfig()
	ApplyReportsAPIBudget()
	log.Printf("[reports-api-config] updated by %s — base=%q keyChanged=%v rate=%d/min bg=%d/min",
		who, base, setKey, rateLimit, bgShare)
	/* A second, louder line when a key was put behind a public http:// address.
	   The screen shows the warning to whoever made the change; this is what an
	   incident reads afterwards, when the question is how long the key had been
	   travelling in clear text and who put it there. */
	if warning != "" {
		log.Printf("[reports-api-config] WARNING: %s set base=%q — plain http to a public "+
			"host, the API key is sent in clear text", who, base)
	}
	ok(w, map[string]any{"success": true, "warning": warning})
}

/*
── Request pacing ────────────────────────────────────────────────────────────

	How many calls a minute the portal will make, and how many of those a
	background job may have. Stored here because they belong to the CONNECTION —
	they describe what the far end will tolerate — and because they are the only
	numbers that change how long a cache warm takes.

	Kept as settings rather than constants after a warm of 160 clients was
	measured at four and a half hours: 1,640 reports at roughly fifty calls each
	is 80,000 calls, and at 300 a minute that is the arithmetic. Adding warm
	workers does nothing for it — they all wait on the same window.
*/
const (
	defaultRateLimit = 480 // the portal's ceiling, under the service's 600
	defaultBGShare   = 300 // of which a background pass may use this many
)

/*
clampBudget keeps the pair usable.

A background share is never allowed above the total. Letting it through would
hand a warm pass every token in the window and leave a report someone has open
waiting on the minute boundary — which is precisely the failure the pacer was
written to stop, and it would arrive by way of a settings screen.
*/
func clampBudget(rate, bg int) (int, int) {
	if rate <= 0 {
		rate = defaultRateLimit
	}
	if rate > 100000 {
		rate = 100000
	}
	if bg <= 0 {
		bg = defaultBGShare
	}
	if bg > rate {
		bg = rate
	}
	return rate, bg
}

/*
ApplyReportsAPIBudget pushes the stored pacing into the client.

Called at boot and after every save, so raising the limit takes effect on the
pass that is running rather than on the next restart.
*/
func ApplyReportsAPIBudget() {
	ensureReportsAPISchema()
	rate, bg := defaultRateLimit, defaultBGShare
	if row, _ := db.QueryOne("SELECT rate_limit, bg_share FROM " + reportsAPITable + " WHERE id = 1 LIMIT 1"); row != nil {
		if v := int(intVal(row["rate_limit"])); v > 0 {
			rate = v
		}
		if v := int(intVal(row["bg_share"])); v > 0 {
			bg = v
		}
	}
	rate, bg = clampBudget(rate, bg)
	reportsapi.SetBudget(rate, bg)
	log.Printf("[reports-api-config] pacing %d call(s)/min, %d of them for background work", rate, bg)
}

/*
httpWarning is what to tell the person who just saved, or "" when there is
nothing worth saying.

Only one case earns it: plain http to an address outside our own network. https
is fine whatever the host, and http to a container, a loopback or a LAN address
never reaches a wire a stranger is on.
*/
func httpWarning(base string) string {
	if !strings.HasPrefix(base, "http://") || isPrivateHost(base) {
		return ""
	}
	return "Saved, but " + hostOf(base) + " is a public address on plain http:// — " +
		"the API key is sent to it in clear text and anything on the network path " +
		"can read it. Use https:// if that host can offer it."
}

/*
isPrivateHost answers the question the scheme cannot: does a request to this
address stay inside infrastructure we control?

An http:// URL is only a disclosure problem if the traffic crosses something
someone else can listen to. These do not:

  - loopback — localhost, 127.0.0.0/8, ::1, and the *.localhost names
  - the RFC 1918 ranges, plus link-local 169.254 and CGNAT 100.64/10
  - a SINGLE-LABEL host with no dot in it: `reports_api`, `reports-api`. A bare
    name like that is not resolvable on the public internet — it is a Docker
    service, a Compose alias or a LAN hostname, by construction local.
  - the reserved internal suffixes: .local, .internal, .lan, .home.arpa, and
    Kubernetes' .svc / .cluster.local

Anything else is treated as public, which is the right way round for a default:
a host we cannot prove is internal gets the warning.
*/
func isPrivateHost(rawURL string) bool {
	host := hostOf(rawURL)
	if host == "" {
		return false
	}
	host = strings.ToLower(host)

	if ip := net.ParseIP(strings.Trim(host, "[]")); ip != nil {
		return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
			ip.IsUnspecified() || isCGNAT(ip)
	}

	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return true
	}
	// No dot at all — a name only a private resolver can answer.
	if !strings.Contains(host, ".") {
		return true
	}
	for _, suffix := range []string{".local", ".internal", ".lan", ".home.arpa", ".svc", ".cluster.local"} {
		if strings.HasSuffix(host, suffix) {
			return true
		}
	}
	return false
}

// isCGNAT covers 100.64.0.0/10, which net.IP.IsPrivate does not: it is carrier
// space, and it is also what Tailscale and several container runtimes hand out.
func isCGNAT(ip net.IP) bool {
	v4 := ip.To4()
	return v4 != nil && v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127
}

// hostOf is the hostname without the port, or "" if the URL will not parse.
// Falls back to a manual split so a URL net/url rejects still produces a name
// for the warning text rather than an empty sentence.
func hostOf(rawURL string) string {
	if u, err := url.Parse(rawURL); err == nil && u.Host != "" {
		return u.Hostname()
	}
	s := rawURL
	for _, p := range []string{"http://", "https://"} {
		s = strings.TrimPrefix(s, p)
	}
	if i := strings.IndexAny(s, "/?#"); i >= 0 {
		s = s[:i]
	}
	if i := strings.LastIndex(s, ":"); i > 0 && !strings.Contains(s[i:], "]") {
		s = s[:i]
	}
	return s
}

/*
adminName is who is making the change, for the audit line and the row.

The login username rather than a display name: it is the thing that is unique
and the thing an access log elsewhere can be joined on.
*/
func adminName(r *http.Request) string {
	c := getClaims(r)
	if c == nil {
		return "unknown"
	}
	if c.LoginUsername != "" {
		return c.LoginUsername
	}
	return fmt.Sprintf("loginId:%d", c.LoginID)
}

func sourceOf(stored bool) string {
	if stored {
		return "database"
	}
	return "environment"
}

/*
── GET /api/admin/reports-api-config/reveal ─────────────────────────────────

	The decrypted key, on demand, Super-Admin only, and logged.

	It exists because a key that can never be read back cannot be verified
	against the other end — but every read is an opportunity for it to leave, so
	it is a separate route with a stricter guard than the screen that shows the
	mask, and the fact that it happened is recorded.
*/
func ReportsAPIConfigReveal(w http.ResponseWriter, r *http.Request) {
	ensureReportsAPISchema()
	row, _ := db.QueryOne("SELECT api_key FROM " + reportsAPITable + " WHERE id = 1 LIMIT 1")
	if row == nil {
		ok(w, map[string]any{"success": true, "apiKey": ""})
		return
	}
	key := ""
	if enc := strings.TrimSpace(strVal(row["api_key"])); enc != "" {
		key = ipauth.DecryptMain(enc)
	}
	// Named in the log, because "who read the key" is the question an incident
	// asks and the answer has to exist before it is asked.
	log.Printf("[reports-api-config] KEY REVEALED to %s", adminName(r))
	w.Header().Set("Cache-Control", "no-store")
	ok(w, map[string]any{"success": true, "apiKey": key})
}

/*
── POST /api/admin/reports-api-config/test ──────────────────────────────────

	Try a base URL and key against the live service before committing them.

	Without this, saving is the only way to find out whether a key works — and a
	wrong one is discovered later, on a report page, by someone who did not make
	the change. It tests what was TYPED where something was typed, falling back
	to what is stored, so a key can be checked before it is written.
*/
func ReportsAPIConfigTest(w http.ResponseWriter, r *http.Request) {
	var body struct {
		BaseURL string `json:"baseUrl"`
		APIKey  string `json:"apiKey"`
	}
	json.NewDecoder(r.Body).Decode(&body)

	base := strings.TrimRight(strings.TrimSpace(body.BaseURL), "/")
	key := strings.TrimSpace(body.APIKey)
	sb, sk := ReportsAPISource()
	if base == "" {
		base = sb
	}
	if key == "" {
		key = sk
	}
	if base == "" {
		fail(w, 422, "Enter a base URL to test")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()

	res := reportsapi.Probe(ctx, base, key)
	ok(w, map[string]any{
		"success":    true,
		"reachable":  res.Reachable,
		"authorized": res.Authorized,
		"datasets":   res.Datasets,
		"warehouse":  res.WarehouseOK,
		"detail":     res.Detail,
	})
}
