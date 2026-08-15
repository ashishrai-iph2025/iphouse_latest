package handlers

import (
	"fmt"
	"log"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"

	ipauth "github.com/ip-house/iphouse-api/auth"
	"github.com/ip-house/iphouse-api/db"
)

// Summary — one report across every platform, replacing the PowerBI overview.
//
// Every other section is one configured platform. The summary is the sheet the
// client actually opens first: total assets, total infringements, removal rate,
// the month-on-month trend, and then the same result set split by platform, by
// language, by asset, by turnaround and so on. So it is not a new query engine —
// it runs each platform exactly as its own section would and merges the answers,
// plus two figures no single platform can produce:
//
//   - byPlatformGroup       identification and removal PER PLATFORM, which is
//                           the one chart that only exists at this level
//   - bySuspensionPlatform  suspended channels per platform, likewise
//
// It is a VIRTUAL platform: there is no row for it in report_platform, nothing to
// configure, and a platform added in Report Configuration joins the summary by
// existing. A real platform keyed "summary" takes precedence, so the built-in can
// always be replaced by a configured one.
//
// ACCESS: the summary aggregates only the platforms the calling login may see
// (see reportsAllowedFor), so it can never total up something the reader could
// not open directly. It is therefore not itself listed in Report Configuration's
// access tab — restricting it would be restricting nothing.

const (
	summaryKey   = "summary"
	summaryLabel = "Summary"

	// Platforms queried at once. The warehouse pool is six connections
	// (REPORTS_DB_MAX_CONNS) and each platform holds one at a time, so this
	// leaves room for the rest of the portal rather than saturating it.
	summaryConcurrency = 3

	// Distinct asset ids are unioned in memory so a title enforced on both
	// YouTube and Telegram counts once. The cap is the point past which that
	// stops being worth the memory; over it, the summary falls back to summing
	// each platform's distinct count and says so.
	summaryAssetCap = 250000
)

// knownFilterParams is every slicer parameter the reports API understands.
// Mirrors DIMFilterParam's return values, and is the set specHonoursFilters
// checks a spec against.
var knownFilterParams = []string{
	"assetId", "language", "country", "searchEngine", "tatBucket",
	"platform", "channel", "groupType", "quality", "genre", "infringementType",
	"deliveryType", "keyword", "domain",
}

/* ── Panels ───────────────────────────────────────────────────────────────────
   The summary fixes both the ORDER and the TITLES of its panels, which the
   per-platform sections leave to the registry. Two reasons: the order is the
   reading order of the report this replaces, and a title like "Top 10 Open Web
   Domains" is only true once the platforms are side by side — on the Open Web
   section alone it is just "Top Domains".

   A panel appears only if some platform can produce it, so an install without
   Telegram gets no Print Quality card rather than an empty one. */
