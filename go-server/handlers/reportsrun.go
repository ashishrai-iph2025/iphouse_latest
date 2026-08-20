package handlers

import (
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/ip-house/iphouse-api/db"
)

// Spec-driven report execution — see reportspecs.go for the registry.
//
// One code path serves every section: build the WHERE from the spec's filter map,
// then run the KPI query, the daily trend, and one grouped query per dimension.
// Each query runs on its own, so a wrong column name in one dimension costs that
// panel and nothing else.

/*
── GET /api/reports/sections ─────────────────────────────────────────────────

	The page builds its sidebar and its panels from this rather than hardcoding a
	copy of the registry, so adding a report on the server is enough to make it
	appear in the UI.
*/
func ReportsSections(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	// An allow-list of nil means unrestricted, which is the default for every
	// login — see reportsAllowedFor.
	var allowed map[string]bool
	if claims != nil {
		allowed = reportsAllowedFor(claims.LoginID)
	}

	if !mayOpenReports(claims) {
		Fail(w, 403, "The Reports module is not enabled for this account")
		return
	}
	// The panel layout can differ per client, so the page re-asks for its sections
	// when the client slicer changes. Everything else here is client-independent.
	// A client login cannot name a client — it gets its own, mapped one.
	clientID, _, _ := reportScope(claims, r.URL.Query().Get("clientId"))

	out := make([]map[string]any, 0, 8)
	visible := []platformDef{}
	for _, p := range loadPlatforms() {
		if !p.Enabled {
			continue
		}
		if allowed != nil && !allowed[p.Key] {
			continue
		}
		if p.Key != summaryKey {
			visible = append(visible, p)
		}
		// Dimensions and slicers are the union across the platform's tables: a
		// panel is offered when at least one of its tables can produce it.
		specs, _ := specsForPlatform(p)
		dims := sectionDimensions(p)
		params := filterParamsFor(p)
		extraSeen := map[string]bool{}
		for _, sp := range specs {
			for k := range sp.ExtraKPI {
				extraSeen[k] = true
			}
		}

		/* A slicer follows its PANEL out of the report.

		   Hiding a breakdown in Report Configuration used to leave its dropdown
		   in the rail: a Genre filter on a report with no Genre chart, whose only
		   visible effect was to empty every other panel. Whatever the layout
		   switches off is off everywhere.

		   A slicer several panels share survives while any of them is visible —
		   Open Web's domain filter serves both the linking and the hosting
		   panel, and hiding one must not take the other's control with it. */
		hidden := hiddenDimsFor(p.Key, clientID, dims, rolesForPlatform(p),
			kpiTilesFor(platformExtraKPIs(p)))
		stillShown := map[string]bool{}
		for _, d := range dims {
			key := strFromAny(d["key"])
			if hidden[key] {
				continue
			}
			if param := DIMFilterParam(key); param != "" {
				stillShown[param] = true
			}
		}

		/* The filter pane, as configured for this platform and this client:
		   which slicers get a control, and in what order down the rail. Hiding
		   a chart still takes its slicer with it — that is the DEFAULT the pane
		   starts from — but it is a default now, and Report Configuration can
		   say otherwise in either direction. */
		slicers := sectionSlicers(p.Key, clientID, params, stillShown)
		inPane := map[string]bool{}
		for _, k := range slicers {
			inPane[k] = true
		}

		filters := make([]string, 0, len(params))
		for _, k := range params {
			// A parameter no visible breakdown maps to is kept: the date, the
			// client, and any filter that never had a panel of its own. So is one
			// whose slicer is in the pane whatever became of its chart — the
			// control is on the page, so the report has to honour it.
			if hasPanel := dimFilterParamHasPanel(k); hasPanel && !stillShown[k] && !inPane[k] {
				continue
			}
			filters = append(filters, k)
		}
		extras := make([]string, 0, len(extraSeen))
		for k := range extraSeen {
			extras = append(extras, k)
		}
		sort.Strings(extras)

		out = append(out, map[string]any{
			"key": p.Key, "label": p.Label,
			"dimensions": dims, "filters": filters, "extraKpi": extras,
			/* `filters` is what the section UNDERSTANDS — every parameter a click
			   on a panel may set. `slicers` is the subset that gets a dropdown in
			   the rail, in the order it is drawn. The two are not the same list:
			   turnaround is picked off its own bar and has no dropdown unless one
			   is asked for, and hiding a slicer must not stop the panel beneath
			   it cross-filtering the page. */
			"slicers": slicers,
			/* The table list is NOT published here.

			   This endpoint is served to every authenticated login, client
			   logins included, and nothing on the page reads it — so it was the
			   warehouse's table names handed to every reader of a report, for
			   no purpose. Where the sources genuinely need naming, that is
			   Report Configuration, and it is Super Admin only: see
			   reportsources.go. */
			// The page draws `panels`, not `dimensions` — the visuals in the order
			// and at the widths this platform is configured for. `dimensions` is
			// still here because the panel list references it by key.
			"kpiTiles": kpiTilesFor(extras),
			"panels":   sectionPanels(p.Key, clientID, dims, rolesForPlatform(p), kpiTilesFor(extras)),
		})
	}

	// The summary is a virtual platform over everything above it, so it is added
	// here rather than stored — and it leads the list, because it is the sheet a
	// reader opens first. A configured platform keyed "summary" replaces it.
	if summaryIsBuiltIn() {
		if sec, ok := summarySection(visible, clientID); ok {
			out = append([]map[string]any{sec}, out...)
		}
	}

	OK(w, map[string]any{"success": true, "sections": out, "configured": reportsBackendReady()})
}

