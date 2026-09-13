package handlers

/*
VALUES A CLIENT HAS ASKED NOT TO BE REPORTED ON.

A sports client's asset list is not all theirs to talk about. A franchise they no
longer hold, a fixture loaded for a neighbouring region, a title ingested by
mistake: each arrives in the warehouse like any other and lands in every figure
the report prints. Until now the only way to say "not this one" was to change the
data.

This is that way. Three dimensions — franchise, match day, asset — and per client
a list of the values to leave out.

── EXCLUSIONS, NOT INCLUSIONS, AND THAT IS THE WHOLE DESIGN ─────────────────

The stored list is what to HIDE. The obvious alternative — store what to show —
reads the same on the screen and is wrong in a way that only appears weeks later:
new fixtures arrive continuously, and an inclusion list cannot name one that did
not exist when it was saved. Every new match would be invisible until somebody
noticed and ticked it, which is a report that quietly stops covering the season.

An exclusion list has the opposite failure, and it is the harmless one: a value
nobody has hidden is shown. That is also what makes "all selected by default"
true without storing anything at all — a client with no row here gets the report
it has always had, byte for byte.

── WHERE IT IS ENFORCED ─────────────────────────────────────────────────────

Not here. This file stores the lists and hands them over as three query
parameters; the subtraction happens in reports_api, in SQL, at the point the
counting happens — see dimexclude.go there for the predicates and the reason
they are JSON arrays rather than comma-separated lists.

That matters for the requirement behind this feature: every figure has to follow
the setting, not just the panels that group by these columns. A KPI total is a
COUNT over rows, and no amount of post-filtering in the portal can subtract a
hidden fixture from a number the warehouse has already added up. So the list
travels into the WHERE clause, and the KPI band, the daily trend, every
breakdown, the raw rows, the slicer values and the live counts card all narrow
together because they are all built from the same scope.

── PER CLIENT, WITH NO DEFAULT ──────────────────────────────────────────────

Unlike the sports period, there is no shared default to fall back to. What one
client may not be shown is a fact about that client's contract; a value hidden
for everyone would be a statement about the data, and the place to make that
statement is the data. So the table is keyed by client and an absent client
means nothing hidden.
*/

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ip-house/iphouse-api/db"
	"github.com/ip-house/iphouse-api/reportsapi"
)

const dimExclusionTable = "report_dim_exclusions"

// errNoDatabase is what a save answers when the portal's own pool is not up. Its
// own error rather than a nil-pointer panic two lines later.
var errNoDatabase = errors.New("the portal database is not available")

/*
The three dimensions, and the parameter each is sent to the service under.

Keyed by a short stable name rather than by the parameter, because the parameter
is a wire detail and this key is what the configuration screen stores and the
admin API speaks. They are the three the asset master can be narrowed by — see
assetattrs.go in reports_api — and adding a fourth means a column there first.
*/
var dimExclusionParams = map[string]string{
	"franchise": "excludeFranchise",
	"matchDay":  "excludeMatchDay",
	"asset":     "excludeAsset",
}

/*
dimExclusionOrder is the order the screen shows them in, and the order the
parameters are written in.

A fixed slice rather than ranging the map: a url.Values built in map order would
key a cache differently between two identical requests, which is the same reason
reports_api iterates its ExprFilters from a slice.
*/
var dimExclusionOrder = []string{"franchise", "matchDay", "asset"}

/*
dimExclusionLabels name them as the report does.

The screen is arranging the same three things the filter rail offers, and a
configuration page calling them something else is a page nobody can map onto the
report it configures.
*/
var dimExclusionLabels = map[string]string{
	"franchise": "Franchise",
	"matchDay":  "Match Day",
	"asset":     "Asset",
}

func isDimExclusionKey(dim string) bool { _, ok := dimExclusionParams[dim]; return ok }

var dimExclusionOnce sync.Once

func ensureDimExclusionSchema() {
	/* Nothing at all until the portal's own pool is up.

	   The Once is deliberately NOT consumed here: a process that reached this
	   before the database was ready has to be able to create the table once it
	   is, and a Once spent on a no-op would leave it never created. The tests
	   run with no pool and this is the line that keeps them from a nil
	   dereference three frames into database/sql. */
	if !db.Ready() {
		return
	}
	dimExclusionOnce.Do(func() {
		/* One row per hidden value.

		   NO unique key on (client_id, dim, value), deliberately. MySQL's index
		   prefix limit would force one on the first ~191 characters of the
		   value, and franchise names run to 140 already — so two long names
		   sharing a prefix would collide on a constraint nobody would think to
		   look for. A save replaces the whole set for one client and dimension
		   inside a transaction, which is what actually keeps the set distinct. */
		if _, _, err := db.Exec(`
			CREATE TABLE IF NOT EXISTS ` + dimExclusionTable + ` (
			  id         BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
			  client_id  VARCHAR(64)  NOT NULL,
			  dim        VARCHAR(16)  NOT NULL,
			  value      VARCHAR(512) NOT NULL,
			  updated_by VARCHAR(191) NOT NULL DEFAULT '',
			  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
			  KEY idx_client_dim (client_id, dim)
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`); err != nil {
			log.Printf("[dim-exclusions] create %s: %v", dimExclusionTable, err)
		}
	})
}