// `Span` is how much of a row the panel takes: "full", "half" or "third". It is
// set here rather than derived from the chart type because the ROW is the unit
// being designed — panels that answer the same question are meant to be read
// side by side, and each row's spans are chosen to add up to a full width so no
// row ends with a hole in it. Leave it empty and the page falls back to the
// chart type's own default.
// `Row` groups panels that belong side by side, and the WIDTH IS DERIVED from
// how many of that group survive: one panel takes the row, two take a half each,
// three take a third. Set as a group rather than as three separate widths
// because that is the actual intent — "turnaround, print quality and nature of
// infringement are read together" — and because a panel can be missing. Genre
// needs a column not every warehouse has; hand-set widths would then leave
// Languages sitting on half a row with a hole beside it, where a group simply
// gives it the whole row.
var summaryDims = []struct {
	Key, Label, Viz string
	Row             int
}{
	{"byPlatformGroup", "Identification & Removal basis Platform", "hbar", 1},
	// What was infringed, and what kind of thing it was.
	{"byLanguage", "Infringements Breakdown - Languages", "bars", 2},
	{"byGenre", "Genre", "column", 2},
	// Horizontal: ten bars stacked down the card, so a full asset title fits in
	// the label column instead of being angled and cut under a column.
	{"byAsset", "Top 10 Assets - Identification & Removal", "hbar", 3},
	{"byPlatform", "Top 10 Social Media Platforms - Identification & Removal", "column", 4},
	// How the enforcement went: how fast, on what quality of copy, of what kind.
	{"byTAT", "Overall Removal Turn Around Time (TAT)", "ordinal", 5},
	{"byQuality", "Infringements Breakdown - Print Quality", "bars", 5},
	{"byInfringementType", "Nature of Infringements", "bars", 5},
	{"bySuspensionPlatform", "Channel Suspension - Platform", "value", 6},
	{"byDeliveryType", "Delivery Type", "value", 6},
	{"byDomain", "Top 10 Open Web Domains - Infringements", "hbar", 7},
	// Below the report's own panels: dimensions a platform may carry that the
	// PowerBI sheet did not show. They keep their registry titles.
	{"byDomainSource", "Top 10 Host Websites", "hbar", 8},
	{"byCountry", "Infringements Breakdown - Country", "map", 9},
	{"byKeyword", "Top 10 Keywords", "hbar", 10},
}

// spanForRowOf splits a six-column row evenly between the panels in it. Past
// three the row wraps, which is what a third-width panel does anyway.
func spanForRowOf(count int) string {
	switch count {
	case 1:
		return spanFull
	case 2:
		return spanHalf
	default:
		return spanThird
	}
}

// summaryDimAlias folds the warehouse's two spellings of a dimension into the
// one panel the summary draws. A social table groups by LanguageId and an
// open-web table by LanguageName; both are "Languages", and a reader looking at
// a merged report wants one card whose rows add up, not two half-answers. The
// canonical key on the right is the one the section declares and the one the
// merged rows are stored under.
var summaryDimAlias = map[string]string{
	"byLanguageId":         "byLanguage",
	"byInfringementTypeId": "byInfringementType",
	"byGenreId":            "byGenre",
	"byAssetName":          "byAsset",
}

// summaryDimKey resolves a dimension key to the one the summary shows it under.
func summaryDimKey(key string) string {
	if to, ok := summaryDimAlias[key]; ok {
		return to
	}
	return key
}

// summaryKPIOrder is the tile band, left to right, top row then bottom — the
// order of the report this replaces. Tiles whose figure no platform produces are
// dropped rather than shown as a zero.
var summaryKPIOrder = []string{
	"totalAssets", "totalPlaces", "channelsSuspended",
	"impactedSubscribers", "viewsSaved", "savedRevenue",
}

/*
── Estimated saved revenue ──────────────────────────────────────────────────

	Views saved × a rate, quoted as a RANGE because a view is not worth one
	number: the low end is what the content earns where it is monetised thinly,
	the high end where it is not. Both rates are environment settings —

	  REPORTS_REVENUE_PER_VIEW_MIN   (default 0.00895)
	  REPORTS_REVENUE_PER_VIEW_MAX   (default 0.0895)
	  REPORTS_REVENUE_CURRENCY       (optional prefix, e.g. "$"; default none)

	— because they are a commercial assumption, not a fact about the data, and
	correcting one must not need a deploy. The defaults reproduce the figures on
	the report this replaces; no currency is assumed, so the tile shows the rate it
	used and lets the reader supply the unit.
*/
func summaryRevenueRates() (low, high float64, currency string) {
	low = envFloat("REPORTS_REVENUE_PER_VIEW_MIN", 0.00895)
	high = envFloat("REPORTS_REVENUE_PER_VIEW_MAX", 0.0895)
	if high < low {
		low, high = high, low
	}
	return low, high, strings.TrimSpace(os.Getenv("REPORTS_REVENUE_CURRENCY"))
}

func envFloat(key string, def float64) float64 {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil || f < 0 {
		log.Printf("[reports] %s is not a number (%q) — using %g", key, v, def)
		return def
	}
	return f
}