/*
sectionDimensions is a platform's breakdown panels: the union across its tables,
in the canonical reading order.

Deduped by LABEL as well as by key. Several dimensions exist twice in the
registry because the warehouse spells the same thing two ways — InfringementType
on one table, InfringementTypeId on another — and a platform whose tables have
both would otherwise show the reader two panels with the same title.

Shared with the layout endpoints, so the panel list an admin arranges is exactly
the panel list the report draws.
*/
func sectionDimensions(p platformDef) []map[string]any {
	specs, _ := specsForPlatform(p)
	dimSeen := map[string]bool{}
	labelSeen := map[string]bool{}
	dims := []map[string]any{}
	for _, sp := range specs {
		for _, d := range sp.Dimensions {
			if dimSeen[d.Key] || labelSeen[d.Label] {
				continue
			}
			dimSeen[d.Key] = true
			labelSeen[d.Label] = true
			viz := d.Viz
			if viz == "" {
				viz = "bars"
			}
			dims = append(dims, map[string]any{"key": d.Key, "label": d.Label, "viz": viz})
		}
	}
	// Panels are collected table by table but read as one page, so they are put
	// back into the canonical order — see dimensionRank.
	sort.SliceStable(dims, func(i, j int) bool {
		return rankOfDim(strFromAny(dims[i]["key"])) < rankOfDim(strFromAny(dims[j]["key"]))
	})

	/* How the CHANNELS compare, where a platform covers more than one.

	   Summary - Sports adds up the open web, social media, Telegram and the app
	   stores, and the first question anyone asks of it is which of those the
	   infringements are in. Nothing else on the page answers that: every other
	   panel is the merged total, so the split the report exists to summarise is
	   the one thing it did not show.

	   Synthetic — there is no column to GROUP BY. Each row is one channel's own
	   identified and removed figures, which runPlatform already computes per
	   table on its way to the merged KPI band, so the panel costs no extra query.

	   Only with two or more channels: on a single-channel platform it would be
	   one bar equal to the KPI tile above it. Placed FIRST among the breakdowns
	   because it is the panel the rest are read through. */
	if len(sourceChannelsFor(p)) > 1 {
		dims = append([]map[string]any{{
			"key":   dimSourcePlatform,
			"label": "Identification & Removal basis Platform",
			"viz":   "column",
		}}, dims...)
	}
	return dims
}

/**
 * lookupReport says, per id-based dimension, whether its lookup resolves — and
 * when it does not, what columns that lookup table actually has.
 *
 * An id column is only readable through its lookup, so "Genre shows GUIDs" and
 * "Genre failed to load" both come down to one question: what is the name column
 * called on this warehouse? Listing the candidate table's columns answers it
 * here instead of sending someone to DESCRIBE it by hand.
 */
