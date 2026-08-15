package handlers

import (
	"encoding/json"
	"log"
	"net/http"
	"sort"
	"strings"
	"sync"

	"github.com/ip-house/iphouse-api/db"
)

// Panel layout — where each visual sits on a report, and how wide it is.
//
// Until now the page's shape was code: the KPI band, then the trend, then the
// rate, then a grid of breakdown panels in registry order, each panel's width
// derived from its chart type. That is a sensible default and a bad rule — which
// panels matter, and which belong side by side, is a question about the client
// reading the report, not about the chart.
//
// So the layout is data. A PANEL is any visual on the page — the KPI band, a
// section heading, a trend chart, the removal rate, or one breakdown — and each
// one carries a position, a width and a visible flag, stored per platform. The
// server computes the DEFAULT layout from the platform's shape (that is the code
// that used to be the only layout) and then overlays whatever has been
// configured, so an unconfigured platform looks exactly as it did and a
// configured one is edited a row at a time rather than rebuilt.
//
// Widths are thirds of a six-column grid: full (6), half (3) or third (2) — so a
// row holds one, two or three panels. Nothing enforces that a row adds up; a row
// that does not simply wraps, which is the honest result of the choice made.

const layoutTable = "report_panel_layout"

// The empty client id is the layout every client gets unless one of them has its
// own. Stored as a real row rather than a NULL so the primary key stays simple.
const layoutAllClients = ""

var layoutSchemaOnce sync.Once

func ensureLayoutSchema() {
	layoutSchemaOnce.Do(func() {
		if _, _, err := db.Exec(`
			CREATE TABLE IF NOT EXISTS ` + layoutTable + ` (
			  platform_key VARCHAR(64)  NOT NULL,
			  client_id    VARCHAR(64)  NOT NULL DEFAULT '',
			  panel_key    VARCHAR(96)  NOT NULL,
			  sort_order   INT          NOT NULL DEFAULT 0,
			  span         VARCHAR(8)   NOT NULL DEFAULT '',
			  viz          VARCHAR(16)  NOT NULL DEFAULT '',
			  is_hidden    TINYINT(1)   NOT NULL DEFAULT 0,
			  updated_by   VARCHAR(191) NOT NULL DEFAULT '',
			  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
			  PRIMARY KEY (platform_key, client_id, panel_key)
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`); err != nil {
			log.Printf("[layout] create %s: %v", layoutTable, err)
			return
		}
		// An install created before layouts could vary per client has the
		// two-column key. Widen it in place — the rows it holds are the
		// all-clients default, which is exactly what an empty client_id means, so
		// nothing needs rewriting.
		if !portalColumnExists(layoutTable, "client_id") {
			if _, _, err := db.Exec(
				"ALTER TABLE " + layoutTable + " ADD COLUMN client_id VARCHAR(64) NOT NULL DEFAULT '' AFTER platform_key"); err != nil {
				log.Printf("[layout] add client_id: %v", err)
				return
			}
			if _, _, err := db.Exec(
				"ALTER TABLE " + layoutTable + " DROP PRIMARY KEY, ADD PRIMARY KEY (platform_key, client_id, panel_key)"); err != nil {
				log.Printf("[layout] widen primary key: %v", err)
				return
			}
			log.Printf("[layout] %s now keyed per client; existing rows kept as the all-clients default", layoutTable)
		}
		// Chart type joined the layout later than position and width. An empty
		// value means "whatever the registry picked", which is what every
		// existing row means.
		if !portalColumnExists(layoutTable, "viz") {
			if _, _, err := db.Exec(
				"ALTER TABLE " + layoutTable + " ADD COLUMN viz VARCHAR(16) NOT NULL DEFAULT '' AFTER span"); err != nil {
				log.Printf("[layout] add viz: %v", err)
			}
		}
	})
}