/* ── Which platforms a login's summary covers ─────────────────────────────── */

// summaryPlatforms lists the enabled platforms this login may see. An empty
// result means there is nothing to summarise and the section is not offered.
func summaryPlatforms(claims *ipauth.Claims) []platformDef {
	var allowed map[string]bool
	if claims != nil {
		// nil means unrestricted, which is the default for every login.
		allowed = reportsAllowedFor(claims.LoginID)
	}
	out := []platformDef{}
	for _, p := range loadPlatforms() {
		if !p.Enabled || p.Key == summaryKey {
			continue
		}
		if allowed != nil && !allowed[p.Key] {
			continue
		}
		out = append(out, p)
	}
	return out
}

// summaryIsBuiltIn reports whether the virtual summary should be served. A
// configured platform of the same key always wins.
func summaryIsBuiltIn() bool {
	_, real := platformByKey(summaryKey)
	return !real
}

/* ── GET /api/reports/sections — the summary's descriptor ─────────────────── */

// summarySection describes the summary to the page: which panels to draw, in
// which order, under which titles, and which slicers apply.
func summarySection(platforms []platformDef, clientID string) (map[string]any, bool) {
	if len(platforms) == 0 {
		return nil, false
	}

	// byPlatformGroup is computed here, so it always exists; the rest depend on
	// what the configured tables actually carry.
	avail := map[string]bool{"byPlatformGroup": true}
	filterSeen := map[string]bool{}
	extraSeen := map[string]bool{}
	for _, p := range platforms {
		specs, _ := specsForPlatform(p)
		for _, sp := range specs {
			for _, d := range sp.Dimensions {
				avail[summaryDimKey(d.Key)] = true
			}
			for param := range sp.Filters {
				filterSeen[param] = true
			}
			for k := range sp.ExtraKPI {
				extraSeen[k] = true
			}
		}
	}
	if extraSeen["channelsSuspended"] {
		avail["bySuspensionPlatform"] = true
	}

	// Deduped by title as well as by key: the warehouse spells the same thing two
	// ways on different tables (InfringementType / InfringementTypeId), and both
	// merge into one panel here.
	kept := make([]int, 0, len(summaryDims))
	perRow := map[int]int{}
	labelSeen := map[string]bool{}
	for i, d := range summaryDims {
		if !avail[d.Key] || labelSeen[d.Label] {
			continue
		}
		labelSeen[d.Label] = true
		kept = append(kept, i)
		perRow[d.Row]++
	}
	// Widths come from how many panels ended up sharing each row — see the Row
	// field on summaryDims.
	dims := make([]map[string]any, 0, len(kept))
	for _, i := range kept {
		d := summaryDims[i]
		dims = append(dims, map[string]any{
			"key": d.Key, "label": d.Label, "viz": d.Viz,
			"span": spanForRowOf(perRow[d.Row]),
		})
	}

	filters := make([]string, 0, len(filterSeen))
	for k := range filterSeen {
		filters = append(filters, k)
	}
	sort.Strings(filters)

	// Derived tiles the merge adds on top of what any one platform returns.
	extraSeen["totalPlaces"] = extraSeen["totalDomains"] || extraSeen["totalChannels"]
	extraSeen["savedRevenue"] = extraSeen["viewsSaved"]
	// Unlike a platform section, the order here is the tile band's reading order,
	// not alphabetical.
	extras := make([]string, 0, len(summaryKPIOrder))
	for _, k := range summaryKPIOrder {
		if extraSeen[k] {
			extras = append(extras, k)
		}
	}

	/* The summary's headline tiles are a fixed set in a fixed order — the one the
	   report it replaces prints, which is the order the people reading it already
	   know — rather than "the base four, then whatever else turned up". A figure
	   no platform produces is dropped instead of shown as a zero. */
	tiles := []string{}
	for _, k := range []string{
		"totalAssets", "identified", "totalPlaces", "removalPct",
		"channelsSuspended", "impactedSubscribers", "viewsSaved", "savedRevenue",
	} {
		if k == "identified" || k == "removalPct" || extraSeen[k] {
			tiles = append(tiles, k)
		}
	}

	tables := []string{}
	labels := make([]string, 0, len(platforms))
	for _, p := range platforms {
		tables = append(tables, p.Tables...)
		labels = append(labels, p.Label)
	}

	return map[string]any{
		"key": summaryKey, "label": summaryLabel,
		"dimensions": dims, "filters": filters, "extraKpi": extras,
		"kpiTiles": tiles,
		"tables":   uniqueStrings(tables),
		// The summary has no source roles of its own — it never draws a linking
		// trend against a hosting one — so it takes the single merged trend.
		"panels": sectionPanels(summaryKey, clientID, dims, nil, tiles),
		// What the summary is actually adding up, so the page can say so rather
		// than leaving the reader to guess the scope of a total.
		"platforms": labels,
	}, true
}