func lookupReport(sp reportSpec) []map[string]any {
	out := []map[string]any{}
	for _, d := range sp.Dimensions {
		cand, ok := lookupCandidateFor(d.Key)
		if !ok {
			continue
		}
		shape := tableShapeOf(cand.Table)
		usable := shape.has(cand.IDCol) && shape.has(cand.NameCol)
		row := map[string]any{
			"dimension": d.Key, "table": cand.Table,
			"idColumn": cand.IDCol, "nameColumn": cand.NameCol, "usable": usable,
		}
		if !usable {
			if shape.Err != "" {
				row["error"] = shape.Err
			}
			names := make([]string, 0, len(shape.Columns))
			for _, c := range shape.Columns {
				names = append(names, c)
			}
			sort.Strings(names)
			// The whole point: the name to use instead is in this list.
			row["availableColumns"] = names
		}
		out = append(out, row)
	}
	return out
}

/*
── GET /api/reports/spec-check?type= ────────────────────────────────────────

	Column names in the registry come from the source project's SQL, not from the
	live warehouse. This compares a spec against information_schema and names the
	columns that do not exist, which turns "empty panel" into a specific fix.
*/
func ReportsSpecCheck(w http.ResponseWriter, r *http.Request) {
	/* This is the diagnostic that names every table behind a report and every
	   column the engine looked for in it. It is the most complete disclosure of
	   the warehouse's shape the portal can make, so it goes no further than the
	   people who may see that shape at all. */
	if !requireWarehouseNames(w, r) {
		return
	}
	key := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("type")))
	p, ok := platformByKey(key)
	if !ok && key == summaryKey && summaryIsBuiltIn() {
		// The summary has no tables of its own; checking it means checking every
		// table it reads, which is every table behind the platforms it covers.
		p = platformDef{Key: summaryKey, Label: summaryLabel}
		for _, sub := range summaryPlatforms(ClaimsFrom(r)) {
			p.Tables = append(p.Tables, sub.Tables...)
		}
		p.Tables = uniqueStrings(p.Tables)
		ok = true
	}
	if !ok {
		Fail(w, 422, "Unknown platform: "+key)
		return
	}
	if !db.ReportsConfigured() {
		reportsUnavailable(w, fmt.Errorf("reports database is not configured"))
		return
	}

	tables := []map[string]any{}
	for _, t := range p.Tables {
		entry := map[string]any{"table": t}
		shape := tableShapeOf(t)
		if shape.Err != "" {
			entry["error"] = shape.Err
		}
		entry["tableExists"] = len(shape.Columns) > 0
		entry["columnCount"] = len(shape.Columns)
		if sp, usable := inferSpec(p.Key, p.Label, t); usable {
			entry["usable"] = true
			entry["clientCol"] = sp.ClientCol
			entry["dateCol"] = sp.DateCol
			entry["identExpr"] = sp.IdentExpr
			entry["removedExpr"] = sp.RemovedExpr
			// The extra KPIs are the ones that turn up as a bare 0 when the
			// column exists but the warehouse fills it differently than the
			// expression assumes — ChannelStatus not literally containing
			// "Suspend", ViewsSaved left NULL. Reporting the expression makes
			// "why is this zero" answerable without reading the source.
			entry["extraKpi"] = sp.ExtraKPI
			cols := []string{}
			for _, d := range sp.Dimensions {
				cols = append(cols, d.Column)
			}
			sort.Strings(cols)
			entry["dimensionColumns"] = cols
			entry["lookups"] = lookupReport(sp)
		} else {
			entry["usable"] = false
		}
		tables = append(tables, entry)
	}

	OK(w, map[string]any{"success": true, "platform": key, "label": p.Label, "tables": tables})
}

