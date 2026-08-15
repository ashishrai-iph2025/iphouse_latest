package handlers

// Per-reader chart shapes.
//
// Three things can decide how a report panel is drawn, and they are not the same
// kind of statement:
//
//   - the REGISTRY picks a shape per dimension — a share as a donut, a turnaround
//     as an ordered ramp. A sensible default, decided by what the data is.
//   - the LAYOUT overrides it per platform and per client (report_panel_layout,
//     see reportlayout.go). Configuration: staff deciding how a client's report
//     should look.
//   - this table overrides BOTH, for one login only. A reading preference: the
//     person looking at the page prefers columns to bars, and nobody else's page
//     changes because of it.
//
// The page also has a fourth, weaker level — "view this as", which is not stored
// at all and lasts until the tab is reloaded. That is why the menu offers two
// actions per shape: look at it now, or keep it. Only the second one lands here.
//
// Keyed on login_id rather than user_id: a preference belongs to the person
// sitting in front of the report, and two logins on the same portal user are two
// people.

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"sync"

	"github.com/ip-house/iphouse-api/db"
)

const vizPrefTable = "report_user_viz"

var vizPrefSchemaOnce sync.Once

func ensureVizPrefSchema() {
	vizPrefSchemaOnce.Do(func() {
		// panel_key is "<platform>:<panel>" — the same composite the page keys its
		// in-memory overrides on, so a panel means the same thing on both sides.
		if _, _, err := db.Exec(`
			CREATE TABLE IF NOT EXISTS ` + vizPrefTable + ` (
			  login_id   INT UNSIGNED NOT NULL,
			  panel_key  VARCHAR(191) NOT NULL,
			  viz        VARCHAR(16)  NOT NULL,
			  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
			  PRIMARY KEY (login_id, panel_key)
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`); err != nil {
			log.Printf("[viz-prefs] create %s: %v", vizPrefTable, err)
		}
	})
}

/*
── GET /api/reports/viz-prefs ───────────────────────────────────────────────

	Every shape this login has kept, as panelKey → viz. One request on page load
	rather than one per panel: the whole set is a few dozen short rows at most,
	and a panel cannot render until it knows its shape.

	An empty map is the normal answer for someone who has never set one, and is
	not an error — the page falls through to the configured shape.
*/
func ReportVizPrefsGet(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	if claims == nil || !mayOpenReports(claims) {
		Fail(w, 403, "The Reports module is not enabled for this account")
		return
	}
	ensureVizPrefSchema()

	prefs := map[string]string{}
	rows, err := db.Query(
		"SELECT panel_key, viz FROM "+vizPrefTable+" WHERE login_id = ?", claims.LoginID)
	if err != nil {
		// A reading preference is not worth failing a report over: the page still
		// renders every panel in its configured shape.
		log.Printf("[viz-prefs] read for login %d: %v", claims.LoginID, err)
		OK(w, map[string]any{"success": true, "prefs": prefs})
		return
	}
	for _, row := range rows {
		key := strFromAny(row["panel_key"])
		if key != "" {
			prefs[key] = strFromAny(row["viz"])
		}
	}
	OK(w, map[string]any{"success": true, "prefs": prefs})
}

/*
── PUT /api/reports/viz-prefs ───────────────────────────────────────────────

	Keep one panel's shape, or forget it. An empty viz deletes the row rather than
	storing a blank, so "back to the configured shape" leaves nothing behind and
	a later change to the layout is picked up instead of being masked by a stale
	preference.
*/
func ReportVizPrefsSave(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	if claims == nil || !mayOpenReports(claims) {
		Fail(w, 403, "The Reports module is not enabled for this account")
		return
	}
	/* Impersonation reads, it does not rewrite. Staff looking at a client's
	   report through their account would otherwise silently replace that
	   person's saved shapes with whatever they clicked while diagnosing. The
	   session-only "View" still works, which is what a diagnostic needs. */
	if claims.ImpersonatorLoginID != 0 {
		Fail(w, 403, "Chart defaults cannot be changed while viewing as another user")
		return
	}
	ensureVizPrefSchema()

	var body struct {
		PanelKey string `json:"panelKey"`
		Viz      string `json:"viz"`
	}
	json.NewDecoder(r.Body).Decode(&body)

	panelKey := strings.TrimSpace(body.PanelKey)
	if panelKey == "" || len(panelKey) > 191 {
		Fail(w, 422, "A panel is required")
		return
	}
	viz := strings.TrimSpace(body.Viz)

	if viz == "" {
		if _, _, err := db.Exec(
			"DELETE FROM "+vizPrefTable+" WHERE login_id = ? AND panel_key = ?",
			claims.LoginID, panelKey); err != nil {
			Fail(w, 500, "Could not clear this chart type")
			return
		}
		OK(w, map[string]any{"success": true, "panelKey": panelKey, "viz": ""})
		return
	}

	/* The vocabulary is wider here than validViz, which only covers the breakdown
	   panels. The trend and rate cards have shapes of their own — a trend can be
	   automatic, the rate cannot — and neither is in the layout's list. Rejecting
	   an unknown value rather than storing it keeps a typo from surviving a
	   reload as a panel that renders nothing. */
	if !validPanelViz(viz) {
		Fail(w, 422, "Unknown chart type: "+viz)
		return
	}

	if _, _, err := db.Exec(`
		INSERT INTO `+vizPrefTable+` (login_id, panel_key, viz) VALUES (?, ?, ?)
		ON DUPLICATE KEY UPDATE viz = VALUES(viz)`,
		claims.LoginID, panelKey, viz); err != nil {
		log.Printf("[viz-prefs] save %s for login %d: %v", panelKey, claims.LoginID, err)
		Fail(w, 500, "Could not save this chart type")
		return
	}
	OK(w, map[string]any{"success": true, "panelKey": panelKey, "viz": viz})
}

// validPanelViz accepts any shape a report card can be drawn as: the breakdown
// vocabulary the layout configures, plus the trend and rate cards' own.
func validPanelViz(v string) bool {
	if validViz(v) {
		return true
	}
	switch v {
	case "auto", "line": // trend: automatic; rate: a plain line
		return true
	}
	return false
}
