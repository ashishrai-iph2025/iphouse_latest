package handlers

// What a report is DRAWN WITH and DRAWN IN, per client.
//
// Two settings, one row:
//
//   - ENGINE — which charting library renders the panels. The built-in
//     components, ApexCharts, ECharts, Toast UI, or the sparkline strips.
//     See lib/charts/engines.tsx for what each one can and cannot draw.
//   - THEME  — which palette every mark is coloured from, out of the six named
//     ones in lib/reportTheme.ts, or `custom`: a palette typed into Report
//     Configuration and stored in the `palette` column beside it.
//
// ── Why this is configuration and not a reading preference ───────────────────
//
// It looks like one. It sits next to the per-panel chart shapes, which ARE a
// reading preference (reportvizprefs.go) — kept per login, invisible to
// everyone else. Appearance is deliberately the other thing, for one reason:
//
//   A PALETTE CARRIES MEANING. Identification is navy and removal is orange
//   across this whole product, and a custom palette exists exactly so a client
//   whose brand is green can have that changed. Once one person can change what
//   removal is coloured, two people reading the same report are reading two
//   different documents — and the one who exports a deck sends colours the
//   other has never seen.
//
// So it is decided per client, once, by staff holding the `report-config`
// grant, in the same screen as the layout it belongs beside. Readers do not get
// a switch.
//
// ── The two-layer lookup ─────────────────────────────────────────────────────
//
// An empty client_id is the row every client gets. A client with its own row
// takes it WHOLE — engine, theme and palette together — rather than inheriting
// field by field, so a later change to the default cannot half-recolour a
// report somebody set up deliberately. Same rule as the page layout, for the
// same reason.

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"sync"

	"github.com/ip-house/iphouse-api/db"
)

/*
Said in the words the admin screen shows, because it shows them verbatim. A

	rejected colour is a typo in a form, and "invalid input" would leave somebody
	hunting through six swatches for which one it meant.
*/
var (
	errBadPalette = errors.New("Those custom colours could not be read")
	errBadIdent   = errors.New("The identification colour must be a hex value, like #14254A")
	errBadRemoved = errors.New("The removal colour must be a hex value, like #FC934C")
	errBadCat     = errors.New("Every categorical colour must be a hex value, like #FFC82B")
)

const appearanceTable = "report_appearance"

var appearanceSchemaOnce sync.Once

func ensureAppearanceSchema() {
	appearanceSchemaOnce.Do(func() {
		if _, _, err := db.Exec(`
			CREATE TABLE IF NOT EXISTS ` + appearanceTable + ` (
			  client_id  VARCHAR(64)  NOT NULL DEFAULT '',
			  engine     VARCHAR(16)  NOT NULL DEFAULT 'native',
			  theme      VARCHAR(16)  NOT NULL DEFAULT 'iphouse',
			  -- The custom theme's colours, as JSON. Null on every row whose
			  -- theme is one of the named six; kept rather than cleared when a
			  -- client switches away from custom, so switching back does not
			  -- mean typing six colours again.
			  palette    TEXT         NULL,
			  updated_by VARCHAR(191) NOT NULL DEFAULT '',
			  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
			  PRIMARY KEY (client_id)
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`); err != nil {
			log.Printf("[appearance] create %s: %v", appearanceTable, err)
		}
	})
}

// The shipped answer, for a portal with nothing configured at all.
const (
	defaultReportEngine = "native"
	defaultReportTheme  = "iphouse"
)

// ReportAppearance is one resolved answer: what this client's report is drawn
// with and in.
type ReportAppearance struct {
	Engine string         `json:"engine"`
	Theme  string         `json:"theme"`
	Custom map[string]any `json:"custom,omitempty"`
	/* Which row this came from — "" for the shared default, the client id for a
	   client's own. The admin screen reads it to say whether saving would create
	   an override or edit one; the report itself ignores it. */
	Source string `json:"source"`
}