// specWhere builds one spec's WHERE clause and its bound arguments.
//
// Every value is a bound parameter; only the column names are interpolated, and
// those come from the spec — a request cannot introduce a column of its own,
// because a parameter it does not declare is simply ignored here.
func specWhere(s reportSpec, q map[string]string) (string, []any) {
	conds := []string{s.ClientCol + " = ?"}
	args := []any{strings.TrimSpace(q["clientId"])}

	if from, to := strings.TrimSpace(q["from"]), strings.TrimSpace(q["to"]); from != "" && to != "" {
		conds = append(conds, fmt.Sprintf("DATE(%s) BETWEEN ? AND ?", s.DateCol))
		args = append(args, from, to)
	}
	params := make([]string, 0, len(s.Filters))
	for param := range s.Filters {
		params = append(params, param)
	}
	sort.Strings(params)
	for _, param := range params {
		if v := strings.TrimSpace(q[param]); v != "" {
			conds = append(conds, s.Filters[param]+" = ?")
			args = append(args, v)
		}
	}
	return "WHERE " + strings.Join(conds, " AND "), args
}

// previousWindow returns the window of the same length ending the day before
// [from,to] starts — what "vs previous period" on a KPI tile is measured
// against. Both dates are YYYY-MM-DD.
//
// Same LENGTH, not the same calendar month: the reader picks arbitrary windows
// here, and a 13-day window compared against a full month would report a fall
// that is only the two windows being different sizes.
//
// ok is false when either end is missing or unparseable, which is the honest
// answer for an unbounded request — there is no "previous" to a window with no
// start, and the tiles then render without a delta rather than with a made-up
// one.
func previousWindow(from, to string) (string, string, bool) {
	f, errF := time.Parse("2006-01-02", strings.TrimSpace(from))
	t, errT := time.Parse("2006-01-02", strings.TrimSpace(to))
	if errF != nil || errT != nil || t.Before(f) {
		return "", "", false
	}
	days := int(t.Sub(f).Hours()/24) + 1 // inclusive of both ends
	prevTo := f.AddDate(0, 0, -1)
	prevFrom := prevTo.AddDate(0, 0, -(days - 1))
	return prevFrom.Format("2006-01-02"), prevTo.Format("2006-01-02"), true
}

// specHonoursFilters answers whether a spec can apply every slicer the request
// set. A table that has no Platform column cannot answer "only Instagram" — it
// would return its full, unfiltered total instead, which then gets added to a
// number the reader believes is Instagram-only. So the caller drops it rather
// than mixing filtered and unfiltered rows in one figure.
func specHonoursFilters(s reportSpec, q map[string]string) bool {
	for _, param := range knownFilterParams {
		if strings.TrimSpace(q[param]) == "" {
			continue
		}
		if s.Filters[param] == "" {
			return false
		}
	}
	return true
}

