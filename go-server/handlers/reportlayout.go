package handlers

import (
	"encoding/json"
	"log"
	"net/http"
	"regexp"
	"sort"
	"strconv"
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
			  platform_key VARCHAR(64)   NOT NULL,
			  client_id    VARCHAR(64)   NOT NULL DEFAULT '',
			  panel_key    VARCHAR(96)   NOT NULL,
			  sort_order   INT           NOT NULL DEFAULT 0,
			  span         VARCHAR(8)    NOT NULL DEFAULT '',
			  viz          VARCHAR(16)   NOT NULL DEFAULT '',
			  is_hidden    TINYINT(1)    NOT NULL DEFAULT 0,
			  custom_label VARCHAR(191)  NOT NULL DEFAULT '',
			  description  VARCHAR(1000) NOT NULL DEFAULT '',
			  updated_by   VARCHAR(191)  NOT NULL DEFAULT '',
			  updated_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
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
		// A custom title and a description joined later still. Empty means "the
		// registry's own name" and "no info icon" respectively, which is what
		// every existing row means.
		if !portalColumnExists(layoutTable, "custom_label") {
			if _, _, err := db.Exec(
				"ALTER TABLE " + layoutTable + " ADD COLUMN custom_label VARCHAR(191) NOT NULL DEFAULT '' AFTER is_hidden"); err != nil {
				log.Printf("[layout] add custom_label: %v", err)
			}
		}
		/* How many rows a top-N breakdown keeps. Joined last of all.

		   0 means "whatever the registry chose", which is what every existing
		   row means and what an unconfigured panel goes back to — so there is no
		   separate control for "use the default", and no migration to write. */
		if !portalColumnExists(layoutTable, "row_limit") {
			if _, _, err := db.Exec(
				"ALTER TABLE " + layoutTable + " ADD COLUMN row_limit INT NOT NULL DEFAULT 0 AFTER description"); err != nil {
				log.Printf("[layout] add row_limit: %v", err)
			}
		}
		if !portalColumnExists(layoutTable, "description") {
			if _, _, err := db.Exec(
				"ALTER TABLE " + layoutTable + " ADD COLUMN description VARCHAR(1000) NOT NULL DEFAULT '' AFTER custom_label"); err != nil {
				log.Printf("[layout] add description: %v", err)
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
	// Columns for found-and-removed, with the recurrence count carried on the
	// axis label beside each account. Only the repeat-offenders panel has a
	// `repeats` figure to draw, so it is the only one this shape means anything
	// on — offered in the list because the layout may still pick it, and a
	// panel without the figure simply draws the pair of columns.
	{"repeat", "Repeat offenders"},
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
	panelFilter  = "filter"  // ONE slicer in the report's filter pane
)

// Stable keys for the panels that are not breakdowns.
const (
	keyHeadTop   = "head:volume"
	keyHeadDims  = "head:breakdowns"
	keyTrend     = "trend"
	keyRate      = "rate"
	keyTrendRole = "trend:"  // + role, e.g. trend:linking
	keyTilePfx   = "kpi:"    // + metric, e.g. kpi:totalAssets
	keyFilterPfx = "filter:" // + slicer parameter, e.g. filter:country
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
	"identified":        "Total Infringements",
	"removed":           "Removed",
	"removalPct":        "Total Removal %",
	"pending":           "Pending Removal",
	"totalAssets":       "Total Assets",
	"totalDomains":      "Total Websites",
	"totalChannels":     "Channels",
	"totalPlaces":       "No. of Website / Channel / Page",
	"channelsSuspended": "Website / Channel Suspended",
	// The social equivalent, and deliberately its own key: a suspended ACCOUNT
	// is not a suspended channel, and one report shows both.
	"profilesSuspended":   "Profiles Suspended",
	"suspendedWebsites":   "Suspended Websites",
	"impactedSubscribers": "Impacted Subscribers",
	"impactedTraffic":     "Impacted Traffic",
	"views":               "Total Views",
	// The part of that audience the takedown removed. Named as the pair it is:
	// the tile beside it is the audience reached, this one the audience taken.
	"viewsImpacted": "Total Views Impacted",
	/* A distinct count over TVChannelName, and deliberately NOT the "Channels"
	   tile beside it on the same report, which counts accounts. Two counts that
	   both read as channels, so each is named for what it is. */
	"totalTVChannels": "Total Channels",
	"viewsSaved":      "Total Views Saved",
	"savedRevenue":    "Estimated Saved Revenue",
	"likes":           "Total Likes",
	"crawled":         "Crawled",
	"notices":         "Notices Sent",
	/* Submissions, not de-indexed URLs. "De-Indexed" above is how many links an
	   engine DROPPED; this is how many submissions we sent it. Both tiles sit on
	   the same report, which is exactly why neither may be called the other.

	   Called submissions rather than batches throughout. "Batch" is the
	   warehouse's word — DelistingBatchId is a column — and it had leaked onto
	   a tile, where it asks the reader to know an internal grouping before they
	   can read the number. What they need to know is that one submission is one
	   submission however many links rode on it, which "submissions" says and
	   the subtitle beside it spells out. */
	"delistingBatches": "De-Indexing",
	"googleDelisted":   "Google De-Indexed",
	"bingDelisted":     "Bing De-Indexed",
	"delisted":         "De-Indexed",

	// ── Mobile apps ──────────────────────────────────────────────────────────
	"totalApps":         "Total Apps",
	"totalCategories":   "Categories",
	"totalDevelopers":   "Developers",
	"installs":          "Total Installs",
	"ratings":           "Total Ratings",
	"reviews":           "Total Reviews",
	"avgStars":          "Average Rating",
	"enforced":          "Enforced",
	"sourceRemoved":     "Listings Removed",
	"infringingRemoved": "Downloads Removed",
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
	// Ten account URLs across one axis, each with a day count under it. At half
	// a row every label is cut to a few characters and the card names nobody.
	"repeat": true,
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
	Param  string // filter only: the slicer query parameter it controls
	Span   string
	Hidden bool
	/* The admin's overrides, stored on the layout row. Title replaces the
	   panel's default name on the report page; Desc is shown behind an info
	   icon on the card. Kept apart from Label so the configuration screen can
	   still show what the default name was. */
	Title string
	Desc  string
	/* The built-in note, shown until an admin writes one of their own — see
	   reportpaneldesc.go. Kept apart from Desc so the configuration screen can
	   offer it as the editor's placeholder: clearing the box then visibly means
	   "back to this", rather than being a blank field with no stated effect. */
	DefaultDesc string
	/* How many rows this breakdown keeps — "Top 10" and how it comes to be ten.
	   Limit is the admin's override and 0 means unset; DefaultLimit is what the
	   registry chose, kept beside it so the configuration screen can show what
	   clearing the field goes back to. Both are 0 on a panel that is not a
	   top-N at all, and on those the control is not offered: see rowLimitFor. */
	Limit        int
	DefaultLimit int
}

func (p panelDef) asMap() map[string]any {
	out := map[string]any{
		"key": p.Key, "kind": p.Kind, "label": p.Label, "span": p.Span,
	}
	/* The configured size, restated in the panel's own name. A card headed
	   "Top 10 Apps" listing five is worse than either number on its own — the
	   reader counts the rows and concludes the report is broken. Applied before
	   the rename, so an admin who wrote their own title keeps it verbatim:
	   theirs is a name, not a description of the cut. */
	if p.Limit > 0 && p.Limit != p.DefaultLimit {
		out["label"] = topNLabel(p.Label, p.Limit)
	}
	// The rename is applied HERE, so the report page needs no second field:
	// whatever reads `label` gets the admin's title where one is set.
	if p.Title != "" {
		out["label"] = p.Title
	}
	// What the admin wrote, or the built-in note until they write one.
	if d := panelDescOf(p); d != "" {
		out["desc"] = d
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
	if p.Param != "" {
		out["param"] = p.Param
	}
	if p.Hidden {
		out["hidden"] = true
	}
	return out
}

/* ── The default layout ───────────────────────────────────────────────────── */

/*
trendPanelLabel is what a trend card is CALLED — on the report and on the
configuration screen, from this one function so the two cannot disagree.

It used to be computed in two places that worded it differently: the page built
"Day-on-Day Linking Identification & De-Indexing" from the data it had, and
panelName said "Linking identification over time". Same card, two names, and no
way to tell from the configuration screen which chart you were arranging.

The GRAIN is deliberately not in it. "Day-on-Day" flips to "Month-on-Month" when
the reader changes the range, which no stored layout can track — and the card's
own subtitle already says "by day" / "by month", so nothing is lost by leaving it
out and the name is stable enough to be configured against.
*/
func trendPanelLabel(platformKey, role string, delisting map[string]bool) string {
	if role == "" {
		// The merged trend, where a platform's tables all describe one thing.
		if platformKey == summaryKey {
			return "Infringement Identification & Removal"
		}
		return "Identification & Removal"
	}
	side := role
	if n, ok := roleDisplayName[role]; ok {
		side = n
	}
	/* A link dropped by a search engine is not a page taken down, and only the
	   linking side has the first — so the two cards name different second
	   measures, exactly as the report's own legend does. */
	second := "Removal"
	if delisting[role] {
		second = "De-Indexing"
	}
	return side + " Identification & " + second
}

/*
mergesReports says whether a platform's tables are several REPORTS merged, rather
than the two ends of one.

It decides whether the role trends are the whole answer or only part of it.

Called by defaultPanels' CALLERS, never by defaultPanels — it reads the platform
store, which needs a database, and that function has to stay computable from its
arguments alone or every layout test needs a warehouse to run.

Open Web reads two tables — the links, and the pages they point at. That is one
report seen from both ends, the pair of role cards IS its answer, and a merged
line over the top would add a link to the very page it links to.

A sports summary reads five, one per platform, and the tiles above it already add
them together: TOTAL INFRINGEMENTS is that sum. Its role split covers only the two
Open Web tables among those five, so the pair accounts for part of the report and
nothing on the page draws the figure the headline tile reports — which is what the
merged card is for.

Three is the line because two is exactly the "one report, two ends" shape and
anything past it is a collection. The built-in summary never reaches this: it
declares no roles at all, so it takes the single-trend branch already.
*/
func mergesReports(platformKey string) bool {
	p, ok := platformByKey(platformKey)
	return ok && len(p.Tables) >= 3
}

// defaultPanels builds the layout a platform has before anyone configures it —
// which is the page exactly as it was written by hand: headline figures, the
// trend (one per source where the platform's tables describe different things),
// the rate, then the breakdowns in the registry's reading order.
//
// `dims` are the section's breakdowns, already ordered and labelled; `roles` are
// the distinct source roles the platform's tables carry; `tiles` are the metrics
// this report can put a headline figure against; `actions` is the enforcement
// action each role records, where it records one; `delisting` is which roles
// carry a delisting measure, which decides what their trend card is called;
// `merged` says the platform is several reports rather than one seen from both
// ends, which earns it an overall trend under the per-role pair — see
// mergesReports, which is what the callers pass here.
func defaultPanels(platformKey string, dims []map[string]any, roles []string, tiles []string,
	actions map[string]string, delisting map[string]bool, merged bool) []panelDef {
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
				Label:       trendPanelLabel(platformKey, role, delisting),
				DefaultDesc: trendPanelDesc(role, delisting),
			})
		}
		/* ...and the MERGED trend under them, where the platform is several
		   reports rather than the two ends of one — see mergesReports.

		   Named "Overall" rather than left to trendPanelLabel's wording for the
		   role-less case, because here it is not the only trend on the page: it
		   sits under two cards whose names already end in "Identification &
		   Removal", and three of those in a column is a reader counting words to
		   work out which chart is which. */
		if merged {
			out = append(out, panelDef{
				Key: keyTrend, Kind: panelTrend, Span: spanFull,
				Label:       "Overall Identification & Removal",
				DefaultDesc: trendPanelDesc("", delisting),
			})
		}
	} else {
		out = append(out, panelDef{Key: keyTrend, Kind: panelTrend, Span: spanFull,
			Label:       trendPanelLabel(platformKey, "", delisting),
			DefaultDesc: trendPanelDesc("", delisting)})
	}

	/* What we SENT, day by day, used to be a pair of trend cards here — one per
	   acting side, drawn from the daily rows. They are BREAKDOWN panels now
	   (dimNoticesByDay, dimBatchesByDay in enforcementactions.go), built the
	   same way as the per-counterparty enforcement panels, so they arrive with
	   `dims` below in the registry's reading order and need no special card.
	   `actions` still names each side's action for the tiles and titles. */
	_ = actions

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
	out = append(out, panelDef{Key: keyRate, Kind: panelRate, Span: rateSpan,
		Label: "Removal rate"})
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
		DefaultLimit: int(numOf(d["limit"])),
	}
}