/*
appearanceFor resolves the two-layer lookup for one client.

	Never fails: a report that cannot read this table is drawn in the house
	palette by the built-in components, which is what every report looked like
	before this existed. An unreadable setting is not worth an error banner over
	a page of real numbers.
*/
func appearanceFor(clientID string) ReportAppearance {
	ensureAppearanceSchema()
	out := ReportAppearance{Engine: defaultReportEngine, Theme: defaultReportTheme}

	// Both candidate rows in one round trip; the client's own wins where it
	// exists. Ordered so the client row is read last and overwrites.
	rows, err := db.Query(
		"SELECT client_id, engine, theme, palette FROM "+appearanceTable+
			" WHERE client_id IN ('', ?) ORDER BY client_id ASC", strings.TrimSpace(clientID))
	if err != nil {
		log.Printf("[appearance] read for client %q: %v", clientID, err)
		return out
	}
	for _, row := range rows {
		id := strFromAny(row["client_id"])
		// Guard against the empty clientID case matching twice.
		if id != "" && id != strings.TrimSpace(clientID) {
			continue
		}
		out.Engine = defaultString(strFromAny(row["engine"]), defaultReportEngine)
		out.Theme = defaultString(strFromAny(row["theme"]), defaultReportTheme)
		out.Source = id
		out.Custom = nil
		if raw := strFromAny(row["palette"]); raw != "" {
			var parsed map[string]any
			// A palette that will not parse is dropped rather than passed on: the
			// page falls back to the house colours for the custom theme, which is
			// what buildCustomTheme does with an empty one anyway.
			if err := json.Unmarshal([]byte(raw), &parsed); err == nil {
				out.Custom = parsed
			}
		}
	}
	return out
}

func defaultString(v, fallback string) string {
	if strings.TrimSpace(v) == "" {
		return fallback
	}
	return v
}

/*
── GET /api/admin/report-appearance?clientId= ───────────────────────────────

	What this client's report is drawn with and in, and whether that answer is
	their own row or the shared default. The admin screen needs both: it says
	"following the shared appearance" until there is an override to edit.
*/
func ReportAppearanceGet(w http.ResponseWriter, r *http.Request) {
	clientID := strings.TrimSpace(r.URL.Query().Get("clientId"))
	got := appearanceFor(clientID)
	OK(w, map[string]any{
		"success":    true,
		"clientId":   clientID,
		"appearance": got,
		// True when the answer came from the shared row rather than this
		// client's own — saving would create one.
		"inherited": clientID != "" && got.Source != clientID,
		"clients":   appearanceClients(),
	})
}

/*
── PUT /api/admin/report-appearance ─────────────────────────────────────────

	Save one row. An empty clientId writes the shared default; a client id writes
	that client's own, creating it if this is the first time.
*/
func ReportAppearanceSave(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	ensureAppearanceSchema()

	var body struct {
		ClientID string          `json:"clientId"`
		Engine   string          `json:"engine"`
		Theme    string          `json:"theme"`
		Custom   json.RawMessage `json:"custom"`
	}
	json.NewDecoder(r.Body).Decode(&body)

	clientID := strings.TrimSpace(body.ClientID)
	if len(clientID) > 64 {
		Fail(w, 422, "That client id is too long")
		return
	}
	engine := strings.TrimSpace(body.Engine)
	theme := strings.TrimSpace(body.Theme)
	/* Both vocabularies are duplicated from the client, deliberately. This is
	   validation, not configuration: the point is to refuse a value the report
	   would not understand, and a list that fetched itself from the front end
	   could not do that. Add an engine or a theme there, add it here. */
	if !validReportEngine(engine) {
		Fail(w, 422, "Unknown chart engine: "+engine)
		return
	}
	if !validReportTheme(theme) {
		Fail(w, 422, "Unknown report theme: "+theme)
		return
	}

	palette, err := normalisePalette(body.Custom)
	if err != nil {
		Fail(w, 422, err.Error())
		return
	}
	// Required only where it is actually used, so a client on a named theme is
	// never blocked by colours nobody will read.
	if theme == "custom" && palette == "" {
		Fail(w, 422, "The custom theme needs an identification and a removal colour")
		return
	}

	who := ""
	if claims != nil {
		who = claims.LoginUsername
	}

	/* A null palette is written only when none was sent. Sending the same
	   colours with a named theme selected keeps them on the row, which is what
	   lets somebody try Slate and come back to their own set. */
	var paletteArg any
	if palette != "" {
		paletteArg = palette
	}

	if _, _, err := db.Exec(`
		INSERT INTO `+appearanceTable+` (client_id, engine, theme, palette, updated_by)
		VALUES (?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
		  engine=VALUES(engine), theme=VALUES(theme),
		  palette=COALESCE(VALUES(palette), palette),
		  updated_by=VALUES(updated_by)`,
		clientID, engine, theme, paletteArg, who); err != nil {
		log.Printf("[appearance] save for client %q: %v", clientID, err)
		Fail(w, 500, "Could not save this appearance")
		return
	}
	OK(w, map[string]any{"success": true, "clientId": clientID, "appearance": appearanceFor(clientID)})
}