// runSpec executes one section and returns the payload the page renders.
func runSpec(s reportSpec, q map[string]string, bg bool) map[string]any {
	/* Same section, same returned shape, different source. Everything above
	   this — the merging in runPlatform, the summary, the layout — reads the
	   map this returns and cannot tell which path produced it. See
	   reportsapi_bridge.go. */
	if reportsViaAPI() {
		return runSpecViaAPI(s, q, bg)
	}

	where, args := specWhere(s, q)

	// One bad column must not cost the whole report — but a silently empty
	// report is worse than a slow one, so the first failure is reported back and
	// the page surfaces it.
	var firstErr string
	failed := 0
	run := func(sqlStr string) []map[string]any {
		rows, err := db.ReportsQuery(sqlStr, args...)
		if err != nil {
			failed++
			if firstErr == "" {
				firstErr = err.Error()
			}
			return nil
		}
		return rows
	}

	// ── KPI ──────────────────────────────────────────────────────────────────
	sel := []string{
		s.IdentExpr + " AS identified",
		s.RemovedExpr + " AS removed",
	}
	if s.DelistedExpr != "" {
		sel = append(sel, s.DelistedExpr+" AS delisted")
	}
	extraNames := make([]string, 0, len(s.ExtraKPI))
	for name := range s.ExtraKPI {
		extraNames = append(extraNames, name)
	}
	sort.Strings(extraNames)
	for _, name := range extraNames {
		sel = append(sel, s.ExtraKPI[name]+" AS "+name)
	}
	kpiRow := firstRow(run("SELECT " + strings.Join(sel, ", ") + " FROM " + s.Table + " " + where))

	ident := numOf(kpiRow["identified"])
	removed := numOf(kpiRow["removed"])
	pct := 0.0
	if ident > 0 {
		pct = float64(removed) / float64(ident) * 100
	}
	kpi := map[string]any{
		"identified": ident, "removed": removed,
		"pending":    max64(0, ident-removed),
		"removalPct": roundTo(pct, 2),
	}
	for _, name := range extraNames {
		kpi[name] = numOf(kpiRow[name])
	}
	if s.DelistedExpr != "" {
		kpi["delisted"] = numOf(kpiRow["delisted"])
	}

	// ── The same measures over the preceding window ──────────────────────────
	// So a tile can say what its figure DID as well as what it is. The identical
	// SELECT against the identical filters, over previousWindow() — the only
	// thing that changes is the pair of bound dates, which is what makes the two
	// figures comparable.
	//
	// Deliberately not counted in `failed`: a report whose deltas could not be
	// read is still a complete report, and warning that "1 of this report's
	// queries failed" over a comparison figure would send someone looking for
	// missing data that is all present. It just renders without deltas.
	var kpiPrev map[string]any
	if pFrom, pTo, ok := previousWindow(q["from"], q["to"]); ok {
		pq := make(map[string]string, len(q))
		for k, v := range q {
			pq[k] = v
		}
		pq["from"], pq["to"] = pFrom, pTo
		pWhere, pArgs := specWhere(s, pq)
		if rows, err := db.ReportsQuery(
			"SELECT "+strings.Join(sel, ", ")+" FROM "+s.Table+" "+pWhere, pArgs...); err == nil {
			prevRow := firstRow(rows)
			pIdent := numOf(prevRow["identified"])
			pRemoved := numOf(prevRow["removed"])
			pPct := 0.0
			if pIdent > 0 {
				pPct = float64(pRemoved) / float64(pIdent) * 100
			}
			kpiPrev = map[string]any{
				"identified": pIdent, "removed": pRemoved,
				"pending":    max64(0, pIdent-pRemoved),
				"removalPct": roundTo(pPct, 2),
				// The window itself, so the page can name what it compared
				// against instead of asserting a vague "previous period".
				"from": pFrom, "to": pTo,
			}
			for _, name := range extraNames {
				kpiPrev[name] = numOf(prevRow[name])
			}
			if s.DelistedExpr != "" {
				kpiPrev["delisted"] = numOf(prevRow["delisted"])
			}
		}
	}

	// ── Daily trend ──────────────────────────────────────────────────────────
	// The linking side carries a third series: links search engines have dropped,
	// which moves independently of pages taken down.
	delistedSel, delistedKey := "", []string{}
	if s.DelistedExpr != "" {
		delistedSel = ", " + s.DelistedExpr + " AS delisted"
		delistedKey = []string{"delisted"}
	}
	daily := mapRows(run(fmt.Sprintf(
		`SELECT DATE(%s) AS date, %s AS urls, %s AS removed%s
		   FROM %s %s GROUP BY DATE(%s) ORDER BY date ASC`,
		s.DateCol, s.IdentExpr, s.RemovedExpr, delistedSel, s.Table, where, s.DateCol)),
		append([]string{"date", "urls", "removed"}, delistedKey...)...)

	// ── Dimensions ───────────────────────────────────────────────────────────
	breakdowns := map[string]any{}
	for _, d := range s.Dimensions {
		// A synthetic panel has no grouping column — its rows are assembled by
		// the caller from figures the queries above already returned.
		if d.Column == "" {
			continue
		}
		limit := ""
		if d.Limit > 0 {
			limit = fmt.Sprintf(" LIMIT %d", d.Limit)
		}
		// A panel may count something other than the section's own measure.
		identExpr, removedExpr := s.IdentExpr, s.RemovedExpr
		if d.IdentOverride != "" {
			identExpr, removedExpr = d.IdentOverride, d.RemovedOverride
			if removedExpr == "" {
				removedExpr = "0"
			}
		}

		var rows []map[string]any
		if d.LookupTable != "" {
			// Group by the readable name, keeping the id as the value a click
			// filters on. COALESCE falls back to the id when the lookup misses,
			// so a row is never dropped just because a reference is dangling.
			//
			// The WHERE was built against unqualified columns, so the base table
			// is aliased `t` and the predicate re-qualified — otherwise a column
			// present in both tables would be ambiguous.
			w := strings.ReplaceAll(where, s.ClientCol, "t."+s.ClientCol)
			w = strings.ReplaceAll(w, "DATE("+s.DateCol+")", "DATE(t."+s.DateCol+")")
			rows = run(fmt.Sprintf(
				`SELECT COALESCE(lk.%s, t.%s, 'Unknown') AS label,
				        t.%s AS value, %s AS urls, %s AS removed
				   FROM %s t
				   LEFT JOIN %s lk ON lk.%s = t.%s
				  %s AND t.%s IS NOT NULL AND t.%s != ''
				  GROUP BY label, t.%s ORDER BY urls DESC%s`,
				d.LookupName, d.Column,
				d.Column, qualifyExpr(identExpr, "t"), qualifyExpr(removedExpr, "t"),
				s.Table,
				d.LookupTable, d.LookupIDCol, d.Column,
				w, d.Column, d.Column,
				d.Column, limit))
			breakdowns[d.Key] = sortedDimRows(d.Key, rows)
			continue
		}

		// `value` is emitted even here, where it is the same string as the label.
		// Every breakdown row then carries the exact value its slicer filters on,
		// and the page never has to fall back to the label — a fallback that, for
		// an id-based dimension, quietly filters by the asset's NAME and returns
		// a report full of zeroes with no error anywhere to explain it.
		rows = run(fmt.Sprintf(
			`SELECT COALESCE(%s,'Unknown') AS label, COALESCE(%s,'Unknown') AS value,
			        %s AS urls, %s AS removed
			   FROM %s %s AND %s IS NOT NULL AND %s != ''
			  GROUP BY %s ORDER BY urls DESC%s`,
			d.Column, d.Column, identExpr, removedExpr,
			s.Table, where, d.Column, d.Column, d.Column, limit))
		breakdowns[d.Key] = sortedDimRows(d.Key, rows)
	}

	out := map[string]any{
		"ok": true, "available": true, "type": s.Key, "label": s.Label,
		"kpi": kpi, "daily": daily, "breakdowns": breakdowns,
		"table": s.Table, "role": s.Role, "roleLabel": s.RoleLabel,
	}
	// Absent rather than zeroed when there was no window to compare against —
	// the page reads "no previous figures" off its absence, and a block of
	// zeroes would instead read as "everything fell to nothing".
	if kpiPrev != nil {
		out["kpiPrev"] = kpiPrev
	}
	if failed > 0 {
		out["queryWarning"] = fmt.Sprintf("%d of this report's queries failed against %s: %s",
			failed, s.Table, firstErr)
	}
	return out
}