/*
── Chart types ──────────────────────────────────────────────────────────────

	What a breakdown panel can be drawn as. The registry picks one per dimension
	— a share split as a donut, a turnaround split as an ordered ramp — and that
	choice is a sensible default rather than a fact: the same rows read better as
	a table for one client and as bars for another.

	So the layout can override it. This list is the whole vocabulary the report
	page knows how to render (see renderDim in app/admin/reports/page.tsx); a
	value outside it is ignored rather than passed through, or the panel would
	fall through to the default renderer with no explanation.
*/
var vizChoices = []struct{ Key, Label string }{
	{"bars", "Ranked bars"},
	{"hbar", "Horizontal bars"},
	{"column", "Columns"},
	{"stacked", "Stacked share"},
	{"value", "Single-series bars"},
	{"ordinal", "Ordered bars"},
	{"donut", "Donut"},
	{"share", "Donut, ordered"},
	{"table", "Ranked table"},
	{"map", "World map"},
	{"heat", "Heat grid"},
}

func validViz(v string) bool {
	for _, c := range vizChoices {
		if c.Key == v {
			return true
		}
	}
	return false
}

func vizLabel(v string) string {
	for _, c := range vizChoices {
		if c.Key == v {
			return c.Label
		}
	}
	return v
}

// portalColumnExists asks the PORTAL's own schema whether a column is there —
// used to make a schema change idempotent without tracking migrations.
func portalColumnExists(table, column string) bool {
	row, err := db.QueryOne(`
		SELECT COUNT(*) AS c FROM information_schema.COLUMNS
		 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, table, column)
	return err == nil && row != nil && numOf(row["c"]) > 0
}

/* ── Panel kinds ──────────────────────────────────────────────────────────────
   The kind tells the page what to draw; the key identifies the panel across
   renders and is what the configuration is stored against. A breakdown panel's
   key IS its dimension key, so a dimension that disappears from the warehouse
   takes its layout row with it and nothing dangles. */

const (
	panelTile    = "tile"    // ONE headline figure
	panelHeading = "heading" // a section rule with a title
	panelTrend   = "trend"   // identification over time, merged or per source
	panelRate    = "rate"    // removal rate over time
	panelDim     = "dim"     // one breakdown
)

// Stable keys for the panels that are not breakdowns.
const (
	keyHeadTop   = "head:volume"
	keyHeadDims  = "head:breakdowns"
	keyTrend     = "trend"
	keyRate      = "rate"
	keyTrendRole = "trend:" // + role, e.g. trend:linking
	keyTilePfx   = "kpi:"   // + metric, e.g. kpi:totalAssets
)

/*
Widths, as fractions of a TWELVE-column grid.

Twelve rather than six because the headline figures are panels too now, and four
of them across a row is what a KPI band has always looked like — which six
columns cannot express. Twelve divides by 2, 3 and 4, so every width below is a
whole number of columns and a row of any of them lands flush.
*/
const (
	spanFull    = "full"    // 12
	spanHalf    = "half"    // 6
	spanThird   = "third"   // 4
	spanQuarter = "quarter" // 3
)

func validSpan(s string) bool {
	return s == spanFull || s == spanHalf || s == spanThird || s == spanQuarter
}

/* ── Headline figures ─────────────────────────────────────────────────────────
   Each tile is its own panel: named in the configuration screen, moved and
   resized like a chart, and switched off for a client who does not want it. The
   band is not a thing any more — it is simply the run of tiles at the top, which
   is why "add another KPI" and "move that chart up" are now the same operation.

   The metric is the key the report's kpi payload carries, so a tile whose figure
   this platform does not produce is never offered. */

// kpiTileLabels is what each figure is CALLED. Mirrors KPI_LABELS in
// app/admin/reports/page.tsx; this copy exists so the configuration screen can
// name a tile without the warehouse having been queried.
var kpiTileLabels = map[string]string{
	"identified":          "Total Infringements",
	"removed":             "Removed",
	"removalPct":          "Total Removal %",
	"pending":             "Pending Removal",
	"totalAssets":         "Total Assets",
	"totalDomains":        "Total Websites",
	"totalChannels":       "Channels",
	"totalPlaces":         "No. of Website / Channel / Page",
	"channelsSuspended":   "Website / Channel Suspended",
	"suspendedWebsites":   "Suspended Websites",
	"impactedSubscribers": "Impacted Subscribers",
	"impactedTraffic":     "Impacted Traffic",
	"views":               "Total Views",
	"viewsSaved":          "Total Views Saved",
	"savedRevenue":        "Estimated Saved Revenue",
	"likes":               "Total Likes",
	"crawled":             "Crawled",
	"notices":             "Notices Sent",
	"googleDelisted":      "Google Delisted",
	"bingDelisted":        "Bing Delisted",
	"delisted":            "Delisted",
}

func kpiTileLabel(metric string) string {
	if l, ok := kpiTileLabels[metric]; ok {
		return l
	}
	return metric
}

// baseKPIMetrics are the four every report returns, whatever it reads.
var baseKPIMetrics = []string{"identified", "removed", "removalPct", "pending"}

// kpiTilesFor is the tile list a section offers, in its default reading order:
// the figures every report has, then the extras this platform's tables produce.
func kpiTilesFor(extras []string) []string {
	out := append([]string{}, baseKPIMetrics...)
	seen := map[string]bool{}
	for _, m := range out {
		seen[m] = true
	}
	for _, m := range extras {
		if !seen[m] {
			seen[m] = true
			out = append(out, m)
		}
	}
	return out
}

// wideViz names the chart types that need a whole row: a horizontal bar spends
// it on the label column, a column chart on giving each category enough axis to
// carry its own label, a map and a heat grid on being legible at all. Mirrors
// WIDE_VIZ in app/admin/reports/page.tsx, which is the fallback when a panel
// arrives without a span.
var wideViz = map[string]bool{
	"heat": true, "map": true, "table": true, "hbar": true, "column": true,
}

// defaultSpanForViz is the width a breakdown takes when nothing says otherwise.
func defaultSpanForViz(viz string) string {
	if wideViz[viz] {
		return spanFull
	}
	return spanHalf
}

type panelDef struct {
	Key    string
	Kind   string
	Label  string
	Sub    string // heading only
	Viz    string // breakdown only
	Role   string // trend only: which source it draws
	Metric string // tile only: the kpi key it shows
	Span   string
	Hidden bool
}

func (p panelDef) asMap() map[string]any {
	out := map[string]any{
		"key": p.Key, "kind": p.Kind, "label": p.Label, "span": p.Span,
	}
	if p.Sub != "" {
		out["sub"] = p.Sub
	}
	if p.Viz != "" {
		out["viz"] = p.Viz
	}
	if p.Role != "" {
		out["role"] = p.Role
	}
	if p.Metric != "" {
		out["metric"] = p.Metric
	}
	if p.Hidden {
		out["hidden"] = true
	}
	return out
}

/* ── The default layout ───────────────────────────────────────────────────── */

// defaultPanels builds the layout a platform has before anyone configures it —
// which is the page exactly as it was written by hand: headline figures, the
// trend (one per source where the platform's tables describe different things),
// the rate, then the breakdowns in the registry's reading order.
//
// `dims` are the section's breakdowns, already ordered and labelled; `roles` are
// the distinct source roles the platform's tables carry; `tiles` are the metrics
// this report can put a headline figure against.
func defaultPanels(dims []map[string]any, roles []string, tiles []string) []panelDef {
	// Four across, which is what a KPI band has always looked like.
	out := make([]panelDef, 0, len(tiles)+len(dims)+6)
	for _, metric := range tiles {
		out = append(out, panelDef{
			Key: keyTilePfx + metric, Kind: panelTile, Metric: metric,
			Label: kpiTileLabel(metric), Span: spanQuarter,
		})
	}
	out = append(out,
		panelDef{Key: keyHeadTop, Kind: panelHeading, Label: "Volume and enforcement",
			Sub: "How much was found, how much came down, and how that rate moved", Span: spanFull})

	if len(roles) > 1 {
		// Two halves of one report — a linking trend and a hosting trend — so they
		// start side by side, which is the comparison they exist to support.
		for _, role := range roles {
			out = append(out, panelDef{
				Key: keyTrendRole + role, Kind: panelTrend, Role: role, Span: spanHalf,
			})
		}
	} else {
		out = append(out, panelDef{Key: keyTrend, Kind: panelTrend, Span: spanFull})
	}

	/* The removal rate takes half a row when there is a compact panel to ride
	   beside it, and the whole row when there is not — a half-width card with
	   nothing next to it is just a narrow card. The donut split is the one that
	   pairs with it, so it is promoted out of the grid to sit there. */
	var headline map[string]any
	rest := make([]map[string]any, 0, len(dims))
	for _, d := range dims {
		if headline == nil && strFromAny(d["key"]) == "byPlatform" && strFromAny(d["viz"]) == "donut" {
			headline = d
			continue
		}
		rest = append(rest, d)
	}

	rateSpan := spanFull
	if headline != nil {
		rateSpan = spanHalf
	}
	out = append(out, panelDef{Key: keyRate, Kind: panelRate, Span: rateSpan})
	if headline != nil {
		out = append(out, dimPanel(headline, spanHalf))
	}

	out = append(out, panelDef{
		Key: keyHeadDims, Kind: panelHeading, Label: "Breakdowns",
		Sub:  "Views of the same result set — click any row to cross-filter every panel",
		Span: spanFull,
	})
	for _, d := range rest {
		out = append(out, dimPanel(d, ""))
	}
	return out
}

// dimPanel turns a section dimension into a panel, taking the width the registry
// asked for, then the one its chart type implies.
func dimPanel(d map[string]any, span string) panelDef {
	viz := strFromAny(d["viz"])
	if viz == "" {
		viz = "bars"
	}
	if span == "" {
		span = strFromAny(d["span"])
	}
	if !validSpan(span) {
		span = defaultSpanForViz(viz)
	}
	return panelDef{
		Key: strFromAny(d["key"]), Kind: panelDim,
		Label: strFromAny(d["label"]), Viz: viz, Span: span,
	}
}

/* ── The stored overlay ───────────────────────────────────────────────────── */

type layoutRow struct {
	Order  int64
	Span   string
	Viz    string
	Hidden bool
	Set    bool
}

/*
layoutFor reads the stored layout for a platform, for one client.

A client with its own layout gets it WHOLE, not merged over the all-clients one.
Merging would mean a change to the shared default silently reshuffling a page
somebody arranged deliberately for one client — the two would drift apart in
ways nobody asked for. So the fallback is all-or-nothing: a client either has a
layout of its own or takes the default.
*/
func layoutFor(platformKey, clientID string) map[string]layoutRow {
	ensureLayoutSchema()
	out := readLayoutRows(platformKey, clientID)
	if len(out) == 0 && clientID != layoutAllClients {
		out = readLayoutRows(platformKey, layoutAllClients)
	}
	return out
}

func readLayoutRows(platformKey, clientID string) map[string]layoutRow {
	out := map[string]layoutRow{}
	rows, err := db.Query(
		"SELECT panel_key, sort_order, span, viz, is_hidden FROM "+layoutTable+
			" WHERE platform_key = ? AND client_id = ?", platformKey, clientID)
	if err != nil {
		return out
	}
	for _, r := range rows {
		out[strFromAny(r["panel_key"])] = layoutRow{
			Order:  numOf(r["sort_order"]),
			Span:   strFromAny(r["span"]),
			Viz:    strFromAny(r["viz"]),
			Hidden: numOf(r["is_hidden"]) == 1,
			Set:    true,
		}
	}
	return out
}

// applyLayout overlays the stored configuration on the default panels.
//
// A panel with no stored row keeps its default width and its default position,
// which matters more than it sounds: configuring three panels must not shuffle
// the twenty that were left alone, and a NEW panel — a dimension that appeared
// because a table gained a column — has to land somewhere sensible rather than
// at position zero. So an unconfigured panel sorts on its default index, and a
// configured one on its stored order, in the same sequence.
func applyLayout(platformKey, clientID string, panels []panelDef) []panelDef {
	stored := layoutFor(platformKey, clientID)
	if len(stored) == 0 {
		return panels
	}

	type ranked struct {
		p    panelDef
		rank float64
	}
	list := make([]ranked, 0, len(panels))
	for i, p := range panels {
		// Stored positions are written in steps of ten, so a default index is put
		// on the same scale before the two are compared. Otherwise every
		// unconfigured panel — including one that only just appeared because a
		// table gained a column — would sort ahead of the entire saved layout.
		rank := float64((i + 1) * 10)
		if row, ok := stored[p.Key]; ok {
			rank = float64(row.Order)
			if validSpan(row.Span) {
				p.Span = row.Span
			}
			// Only a breakdown has a chart type; a stored one on anything else is
			// a stale row, not an instruction.
			if p.Kind == panelDim && validViz(row.Viz) {
				p.Viz = row.Viz
			}
			p.Hidden = row.Hidden
		}
		list = append(list, ranked{p, rank})
	}
	sort.SliceStable(list, func(i, j int) bool { return list[i].rank < list[j].rank })

	out := make([]panelDef, 0, len(list))
	for _, r := range list {
		out = append(out, r.p)
	}
	return out
}

// sectionPanels is the whole job: default layout for this platform's shape, with
// whatever has been configured for this client laid over it. Hidden panels are
// dropped here, so the report page never has to know they existed.
func sectionPanels(platformKey, clientID string, dims []map[string]any, roles, tiles []string) []map[string]any {
	panels := applyLayout(platformKey, clientID, defaultPanels(dims, roles, tiles))
	out := make([]map[string]any, 0, len(panels))
	for _, p := range panels {
		if p.Hidden {
			continue
		}
		out = append(out, p.asMap())
	}
	return out
}

// rolesForPlatform lists the distinct source roles a platform's tables carry, in
// reading order. Two or more means the report draws a trend per source.
func rolesForPlatform(p platformDef) []string {
	specs, _ := specsForPlatform(p)
	seen := map[string]bool{}
	for _, s := range specs {
		if s.Role != "" {
			seen[s.Role] = true
		}
	}
	out := []string{}
	for _, role := range roleOrder {
		if seen[role] {
			out = append(out, role)
		}
	}
	return out
}

/*
── GET /api/admin/report-layout?platform=&clientId= ─────────────────────────

	The configuration page's view: every panel this platform has, in its current
	order, with its width and whether it is hidden — including the ones that are,
	which the report itself never sees.

	An empty clientId is the layout every client gets. Pass one and the answer is
	that client's own layout if it has one, otherwise the shared default, with
	`ownLayout` saying which — so the screen can offer "this client follows the
	default" rather than pretending the default is theirs.
*/
func ReportLayoutGet(w http.ResponseWriter, r *http.Request) {
	key := strings.TrimSpace(r.URL.Query().Get("platform"))
	if key == "" {
		Fail(w, 422, "A platform is required")
		return
	}
	clientID := strings.TrimSpace(r.URL.Query().Get("clientId"))

	dims, roles, tiles, label, ok := layoutInputsFor(key)
	if !ok {
		Fail(w, 404, "Unknown platform: "+key)
		return
	}

	defaults := defaultPanels(dims, roles, tiles)
	panels := applyLayout(key, clientID, defaults)

	// What the default WOULD be, so the page can show a Reset that means
	// something and mark the rows that differ from it.
	defaultSpan := map[string]string{}
	defaultViz := map[string]string{}
	defaultPos := map[string]int{}
	for i, p := range defaults {
		defaultSpan[p.Key] = p.Span
		defaultViz[p.Key] = p.Viz
		defaultPos[p.Key] = i
	}

	out := make([]map[string]any, 0, len(panels))
	for i, p := range panels {
		row := p.asMap()
		row["position"] = i
		row["hidden"] = p.Hidden
		row["defaultSpan"] = defaultSpan[p.Key]
		if p.Kind == panelDim {
			row["defaultViz"] = defaultViz[p.Key]
			row["defaultVizLabel"] = vizLabel(defaultViz[p.Key])
		}
		// A trend or a rate card titles itself from the data — "Month-on-Month
		// Linking Identification & Delisting" is not knowable until the range is
		// known — so the configuration screen gets a plain name to arrange by.
		row["name"] = panelName(p)
		// A heading is a rule across the page; letting it be half a row wide
		// would make it a label floating beside a chart.
		if p.Kind == panelHeading {
			row["fixedSpan"] = true
		}
		out = append(out, row)
	}

	// The chart types a breakdown may be switched to, so the screen offers a list
	// rather than asking anyone to type a renderer's name.
	vizList := make([]map[string]any, 0, len(vizChoices))
	for _, c := range vizChoices {
		vizList = append(vizList, map[string]any{"key": c.Key, "label": c.Label})
	}

	own := len(readLayoutRows(key, clientID)) > 0
	shared := len(readLayoutRows(key, layoutAllClients)) > 0
	OK(w, map[string]any{
		"success": true, "platform": key, "label": label, "clientId": clientID,
		"panels": out, "vizChoices": vizList,
		// Whether what is shown belongs to this client or is the shared default
		// they are currently following — the screen says which, so "Reset" is
		// never ambiguous about what it would delete.
		"ownLayout": own,
		"configured": func() bool {
			if clientID == layoutAllClients {
				return shared
			}
			return own
		}(),
		"followsDefault":    clientID != layoutAllClients && !own,
		"defaultConfigured": shared,
	})
}

// panelName is what a panel is called when it is being ARRANGED rather than
// read. Most panels carry their own title; the trend and rate cards do not,
// because theirs depends on the date range the reader chose.
func panelName(p panelDef) string {
	switch p.Kind {
	case panelTrend:
		if p.Role != "" {
			if name, ok := roleDisplayName[p.Role]; ok {
				return name + " identification over time"
			}
			return p.Role + " identification over time"
		}
		return "Identification & Removal over time"
	case panelRate:
		return "Removal rate over time"
	case panelTile:
		return kpiTileLabel(p.Metric) + " (KPI tile)"
	}
	if p.Label != "" {
		return p.Label
	}
	return p.Key
}

// layoutInputsFor resolves the breakdowns, source roles and headline figures a
// platform's layout is built from — the same three things the sections endpoint
// uses, so the configuration page and the report can never disagree about which
// panels exist.
func layoutInputsFor(key string) (dims []map[string]any, roles, tiles []string, label string, ok bool) {
	if p, found := platformByKey(key); found {
		return sectionDimensions(p), rolesForPlatform(p), kpiTilesFor(platformExtraKPIs(p)), p.Label, true
	}
	if key == summaryKey && summaryIsBuiltIn() {
		plats := summaryPlatforms(nil)
		if len(plats) == 0 {
			// Access is per-login and this endpoint is staff configuration, so the
			// summary's panel list is built from every enabled platform.
			plats = enabledPlatforms()
		}
		// The all-clients layout, because this is only being asked which PANELS
		// exist — the per-client overlay is applied by the caller.
		sec, built := summarySection(plats, layoutAllClients)
		if !built {
			return nil, nil, nil, "", false
		}
		return asMaps(sec["dimensions"]), nil, asStrings(sec["kpiTiles"]), summaryLabel, true
	}
	return nil, nil, nil, "", false
}

// platformExtraKPIs is every figure beyond the base four that a platform's
// tables can produce, in a stable order.
func platformExtraKPIs(p platformDef) []string {
	specs, _ := specsForPlatform(p)
	seen := map[string]bool{}
	for _, sp := range specs {
		for k := range sp.ExtraKPI {
			seen[k] = true
		}
	}
	out := make([]string, 0, len(seen))
	for k := range seen {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// enabledPlatforms is every platform that is switched on, ignoring per-login
// access — which is what a configuration screen should reason about.
func enabledPlatforms() []platformDef {
	out := []platformDef{}
	for _, p := range loadPlatforms() {
		if p.Enabled && p.Key != summaryKey {
			out = append(out, p)
		}
	}
	return out
}

func asMaps(v any) []map[string]any {
	if rows, ok := v.([]map[string]any); ok {
		return rows
	}
	return asRows(v)
}

/*
── PUT /api/admin/report-layout ─────────────────────────────────────────────

	Body: { platform, panels: [{ key, span, hidden }] } — the whole layout, in the
	order the panels should appear.

	Saved wholesale rather than diffed: the list is short, the order is the point,
	and rewriting it means the stored positions always match exactly what the
	admin just arranged, with no drift from repeated moves.
*/
func ReportLayoutSave(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	ensureLayoutSchema()

	var body struct {
		Platform string `json:"platform"`
		ClientID string `json:"clientId"`
		Panels   []struct {
			Key    string `json:"key"`
			Span   string `json:"span"`
			Viz    string `json:"viz"`
			Hidden bool   `json:"hidden"`
		} `json:"panels"`
	}
	json.NewDecoder(r.Body).Decode(&body)

	key := strings.TrimSpace(body.Platform)
	if key == "" {
		Fail(w, 422, "A platform is required")
		return
	}
	clientID := strings.TrimSpace(body.ClientID)
	if _, _, _, _, ok := layoutInputsFor(key); !ok {
		Fail(w, 404, "Unknown platform: "+key)
		return
	}
	if len(body.Panels) == 0 {
		Fail(w, 422, "A panel list is required")
		return
	}

	who := ""
	if claims != nil {
		who = claims.LoginUsername
	}

	if _, _, err := db.Exec(
		"DELETE FROM "+layoutTable+" WHERE platform_key = ? AND client_id = ?", key, clientID); err != nil {
		Fail(w, 500, "Could not replace this layout")
		return
	}
	pos := 0
	seen := map[string]bool{}
	for _, p := range body.Panels {
		pk := strings.TrimSpace(p.Key)
		if pk == "" || seen[pk] {
			continue
		}
		seen[pk] = true
		span := strings.TrimSpace(p.Span)
		if !validSpan(span) {
			span = ""
		}
		// Empty means "keep whatever the registry chose", which is how a panel
		// goes back to its default without a separate control for it.
		viz := strings.TrimSpace(p.Viz)
		if !validViz(viz) {
			viz = ""
		}
		hidden := 0
		if p.Hidden {
			hidden = 1
		}
		pos += 10
		if _, _, err := db.Exec(`
			INSERT INTO `+layoutTable+` (platform_key, client_id, panel_key, sort_order, span, viz, is_hidden, updated_by)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON DUPLICATE KEY UPDATE sort_order=VALUES(sort_order), span=VALUES(span),
			  viz=VALUES(viz), is_hidden=VALUES(is_hidden), updated_by=VALUES(updated_by)`,
			key, clientID, pk, pos, span, viz, hidden, who); err != nil {
			log.Printf("[layout] save %s/%s/%s: %v", key, clientID, pk, err)
			Fail(w, 500, "Could not save this layout")
			return
		}
	}
	OK(w, map[string]any{"success": true, "platform": key, "clientId": clientID, "panels": len(seen)})
}

/*
── DELETE /api/admin/report-layout?platform=&clientId= ──────────────────────

	Back to the default. Nothing else stores a layout, so removing the rows IS the
	reset — the defaults are recomputed from the platform's shape every time.

	With a clientId this drops only that client's own layout, which puts them back
	on the shared default; without one it drops the shared default itself, and any
	client with a layout of their own keeps it.
*/
func ReportLayoutReset(w http.ResponseWriter, r *http.Request) {
	ensureLayoutSchema()
	key := strings.TrimSpace(r.URL.Query().Get("platform"))
	if key == "" {
		Fail(w, 422, "A platform is required")
		return
	}
	clientID := strings.TrimSpace(r.URL.Query().Get("clientId"))
	if _, _, err := db.Exec(
		"DELETE FROM "+layoutTable+" WHERE platform_key = ? AND client_id = ?", key, clientID); err != nil {
		Fail(w, 500, "Could not reset this layout")
		return
	}
	OK(w, map[string]any{"success": true, "platform": key, "clientId": clientID})
}

/*
── GET /api/admin/report-layout/clients?platform= ───────────────────────────

	Which clients already have a layout of their own, so the configuration screen
	can mark them in its picker rather than making someone open each one to find
	out.
*/
func ReportLayoutClients(w http.ResponseWriter, r *http.Request) {
	ensureLayoutSchema()
	key := strings.TrimSpace(r.URL.Query().Get("platform"))
	if key == "" {
		Fail(w, 422, "A platform is required")
		return
	}
	rows, err := db.Query(
		"SELECT DISTINCT client_id FROM "+layoutTable+" WHERE platform_key = ? AND client_id != ''", key)
	if err != nil {
		Fail(w, 500, "Could not list the configured clients")
		return
	}
	out := make([]string, 0, len(rows))
	for _, r := range rows {
		out = append(out, strFromAny(r["client_id"]))
	}
	sort.Strings(out)
	OK(w, map[string]any{"success": true, "platform": key, "clients": out})
}