/* ── The stored overlay ───────────────────────────────────────────────────── */

type layoutRow struct {
	Order  int64
	Span   string
	Viz    string
	Hidden bool
	Title  string // custom card title; empty keeps the default name
	Desc   string // shown behind an info icon on the card; empty means no icon
	Limit  int    // top-N cut for a breakdown; 0 keeps the registry's own
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
		"SELECT panel_key, sort_order, span, viz, is_hidden, custom_label, description, row_limit FROM "+layoutTable+
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
			Title:  strings.TrimSpace(strFromAny(r["custom_label"])),
			Desc:   strings.TrimSpace(strFromAny(r["description"])),
			Limit:  int(numOf(r["row_limit"])),
			Set:    true,
		}
	}
	return out
}

/*
── How many rows a top-N panel keeps ────────────────────────────────────────

	"Top 10 Linking Websites" is ten because the registry says ten. This is how
	that becomes a setting: per platform, per client, on the same layout row
	that already carries the panel's width and its title.

	Only panels the registry ALREADY cuts are configurable. The others are
	closed lists — every day of the chosen window, every search engine, every
	TAT band — and a top-N over one of those does not shorten a long tail, it
	silently drops days off a calendar. That distinction is the reason the
	registry stores 0 for them, and it is honoured rather than re-litigated
	here.
*/