// mergeSpecOptions lists every slicer's values across a set of tables.
//
// A platform reads several tables and the summary reads several platforms, so
// both need the union: a value belongs in a slicer if ANY table in scope has it,
// and the client list is keyed by id with the first readable name winning — one
// table may carry ClientName while another holds only the id.
// q carries the scope the slicers are listed under — the window and the other
// active filters, exactly as the report itself is run — so a value with nothing
// behind it never reaches the dropdown.
func mergeSpecOptions(specs []reportSpec, clientID string, q map[string]string) map[string]any {
	// The slicer values, from breakdowns rather than DISTINCT queries — see
	// mergeSpecOptionsViaAPI for why that is the same question.
	if reportsViaAPI() {
		return mergeSpecOptionsViaAPI(specs, clientID, q)
	}

	out := map[string]any{"ok": true, "available": true}
	clients := map[string]string{}
	merged := map[string]map[string]bool{}

	for _, sp := range specs {
		part := optionsForSpec(sp, clientID, q)
		for _, c := range asRows(part["clients"]) {
			id := strFromAny(c["id"])
			if id == "" {
				continue
			}
			name := strFromAny(c["name"])
			if cur, seen := clients[id]; !seen || cur == id {
				clients[id] = name
			}
		}
		for k, v := range part {
			if k == "clients" || k == "ok" || k == "available" {
				continue
			}
			if merged[k] == nil {
				merged[k] = map[string]bool{}
			}
			switch vals := v.(type) {
			case []string:
				for _, sv := range vals {
					merged[k][sv] = true
				}
			case []map[string]any:
				for _, row := range vals {
					if id := strFromAny(row["id"]); id != "" {
						merged[k][id] = true
					}
				}
			}
		}
	}

	clientList := make([]map[string]any, 0, len(clients))
	for id, name := range clients {
		if name == "" {
			name = id
		}
		clientList = append(clientList, map[string]any{"id": id, "name": name})
	}
	sort.Slice(clientList, func(i, j int) bool {
		return strFromAny(clientList[i]["name"]) < strFromAny(clientList[j]["name"])
	})
	out["clients"] = clientList
	for k, set := range merged {
		vals := make([]string, 0, len(set))
		for v := range set {
			vals = append(vals, v)
		}
		sort.Strings(vals)
		out[k] = vals
	}
	return out
}