/*
dimExclusionsFor reads one client's hidden values, by dimension.

FAILS OPEN, and says so in the log. A list that cannot be read must not narrow
anything: the failure would present as figures that have quietly dropped, which
sends somebody to look at the warehouse rather than at this table. An unreadable
exclusion is no exclusion — the same direction the sports period fails in, and
the only safe one for a setting that subtracts.

Not cached. It is one indexed read of the portal's own database against a table
holding tens of rows per client, and a cache here would mean a franchise hidden
this morning still being counted this afternoon — which is precisely the
complaint this feature exists to answer.
*/
func dimExclusionsFor(clientID string) map[string][]string {
	out := map[string][]string{}
	clientID = strings.TrimSpace(clientID)
	if clientID == "" {
		return out
	}
	ensureDimExclusionSchema()
	// And the read itself, for the same reason — db.Query dereferences the pool.
	if !db.Ready() {
		return out
	}
	rows, err := db.Query(
		"SELECT dim, value FROM "+dimExclusionTable+" WHERE client_id = ? ORDER BY dim, value",
		clientID)
	if err != nil {
		log.Printf("[dim-exclusions] read for client=%s: %v — reporting on everything", clientID, err)
		return out
	}
	for _, r := range rows {
		dim := strFromAny(r["dim"])
		val := strFromAny(r["value"])
		if !isDimExclusionKey(dim) || val == "" {
			continue
		}
		out[dim] = append(out[dim], val)
	}
	return out
}

/*
dimExclusionJSON renders one dimension's list as the array the service expects.

Empty for an empty list, and the caller then sends no parameter at all — which
keeps a client with nothing hidden byte-identical to the report served before
this feature existed, cache key included. An unsent filter cannot change a
figure, and that is the property that makes this safe to switch on mid-season.

Sorted, so two saves of the same set produce the same string and therefore the
same cache key.
*/
func dimExclusionJSON(values []string) string {
	clean := make([]string, 0, len(values))
	seen := map[string]bool{}
	for _, v := range values {
		v = strings.TrimSpace(v)
		if v == "" || seen[v] {
			continue
		}
		seen[v] = true
		clean = append(clean, v)
	}
	if len(clean) == 0 {
		return ""
	}
	sort.Strings(clean)
	b, err := json.Marshal(clean)
	if err != nil {
		// Unreachable for a []string, and if it ever were: hide nothing rather
		// than send something the service will refuse.
		log.Printf("[dim-exclusions] encode: %v", err)
		return ""
	}
	return string(b)
}

/*
applyDimExclusions writes a client's exclusions onto an outgoing service query.

The ONE function both roads call. The sports report reaches the warehouse
through the dataset endpoints and the live card through the realtime one; they
share no other code, and a client whose report hid a franchise while the card
above it still counted one would be the two halves of a page disagreeing about
what they are showing.
*/
func applyDimExclusions(v url.Values, clientID string) {
	applyDimExclusionMap(v, dimExclusionsFor(clientID))
}

// applyDimExclusionMap is the half that does no I/O, so a caller that already
// holds the lists — or a test — can use it directly.
func applyDimExclusionMap(v url.Values, ex map[string][]string) {
	for _, dim := range dimExclusionOrder {
		if list := dimExclusionJSON(ex[dim]); list != "" {
			v.Set(dimExclusionParams[dim], list)
		}
	}
}