/* ── GET /api/reports/data?type=summary ───────────────────────────────────── */

// runSummary executes every platform and merges them into one report.
func runSummary(platforms []platformDef, q map[string]string) map[string]any {
	type part struct {
		p    platformDef
		data map[string]any
	}

	// Platforms run concurrently: the summary is the slowest page in the product
	// by construction — six platforms' worth of queries — and they do not depend
	// on each other.
	parts := make([]part, len(platforms))
	var wg sync.WaitGroup
	gate := make(chan struct{}, summaryConcurrency)
	for i, p := range platforms {
		wg.Add(1)
		go func(i int, p platformDef) {
			defer wg.Done()
			gate <- struct{}{}
			defer func() { <-gate }()
			parts[i] = part{p: p, data: runPlatform(p, q)}
		}(i, p)
	}
	wg.Wait()

	kpi := map[string]int64{}
	// The same figures over the preceding window, merged the same way, so the
	// summary's tiles carry the change too rather than being the one section
	// where they go quiet. Every platform was asked about the same window, so
	// prevFrom/prevTo are one pair and the first platform to answer sets them.
	kpiPrev := map[string]int64{}
	havePrev := false
	prevFrom, prevTo := "", ""
	daily := map[string]map[string]int64{}
	breakdowns := map[string]map[string]map[string]int64{}
	dimValues := map[string]map[string]string{}
	platformRows := []map[string]any{}
	suspensionRows := []map[string]any{}
	warnings := []string{}
	skipped := []string{}
	// Platforms that answered nothing because no table of theirs carries a column
	// an active slicer needs. Reported, not silently dropped: "Instagram" is a
	// social-media value, and a reader who filters on it should be told that the
	// YouTube and Open Web figures are out of scope rather than assume they were
	// zero.
	outOfScope := []string{}
	covered := []string{}

	// Platforms whose tables could not be read at all — a misconfiguration, and a
	// different thing from being filtered out, so it is reported differently.
	unreadable := []string{}

	for _, pt := range parts {
		d := pt.data
		if d == nil {
			continue
		}
		if ok, _ := d["ok"].(bool); !ok {
			unreadable = append(unreadable, pt.p.Label)
			skipped = append(skipped, asStrings(d["skippedTables"])...)
			continue
		}
		if numOf(d["specsRun"]) == 0 {
			outOfScope = append(outOfScope, pt.p.Label)
			continue
		}
		covered = append(covered, pt.p.Label)
		if wv := strFromAny(d["queryWarning"]); wv != "" {
			warnings = append(warnings, pt.p.Label+": "+wv)
		}
		skipped = append(skipped, asStrings(d["skippedTables"])...)

		pkpi, _ := d["kpi"].(map[string]any)
		for k, v := range pkpi {
			if k == "removalPct" {
				continue // derived, not additive — recomputed after the merge
			}
			kpi[k] += numOf(v)
		}

		if ppkpi, ok := d["kpiPrev"].(map[string]any); ok {
			havePrev = true
			if prevFrom == "" {
				prevFrom, prevTo = strFromAny(ppkpi["from"]), strFromAny(ppkpi["to"])
			}
			for k, v := range ppkpi {
				switch k {
				case "removalPct", "from", "to":
					continue // derived, or the window itself — not summable
				}
				kpiPrev[k] += numOf(v)
			}
		}

		// The two figures that only exist across platforms.
		platformRows = append(platformRows, map[string]any{
			"label": pt.p.Label, "value": pt.p.Key,
			"urls": numOf(pkpi["identified"]), "removed": numOf(pkpi["removed"]),
		})
		if v, ok := pkpi["channelsSuspended"]; ok {
			suspensionRows = append(suspensionRows, map[string]any{
				"label": pt.p.Label, "value": pt.p.Key, "urls": numOf(v),
			})
		}

		for _, row := range asRows(d["daily"]) {
			date := strFromAny(row["date"])
			if date == "" {
				continue
			}
			if daily[date] == nil {
				daily[date] = map[string]int64{}
			}
			daily[date]["urls"] += numOf(row["urls"])
			daily[date]["removed"] += numOf(row["removed"])
		}

		if bd, ok := d["breakdowns"].(map[string]any); ok {
			for key, rows := range bd {
				if breakdowns[key] == nil {
					breakdowns[key] = map[string]map[string]int64{}
				}
				for _, row := range asRows(rows) {
					label := strFromAny(row["label"])
					if label == "" {
						continue
					}
					if breakdowns[key][label] == nil {
						breakdowns[key][label] = map[string]int64{}
					}
					breakdowns[key][label]["urls"] += numOf(row["urls"])
					breakdowns[key][label]["removed"] += numOf(row["removed"])
					if v := strFromAny(row["value"]); v != "" {
						if dimValues[key] == nil {
							dimValues[key] = map[string]string{}
						}
						if _, seen := dimValues[key][label]; !seen {
							dimValues[key][label] = v
						}
					}
				}
			}
		}
	}

	// The two spellings of the same dimension are one panel here — fold the alias
	// into the canonical key so the merged rows add up instead of splitting.
	for from, to := range summaryDimAlias {
		foldDim(breakdowns, dimValues, from, to)
	}

	ident, removed := kpi["identified"], kpi["removed"]
	kpiOut := map[string]any{}
	for k, v := range kpi {
		kpiOut[k] = v
	}
	kpiOut["pending"] = max64(0, ident-removed)
	pct := 0.0
	if ident > 0 {
		pct = float64(removed) / float64(ident) * 100
	}
	kpiOut["removalPct"] = roundTo(pct, 2)

	// "No. of Website / Channel / Page" — the places infringing content was
	// found, whatever kind of place a platform's rows describe. Summed rather
	// than deduplicated: a domain and a channel are never the same row, and two
	// platforms sharing a domain is rare enough not to pay a second scan for.
	//
	// Derived tiles are only published when something underneath them exists. A
	// tile the reader has no way to distinguish from a real zero is worse than a
	// tile that is not there.
	_, hasDomains := kpi["totalDomains"]
	_, hasChannels := kpi["totalChannels"]
	if hasDomains || hasChannels {
		kpiOut["totalPlaces"] = kpi["totalDomains"] + kpi["totalChannels"]
	}

	// Assets, unlike places, DO overlap heavily — the same title is enforced on
	// every platform at once — so summing each platform's distinct count would
	// multiply the catalogue by the number of platforms. This one is counted
	// properly, over the union of the ids themselves.
	if n, exact := summaryDistinctAssets(platforms, q); exact {
		kpiOut["totalAssets"] = n
	}

	low, high, currency := summaryRevenueRates()
	if saved, ok := kpi["viewsSaved"]; ok {
		v := float64(saved)
		kpiOut["savedRevenueLow"] = roundTo(v*low, 2)
		kpiOut["savedRevenueHigh"] = roundTo(v*high, 2)
		kpiOut["savedRevenue"] = roundTo(v*low, 2) // generic clients show the floor
	}

	// The previous window's tiles. Only the figures that are genuinely the same
	// measure over the other window: the additive ones, pending and the rate
	// derived from them, and the derived tiles that are pure functions of those.
	//
	// totalAssets is left out on purpose. It is counted over the union of asset
	// ids in THIS window (summaryDistinctAssets above), and doing that a second
	// time is another scan for a delta on a catalogue that barely moves. A tile
	// with no previous figure simply shows no delta, which is the right outcome.
	var kpiPrevOut map[string]any
	if havePrev {
		kpiPrevOut = map[string]any{"from": prevFrom, "to": prevTo}
		for k, v := range kpiPrev {
			kpiPrevOut[k] = v
		}
		pIdent, pRemoved := kpiPrev["identified"], kpiPrev["removed"]
		kpiPrevOut["pending"] = max64(0, pIdent-pRemoved)
		pPct := 0.0
		if pIdent > 0 {
			pPct = float64(pRemoved) / float64(pIdent) * 100
		}
		kpiPrevOut["removalPct"] = roundTo(pPct, 2)
		if hasDomains || hasChannels {
			kpiPrevOut["totalPlaces"] = kpiPrev["totalDomains"] + kpiPrev["totalChannels"]
		}
		if saved, ok := kpiPrev["viewsSaved"]; ok {
			v := float64(saved)
			kpiPrevOut["savedRevenueLow"] = roundTo(v*low, 2)
			kpiPrevOut["savedRevenueHigh"] = roundTo(v*high, 2)
			kpiPrevOut["savedRevenue"] = roundTo(v*low, 2)
		}
	}

	dates := make([]string, 0, len(daily))
	for d := range daily {
		dates = append(dates, d)
	}
	sort.Strings(dates)
	dailyOut := make([]map[string]any, 0, len(dates))
	for _, d := range dates {
		dailyOut = append(dailyOut, map[string]any{
			"date": d, "urls": daily[d]["urls"], "removed": daily[d]["removed"],
		})
	}

	bdOut := map[string]any{}
	for key, byLabel := range breakdowns {
		rows := make([]map[string]any, 0, len(byLabel))
		for label, m := range byLabel {
			row := map[string]any{"label": label, "urls": m["urls"], "removed": m["removed"]}
			if v := dimValues[key][label]; v != "" {
				row["value"] = v
			}
			rows = append(rows, row)
		}
		sort.Slice(rows, func(i, j int) bool { return numOf(rows[i]["urls"]) > numOf(rows[j]["urls"]) })
		// Closed sets keep every value; open-ended ones are a top-N list and say
		// so in their title.
		if len(rows) > 15 && !summaryClosedSet[key] {
			rows = rows[:15]
		}
		bdOut[key] = rows
	}

	sort.Slice(platformRows, func(i, j int) bool { return numOf(platformRows[i]["urls"]) > numOf(platformRows[j]["urls"]) })
	sort.Slice(suspensionRows, func(i, j int) bool { return numOf(suspensionRows[i]["urls"]) > numOf(suspensionRows[j]["urls"]) })
	bdOut["byPlatformGroup"] = platformRows
	if len(suspensionRows) > 0 {
		bdOut["bySuspensionPlatform"] = suspensionRows
	}

	out := map[string]any{
		"ok": true, "available": true, "type": summaryKey, "label": summaryLabel,
		"kpi": kpiOut, "daily": dailyOut, "breakdowns": bdOut,
		"platforms": covered,
		"revenueRate": map[string]any{
			"min": low, "max": high, "currency": currency,
			"basis": "per view saved",
		},
	}
	if kpiPrevOut != nil {
		out["kpiPrev"] = kpiPrevOut
	}
	if len(outOfScope) > 0 {
		out["outOfScopePlatforms"] = outOfScope
	}
	if len(unreadable) > 0 {
		out["unreadablePlatforms"] = unreadable
		warnings = append(warnings,
			"no readable table behind "+strings.Join(unreadable, ", ")+" — check Report Configuration")
	}
	if len(skipped) > 0 {
		out["skippedTables"] = uniqueStrings(skipped)
	}
	if len(warnings) > 0 {
		out["queryWarning"] = strings.Join(warnings, " · ")
	}
	if len(covered) == 0 {
		out["error"] = "No platform could answer this filter set"
	}
	return out
}