// topNLabel restates a panel's own name at the configured size.
//
// A card titled "Top 10 Apps" showing five rows is worse than either — the
// reader counts the rows and concludes the report is broken. Only the number is
// touched, and only where the name already carries one: a panel called
// something else keeps the name it was given.
// The capture keeps the word and the spacing exactly as the label wrote them —
// "Top 10", "TOP 10" and "Top  10" all occur — so only the digits move.
var topNInLabel = regexp.MustCompile(`(?i)\b(top\s+)\d+\b`)

func topNLabel(label string, n int) string {
	if n <= 0 || label == "" {
		return label
	}
	return topNInLabel.ReplaceAllString(label, "${1}"+strconv.Itoa(n))
}

/*
dimRowLimits is the effective top-N for every breakdown of one platform, for one
client: the registry's number unless an admin set another.

Read straight off the layout rather than from the panel list, because the RUN
path needs it before any panel exists — the limit decides how many rows the
query asks for, not how many of them are drawn.
*/
func dimRowLimits(platformKey, clientID string, dims []map[string]any) map[string]int {
	return resolveRowLimits(dims, layoutFor(platformKey, clientID))
}

/*
resolveRowLimits is the rule itself, with the reading done elsewhere.

Split from the lookup above because the rule is the part worth pinning — which
panels may be cut, and whose number wins — and a rule that can only be exercised
against a live layout table is a rule nobody exercises.
*/
func resolveRowLimits(dims []map[string]any, stored map[string]layoutRow) map[string]int {
	out := map[string]int{}
	for _, d := range dims {
		key := strFromAny(d["key"])
		def := int(numOf(d["limit"]))
		if def <= 0 {
			// A closed list. Not configurable, and not defaulted either — it is
			// absent from the result rather than present as zero, so a caller
			// cannot mistake "do not cut this" for "cut it to nothing".
			continue
		}
		out[key] = def
		if row, ok := stored[key]; ok && row.Limit > 0 {
			out[key] = row.Limit
		}
	}
	return out
}