/*
saveDimExclusions replaces one client's whole set.

REPLACES rather than merges, because the screen sends the whole set: it shows
every value with a checkbox and hands back the ones that are off. A merge would
make unticking impossible — the only way to re-show a value would be a delete
endpoint the screen does not have — and would leave the stored set drifting
further from what the admin is looking at with every save.

In ONE transaction, so a failure halfway does not leave a client with half its
exclusions applied. That state is invisible: the report still renders, just
narrower or wider than anybody chose.
*/
func saveDimExclusions(clientID string, byDim map[string][]string, actor string) error {
	ensureDimExclusionSchema()
	clientID = strings.TrimSpace(clientID)

	pool := db.Get()
	if pool == nil {
		return errNoDatabase
	}
	tx, err := pool.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	for _, dim := range dimExclusionOrder {
		values, sent := byDim[dim]
		if !sent {
			// A dimension the screen did not send is one it was not showing —
			// left exactly as it was rather than silently cleared.
			continue
		}
		if _, err := tx.Exec(
			"DELETE FROM "+dimExclusionTable+" WHERE client_id = ? AND dim = ?",
			clientID, dim); err != nil {
			return err
		}
		seen := map[string]bool{}
		for _, v := range values {
			v = strings.TrimSpace(v)
			if v == "" || seen[v] {
				continue
			}
			seen[v] = true
			if _, err := tx.Exec(
				"INSERT INTO "+dimExclusionTable+" (client_id, dim, value, updated_by) VALUES (?, ?, ?, ?)",
				clientID, dim, v, actor); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}

/*
── GET /api/admin/report-dim-exclusions?clientId=… ──────────────────────────

One client's hidden values, by dimension. The VALUES to choose from are not
served here: they are the client's own franchises, fixtures and titles, which
the configuration screen already fetches from the report's own slicer endpoint —
and resolving them here would put a warehouse round trip behind a settings read
and give the screen two lists that could disagree about what exists.
*/
func DimExclusionsGet(w http.ResponseWriter, r *http.Request) {
	clientID := strings.TrimSpace(r.URL.Query().Get("clientId"))
	if clientID == "" {
		Fail(w, 400, "clientId is required")
		return
	}
	writeDimExclusions(w, clientID)
}

/*
── PUT /api/admin/report-dim-exclusions ─────────────────────────────────────

	{"clientId": "...", "hidden": {"franchise": ["Serie A"], "asset": []}}

A dimension present with an empty list clears it; a dimension left out is left
alone. Those are different on purpose — see saveDimExclusions.
*/
func DimExclusionsSave(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ClientID string              `json:"clientId"`
		Hidden   map[string][]string `json:"hidden"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		Fail(w, 400, "Could not read the request")
		return
	}
	if strings.TrimSpace(body.ClientID) == "" {
		Fail(w, 400, "clientId is required")
		return
	}
	for dim := range body.Hidden {
		if !isDimExclusionKey(dim) {
			Fail(w, 400, "Unknown dimension "+dim+" — expected franchise, matchDay or asset")
			return
		}
	}
	who := ""
	if claims := ClaimsFrom(r); claims != nil {
		who = claims.LoginUsername
	}
	if err := saveDimExclusions(body.ClientID, body.Hidden, who); err != nil {
		log.Printf("[dim-exclusions] save for client=%s: %v", body.ClientID, err)
		Fail(w, 500, "Could not save")
		return
	}
	/* Answered from the id in the BODY, not by delegating to the GET handler.

	   Delegating is what this did, and it was wrong in the way that is worst:
	   the GET reads its client from the QUERY STRING, a PUT carries it in the
	   body, so every save committed and then answered "clientId is required".
	   The screen showed a failure over a change that had already been stored —
	   and a reload would show the change the admin had just been told did not
	   happen. */
	writeDimExclusions(w, body.ClientID)
}

// writeDimExclusions is the response both handlers give: one client's hidden
// values, every dimension present. Shared so a save and a read cannot describe
// the same stored set differently.
func writeDimExclusions(w http.ResponseWriter, clientID string) {
	OK(w, map[string]any{
		"clientId": clientID,
		"hidden":   hiddenByDim(dimExclusionsFor(clientID)),
	})
}

/*
── GET /api/admin/report-dim-values?clientId=…&q=… ──────────────────────────

The values there are to choose from, for one client.

WHY THIS IS NOT THE REPORT'S OWN SLICER LISTS. Those are narrowed by the
exclusions — that is the point of the feature — so a franchise would vanish from
the picker the moment it was hidden and there would be no way to put it back.
This reads the asset MASTER, which nothing narrows, so the list is always the
client's whole catalogue and a hidden value is a ticked box rather than an
absent row.

FRANCHISE AND MATCH DAY come back whole, from the master's facets: a DISTINCT
over an indexed client scope, which is a few rows rather than the 47,575 the
largest client's catalogue would cost to collect them from.

ASSETS CANNOT come back whole, for the same reason. So the list is either

	· the titles currently hidden, resolved to their names — what the screen shows
	  when it opens, because those are the ones somebody needs to see and untick,
	· or the matches for a search, which is how more are found.

A client with 47,575 titles has no useful ticked list of all of them, and a
screen that tried to draw one would be a scroll bar with a search box hidden
somewhere in it.
*/
func DimExclusionValues(w http.ResponseWriter, r *http.Request) {
	clientID := strings.TrimSpace(r.URL.Query().Get("clientId"))
	if clientID == "" {
		Fail(w, 400, "clientId is required")
		return
	}
	if !reportsapi.Configured() {
		Fail(w, 503, "No report backend is configured, so the value lists cannot be read")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), dimValuesTimeout)
	defer cancel()

	hidden := dimExclusionsFor(clientID)
	out := map[string]any{
		"clientId": clientID,
		"hidden":   hiddenByDim(hidden),
	}

	/* The two whole lists, from one request. `limit=1` because the ROWS are not
	   wanted — only the facets — and the endpoint will not serve facets without
	   serving a page of the list beside them. */
	q := url.Values{}
	q.Set("ClientMasterId", clientID)
	q.Set("limit", "1")
	q.Set("facets", "FranchiseName,MatchDay")
	var facetBody struct {
		Facets map[string][]any `json:"facets"`
	}
	if err := reportsapi.Get().GetJSON(ctx, "/v1/masters/assets", q, &facetBody); err != nil {
		log.Printf("[dim-exclusions] facets for client=%s: %v", clientID, err)
		Fail(w, 502, "The value lists could not be read")
		return
	}
	out["franchise"] = stringsFromFacet(facetBody.Facets["FranchiseName"])
	out["matchDay"] = stringsFromFacet(facetBody.Facets["MatchDay"])

	/* The titles: a search, or the hidden ones. Both are the same request with a
	   different narrowing, so one code path serves the screen's two states. */
	search := strings.TrimSpace(r.URL.Query().Get("q"))
	aq := url.Values{}
	aq.Set("ClientMasterId", clientID)
	switch {
	case search != "":
		aq.Set("q", search)
		aq.Set("limit", strconv.Itoa(dimValuesSearchLimit))
	case len(hidden["asset"]) > 0:
		/* Comma-joined, and safe: an asset id is a GUID. The same list encoding
		   the exclusions themselves deliberately avoid — see dimExclusionJSON —
		   because there a value can hold a comma and here it cannot. */
		aq.Set("ids", strings.Join(hidden["asset"], ","))
		aq.Set("limit", "all")
	default:
		// Nothing hidden and nothing searched: no titles to draw yet.
		out["assets"] = []map[string]any{}
		OK(w, out)
		return
	}

	var assetBody struct {
		Rows []map[string]any `json:"rows"`
	}
	if err := reportsapi.Get().GetJSON(ctx, "/v1/masters/assets", aq, &assetBody); err != nil {
		log.Printf("[dim-exclusions] titles for client=%s: %v", clientID, err)
		Fail(w, 502, "The title list could not be read")
		return
	}
	assets := make([]map[string]any, 0, len(assetBody.Rows))
	for _, row := range assetBody.Rows {
		id := strFromAny(row["Id"])
		if id == "" {
			continue
		}
		assets = append(assets, map[string]any{
			"id": id, "name": strFromAny(row["AssetName"]),
			// The franchise beside the title, because two fixtures can share a
			// name across competitions and the id is not something to pick by.
			"franchise": strFromAny(row["FranchiseName"]),
		})
	}
	out["assets"] = assets
	out["assetsTruncated"] = search != "" && len(assets) >= dimValuesSearchLimit
	OK(w, out)
}

// dimValuesTimeout bounds the two master reads. Generous — a catalogue read is
// genuinely slow — but bounded, because a configuration screen must not hold a
// portal worker open indefinitely.
const dimValuesTimeout = 45 * time.Second

/*
How many titles a search answers with. Enough that a real search finds what it

	is looking for, few enough that a one-letter query does not return a
	catalogue. The screen says when it has been cut.
*/
const dimValuesSearchLimit = 50

// hiddenByDim fills in the dimensions with nothing hidden, so the screen draws
// three sections rather than however many happen to have rows.
func hiddenByDim(ex map[string][]string) map[string][]string {
	out := map[string][]string{}
	for _, dim := range dimExclusionOrder {
		if ex[dim] == nil {
			out[dim] = []string{}
		} else {
			out[dim] = ex[dim]
		}
	}
	return out
}

// stringsFromFacet reads a facet's values. They arrive as []any through JSON and
// a non-string among them is dropped rather than rendered as its Go formatting.
func stringsFromFacet(vals []any) []string {
	out := make([]string, 0, len(vals))
	for _, v := range vals {
		if s := strings.TrimSpace(strFromAny(v)); s != "" {
			out = append(out, s)
		}
	}
	return out
}
