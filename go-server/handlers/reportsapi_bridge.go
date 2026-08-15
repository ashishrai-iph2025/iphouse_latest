package handlers

// Reading the reports through reports_api instead of the warehouse.
//
// Set REPORTS_API_URL and the portal stops holding analytics credentials: the
// three places the report engine touched the warehouse are served over HTTP
// instead, and everything above them — the platform registry, the layout, the
// access checks, the merging of several tables into one platform — is unchanged
// and does not know the difference.
//
// The three seams:
//
//	tableShapeOf   what columns a table has. The engine INFERS each spec from
//	               the schema, so without this nothing resolves at all and every
//	               platform reports "none of this platform's tables can be read".
//	runSpec        one table's KPI band, trend and breakdown panels.
//	mergeSpecOptions  the slicer values.
//
// Unset REPORTS_API_URL and none of this runs. The direct-to-warehouse path is
// untouched and remains the default, so this is reversible by deleting one
// environment variable.

import (
	"context"
	"fmt"
	"net/url"
	"sort"
	"strings"

	"github.com/ip-house/iphouse-api/db"
	"github.com/ip-house/iphouse-api/reportsapi"
)

// reportsViaAPI is the single switch. Read in each seam rather than cached in a
// package variable, so the mode is decided by configuration at the moment of
// use and a test can set it without a restart.
func reportsViaAPI() bool { return reportsapi.Configured() }

/*
maxAPIBreakdownRows is the ceiling reports_api puts on one breakdown.

Named here because exceeding it is a 422, and a 422 on a slicer query does not
look like an error to a reader — it looks like a slicer with nothing in it.
Keep this at or below the service's own maximum.
*/
const maxAPIBreakdownRows = 200

/*
reportsBackendReady reports whether the engine has SOMETHING to read from.

The gates on the report endpoints used to ask "are warehouse credentials set",
because that was the only possible source. Two sources exist now, and asking the
old question of an install that reads through the API answers "no" and shows the
reader "Reports are temporarily unavailable" while the API sits there answering
perfectly well.
*/
func reportsBackendReady() bool { return reportsViaAPI() || db.ReportsConfigured() }

/*
apiMeasure translates the portal's KPI names into reports_api measure keys.

They differ because they were named at different times for different readers:
the portal's tiles are labelled for a client ("impacted subscribers"), the API's
measures are named for what the column holds ("subscribers"). Rather than rename
either — one would break saved layouts, the other an API in use — the mapping is
written here, once.

A name with NO entry is left absent from the KPI band rather than filled with a
zero. Absent renders as "—", which is the truth: this table does not record it.
A zero would be read as "it happened nothing times".
*/
var apiMeasure = map[string]string{
	"identified":          "identified",
	"removed":             "removed",
	"delisted":            "delisted",
	"googleDelisted":      "googleDelisted",
	"bingDelisted":        "bingDelisted",
	"totalDomains":        "domains",
	"totalAssets":         "assets",
	"totalChannels":       "channels",
	"channelsSuspended":   "channelsSuspended",
	"views":               "views",
	"viewsSaved":          "viewsSaved",
	"impactedSubscribers": "subscribers",
	"likes":               "likes",
	"comments":            "comments",
	"crawled":             "crawled",
	"notices":             "noticesSent",
	// impactedTraffic has no counterpart: no dataset sums a traffic column, so
	// the tile stays empty rather than claiming a number nothing produced.
}

/*
apiTableShape answers "what columns does this table have" from the catalogue.

reports_api already reports each dataset's column list, so the schema lookup the
engine used to make against information_schema becomes a map read. The list is
the API's OWN column list, which is narrower than the physical table — it is
what the service will actually return — and that is the right answer here: a
spec inferred from a column the API does not serve would produce a panel that is
permanently empty.
*/
func apiTableShape(table string) tableShape {
	shape := tableShape{Table: table, Columns: map[string]string{}}
	c := reportsapi.Get()

	/* The catalogue is fetched FIRST, and its failure is reported as its own
	   thing.

	   Both failures used to say "this table is not one of the datasets
	   reports_api serves", which is a precise and confident sentence about the
	   wrong problem: when the service cannot be reached at all, EVERY table says
	   it, and the reader goes looking for a missing dataset instead of a
	   connection. The two now read differently because they are fixed
	   differently. */
	if _, err := c.Catalog(context.Background()); err != nil {
		shape.Err = fmt.Sprintf("cannot reach reports_api at %s — %v", c.BaseURL(), err)
		return shape
	}

	ds, ok := c.ByTable(context.Background(), table)
	if !ok {
		shape.Err = fmt.Sprintf(
			"%s is not one of the datasets reports_api serves — see GET /v1/sports/datasets at %s",
			table, c.BaseURL())
		return shape
	}
	for _, col := range ds.Columns {
		shape.Columns[strings.ToLower(col)] = col
	}
	return shape
}