// summaryClosedSet names the dimensions whose values are a fixed, short list, so
// the merge keeps all of them instead of cutting to a top 15.
var summaryClosedSet = map[string]bool{
	"byTAT": true, "byGroupType": true, "byQuality": true,
	"byPlatformGroup": true, "bySuspensionPlatform": true,
	"byDeliveryType": true, "byDelistingStatus": true, "byGenre": true,
}

// foldDim merges one dimension's rows into another's — used where the warehouse
// spells the same thing two ways on different tables and the summary shows one
// panel for both.
func foldDim(breakdowns map[string]map[string]map[string]int64, values map[string]map[string]string, from, to string) {
	src := breakdowns[from]
	if src == nil {
		return
	}
	delete(breakdowns, from)
	if breakdowns[to] == nil {
		breakdowns[to] = map[string]map[string]int64{}
	}
	for label, m := range src {
		if breakdowns[to][label] == nil {
			breakdowns[to][label] = map[string]int64{}
		}
		breakdowns[to][label]["urls"] += m["urls"]
		breakdowns[to][label]["removed"] += m["removed"]
	}
	for label, v := range values[from] {
		if values[to] == nil {
			values[to] = map[string]string{}
		}
		if _, seen := values[to][label]; !seen {
			values[to][label] = v
		}
	}
	delete(values, from)
}

