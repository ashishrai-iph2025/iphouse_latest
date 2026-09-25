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
		/* ── The two provider panels stopped being single-measure ────────────

		   They counted ONE thing — notices sent to a provider, de-indexing
		   submissions made about its links — and `value` was the registry's own
		   chart type for them: single-series bars, which is the right picture
		   for one number.

		   They now report three: how many sites the provider answers for, how
		   much was identified on them, how much came down. `value` draws the
		   first series and silently discards the other two, so a client who had
		   ever saved a layout for these panels kept a card that looked exactly
		   as before — the stored chart type overrides the registry (see
		   applyLayout), and the stored one was chosen when one series was all
		   there was.

		   Cleared rather than rewritten, so the registry's choice applies and an
		   admin can still pick anything they like afterwards. NARROW on purpose:
		   only these two panel keys, and only where the stored value is the
		   stale `value` — a deliberate `table` or `donut` is someone's decision
		   about a panel they were looking at, and this is not entitled to it. */
		if portalColumnExists(layoutTable, "viz") {
			if _, n, err := db.Exec(
				"UPDATE "+layoutTable+" SET viz = '' WHERE panel_key IN (?, ?) AND viz = 'value'",
				dimHSPNotices, dimHSPDelisting); err != nil {
				log.Printf("[layout] clear the stale provider-panel chart type: %v", err)
			} else if n > 0 {
				log.Printf("[layout] cleared a stale 'value' chart type on %d provider panel(s) — "+
					"they carry three measures now and value draws one", n)
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
		/* ── "Source of Piracy" moved to the panel that draws broadcasters ────

		   byChannel used to draw two different things under one key: the pirate
		   ACCOUNT on Telegram, YouTube and social, and the BROADCASTER on the two
		   Open Web sports tables — which carry no account at all, so their
		   ChannelName is the station. A summary merging the platforms therefore
		   ranked Paramount+ and DAZN beside the Telegram channels restreaming
		   them, and clients named that card for what they saw in it: "Top 10
		   Source of Piracy".

		   The two are separate panels now. byChannel is the account, gated on a
		   ChannelURL; byTVChannel is the broadcaster, resolved from TVChannelName
		   or from ChannelName on the two named tables. Which leaves every saved
		   layout row titled for broadcasters pointing at the panel that now
		   shows accounts — so the card a client called "Source of Piracy" filled
		   with pirate channels the day the split deployed.

		   Re-keyed here, on the LABEL, because the label is the client's own
		   statement of what the panel was for. Sort order, width and hidden flag
		   travel with it, so the card stays where it was. UPDATE IGNORE first,
		   so a client who has already configured byTVChannel keeps that; the
		   DELETE then clears the stale byChannel rows the update could not move.
		   Idempotent — after the first run nothing matches. */
		if portalColumnExists(layoutTable, "custom_label") {
			const broadcasterLabel = "%Source of Piracy%"
			if _, n, err := db.Exec(
				"UPDATE IGNORE "+layoutTable+" SET panel_key = ? WHERE panel_key = ? AND custom_label LIKE ?",
				dimTVChannel, "byChannel", broadcasterLabel); err != nil {
				log.Printf("[layout] move the Source of Piracy rename to the broadcaster panel: %v", err)
			} else if n > 0 {
				log.Printf("[layout] moved %d \"Source of Piracy\" layout row(s) from byChannel to %s — "+
					"the account panel was carrying the broadcaster panel's name", n, dimTVChannel)
			}
			if _, n, err := db.Exec(
				"DELETE FROM "+layoutTable+" WHERE panel_key = ? AND custom_label LIKE ?",
				"byChannel", broadcasterLabel); err != nil {
				log.Printf("[layout] clear stale Source of Piracy rows on byChannel: %v", err)
			} else if n > 0 {
				log.Printf("[layout] dropped %d stale byChannel row(s) already superseded by a %s layout", n, dimTVChannel)
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
		/* Which UGC and social platforms the live card folds into one row.

		   Only ever set on the realtime panel's row, and empty everywhere else.
		   A column on the layout table rather than a table of its own because it
		   IS a layout setting — per platform report, per client, saved and reset
		   by the same screen and the same request as the panel's width and its
		   title. A second table would need its own key, its own migration and
		   its own half of every save, to hold one string per card.

		   Empty means "fold nothing", which is what every existing row means and
		   what an unconfigured card does. See realtimeplatforms.go. */
		if !portalColumnExists(layoutTable, "realtime_rollup") {
			if _, _, err := db.Exec(
				"ALTER TABLE " + layoutTable + " ADD COLUMN realtime_rollup VARCHAR(1000) NOT NULL DEFAULT '' AFTER description"); err != nil {
				log.Printf("[layout] add realtime_rollup: %v", err)
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
	/* Volume bars and a mirror-count gauge on one card, each on its own scale.
	   Like "repeat" above, it means something on exactly one panel — the
	   combined root-domain card is the only breakdown whose rows carry a
	   `mirrors` figure — and a panel without that figure simply draws the pair
	   of volume bars and says underneath that it has no mirror counts. */
	{"mirror", "Volume & count"},
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
	/* Both sides of a two-sided report, on ONE monthly axis.

	   Not a third panelTrend: a trend card draws one source's two series, and
	   the comparison this exists for is BETWEEN the sources — how much of a
	   month's identification was linking and how much was hosting, and how each
	   side's removal moved against its own. Four series on one axis is a
	   different chart from two charts of two, and forcing it through panelTrend
	   would mean a `role` that names two roles.

	   MONTHLY by construction, where the per-side cards switch to months only
	   once a window is long enough to need it. This card is the shape of the
	   year, and a reader comparing two halves of a business over twelve months
	   should not get days because they happened to pick a short range. */
	panelTrendSplit = "trendsplit"
	panelDim        = "dim"    // one breakdown
	panelFilter     = "filter" // ONE slicer in the report's filter pane
	/* The live counts strip — RealtimeCard, above the report on the sports
	   pages. A panel like the rest, so it can be moved, resized, hidden,
	   renamed and described on the same screen as everything else it sits
	   with. It is NOT drawn from the report's own result set: it counts
	   straight from the enforcement side, on its own refresh, which is exactly
	   why it needs a note of its own more than any card here. */
	panelRealtime = "realtime"
)

// Stable keys for the panels that are not breakdowns.
const (
	keyHeadTop   = "head:volume"
	keyHeadDims  = "head:breakdowns"
	keyTrend     = "trend"
	keyRate      = "rate"
	keyTrendRole = "trend:" // + role, e.g. trend:linking
	/* The two sides on one monthly axis. A key of its own rather than a role of
	   "both" on keyTrendRole, so an admin's stored layout row for it cannot be
	   confused with a per-side card that has been renamed. */
	keyTrendSplit = "trend:split"
	keyTilePfx    = "kpi:"    // + metric, e.g. kpi:totalAssets
	keyFilterPfx  = "filter:" // + slicer parameter, e.g. filter:country
	keyRealtime   = "realtime"
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
	"identified":    "Total Infringements",
	"removed":       "Removed",
	"removalPct":    "Total Removal %",
	"pending":       "Pending Removal",
	"totalAssets":   "Total Assets",
	"totalDomains":  "Total Websites",
	"totalChannels": "Channels",
	"totalPlaces":   "No. of Website / Channel / Page",
	// Names the CHANNEL only: this metric is offered off a channel-status column
	// and never reaches a website report, which has suspendedWebsites below for
	// that. See the same entry in app/admin/reports/page.tsx.
	"channelsSuspended": "Channels Suspended",
	// The social equivalent, and deliberately its own key: a suspended ACCOUNT
	// is not a suspended channel, and one report shows both.
	"profilesSuspended": "Profiles Suspended",
	// The account count and the audience behind it, on the social reports. A
	// "channel" here is the PROFILE — see channelKPIs.
	"totalSubscribers":  "Total Subscribers",
	"suspendedWebsites": "Suspended Websites",
	/* Not the tile above: that one reads a per-row flag some tables carry;
	   these read mediascan.WebsiteSuspension and SimilarWeb through the
	   domain-reporting master, for this client's hostnames. See
	   domainsuspension.go. */
	kpiDomainsSuspended: "Domains Suspended",
	kpiTrafficImpacted:  "Total Traffic Impacted",
	/* YouTube's two routes — see ytautoclaim.go. The pair is named by HOW the
	   claim was made, because that is the only thing that distinguishes them:
	   one was found and reported, the other Content ID matched by itself. Total
	   Infringements above them is the two together. */
	"manualClaims":        "Manual Claims",
	"autoClaims":          "Auto Claims",
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
	/* ── The two-sided open-web split ────────────────────────────────────────
	   Each is one HALF of a figure the band already shows whole, so each says
	   which half in its own name. "Linking" is the page that points at the
	   content; "Host" is the machine holding it. A PIRATE BRAND is a site and
	   all its mirrors counted once — see domainroot.go. */
	"linkingIdentified": "Total Linking Identification",
	"hostIdentified":    "Total Host Identification",
	"linkingDomains":    "Total Linking Domains",
	"hostDomains":       "Total Host Domains",
	"linkingBrands":     "Pirate Brands",
	"hostBrands":        "Host Pirate Brands",

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
	/* Three columns of content — the brand, the volume bars and the mirror
	   gauge — and the middle one is the only elastic thing in the row. At half
	   a row the volume bars are shorter than the figures printed beside them
	   and the two scales sit close enough to read as one. */
	"mirror": true,
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
	/* Which UGC and social platforms the live card folds into one row, comma
	   separated. Only ever set on the realtime panel; empty everywhere else,
	   and empty there folds nothing. See realtimeplatforms.go. */
	Rollup string
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
	/* What the admin wrote, or the built-in note until they write one.

	   The live counts card is the one exception, and only ADMIN text travels to
	   it. That card writes its own note from each reading — the season it
	   covered, what it was narrowed to, whether a platform failed to answer, all
	   of which change between refreshes — and it keeps that note whatever is set
	   here, showing the admin's paragraph above it. Sending the built-in default
	   as well would print a static paragraph directly over the live one saying
	   the same thing. See scopeNote in components/shared/RealtimeCard.tsx. */
	desc := panelDescOf(p)
	if p.Kind == panelRealtime {
		desc = p.Desc
	}
	if desc != "" {
		out["desc"] = desc
	}
	/* The SUBTITLE under a section heading.

	   `Sub` is the built-in wording; an admin's own text wins, and it arrives in
	   `Desc` because that is the field the layout editor offers on every panel.
	   A heading has no ⓘ — it is a rule across the page with a line of guidance
	   under it — so its description had nowhere to go and the grey line beneath
	   "Volume and enforcement" was the one piece of copy on the report nobody
	   could change.

	   Mapped rather than given a field of its own, so the editor needs no
	   special case: whatever is typed into a heading's description is what the
	   reader sees under its title. */
	if p.Kind == panelHeading && p.Desc != "" {
		out["sub"] = p.Desc
	} else if p.Sub != "" {
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

/*
hasRealtime is whether this platform's report carries the LIVE COUNTS strip —
RealtimeCard, the figure that counts straight from the enforcement side rather
than from the prepared tables the rest of the page reads.

Sports only, because that is the only place the card is fed: the count is scoped
to the client's configured season, and the narrowing slicers it honours — match
day, asset, franchise — exist on no other report.

Derived through isSportsPlatform rather than a list of keys held here, for the
same reason the reports page reads it off the platform's own name: the keys are
configuration an admin edits on the next tab, and a hardcoded list would go
quietly wrong the day somebody adds a sports platform, with the symptom being a
panel that is simply absent from this screen.

The panel EXISTING is not the card appearing. The report still draws it only
once a client and one of those narrowing slicers are chosen — an unfiltered live
count over a whole season is the most expensive query in the product, run to
answer a question nobody asked. This decides whether the panel is on the page to
be arranged at all.
*/
func hasRealtime(platformKey string) bool {
	p, ok := platformByKey(platformKey)
	return ok && isSportsPlatform(p)
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
// mergesReports, which is what the callers pass here; `realtime` says the report
// carries the live counts strip, which is hasRealtime for the same reason.
//
// Both are passed rather than looked up here so that this function stays a pure
// function of a platform's SHAPE. Reading the platform table from inside it
// would put a database call under every caller — including the tests, which
// describe a shape directly and have no database at all.
func defaultPanels(platformKey string, dims []map[string]any, roles []string, tiles []string,
	actions map[string]string, delisting map[string]bool, merged, realtime bool) []panelDef {
	// Four across, which is what a KPI band has always looked like.
	out := make([]panelDef, 0, len(tiles)+len(dims)+7)
	/* The live counts strip, FIRST and full width — which is exactly where it
	   has always been drawn, so a platform nobody has arranged looks as it did.
	   From here it can be moved under the tiles, narrowed, switched off, renamed
	   or given a note of its own like any other panel.

	   Its position carries one extra meaning the rest do not: left at the top of
	   the page it is the sticky band the reader can PIN, running the full width
	   of the report and holding its place while everything scrolls under it.
	   Moved below another panel it becomes an ordinary card in the grid, and the
	   pin goes with the position — a card pinned from the middle of a page has
	   nothing to stick to. See showRealtime in app/admin/reports/page.tsx. */
	if realtime {
		out = append(out, panelDef{
			Key: keyRealtime, Kind: panelRealtime, Span: spanFull,
			Label: "Realtime",
		})
	}
	/* The Removed tile means something different on a two-sided report whose
	   linking half is enforced by de-indexing — see openWebRemovedFromDelisting,
	   which is where the figure is built. The generic note ("how many have since
	   come down") is then wrong in the way that matters: most of this number is
	   links that have NOT come down, they have been made unfindable. Set here
	   rather than in kpiTileDescriptions because that map is keyed by metric
	   alone and this depends on the platform. */
	splitRemoval := len(roles) > 1 && delisting["linking"]

	for _, metric := range tiles {
		p := panelDef{
			Key: keyTilePfx + metric, Kind: panelTile, Metric: metric,
			Label: kpiTileLabel(metric), Span: spanQuarter,
		}
		if metric == "removed" && splitRemoval {
			p.DefaultDesc = "Infringements dealt with, counted by what enforcement " +
				"MEANS on each side of this report: links de-indexed by the search " +
				"engines on the linking side, plus URLs taken down on the host side. " +
				"A de-indexed page is still there — it is no longer findable — which " +
				"is why the linking side's own takedown count is not what this shows."
		}
		out = append(out, p)
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
		/* ...and then both of them on ONE monthly axis, full width, directly
		   under the pair.

		   The two cards above answer "how did the linking side move" and "how
		   did the hosting side move". Neither answers "how much of this month
		   was which", which is the question a two-sided report is read for —
		   and answering it by eye across two charts with two independent y-axes
		   is exactly the comparison a chart is supposed to remove.

		   Under them rather than above: the per-side cards are where the detail
		   is, this is the summary of both, and a reader scanning down meets the
		   halves before the whole. */
		out = append(out, panelDef{
			Key: keyTrendSplit, Kind: panelTrendSplit, Span: spanFull,
			Label:       "Overall Identification & Removal - Monthly",
			DefaultDesc: trendSplitPanelDesc(delisting),
		})
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
	/* Which UGC and social platforms the live card folds into one row, comma
	   separated. Only meaningful on the realtime panel; empty everywhere else,
	   and empty there means fold nothing. See realtimeplatforms.go. */
	Rollup string
	Set    bool
}

/*
realtimeRollupFor is the fold configured for one client's live card.

Reads through the same layout the report page is drawn from — the client's own
row where it has one, the all-clients default otherwise — so the card a reader
sees and the setting an admin edited are one thing rather than two that agree
most of the time.

Only the sports view has a live card to configure, and only its layout carries
the setting; every other view folds nothing. Named here rather than in
realtimeplatforms.go because it is the layout it reads, and layoutFor is this
file's.
*/
func realtimeRollupFor(view, platformKey, clientID string) map[string]bool {
	/* Only the sports view has a live card that can be configured, and only a
	   request that says WHICH report it is on can be. The War Room's card sends
	   neither and folds nothing, which is the behaviour it has always had. */
	if view != "sports" || strings.TrimSpace(platformKey) == "" {
		return nil
	}
	/* Per SECTION, like every other layout setting. A client reads Summary,
	   Open Web and Social as separate reports with separate arrangements, and
	   the fold is arranged on the same screen and stored on the same row as the
	   card's width and its title — so an admin who configures the card on the
	   report they are looking at has configured the card they are looking at.
	   The alternative, one setting per client read off the Summary, would make
	   this the single control on that screen that does nothing where it is
	   edited. */
	row, ok := layoutFor(strings.TrimSpace(platformKey), clientID)[keyRealtime]
	if !ok || row.Rollup == "" {
		return nil
	}
	return parseRollup(row.Rollup)
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
	rows, _ := layoutForScoped(platformKey, clientID)
	return rows
}

/*
layoutForScoped is layoutFor, plus WHOSE layout came back.

`own` is true only where the rows are this CLIENT'S — not the all-clients
fallback, and not the shared layout read for itself. It is the difference
between "somebody designed this page for this company" and "this company follows
the default", and applyLayout needs to know which, because a panel missing from
those two states means opposite things:

  - missing from a client's OWN layout means it did not exist when that layout
    was designed. Every save writes a row for every panel on the page, so the
    only way to be absent is to have been added since.
  - missing from the shared layout means the same thing, but the shared layout
    is where an admin arranges the default for everyone — a new panel has to
    surface there or nobody would ever know it existed.
*/
func layoutForScoped(platformKey, clientID string) (map[string]layoutRow, bool) {
	ensureLayoutSchema()
	out := readLayoutRows(platformKey, clientID)
	if len(out) > 0 {
		return out, clientID != layoutAllClients
	}
	if clientID != layoutAllClients {
		return readLayoutRows(platformKey, layoutAllClients), false
	}
	return out, false
}

func readLayoutRows(platformKey, clientID string) map[string]layoutRow {
	out := map[string]layoutRow{}
	rows, err := db.Query(
		"SELECT panel_key, sort_order, span, viz, is_hidden, custom_label, description, row_limit, realtime_rollup FROM "+layoutTable+
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
			Rollup: strings.TrimSpace(strFromAny(r["realtime_rollup"])),
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
	stored, own := layoutForScoped(platformKey, clientID)
	return overlayLayout(panels, stored, own)
}

/*
overlayLayout applies a stored layout to the registry's panels.

Split from the lookup so the decision can be tested without a database — the
same reason sportsPeriodScope takes its period rather than fetching it. `own`
says whether `stored` is this client's own design or the shared default; see
layoutForScoped, and the branch below that turns on it.
*/
func overlayLayout(panels []panelDef, stored map[string]layoutRow, own bool) []panelDef {
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
			// And only the live strip folds platforms. Same rule as the two
			// above: a stored value against any other panel is a row left
			// behind by a panel that changed kind, not an instruction.
			if p.Kind == panelRealtime {
				p.Rollup = row.Rollup
			}
		} else if own {
			/* ── A PANEL THIS CLIENT'S LAYOUT HAS NEVER SEEN ─────────────────

			   Hidden, rather than dropped into the page at its registry
			   position.

			   A save writes a row for EVERY panel on the page, so the only way
			   to be missing from a client's own layout is to have been added
			   since it was designed. Placed by the registry, a new card lands
			   in the middle of a page somebody arranged deliberately — the one
			   thing a bespoke layout exists to prevent, and it happens without
			   anyone choosing it.

			   Hidden is not lost. The layout editor lists these under its
			   Hidden section, toggled off, so an admin with the grant sees
			   exactly what is new and switches on the ones that belong. The
			   decision moves from the registry to the person who designed the
			   page.

			   ONLY for a client's OWN layout. The shared one is where an admin
			   arranges the default for everyone, and a new panel has to surface
			   there or it would be invisible to every report at once — see
			   layoutForScoped. */
			p.Hidden = true
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
		defaultPanels(platformKey, dims, roles, tiles, actions, delisting,
			mergesReports(platformKey), hasRealtime(platformKey))) {
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
		defaultPanels(platformKey, dims, roles, tiles, actions, delisting,
			mergesReports(platformKey), hasRealtime(platformKey)))
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
	"pageNoBucket":     "Page Number",
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

	// Which SIDE of the open web to read — the only slicer here that selects a
	// table rather than a value in one. See sourcetype.go.
	"sourceType": "Source Type",

	// How far into the takedown workflow to read — monitoring alone, or the
	// whole engagement. Offered only to clients configured for it. See
	// monitoringscope.go.
	"monitoringScope": "Monitoring Scope",

	// One pirate operator, however many hostnames it runs. Linking side only —
	// the host table has no linking-domain column. See piratebrand.go.
	"pirateBrand": "Pirate Brand",

	// The only slicer that narrows ONE PANEL rather than the page — the platform
	// behind the repeat-offender ranking. See repeatoffenders.go.
	"repeatPlatform": "Platform (Repeat Offenders)",
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
func filterParamsFor(p platformDef, clientID string) []string {
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
	/* And the one slicer that is not a column — which SIDE of the open web to
	   read. Appended after the sort rather than inside it so it lands at the
	   foot of the pane's default order: it changes what the whole report covers
	   rather than narrowing it, which is a different kind of control from the
	   value pickers above it and reads better apart from them. Somebody who
	   wants it first can move it in Report Configuration like any other.
	   See sourcetype.go. */
	if platformOffersSourceType(specs) {
		out = append(out, sourceTypeParam)
	}
	/* And the other slicer that is not a column — how far into the takedown
	   workflow to read. Appended after the sort for the same reason as the one
	   above, and offered only where the client is configured for it: most
	   clients buy one engagement or the other, and for them this is a dropdown
	   with a single meaningful setting. See monitoringscope.go.

	   `clientID` is empty on the all-clients layout editor, where a per-client
	   control has nothing to answer to — the per-client overlay is applied by
	   the caller, and the slicer appears there once the client has it on. */
	if clientID != "" && monitoringScopeEnabled(clientID) {
		out = append(out, monitoringScopeParam)
	}
	/* And the one slicer that narrows a single PANEL rather than the page — the
	   platform behind the repeat-offender ranking. Offered only where that panel
	   exists and the source records a platform to pick from; see
	   repeatPlatformParam for why it is deliberately not a scope filter. */
	for _, sp := range specs {
		if sp.Filters[repeatPlatformParam] != "" {
			continue
		}
		if hasDim(sp, dimRepeatOffender) && specHasColumn(sp, colPlatform) {
			out = append(out, repeatPlatformParam)
			break
		}
	}
	return out
}

// hasDim reports whether a spec draws a given panel.
func hasDim(s reportSpec, key string) bool {
	for _, d := range s.Dimensions {
		if d.Key == key {
			return true
		}
	}
	return false
}

// specHasColumn reports whether the spec's table carries a column, by the same
// shape lookup inferSpec used to build it.
func specHasColumn(s reportSpec, col string) bool {
	return tableShapeOf(s.Table).has(col)
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
		if p.Hidden {
			continue
		}
		/* THE PANEL-SCOPED ONES ARE NOT RAIL SLICERS.

		   The rail is where a reader changes the SCOPE — every control in it
		   moves the KPI band, the trends and all twenty panels together. The
		   repeat-offender platform does not: it narrows one card and leaves the
		   rest of the report alone, which is the whole point of it.

		   Sitting in the rail it read as a scope control that was quietly
		   failing, because that is what every other control there is. A reader
		   picking TikTok from the pane has every reason to expect the page to
		   follow, and nothing on screen explained why it did not. So the control
		   moves onto the card it acts on, where its reach is obvious from where
		   it is.

		   It stays in `filters` — the section still UNDERSTANDS the parameter,
		   the options endpoint still serves its values, and the card draws its
		   own dropdown from them. Only the rail stops offering it. */
		if panelScopedParams[p.Param] {
			continue
		}
		out = append(out, p.Param)
	}
	return out
}

/*
panelScopedParams narrow ONE panel rather than the page.

A list rather than a flag on the parameter because it is read from two places
that have no other reason to know about each other — the rail, which must not
draw them, and the page, which draws them on their own cards.
*/
var panelScopedParams = map[string]bool{
	repeatPlatformParam: true,
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
/*
adminHiddenPanelsFor is adminHiddenPanels as it applies to ONE client: the
panels that client may not switch on or arrange.

The shared default hides a panel for everyone, but a client's OWN layout can
show it — IP House switching a tile on for one company from Report
Configuration. Such a panel is on that client's report, so it has to be in their
editor too: leaving it out meant a card on the page that the "Arrange your
reports" screen did not list and could not move, and the next save the client
made forced it hidden again, silently undoing what IP House had turned on.

So a panel shown in the client's own layout is theirs to arrange; everything
else the shared default hides stays locked, exactly as before.
*/
func adminHiddenPanelsFor(platformKey, clientID string) map[string]bool {
	hidden := adminHiddenPanels(platformKey)
	if clientID == layoutAllClients || len(hidden) == 0 {
		return hidden
	}
	own := readLayoutRows(platformKey, clientID)
	for key, row := range own {
		if hidden[key] && row.Set && !row.Hidden {
			delete(hidden, key)
		}
	}
	return hidden
}

func adminHiddenPanels(platformKey string) map[string]bool {
	out := map[string]bool{}
	// The all-clients layer: no client, so a per-client slicer has nothing to
	// answer to here — see filterParamsFor.
	in, ok := layoutInputsFor(platformKey, "")
	if !ok {
		return out
	}
	defaults := defaultPanels(platformKey, in.Dims, in.Roles, in.Tiles, in.Actions, in.Delisting,
		mergesReports(platformKey), hasRealtime(platformKey))
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

	in, ok := layoutInputsFor(key, clientID)
	if !ok {
		Fail(w, 404, "Unknown platform: "+key)
		return
	}

	defaults := defaultPanels(key, in.Dims, in.Roles, in.Tiles, in.Actions, in.Delisting,
		mergesReports(key), hasRealtime(key))
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
	adminHidden := adminHiddenPanelsFor(key, clientID)

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
		switch {
		/* A heading's "description" IS its subtitle — see asMap — so the
		   placeholder is the built-in one rather than a panel note it will never
		   show. Without this the editor invited an admin to write an ⓘ note for
		   a card that has no ⓘ. */
		case p.Kind == panelHeading:
			row["defaultDesc"] = p.Sub
		case p.DefaultDesc != "":
			row["defaultDesc"] = p.DefaultDesc
		default:
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
		/* The live card's platform list, on the live card's own row.

		   Sent only for that panel, because it is the only one it means anything
		   on — a checklist of social platforms under a KPI tile would be a
		   control with nothing to act on. The screen ticks what is SHOWN, so
		   each entry carries `rolledUp` and the editor draws it inverted; see
		   realtimeplatforms.go for why the stored form is the other way round.

		   The catalogue can be EMPTY, and that is a state the screen has to be
		   able to say something about rather than draw as "no platforms": it
		   means no reading has been taken yet on this install, not that the
		   service watches nothing. */
		if p.Kind == panelRealtime {
			row["realtimePlatforms"] = realtimePlatformChoices(parseRollup(p.Rollup))
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
	// The combined monthly card is named here with the other dated ones, for the
	// same reason: its title comes from defaultPanels, and a configuration screen
	// that invents a second name for it leaves nothing to match the two by.
	case panelTrend, panelRate, panelTrendSplit:
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

func layoutInputsFor(key, clientID string) (layoutInputs, bool) {
	if p, found := platformByKey(key); found {
		return layoutInputs{
			Dims: sectionDimensions(p), Roles: rolesForPlatform(p),
			Actions:   actionsForPlatform(p),
			Delisting: delistingForPlatform(p),
			Tiles:     kpiTilesFor(platformExtraKPIs(p)), Params: filterParamsFor(p, clientID),
			Label: p.Label, FollowPanels: true,
		}, true
	}
	if key == summaryKey && summaryIsBuiltIn() {
		plats := summaryPlatforms(nil, "")
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
	roles := map[string]bool{}
	for _, sp := range specs {
		for k := range sp.ExtraKPI {
			seen[k] = true
		}
		if sp.Role != "" {
			roles[sp.Role] = true
		}
	}
	/* The per-side tiles, offered only on a platform that HAS two sides.

	   They are not ExtraKPI entries — no spec computes them, because each is one
	   side's figure and a spec only ever knows its own. runPlatform assembles
	   them from roleKPI once both have answered, so this is where the layout
	   editor is told they exist. Same guard as there: on a single-sided report
	   each would be the headline figure under a second name.

	   `brands` is offered with them and is the reason this cannot key off
	   ExtraKPI at all — it is folded in the API bridge from the full hostname
	   list, not summed from a column. */
	if len(roles) > 1 {
		for _, k := range perSideKPIs {
			seen[k] = true
		}
	}

	/* The two claim routes, on the YouTube report.

	   Here for exactly the reason perSideKPIs are: no spec computes them. The
	   API bridge fetches the auto-claim summary alongside the section's own and
	   sets both figures once it has answered, so there is no ExtraKPI entry to
	   find — and a tile is only ever drawn for a metric the layout was told
	   exists. Computing a figure and giving it a label is not enough on its
	   own; without this the numbers are correct, present in the response, and
	   invisible. */
	for _, sp := range specs {
		if tableHasAutoClaims(sp.Table) {
			for _, k := range autoClaimKPIs {
				seen[k] = true
			}
			break
		}
	}
	/* The suspension tiles, on any platform whose tables record a website —
	   no spec computes them either; runPlatform does. See domainsuspension.go. */
	if platformHasHostnames(specs) {
		for _, k := range suspensionKPIs {
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

/*
perSideKPIs are the tiles that split a two-sided report into its halves.

Listed once, in the order they read on the band: what was found, on how many
sites, run by how many operators — linking first and host second, which is the
order the page puts the two trends in and the order a link is followed.

Assembled in runPlatform from roleKPI; see the note there for why each is left
ABSENT rather than zero when a side does not report it.
*/
var perSideKPIs = []string{
	"linkingIdentified", "hostIdentified",
	"linkingDomains", "hostDomains",
	"linkingBrands", "hostBrands",
}

/*
withPerSideTiles adds those same six to the list the PAGE draws from.

── WHY THIS EXISTS AS A SECOND FUNCTION ────────────────────────────────────

There are two lists, and the distinction has now cost three features. platformExtraKPIs
above feeds the layout EDITOR — what an admin may place on a band. The list a
reader's page actually renders is built separately in ReportsSections out of each
spec's ExtraKPI, and these six are not ExtraKPI entries: no spec computes them,
because each is one side's figure and a spec only ever knows its own. runPlatform
assembles them from roleKPI once both sides have answered.

So they were computed, carried in every Open Web response, offered to an admin
arranging panels — and never drawn. Exactly the failure withAutoClaimTiles was
written for, on a different set of tiles, which is why this is modelled on it
rather than solved again.

── THE GUARD ───────────────────────────────────────────────────────────────

Two sides or nothing, the same condition runPlatform and platformExtraKPIs both
apply. On a single-sided report every one of these is the headline figure under a
second name, and a band reading "Total Infringements 812,400" beside "Total
Linking Identification 812,400" invites the reader to hunt for a difference that
does not exist.

Not gated per client, unlike the claim tiles: whether a platform has two sides is
a property of its table list, which is the same for everyone looking at it.
*/
func withPerSideTiles(extras []string, p platformDef) []string {
	if len(rolesForPlatform(p)) < 2 {
		return extras
	}
	seen := make(map[string]bool, len(extras))
	for _, k := range extras {
		seen[k] = true
	}
	for _, k := range perSideKPIs {
		if !seen[k] {
			extras = append(extras, k)
		}
	}
	sort.Strings(extras)
	return extras
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
			/* The live card's folded platforms — the ones the screen did NOT
			   tick. Absent on every other panel, and absent here means fold
			   nothing, which is what an unconfigured card does. */
			RealtimeRollup []string `json:"realtimeRollup"`
		} `json:"panels"`
	}
	json.NewDecoder(r.Body).Decode(&body)

	key := strings.TrimSpace(body.Platform)
	if key == "" {
		Fail(w, 422, "A platform is required")
		return
	}
	clientID := strings.TrimSpace(body.ClientID)
	if _, ok := layoutInputsFor(key, clientID); !ok {
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
	/*
		Two counters, because the page has two lists.

		The grid and the filter pane are arranged separately, read back
		separately — applyLayout sorts the panels, filterPanels sorts the
		slicers — and each of those compares a stored order against a DEFAULT
		of (index + 1) * 10 within its own list. One running counter across the
		whole body put the slicers on a scale the pane never uses: the body
		carries them after the panels, so on a thirty-panel report the first
		slicer was written at 310 while an unconfigured one still defaults to
		10.

		That is invisible until a slicer arrives without a row — a table gains a
		column, and the new one sorts above every slicer anybody has ever
		arranged. Numbering each list from its own zero is what the two readers
		already assume.
	*/
	pos := 0
	filterPos := 0
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
		/* The folded platforms, normalised and capped at what the column holds.

		   Cut rather than refused, like the title above it — though it takes a
		   service watching sixty social platforms with long keys to reach a
		   thousand characters, and a truncated list would silently unfold the
		   tail. So it is cut on a SEPARATOR: a shorter list that is entirely
		   correct beats a longer one whose last entry is half a key matching
		   nothing. */
		rollup := joinRollup(p.RealtimeRollup)
		if len(rollup) > 1000 {
			rollup = rollup[:1000]
			if i := strings.LastIndex(rollup, ","); i >= 0 {
				rollup = rollup[:i]
			} else {
				rollup = ""
			}
		}
		// Which list this panel is ordered within — see the note on the two
		// counters above.
		order := 0
		if strings.HasPrefix(pk, keyFilterPfx) {
			filterPos += 10
			order = filterPos
		} else {
			pos += 10
			order = pos
		}
		if _, _, err := db.Exec(`
			INSERT INTO `+layoutTable+` (platform_key, client_id, panel_key, sort_order, span, viz, is_hidden, custom_label, description, row_limit, realtime_rollup, updated_by)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON DUPLICATE KEY UPDATE sort_order=VALUES(sort_order), span=VALUES(span),
			  viz=VALUES(viz), is_hidden=VALUES(is_hidden), custom_label=VALUES(custom_label),
			  description=VALUES(description), row_limit=VALUES(row_limit),
			  realtime_rollup=VALUES(realtime_rollup), updated_by=VALUES(updated_by)`,
			key, clientID, pk, order, span, viz, hidden, title, desc, rowLimit, rollup, who); err != nil {
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
