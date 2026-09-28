package handlers

// Reader-chosen list length on the Sports report — "Top 10 / 15 / 20 / 25".
//
// A top-N panel's size was fixed when the report was built: Report
// Configuration's row count decided how many rows the warehouse was asked for,
// and that was all the page ever had. The reader now picks the size on the
// card, so the report carries the MOST a reader can pick (readerTopMax) and the
// page draws the first N. Switching is therefore instant — no query, no cache
// miss — and costs the warehouse almost nothing: a grouped count computes every
// group anyway, the LIMIT only trims what comes back.
//
// Scope: the Sports platforms (and the Sports summary, which adds them up).
// VOD reports keep their configured size.
//
// What the panel opens at, strongest first:
//   - the CLIENT's default for the panel (report_client_topn, below) — set from
//     the card, but only by someone who may shape that client's report: staff,
//     the client's Client Admin, or a login granted report layout (Arrange)
//   - the size Report Configuration sets for the client, 10 unless changed
// A size any reader picks on the card lasts until the page reloads and changes
// that one chart only.

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"sync"

	ipauth "github.com/ip-house/iphouse-api/auth"

	"github.com/ip-house/iphouse-api/db"
)

// dimLinkingWebsites is "Top 10 Linking Websites" — the one panel measured on
// de-indexing rather than removal (see reportsapi_bridge.go).
const dimLinkingWebsites = "byDomain"

// readerTopMax is the largest size a reader can pick, and so the size the
// report is built at.
const readerTopMax = 25

// readerTopChoices is the menu. A configured size outside it is added by the
// page, so a client set to 5 or 50 still opens at its own number.
var readerTopChoices = []int{10, 15, 20, 25}

// readerTopDefault is what a panel opens at when nothing says otherwise.
const readerTopDefault = 10

// readerTopPlatform reports whether a platform's top-N panels are reader-sized.
func readerTopPlatform(platformKey string) bool {
	return sportsOnlyPlatformKeys()[platformKey]
}

// readerTopFetch is how many rows to ASK for, given the configured size n.
func readerTopFetch(platformKey string, n int) int {
	if n > 0 && n < readerTopMax && readerTopPlatform(platformKey) {
		return readerTopMax
	}
	return n
}

func validReaderTop(n int) bool {
	return n > 0 && n <= maxRowLimit
}

/* ── the client's default size per panel ─────────────────────────────────

   Its own table rather than a row in the client's layout (report_panel_layout):
   a client with no layout rows reads the SHARED default layout, and its first
   row would replace that wholesale — one "default size" click would quietly
   discard every arrangement the client inherits. */

const topNClientTable = "report_client_topn"

var topNClientSchemaOnce sync.Once

func ensureTopNClientSchema() {
	topNClientSchemaOnce.Do(func() {
		// panel_key is "<platform>:<panel>", the same composite the chart-type
		// preferences use.
		if _, _, err := db.Exec(`
			CREATE TABLE IF NOT EXISTS ` + topNClientTable + ` (
			  client_id  VARCHAR(64)  NOT NULL,
			  panel_key  VARCHAR(191) NOT NULL,
			  top_n      INT          NOT NULL,
			  updated_by VARCHAR(191) NOT NULL DEFAULT '',
			  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
			  PRIMARY KEY (client_id, panel_key)
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`); err != nil {
			log.Printf("[topn-defaults] create %s: %v", topNClientTable, err)
		}
	})
}

/*
mayDefaultTopN is who may set a client's default size: whoever may shape that
client's report — staff, a login granted report layout (Arrange), or the
client's Client Admin. Never while viewing as someone else: impersonation reads,
it does not rewrite.
*/
func mayDefaultTopN(claims *ipauth.Claims) bool {
	if claims == nil || claims.ImpersonatorLoginID != 0 {
		return false
	}
	return mayEditReportLayout(claims) || claims.ClientAdmin
}

// GET /api/reports/topn-prefs?clientId= → { prefs, canSetDefault, choices, max }
func ReportTopNPrefsGet(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	if claims == nil || !mayOpenAnyReportsPage(claims) {
		Fail(w, 403, "The Reports module is not enabled for this account")
		return
	}
	prefs := map[string]int{}
	clientID, ok, _ := reportScope(claims, r.URL.Query().Get("clientId"))
	if ok && clientID != "" {
		ensureTopNClientSchema()
		rows, err := db.Query("SELECT panel_key, top_n FROM "+topNClientTable+" WHERE client_id = ?", clientID)
		if err != nil {
			// A default that cannot be read is not worth failing a report over.
			log.Printf("[topn-defaults] read for %s: %v", clientID, err)
		}
		for _, row := range rows {
			if k := strFromAny(row["panel_key"]); k != "" {
				prefs[k] = int(numOf(row["top_n"]))
			}
		}
	}
	OK(w, map[string]any{"success": true, "prefs": prefs,
		"canSetDefault": ok && clientID != "" && mayDefaultTopN(claims),
		"choices":       readerTopChoices, "max": readerTopMax})
}

// PUT /api/reports/topn-prefs {clientId, panelKey, topN} — set the client's
// default size for one panel; topN 0 goes back to the configured size.
func ReportTopNPrefsSave(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	if claims == nil || !mayOpenAnyReportsPage(claims) {
		Fail(w, 403, "The Reports module is not enabled for this account")
		return
	}
	if !mayDefaultTopN(claims) {
		Fail(w, 403, "Only an administrator or someone with report layout access can change the default")
		return
	}
	var body struct {
		ClientID string `json:"clientId"`
		PanelKey string `json:"panelKey"`
		TopN     int    `json:"topN"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	clientID, ok, why := reportScope(claims, body.ClientID)
	if !ok {
		Fail(w, 403, why)
		return
	}
	if clientID == "" {
		Fail(w, 422, "Pick a client first")
		return
	}
	panelKey := strings.TrimSpace(body.PanelKey)
	if panelKey == "" || len(panelKey) > 191 {
		Fail(w, 422, "A panel is required")
		return
	}
	ensureTopNClientSchema()
	if body.TopN == 0 {
		if _, _, err := db.Exec("DELETE FROM "+topNClientTable+" WHERE client_id = ? AND panel_key = ?", clientID, panelKey); err != nil {
			Fail(w, 500, "Could not clear this default")
			return
		}
		OK(w, map[string]any{"success": true, "panelKey": panelKey, "topN": 0})
		return
	}
	if !validReaderTop(body.TopN) {
		Fail(w, 422, "Pick a size between 1 and 100")
		return
	}
	if _, _, err := db.Exec(`
		INSERT INTO `+topNClientTable+` (client_id, panel_key, top_n, updated_by) VALUES (?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE top_n = VALUES(top_n), updated_by = VALUES(updated_by)`,
		clientID, panelKey, body.TopN, claims.LoginUsername); err != nil {
		log.Printf("[topn-defaults] save %s for %s: %v", panelKey, clientID, err)
		Fail(w, 500, "Could not save this default")
		return
	}
	log.Printf("[topn-defaults] %s set %s = %d for client %s", claims.LoginUsername, panelKey, body.TopN, clientID)
	OK(w, map[string]any{"success": true, "panelKey": panelKey, "topN": body.TopN})
}