// optionsForSpec lists the distinct values behind each of a section's slicers.
/*
optionScope is the WHERE a slicer's values are listed under, as a suffix.

The same scope the REPORT runs under — client, window and every other active
slicer — because a value that yields nothing is not a value worth offering: pick
it and the page empties, with nothing on it to say the choice was never
available. `except` leaves this parameter's own value out, so choosing one does
not reduce its own list to the one already chosen.

`prefix` qualifies the columns ("t.") for the queries that join a lookup, where
a bare column name can be ambiguous.
*/
func optionScope(s reportSpec, q map[string]string, except, prefix string) (string, []any) {
	conds := []string{}
	args := []any{}

	if c := strings.TrimSpace(q["clientId"]); c != "" {
		conds = append(conds, prefix+s.ClientCol+" = ?")
		args = append(args, c)
	}
	if from, to := strings.TrimSpace(q["from"]), strings.TrimSpace(q["to"]); from != "" && to != "" {
		conds = append(conds, fmt.Sprintf("DATE(%s%s) BETWEEN ? AND ?", prefix, s.DateCol))
		args = append(args, from, to)
	}

	params := make([]string, 0, len(s.Filters))
	for param := range s.Filters {
		params = append(params, param)
	}
	sort.Strings(params)
	for _, param := range params {
		if param == except {
			continue
		}
		if v := strings.TrimSpace(q[param]); v != "" {
			conds = append(conds, prefix+s.Filters[param]+" = ?")
			args = append(args, v)
		}
	}
	if len(conds) == 0 {
		return "", nil
	}
	return " AND " + strings.Join(conds, " AND "), args
}

func optionsForSpec(s reportSpec, clientID string, q map[string]string) map[string]any {
	out := map[string]any{}

	out["clients"] = idNamePairs(clientOptions(s))

	// Slicers whose column is an id have a readable name somewhere, and the
	// dimension that draws the same column has already said where: its lookup
	// table. Reusing it means the Language slicer lists the same names its panel
	// does instead of the GUIDs stored on the row.
	lookups := map[string]dimension{}
	for _, d := range s.Dimensions {
		if d.LookupTable == "" {
			continue
		}
		if p := DIMFilterParam(d.Key); p != "" {
			lookups[p] = d
		}
	}

	params := make([]string, 0, len(s.Filters))
	for param := range s.Filters {
		params = append(params, param)
	}
	sort.Strings(params)
	for _, param := range params {
		col := s.Filters[param]

		// Rebuilt per parameter: each list is scoped by every filter EXCEPT its
		// own, so the scope is not one value shared across the loop.
		// Identical values in identical order; only the column prefix differs,
		// so the one set of arguments serves both forms.
		scope, scopeArgs := optionScope(s, q, param, "")
		scopeT, _ := optionScope(s, q, param, "t.")

		if d, ok := lookups[param]; ok {
			rows, err := db.ReportsQuery(fmt.Sprintf(
				`SELECT DISTINCT t.%s AS id, COALESCE(lk.%s, t.%s) AS name
				   FROM %s t
				   LEFT JOIN %s lk ON lk.%s = t.%s
				  WHERE t.%s IS NOT NULL AND t.%s != ''%s
				  ORDER BY name LIMIT 500`,
				col, d.LookupName, col, s.Table, d.LookupTable, d.LookupIDCol, col, col, col, scopeT), scopeArgs...)
			if err == nil && len(rows) > 0 {
				out[param] = idNamePairs(rows)
				continue
			}
			// Fall through: a dangling lookup must not empty the slicer.
		}

		// The asset slicer is ids in the warehouse; show names where we can.
		if param == "assetId" && s.JoinAssetMaster {
			rows, err := db.ReportsQuery(fmt.Sprintf(
				`SELECT DISTINCT t.%s AS id, COALESCE(a.AssetName, t.%s) AS name
				   FROM %s t
				   LEFT JOIN mediascan.Asset a ON a.Id = t.%s
				  WHERE t.%s IS NOT NULL AND t.%s != ''%s
				  ORDER BY name LIMIT 500`,
				col, col, s.Table, col, col, col, scopeT), scopeArgs...)
			if err == nil && len(rows) > 0 {
				out[param] = idNamePairs(rows)
				continue
			}
			// Fall through to plain ids if the operational schema is unreachable.
		}

		rows, err := db.ReportsQuery(fmt.Sprintf(
			`SELECT DISTINCT %s AS v FROM %s WHERE %s IS NOT NULL AND %s != ''%s ORDER BY v LIMIT 300`,
			col, s.Table, col, col, scope), scopeArgs...)
		if err != nil {
			out[param] = []string{}
			continue
		}
		out[param] = flatten(rows, "v")
	}
	return out
}