/*
apiTableList is the set of tables a platform may be pointed at.

In API mode this is not "every table in the warehouse" — it is every table
reports_api will answer for, which is a NARROWER and more useful list. The old
picker offered all two thousand tables in the server, including the ones no
report could ever read; choosing one of those produced a platform that saved
cleanly and then failed at read time. Here the registry is the allowlist, so an
option that appears is an option that works.
*/
func apiTableList() ([]map[string]any, error) {
	sets, err := reportsapi.Get().Catalog(context.Background())
	if err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0, len(sets))
	for _, d := range sets {
		out = append(out, map[string]any{
			"name": d.Table,
			// What the API calls it, so the picker can say "Sports Telegram"
			// beside the table name rather than only the table name.
			"label":   d.Label,
			"dataset": d.Key,
			"group":   d.Group,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		return strFromAny(out[i]["name"]) < strFromAny(out[j]["name"])
	})
	return out, nil
}

// apiTableColumns is one table's column list, from the same catalogue the
// inference reads. No data TYPES: the API reports the columns it will return,
// not the warehouse's declarations, and inventing a type here would be a fact
// this service does not have.
func apiTableColumns(table string) ([]map[string]any, bool) {
	ds, ok := reportsapi.Get().ByTable(context.Background(), table)
	if !ok {
		return nil, false
	}
	out := make([]map[string]any, 0, len(ds.Columns))
	for _, c := range ds.Columns {
		out = append(out, map[string]any{"name": c, "type": ""})
	}
	return out, true
}

/*
apiScope turns a spec plus the page's query into the parameters reports_api
takes.

Only what the dataset declares is sent. A filter the API does not offer on this
dataset is DROPPED rather than passed through — and that matters: the engine
above already refuses to run a spec that cannot honour an active slicer
(specHonoursFilters), so a filter arriving here that the API will not accept
would otherwise become an unfiltered total added to a filtered figure.
*/
func apiScope(s reportSpec, ds reportsapi.Dataset, q map[string]string) url.Values {
	v := url.Values{}
	v.Set("ClientId", strings.TrimSpace(q["clientId"]))

	from, to := strings.TrimSpace(q["from"]), strings.TrimSpace(q["to"])
	if from != "" && to != "" {
		v.Set(ds.DateFromParam, from)
		v.Set(ds.DateToParam, to)
	}

	// The spec's filters are column-based; the API's are dimension keys.
	for param, col := range s.Filters {
		val := strings.TrimSpace(q[param])
		if val == "" {
			continue
		}
		if key, ok := ds.DimByColumn(col); ok {
			v.Set(key, val)
		}
	}
	return v
}

/*
runSpecViaAPI is runSpec's counterpart: the same section, assembled from three
HTTP calls instead of a dozen queries.

It returns the SAME map — same keys, same types — because everything downstream
(runPlatform's merging, the summary's merging, the page itself) reads that shape
and must not be able to tell which path produced it.
*/
func runSpecViaAPI(s reportSpec, q map[string]string) map[string]any {
	c := reportsapi.Get()
	ctx := context.Background()

	ds, ok := c.ByTable(ctx, s.Table)
	if !ok {
		return map[string]any{
			"ok": false, "available": true, "type": s.Key, "label": s.Label,
			"table": s.Table, "role": s.Role, "roleLabel": s.RoleLabel,
			"error": s.Table + " is not served by reports_api",
		}
	}
	scope := apiScope(s, ds, q)

	var failed int
	var firstErr string
	note := func(err error) {
		failed++
		if firstErr == "" {
			firstErr = err.Error()
		}
	}

	// ── KPI ─────────────────────────────────────────────────────────────────
	kpi := map[string]any{}
	var ident, removed int64
	if sum, err := c.Summary(ctx, ds, scope); err != nil {
		note(err)
	} else {
		ident = numOf(sum["identified"])
		removed = numOf(sum["removed"])
		kpi["identified"] = ident
		kpi["removed"] = removed
		kpi["pending"] = max64(0, ident-removed)
		pct := 0.0
		if ident > 0 {
			pct = float64(removed) / float64(ident) * 100
		}
		kpi["removalPct"] = roundTo(pct, 2)

		// The spec's extra tiles, each only where the dataset actually has it.
		for name := range s.ExtraKPI {
			if m, mapped := apiMeasure[name]; mapped && ds.HasMeasure(m) {
				kpi[name] = numOf(sum[m])
			}
		}
		if s.DelistedExpr != "" && ds.HasMeasure("delisted") {
			kpi["delisted"] = numOf(sum["delisted"])
		}
	}

	// ── Daily trend ─────────────────────────────────────────────────────────
	daily := []map[string]any{}
	if pts, err := c.Timeseries(ctx, ds, scope, "day"); err != nil {
		note(err)
	} else {
		wantDelisted := s.DelistedExpr != "" && ds.HasMeasure("delisted")
		for _, p := range pts {
			row := map[string]any{
				"date":    strFromAny(p["bucket"]),
				"urls":    numOf(p["identified"]),
				"removed": numOf(p["removed"]),
			}
			if wantDelisted {
				row["delisted"] = numOf(p["delisted"])
			}
			daily = append(daily, row)
		}
	}

	// ── Breakdowns ──────────────────────────────────────────────────────────
	breakdowns := map[string]any{}
	for _, d := range s.Dimensions {
		// A synthetic panel has no grouping column; the caller assembles it.
		if d.Column == "" {
			continue
		}
		key, ok := ds.DimByColumn(d.Column)
		if !ok {
			// Not offered by the API on this dataset. An empty panel is the
			// honest result — better than omitting it, which would look like
			// the dimension had no values.
			breakdowns[d.Key] = []map[string]any{}
			continue
		}
		limit := d.Limit
		if limit <= 0 {
			limit = 200
		}
		rows, err := c.Breakdown(ctx, ds, scope, key, limit)
		if err != nil {
			note(err)
			breakdowns[d.Key] = []map[string]any{}
			continue
		}
		out := make([]map[string]any, 0, len(rows))
		for _, r := range rows {
			out = append(out, map[string]any{
				// label is what the reader sees, value is what a click filters
				// on — the same split the panels already expect.
				"label":   strFromAny(r["label"]),
				"value":   strFromAny(r["grp"]),
				"urls":    numOf(r["identified"]),
				"removed": numOf(r["removed"]),
			})
		}
		breakdowns[d.Key] = out
	}

	out := map[string]any{
		"ok": true, "available": true, "type": s.Key, "label": s.Label,
		"kpi": kpi, "daily": daily, "breakdowns": breakdowns,
		"table": s.Table, "role": s.Role, "roleLabel": s.RoleLabel,
	}
	if failed > 0 {
		out["queryWarning"] = fmt.Sprintf("%d of this report's requests to reports_api failed for %s: %s",
			failed, s.Table, firstErr)
	}
	return out
}