/*
── DELETE /api/admin/report-appearance?clientId= ────────────────────────────

	Drop a client's own row, putting them back on the shared default. With no
	clientId this resets the shared row itself, and every client that follows it
	goes back to the built-in components in the house palette.
*/
func ReportAppearanceReset(w http.ResponseWriter, r *http.Request) {
	ensureAppearanceSchema()
	clientID := strings.TrimSpace(r.URL.Query().Get("clientId"))
	if _, _, err := db.Exec(
		"DELETE FROM "+appearanceTable+" WHERE client_id = ?", clientID); err != nil {
		Fail(w, 500, "Could not reset this appearance")
		return
	}
	OK(w, map[string]any{"success": true, "clientId": clientID, "appearance": appearanceFor(clientID)})
}

// appearanceClients lists the clients that have an appearance of their own, so
// the picker can mark them without asking one query per name.
func appearanceClients() []string {
	out := []string{}
	rows, err := db.Query("SELECT client_id FROM " + appearanceTable + " WHERE client_id != ''")
	if err != nil {
		return out
	}
	for _, r := range rows {
		if id := strFromAny(r["client_id"]); id != "" {
			out = append(out, id)
		}
	}
	return out
}

/*
normalisePalette turns the posted custom colours into the JSON that is stored.

	Returns "" for "nothing was sent", which leaves whatever is already on the
	row alone. Everything that IS sent is validated: a colour the page cannot
	parse would be rendered as black on a client's report, which looks like a
	fault in the data rather than a typo in a form.
*/
func normalisePalette(raw json.RawMessage) (string, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return "", nil
	}
	var in struct {
		Ident   string   `json:"ident"`
		Removed string   `json:"removed"`
		Cat     []string `json:"cat"`
	}
	if err := json.Unmarshal(raw, &in); err != nil {
		return "", errBadPalette
	}
	if !isHexColour(in.Ident) {
		return "", errBadIdent
	}
	if !isHexColour(in.Removed) {
		return "", errBadRemoved
	}
	cat := make([]string, 0, len(in.Cat))
	for _, c := range in.Cat {
		if c = strings.TrimSpace(c); c == "" {
			continue
		}
		if !isHexColour(c) {
			return "", errBadCat
		}
		cat = append(cat, c)
		// The report only ever hands out eight categorical slots; anything past
		// that is stored and never drawn.
		if len(cat) == 8 {
			break
		}
	}
	out, err := json.Marshal(map[string]any{
		"ident": in.Ident, "removed": in.Removed, "cat": cat,
	})
	if err != nil {
		return "", errBadPalette
	}
	return string(out), nil
}

// isHexColour accepts #rgb and #rrggbb, with or without the hash — the same
// two shapes lib/reportTheme.ts parses.
func isHexColour(v string) bool {
	s := strings.TrimPrefix(strings.TrimSpace(v), "#")
	if len(s) != 3 && len(s) != 6 {
		return false
	}
	for _, c := range s {
		switch {
		case c >= '0' && c <= '9', c >= 'a' && c <= 'f', c >= 'A' && c <= 'F':
		default:
			return false
		}
	}
	return true
}

func validReportEngine(v string) bool {
	switch v {
	case "native", "apex", "echarts", "toast", "spark":
		return true
	}
	return false
}

func validReportTheme(v string) bool {
	switch v {
	case "iphouse", "slate", "vivid", "contrast", "monochrome", "midnight", "custom":
		return true
	}
	return false
}