/**
 * clientOptions lists the clients present in a report's table, with names.
 *
 * Three sources, in order: a ClientName column on the table itself; a join to
 * mediascan.ClientMaster for the pre-aggregated tables that carry only an id;
 * and finally bare ids, so a slicer is never empty just because the operational
 * schema is out of reach.
 */
func clientOptions(s reportSpec) []map[string]any {
	if s.ClientNameCol != "" {
		rows, err := db.ReportsQuery(fmt.Sprintf(
			`SELECT DISTINCT %s AS id, %s AS name FROM %s
			  WHERE %s IS NOT NULL AND %s != '' AND %s IS NOT NULL AND %s != ''
			  ORDER BY name LIMIT 500`,
			s.ClientCol, s.ClientNameCol, s.Table,
			s.ClientCol, s.ClientCol, s.ClientNameCol, s.ClientNameCol))
		if err == nil && len(rows) > 0 {
			return rows
		}
	}
	if s.JoinClientMaster {
		rows, err := db.ReportsQuery(fmt.Sprintf(
			`SELECT DISTINCT t.%s AS id, COALESCE(cm.CompanyName, t.%s) AS name
			   FROM %s t
			   LEFT JOIN mediascan.ClientMaster cm ON cm.Id = t.%s
			  WHERE t.%s IS NOT NULL AND t.%s != ''
			  ORDER BY name LIMIT 500`,
			s.ClientCol, s.ClientCol, s.Table, s.ClientCol, s.ClientCol, s.ClientCol))
		if err == nil && len(rows) > 0 {
			return rows
		}
	}
	rows, err := db.ReportsQuery(fmt.Sprintf(
		`SELECT DISTINCT %s AS id, %s AS name FROM %s
		  WHERE %s IS NOT NULL AND %s != '' ORDER BY id LIMIT 500`,
		s.ClientCol, s.ClientCol, s.Table, s.ClientCol, s.ClientCol))
	if err != nil {
		return nil
	}
	return rows
}

func splitTable(qualified string) (schema, table string) {
	parts := strings.SplitN(strings.ReplaceAll(qualified, "`", ""), ".", 2)
	if len(parts) == 2 {
		return parts[0], parts[1]
	}
	return "dashboards", parts[0]
}

func uniqueStrings(in []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(in))
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

func max64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

// qualifyExpr prefixes bare column references in a measure expression with a
// table alias, so an expression written for a single-table query still works
// inside a join. Only the column names this project generates are handled —
// anything already qualified is left alone.
func qualifyExpr(expr, alias string) string {
	for _, col := range []string{
		"TotalInfringements", "TotalRemoved", "IdentifiedCount", "RemovedCount",
		"TotalCount", "IsRemoved", "RemovalStatus", "NoticeCount",
		"IsGoogleDelisted", "IsBingDelisted",
	} {
		if strings.Contains(expr, alias+"."+col) {
			continue
		}
		expr = strings.ReplaceAll(expr, col, alias+"."+col)
	}
	return expr
}