// summaryDistinctAssets counts the assets in scope across every platform, as a
// union of the ids rather than a sum of per-table distinct counts.
//
// `exact` is false when the union grew past the cap or no table could be read —
// in which case the caller leaves the summed figure alone rather than publishing
// a number it knows is short.
func summaryDistinctAssets(platforms []platformDef, q map[string]string) (int64, bool) {
	ids := map[string]struct{}{}
	any := false
	for _, p := range platforms {
		specs, _ := specsForPlatform(p)
		for _, s := range specs {
			if s.AssetCol == "" || !specHonoursFilters(s, q) {
				continue
			}
			where, args := specWhere(s, q)
			rows, err := db.ReportsQuery(fmt.Sprintf(
				`SELECT DISTINCT %s AS v FROM %s %s AND %s IS NOT NULL AND %s != ''`,
				s.AssetCol, s.Table, where, s.AssetCol, s.AssetCol), args...)
			if err != nil {
				log.Printf("[summary] distinct assets on %s: %v", s.Table, err)
				continue
			}
			any = true
			for _, r := range rows {
				ids[strFromAny(r["v"])] = struct{}{}
				if len(ids) > summaryAssetCap {
					log.Printf("[summary] distinct asset union passed %d — falling back to the summed count", summaryAssetCap)
					return 0, false
				}
			}
		}
	}
	if !any {
		return 0, false
	}
	return int64(len(ids)), true
}

/* ── GET /api/reports/options?type=summary ────────────────────────────────── */

// summarySpecs flattens every platform's tables into one list of runnable specs.
func summarySpecs(platforms []platformDef) []reportSpec {
	out := []reportSpec{}
	for _, p := range platforms {
		specs, _ := specsForPlatform(p)
		out = append(out, specs...)
	}
	return out
}

// asStrings narrows the `any` a merged payload carries back to a string list.
func asStrings(v any) []string {
	switch t := v.(type) {
	case []string:
		return t
	case []any:
		out := make([]string, 0, len(t))
		for _, e := range t {
			out = append(out, strFromAny(e))
		}
		return out
	}
	return nil
}