// The most rows a breakdown may be configured to keep. A ceiling on
// readability, not on the database: past this a bar chart is a wall.
const maxRowLimit = 100

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
			p.Title = row.Title
			p.Desc = row.Desc
			// Only a breakdown has a row count, and only one the registry
			// already cuts. A stored limit on anything else is a stale row.
			if p.Kind == panelDim && p.DefaultLimit > 0 && row.Limit > 0 {
				p.Limit = row.Limit
			}
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

/*
hiddenDimsFor is the set of BREAKDOWN keys an admin has switched off.

Read by the sections endpoint so that hiding a chart also drops its slicer. The
two were separate before: the panel obeyed the layout and the filter rail did
not, so switching off Genre left a Genre dropdown in the rail filtering a report
that no longer showed genres — a control whose only visible effect was to empty
the page.

Only breakdowns. A tile or a trend has no slicer to take with it, and a stored
row against one is a stale row rather than an instruction.
*/
func hiddenDimsFor(platformKey, clientID string, dims []map[string]any, roles, tiles []string,
	actions map[string]string, delisting map[string]bool) map[string]bool {
	out := map[string]bool{}
	for _, p := range applyLayout(platformKey, clientID,
		defaultPanels(platformKey, dims, roles, tiles, actions, delisting, mergesReports(platformKey))) {
		if p.Kind == panelDim && p.Hidden {
			out[p.Key] = true
		}
	}
	return out
}