/*
mergeSpecOptionsViaAPI lists each slicer's values across a set of tables.

A slicer value is just a breakdown with its measures ignored, so this is the
same call the panels make. Which is the point: the values a slicer offers and
the rows a panel shows come from one query shape, and a value that appears in
one cannot be missing from the other.
*/
func mergeSpecOptionsViaAPI(specs []reportSpec, clientID string) map[string]any {
	c := reportsapi.Get()
	ctx := context.Background()

	/* Keyed by the PARAMETER, exactly as optionsForSpec does it — the page reads
	   `options[param]` for each of the spec's filters, so a pluralised or
	   prettified key here is a slicer that renders empty with nothing to
	   explain why. */
	flat := map[string]map[string]bool{}

	for _, s := range specs {
		ds, ok := c.ByTable(ctx, s.Table)
		if !ok {
			continue
		}
		scope := url.Values{}
		scope.Set("ClientId", clientID)

		for param, col := range s.Filters {
			key, ok := ds.DimByColumn(col)
			if !ok {
				continue
			}
			/* 200 is the API's ceiling for a breakdown, and asking for more is a
			   422 that silently empties every slicer on the page — which is
			   exactly what it did. A slicer showing the 200 commonest values is
			   a usable slicer; one showing none is not. */
			rows, err := c.Breakdown(ctx, ds, scope, key, maxAPIBreakdownRows)
			if err != nil {
				continue
			}
			/* The VALUE, not the label. What the slicer sends must be what this
			   spec's filter compares against: these specs mostly filter on the
			   NAME column (assetId → AssetName), so the grouped value already is
			   the readable name. Sending an id here would filter a name column
			   by a GUID and return nothing, with no error to say so. */
			for _, r := range rows {
				val := strFromAny(r["grp"])
				if val == "" || val == "(none)" {
					continue
				}
				if flat[param] == nil {
					flat[param] = map[string]bool{}
				}
				flat[param][val] = true
			}
		}
	}

	out := map[string]any{"ok": true, "available": true}

	/* The client list comes from its own endpoint, not from the breakdowns.

	   A breakdown is already scoped to one client, so building the list from one
	   could only ever return the client that had already been chosen — which is
	   a picker containing exactly the thing you were trying to change, and an
	   empty one before any choice has been made. That is what "Select client →
	   Nothing matches" was. */
	if list, err := c.Clients(ctx); err == nil {
		out["clients"] = list
	} else {
		/* Fall back to the client in hand rather than to nothing: a staff
		   picker is unusable either way, but a CLIENT login already has its
		   company forced by the server and only needs the name to render. */
		clients := []map[string]any{}
		if clientID != "" {
			clients = append(clients, map[string]any{"id": clientID, "name": clientID})
		}
		out["clients"] = clients
		out["clientsError"] = err.Error()
	}

	for param, set := range flat {
		vals := make([]string, 0, len(set))
		for v := range set {
			vals = append(vals, v)
		}
		sort.Strings(vals)
		out[param] = vals
	}
	return out
}