// sectionPanels is the whole job: default layout for this platform's shape, with
// whatever has been configured for this client laid over it. Hidden panels are
// dropped here, so the report page never has to know they existed.
func sectionPanels(platformKey, clientID string, dims []map[string]any, roles, tiles []string,
	actions map[string]string, delisting map[string]bool) []map[string]any {
	panels := applyLayout(platformKey, clientID,
		defaultPanels(platformKey, dims, roles, tiles, actions, delisting, mergesReports(platformKey)))
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
actionsForPlatform is the enforcement action each of a platform's sides records,
keyed by role — see enforcementactions.go.

At most one per role: an action id lives on one table, and a role is one table
here. A platform whose tables record none answers an empty map, which is what
keeps the action trends off every report but Open Web - Sports.
*/
func actionsForPlatform(p platformDef) map[string]string {
	specs, _ := specsForPlatform(p)
	out := map[string]string{}
	for _, s := range specs {
		if s.Role != "" && s.ActionKey != "" {
			out[s.Role] = s.ActionKey
		}
	}
	return out
}

/*
delistingForPlatform is which of a platform's sides carry a DELISTING measure —
the third figure only the linking half has, since a link dropped by a search
engine is a different event from a page taken down.

It decides what each side's trend card is called, and it is derived from the same
DelistedExpr the report's own second series is drawn from — so the card cannot
end up titled "…& De-Indexing" over a chart whose second line is removals.
*/
func delistingForPlatform(p platformDef) map[string]bool {
	specs, _ := specsForPlatform(p)
	out := map[string]bool{}
	for _, s := range specs {
		if s.Role != "" && s.DelistedExpr != "" {
			out[s.Role] = true
		}
	}
	return out
}

/* ── The filter pane ──────────────────────────────────────────────────────────

   The slicers down the right of a report are panels too.

   They used to be derived and nothing else: a platform offered a control for
   every column its tables could filter on, and one whose breakdown had been
   hidden left with it. That is a good default and a bad law. A client who reads
   by country and never by language wants the Language slicer gone whether or not
   the Language chart is still on the page; turnaround is picked off its own bar
   and wants no dropdown at all. Neither is a statement about the warehouse, so
   neither belonged in code.

   So the pane is arranged on the same screen, out of the same table, with the
   same per-client fallback: one panel per slicer, keyed `filter:<param>`,
   carrying an order and a visible flag. A rail is one column wide, so a filter
   panel has no width to set.

   The DEFAULT is exactly the rule it replaces, which is why a platform nobody
   has configured has the pane it always had. */

// filterParamLabels is what a slicer is CALLED. Mirrors FILTER_LABELS in
// app/admin/reports/page.tsx; this copy exists so the configuration screen can
// name a slicer without the warehouse having been queried.
var filterParamLabels = map[string]string{
	"assetId":          "Asset",
	"language":         "Language",
	"country":          "Country",
	"searchEngine":     "Search Engine",
	"tatBucket":        "TAT Bucket",
	"platform":         "Platform",
	"channel":          "Channel Name",
	"groupType":        "Group Type",
	"quality":          "Print Quality",
	"genre":            "Genre",
	"infringementType": "Infringement Type",
	"deliveryType":     "Delivery Type",
	"keyword":          "Keyword",
	"domain":           "Domain",

	// ── Mobile apps ──────────────────────────────────────────────────────────
	"sourceFeed":    "Source Feed",
	"appName":       "App",
	"category":      "Category",
	"developer":     "Developer",
	"storeType":     "Listing Type",
	"contentRating": "Content Rating",
	"removalStatus": "Removal Status",

	// ── Sports ───────────────────────────────────────────────────────────────
	"franchiseName": "Franchise",
	"matchDay":      "Match Day",
	// The hosting provider a DMCA notice was sent to — the party that answers
	// for the site, which is not the site itself.
	"hspName": "Hosting Provider",

	// The account behind the post, identified by its URL — see
	// repeatoffenders.go. Separate from "channel", which filters on the display
	// name.
	"channelUrl": "Channel / Profile URL",
}

func filterParamLabel(param string) string {
	if l, ok := filterParamLabels[param]; ok {
		return l
	}
	return param
}

/*
panelOnlyFilters are the slicers a report does not put in the pane unless it is
asked to.

Turnaround is read off its own panel — you pick the bucket by clicking the bar —
so a dropdown of the same values is a second control for one job. Keyword is a
long tail with no useful head to pick from. Both still FILTER: clicking the panel
sets one and a chip appears to clear it. Only the dropdown is absent, and now
only until somebody switches it on.

Mirrors PANEL_ONLY_FILTERS in app/admin/reports/page.tsx, which is the fallback
for a page talking to a server too old to send the pane.
*/
var panelOnlyFilters = map[string]bool{
	"tatBucket": true, "keyword": true,
	// And the account URL — see unlistedFilterParams, which is the stronger
	// statement about the same slicer.
	"channelUrl": true,
}

/*
unlistedFilterParams are the slicers whose VALUES are never listed.

Panel-only says "no dropdown unless somebody asks for one". This says the
dropdown could not exist: an account is identified by its URL, and the list of
them is every channel and profile the window found — tens of thousands of
strings with no head worth scrolling to, and no name to search by. The ten worth
choosing are already drawn on the repeat-offenders card, and clicking one is how
this filter is set.

Two things follow, and both matter:

  - The filter pane does not OFFER it, so it cannot be switched on into a
    permanently empty control.
  - The options endpoint does not fetch it. That is the load-bearing half: the
    values behind every slicer are listed on each change to the window, once per
    table, and a full distinct-scan of an account-URL column is by far the most
    expensive of them — paid on every report load for a dropdown nobody can see.

The filter itself is untouched. It still travels in the section's parameter
list, still cross-filters the page, and still shows its chip.
*/
var unlistedFilterParams = map[string]bool{"channelUrl": true}

// filterParamsFor is every slicer parameter a platform's tables can serve, in a
// stable order — the candidates the filter pane is arranged from.
func filterParamsFor(p platformDef) []string {
	specs, _ := specsForPlatform(p)
	seen := map[string]bool{}
	for _, sp := range specs {
		for param := range sp.Filters {
			seen[param] = true
		}
	}
	out := make([]string, 0, len(seen))
	for k := range seen {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// filterParamOf reads the slicer parameter back off a filter panel's key.
func filterParamOf(panelKey string) string {
	return strings.TrimPrefix(panelKey, keyFilterPfx)
}

/*
defaultFilterVisible is whether a slicer is in the pane before anyone has
configured it — the rule this screen replaces, kept as the starting point.

`stillShown` is the set of parameters whose breakdown survived the layout. Pass
one that is true for everything to switch the follow-the-panel half off, which is
what the summary needs: its panels are a fixed subset across several platforms,
so "no panel for this parameter" is the normal case there rather than somebody's
decision to hide it.
*/
func defaultFilterVisible(param string, stillShown map[string]bool) bool {
	if panelOnlyFilters[param] {
		return false
	}
	return !dimFilterParamHasPanel(param) || stillShown[param]
}

/*
filterPanels is the pane for one platform and one client: every slicer that
platform can serve, in the configured order, each carrying whether it is drawn.

A stored row beats the default in both directions — an admin who switched the
Turnaround slicer on meant it, and one who switched Country off meant that too,
whatever became of the matching chart.
*/
func filterPanels(platformKey, clientID string, params []string, stillShown map[string]bool) []panelDef {
	stored := layoutFor(platformKey, clientID)
	type ranked struct {
		p    panelDef
		rank float64
	}
	list := make([]ranked, 0, len(params))
	for i, param := range params {
		// A slicer with no values to list gets no row in the pane — there is
		// nothing to configure about a control that cannot be drawn.
		if unlistedFilterParams[param] {
			continue
		}
		p := panelDef{
			Key: keyFilterPfx + param, Kind: panelFilter, Param: param,
			Label: filterParamLabel(param), Span: spanFull,
			Hidden: !defaultFilterVisible(param, stillShown),
		}
		// Same scale as applyLayout, and for the same reason: a slicer that only
		// just appeared because a table gained a column has to land near where it
		// would have been, not ahead of an arrangement somebody made.
		rank := float64((i + 1) * 10)
		if row, ok := stored[p.Key]; ok {
			rank = float64(row.Order)
			p.Hidden = row.Hidden
			// A slicer is renamed and described on the same screen as a chart,
			// and reaches the pane the same way — see sectionSlicerMeta.
			p.Title = row.Title
			p.Desc = row.Desc
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

// sectionSlicers is the pane as the REPORT needs it: the parameters that get a
// control, in the order they are drawn down the rail.
func sectionSlicers(platformKey, clientID string, params []string, stillShown map[string]bool) []string {
	out := make([]string, 0, len(params))
	for _, p := range filterPanels(platformKey, clientID, params, stillShown) {
		if !p.Hidden {
			out = append(out, p.Param)
		}
	}
	return out
}

/*
sectionSlicerMeta is what each slicer in the pane is CALLED and what its ⓘ says,
keyed by the query parameter the page addresses it by.

A slicer is arranged, renamed and described on the same screen as a chart and
stored in the same table — so without this the rail was the one place a rename
could be made and never take effect, which is worse than not offering it.

Only what differs from the page's own defaults travels: a slicer nobody renamed
or described contributes nothing, and the rail falls back to FILTER_LABELS as it
always has.
*/
func sectionSlicerMeta(platformKey, clientID string, params []string, stillShown map[string]bool) map[string]any {
	out := map[string]any{}
	for _, p := range filterPanels(platformKey, clientID, params, stillShown) {
		if p.Hidden {
			continue
		}
		row := map[string]any{}
		if p.Title != "" {
			row["label"] = p.Title
		}
		if d := panelDescOf(p); d != "" {
			row["desc"] = d
		}
		if len(row) > 0 {
			out[p.Param] = row
		}
	}
	return out
}

// stillShownParams is the set of slicer parameters whose breakdown is still on
// the page, read off a layout that has already been applied.
func stillShownParams(panels []panelDef) map[string]bool {
	out := map[string]bool{}
	for _, p := range panels {
		if p.Kind != panelDim || p.Hidden {
			continue
		}
		if param := DIMFilterParam(p.Key); param != "" {
			out[param] = true
		}
	}
	return out
}

/*
adminHiddenPanels is the set of panel keys the SHARED default switches off.

It is what IP House has decided this report does not show — before any one
client is considered. Two callers need it, and they are the two halves of one
rule: the client-facing editor lists only what is NOT in here, and the
client-facing save puts back everything that IS.

The second half is not belt-and-braces, it is required. layoutFor consults the
shared default ONLY while a client has no rows of its own — so the moment a
client saves anything, the default stops applying to that client entirely. A
save carrying just the panels the client can see would therefore leave every
admin-hidden panel with no row at all, and a panel with no row falls back to the
registry default, which is visible. Hiding a panel from a client would have
un-hidden it for them.

Computed from the all-clients layout rather than read from the table, because
"hidden" is a property of the merged layout: a panel with no stored row is
hidden or not according to the registry, and the filter pane's default depends
on which charts survived.
*/
func adminHiddenPanels(platformKey string) map[string]bool {
	out := map[string]bool{}
	in, ok := layoutInputsFor(platformKey)
	if !ok {
		return out
	}
	defaults := defaultPanels(platformKey, in.Dims, in.Roles, in.Tiles, in.Actions, in.Delisting,
		mergesReports(platformKey))
	base := applyLayout(platformKey, layoutAllClients, defaults)
	for _, p := range base {
		if p.Hidden {
			out[p.Key] = true
		}
	}
	// The slicer pane, on the same terms — and it has to be read AFTER the
	// overlay, because which slicers a platform gets by default depends on
	// which charts survived it. Same order as ReportLayoutGet.
	stillShown := map[string]bool{}
	if in.FollowPanels {
		stillShown = stillShownParams(base)
	} else {
		for _, param := range in.Params {
			stillShown[param] = true
		}
	}
	for _, p := range filterPanels(platformKey, layoutAllClients, in.Params, stillShown) {
		if p.Hidden {
			out[p.Key] = true
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

	in, ok := layoutInputsFor(key)
	if !ok {
		Fail(w, 404, "Unknown platform: "+key)
		return
	}

	defaults := defaultPanels(key, in.Dims, in.Roles, in.Tiles, in.Actions, in.Delisting,
		mergesReports(key))
	panels := applyLayout(key, clientID, defaults)

	/* The filter pane hangs off the layout that was just applied, not off the
	   defaults: which slicers a platform gets by default depends on which charts
	   survived, so the pane has to be read after the overlay rather than beside
	   it. Its panels are appended, so they are one contiguous block at the end of
	   the list and the screen can arrange them on their own. */
	stillShown := map[string]bool{}
	if in.FollowPanels {
		stillShown = stillShownParams(panels)
	} else {
		for _, param := range in.Params {
			stillShown[param] = true
		}
	}
	panels = append(panels, filterPanels(key, clientID, in.Params, stillShown)...)

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

	/* What the SHARED default says about each panel, sent alongside what THIS
	   client's layout says. The configuration screen ignores it — an admin is
	   looking at the layout they control. The client-facing editor lists only
	   the panels it marks visible, so a client can rearrange what IP House
	   chose to show them without being offered what IP House chose not to. */
	adminHidden := adminHiddenPanels(key)

	out := make([]map[string]any, 0, len(panels))
	for i, p := range panels {
		row := p.asMap()
		row["position"] = i
		row["hidden"] = p.Hidden
		row["adminHidden"] = adminHidden[p.Key]
		row["defaultSpan"] = defaultSpan[p.Key]
		if p.Kind == panelDim {
			row["defaultViz"] = defaultViz[p.Key]
			row["defaultVizLabel"] = vizLabel(defaultViz[p.Key])
			/* The top-N controls. `defaultRowLimit` is what makes the field
			   appear at all, so it is sent only for a panel the registry
			   already cuts: a closed list — a per-day trend, the TAT bands —
			   has no top-N to set, and offering one would be offering to drop
			   days off a calendar. */
			if p.DefaultLimit > 0 {
				row["rowLimit"] = p.Limit
				row["defaultRowLimit"] = p.DefaultLimit
			}
		}
		// A trend or a rate card titles itself from the data — "Month-on-Month
		// Linking Identification & Delisting" is not knowable until the range is
		// known — so the configuration screen gets a plain name to arrange by.
		// The name is the DEFAULT one: the rename lives in customLabel, so the
		// screen can show both what a card is called and what it was.
		row["name"] = panelName(p)
		row["customLabel"] = p.Title
		/* The admin's own text and the built-in note are sent APART. `desc` on
		   the report is whichever applies; here the screen needs both, so the
		   editor can show the default as a placeholder and still tell whether
		   this panel has been described by hand. */
		row["desc"] = p.Desc
		if p.DefaultDesc != "" {
			row["defaultDesc"] = p.DefaultDesc
		} else {
			row["defaultDesc"] = defaultPanelDesc(p)
		}
		// A heading is a rule across the page; letting it be half a row wide
		// would make it a label floating beside a chart. A slicer sits in a
		// one-column rail, so it has no width to argue about either.
		if p.Kind == panelHeading || p.Kind == panelFilter {
			row["fixedSpan"] = true
		}
		if p.Kind == panelFilter {
			row["defaultSpan"] = spanFull
			// Whether this slicer is in the pane when nothing is configured, so
			// the screen can mark the ones that have been overridden — and say
			// which two are deliberately off to begin with.
			row["defaultHidden"] = !defaultFilterVisible(p.Param, stillShown)
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
		"success": true, "platform": key, "label": in.Label, "clientId": clientID,
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
	case panelTrend, panelRate:
		/* The name the REPORT gives the card, which defaultPanels has already
		   put on it — see trendPanelLabel. Naming it again here is what made
		   the configuration screen call a card "Linking identification over
		   time" while the report titled it "Day-on-Day Linking Identification &
		   Delisting", leaving nothing to match the two by. */
		if p.Label != "" {
			return p.Label
		}
		// Only reachable for a panel built outside defaultPanels.
		side := p.Role
		if name, ok := roleDisplayName[p.Role]; ok {
			side = name
		}
		if p.Kind == panelRate {
			return "Removal rate"
		}
		if side != "" {
			return side + " Identification & Removal"
		}
		return "Identification & Removal"
	case panelTile:
		return kpiTileLabel(p.Metric) + " (KPI tile)"
	}
	if p.Label != "" {
		return p.Label
	}
	return p.Key
}

// layoutInputs is everything a platform's layout is built from — the same things
// the sections endpoint reads, so the configuration page and the report can never
// disagree about which panels exist.
type layoutInputs struct {
	Dims []map[string]any
	// The enforcement action each role records, if any — what decides whether
	// this platform gets action trends to arrange.
	Actions map[string]string
	// Which roles carry a delisting measure — what each side's trend card is
	// named after. See trendPanelLabel.
	Delisting map[string]bool
	Roles     []string
	Tiles     []string
	Params    []string // slicer parameters, the filter pane's candidates
	Label     string
	/* FollowPanels: whether an unconfigured slicer leaves with its breakdown.

	   True for a platform section, where every slicer has a chart on the same
	   page. False for the summary, whose panel list is a fixed subset over
	   several platforms — there, a parameter with no panel is the normal case
	   rather than somebody's decision to hide it, and applying the rule would
	   strip most of the pane. */
	FollowPanels bool
}

func layoutInputsFor(key string) (layoutInputs, bool) {
	if p, found := platformByKey(key); found {
		return layoutInputs{
			Dims: sectionDimensions(p), Roles: rolesForPlatform(p),
			Actions:   actionsForPlatform(p),
			Delisting: delistingForPlatform(p),
			Tiles:     kpiTilesFor(platformExtraKPIs(p)), Params: filterParamsFor(p),
			Label: p.Label, FollowPanels: true,
		}, true
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
			return layoutInputs{}, false
		}
		return layoutInputs{
			Dims: asMaps(sec["dimensions"]), Tiles: asStrings(sec["kpiTiles"]),
			Params: asStrings(sec["filters"]), Label: summaryLabel,
		}, true
	}
	return layoutInputs{}, false
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
			Title  string `json:"title"`
			Desc   string `json:"desc"`
			// 0 (or absent) means "the registry's own number", which is how a
			// panel goes back to its default without a separate control.
			RowLimit int `json:"rowLimit"`
		} `json:"panels"`
	}
	json.NewDecoder(r.Body).Decode(&body)

	key := strings.TrimSpace(body.Platform)
	if key == "" {
		Fail(w, 422, "A platform is required")
		return
	}
	clientID := strings.TrimSpace(body.ClientID)
	if _, ok := layoutInputsFor(key); !ok {
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
		/* The rename and the description, capped at what the columns hold.
		   Cut rather than refused: a title pasted a few characters long of the
		   limit should save its first 191, not bounce the whole layout. */
		title := strings.TrimSpace(p.Title)
		if r := []rune(title); len(r) > 191 {
			title = string(r[:191]) // runes, not bytes — VARCHAR(191) counts characters
		}
		desc := strings.TrimSpace(p.Desc)
		if r := []rune(desc); len(r) > 1000 {
			desc = string(r[:1000])
		}
		/* Clamped rather than refused, for the same reason the title is cut:
		   an out-of-range number in one field should not bounce a whole layout.
		   The ceiling is a readable-panel ceiling, not a database one — a bar
		   chart of five hundred rows is not a chart. */
		rowLimit := p.RowLimit
		if rowLimit < 0 {
			rowLimit = 0
		}
		if rowLimit > maxRowLimit {
			rowLimit = maxRowLimit
		}
		pos += 10
		if _, _, err := db.Exec(`
			INSERT INTO `+layoutTable+` (platform_key, client_id, panel_key, sort_order, span, viz, is_hidden, custom_label, description, row_limit, updated_by)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON DUPLICATE KEY UPDATE sort_order=VALUES(sort_order), span=VALUES(span),
			  viz=VALUES(viz), is_hidden=VALUES(is_hidden), custom_label=VALUES(custom_label),
			  description=VALUES(description), row_limit=VALUES(row_limit),
			  updated_by=VALUES(updated_by)`,
			key, clientID, pk, pos, span, viz, hidden, title, desc, rowLimit, who); err != nil {
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
