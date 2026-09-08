package handlers

/*
Which titles a sports report is allowed to name.

── The report this exists for ────────────────────────────────────────────────

	Mobile Apps is a sports report reading an ALL-GENRE table. The unified
	mobile-apps source holds every store listing found for a client — the
	fixtures and the feature films — because a store listing is a store listing
	whatever it infringes. Every other sports report reads a Sports* table, which
	is already narrowed by the ETL that fills it.

	So the Asset slicer on the sports Mobile Apps report offered the client's
	whole catalogue, and the Top 10 Assets panel ranked films beside matches. On a
	client that holds both — which is every broadcaster — a reader picking from
	that dropdown is picking titles the report is not about.

── Why the master, and not a column ─────────────────────────────────────────

	There is no genre on the fact table to filter by. A genre is a property of the
	TITLE, recorded once in mediascan.AssetGenre and never repeated on the rows.
	That is the same shape as FranchiseName and MatchDay, and those reach a report
	because reports_api joins the master onto the four sports tables (see
	internal/api/assetattrs.go in that service). The mobile-apps table is not one
	of the four and carries none of them.

	/v1/masters/assets does carry it. `Genre` on an asset row is a comma-joined
	SET of readable names — Sports, Movies, Television, Originals — an asset can
	be in several, and `Genre=Sports` is a declared filter on that endpoint: an
	EXISTS over AssetGenre rather than a match on the joined string, so a title
	tagged Sports AND Movies is returned by it. That list is what this file reads,
	and the ids in it are the titles a sports report may name.

── Membership from the table, ADMISSIBILITY from the master ─────────────────

	Nothing is ADDED to a slicer here. The list a filter offers is still exactly
	what the table found in the window — see the long note in
	mergeSpecOptionsViaAPI about what filling the Asset slicer from the master
	cost the last time it was tried. This only REMOVES, which is the one
	direction that cannot offer a value the report has no rows for.

── It fails OPEN, every time ────────────────────────────────────────────────

	An unreachable master, a master serving no Genre, a client whose catalogue is
	untagged, or a sports set that matches nothing the table found — each leaves
	every list exactly as it was, with a line in the log.

	Because the two failures are not symmetrical. An Asset slicer holding a few
	titles too many is the report as it read yesterday; an Asset slicer holding
	nothing is indistinguishable from a broken screen, and it would be a
	confident answer given on the strength of a lookup that did not work. The
	same reasoning hiddenTables() uses for the warehouse picker, for the same
	reason.
*/

import (
	"context"
	"fmt"
	"log"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ip-house/iphouse-api/reportsapi"
)

/*
sportsGenreName is the genre a sports report is about, as mediascan.GenreMS
spells it.

The NAME rather than the GenreMSId GUID, because the name is what
/v1/masters/assets filters and facets on — its `Genre` parameter joins GenreMS
and compares `g.Name` — so matching on the id would mean a second lookup to
learn which name the id belongs to before the request could be made at all.
*/
const sportsGenreName = "Sports"

/*
sportsGenreParam is what the REPORT datasets call that filter.

Lowercase, unlike the "Genre" the masters endpoint takes — the two halves of
reports_api spell their parameters differently, masters after the warehouse's
column names and datasets after the dimension keys a breakdown groups by. Named
here beside the value so the two places the portal narrows by genre are read
together: the Asset SLICER, from /v1/masters/assets, and the FIGURES, from this
filter on the dataset.

They must agree about which titles are in the genre, or a report's dropdown and
its totals would be narrowed by two different rules and disagree in a way nothing
on the page could explain. Both resolve to an EXISTS over mediascan.AssetGenre
with ag.Active = 1; see the mobile-apps entry in that service's dataset registry.
*/
const sportsGenreParam = "genre"

/*
sportsAssetTTL is how long one client's sports title list is held.

The same half hour MasterNames holds a lookup for, and for the same reason:
these are the slowest-changing rows in the warehouse — a title's genre is set
when it is registered and effectively never edited — while the list is read on
every change to a slicer or the window. A failure is held for seconds instead,
so a service that comes back does not stay unreachable for half an hour.
*/
const (
	sportsAssetTTL    = 30 * time.Minute
	sportsAssetErrTTL = 15 * time.Second
)

type sportsAssetEntry struct {
	at  time.Time
	ids map[string]bool
	err error
}

var (
	sportsAssetMu    sync.Mutex
	sportsAssetCache = map[string]sportsAssetEntry{}
)

/*
sportsAssetIDs is the client's sports titles, keyed by lower-cased asset id.

Lower-cased on both sides of every comparison, here and at the call sites: an
asset id is a GUID, the master returns whatever case it was stored in, and the
fact tables are not required to agree with it. A set that missed on case would
narrow a slicer to nothing, which is exactly the failure this file promises not
to produce.

An error means "this could not be established" and never "there are none" — see
the fail-open note in the header. Callers must leave their list alone on one.
*/
func sportsAssetIDs(ctx context.Context, clientID string) (map[string]bool, error) {
	clientID = strings.TrimSpace(clientID)
	if clientID == "" {
		return nil, fmt.Errorf("a client is required to read its asset genres")
	}
	sportsAssetMu.Lock()
	if e, ok := sportsAssetCache[clientID]; ok {
		ttl := sportsAssetTTL
		if e.err != nil {
			ttl = sportsAssetErrTTL
		}
		if time.Since(e.at) < ttl {
			sportsAssetMu.Unlock()
			return e.ids, e.err
		}
	}
	sportsAssetMu.Unlock()

	/* Checked AFTER the cache, because a held answer is an answer — this guard
	   exists to avoid a request that cannot be made, not to invalidate one that
	   already was. */
	if !reportsapi.Configured() {
		return nil, fmt.Errorf("no report backend is configured — set REPORTS_API_URL to read the title master")
	}

	ids, err := fetchSportsAssetIDs(ctx, clientID)

	sportsAssetMu.Lock()
	sportsAssetCache[clientID] = sportsAssetEntry{at: time.Now(), ids: ids, err: err}
	sportsAssetMu.Unlock()
	return ids, err
}

/*
fetchSportsAssetIDs asks the title master which of a client's assets are sport.

ONE request answers two questions, which is why the facet rides along:

	rows          the sports titles themselves, cut upstream by the declared
	              `Genre` filter so the warehouse does the narrowing rather than
	              this process.
	facets.Genre  every genre the client's catalogue holds, computed over the
	              whole register and NOT affected by the row filter above (the
	              facet query takes only the client scope — see handleMaster in
	              reports_api).

The facet is what tells an EMPTY answer apart from an answer that could not be
given. "No rows came back" on its own is three different situations wearing one
face: the client has no sports titles, the client's titles carry no genre at all,
or this service is talking to a reports_api old enough to ignore a parameter it
does not recognise rather than refuse it. The facet separates them, and only the
first is a fact about the data.

The Genre column on each row is checked as well, and that is not belt-and-braces.
An older reporting service ignores an unknown parameter silently — the same trap
rowsCarryActive was written for — so a `Genre=Sports` that was never applied
comes back as the client's ENTIRE register, and taking that at face value would
"narrow" the slicer to everything it already had while reporting success.
*/
func fetchSportsAssetIDs(ctx context.Context, clientID string) (map[string]bool, error) {
	q := url.Values{}
	q.Set("ClientMasterId", clientID)
	q.Set("Genre", sportsGenreName)
	// The master caps nothing itself, so asking high means the answer is whole.
	// Same number, same reason, as MasterNames and the programme calendar.
	q.Set("limit", strconv.Itoa(assetsDefaultLimit))
	// The client's whole genre list, in the same round trip.
	q.Set("facets", "Genre")

	body, err := queryAssetMaster(ctx, clientID, q)
	if err != nil {
		return nil, err
	}
	return sportsAssetsFromMaster(body, clientID)
}

/*
sportsAssetsFromMaster reads the id set off one master response.

Split from the request so the decision table above is testable without a
warehouse behind it: every branch here is a way the answer can be unusable, and
each of them is a different sentence rather than a shared "no data".
*/
func sportsAssetsFromMaster(body map[string]any, clientID string) (map[string]bool, error) {
	/* A list that was cut off is not a list. Every title past the cut would be
	   read as "not sport" and dropped from the slicer, which is the one outcome
	   this file must never produce quietly. */
	if cut, _ := body["truncated"].(bool); cut {
		return nil, fmt.Errorf("the title master cut its answer off at %d rows for client %s",
			assetsDefaultLimit, clientID)
	}

	genresHeld := map[string]bool{}
	if facets, ok := body["facets"].(map[string]any); ok {
		for _, g := range assetStringsFrom(facets["Genre"]) {
			genresHeld[strings.ToLower(strings.TrimSpace(g))] = true
		}
	}
	if len(genresHeld) == 0 {
		return nil, fmt.Errorf("the title master reported no genres for client %s", clientID)
	}
	if !genresHeld[strings.ToLower(sportsGenreName)] {
		/* The client's catalogue holds genres and none of them is sport, yet
		   somebody configured a sports report for it. That is a disagreement
		   between the tagging and the configuration, and it is not this code's
		   to settle by emptying every asset list on the report. Reported and
		   left alone. */
		return nil, fmt.Errorf("client %s has no %s titles in the title master (genres held: %s)",
			clientID, sportsGenreName, strings.Join(sortedKeys(genresHeld), ", "))
	}

	rows, _ := body["rows"].([]any)
	ids := map[string]bool{}
	for _, raw := range rows {
		row, _ := raw.(map[string]any)
		if row == nil {
			continue
		}
		if !genreSetHas(strFromAny(row["Genre"]), sportsGenreName) {
			continue
		}
		if id := strings.ToLower(strings.TrimSpace(strFromAny(row["Id"]))); id != "" {
			ids[id] = true
		}
	}
	if len(ids) == 0 {
		return nil, fmt.Errorf("no %s title survived the genre check for client %s over %d master row(s)",
			sportsGenreName, clientID, len(rows))
	}
	return ids, nil
}

/*
genreSetHas answers whether an asset carries a genre.

The master returns Genre as ONE STRING holding a comma-separated set, because an
asset can be in several — every tagged games title is in Console, PC and Mobile
Games at once. A plain equality test against "Sports" therefore misses every
multi-genre title, which on a broadcaster's catalogue is most of the interesting
ones. Same split, same reason, as splitSet in components/client/ProgramCalendar.tsx.
*/
func genreSetHas(set, want string) bool {
	want = strings.ToLower(strings.TrimSpace(want))
	for _, part := range strings.Split(set, ",") {
		if strings.ToLower(strings.TrimSpace(part)) == want {
			return true
		}
	}
	return false
}

// sortedKeys is a map's keys in a stable order, so a log line reads the same way
// twice.
func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

/*
sportsReportOnAllGenreTable is the rule that decides which reports narrow.

A report is a sports report if its key or its label says so — the same two tests
isSportsPlatform makes, so a report is judged one way throughout the service —
and it needs narrowing only when the table it reads is NOT itself a sports table.
A table with "Sports" in its name is narrowed by the ETL that fills it and has
nothing to gain from the master.

Read off the names rather than configured, for the reason isSportsPlatform gives
about the table list: a label is free text an admin can change at will, and the
table is what actually decides which rows a report contains.

Mobile Apps is the report this is true of, and at the time of writing the only
one: a sports report by configuration, reading a source that holds every genre a
client has.
*/
func sportsReportOnAllGenreTable(platformKey, label, table string) bool {
	if containsFold(table, "sports") {
		return false
	}
	return containsFold(platformKey, "sports") || containsFold(label, "sports")
}

/*
sportsOnlySpecSet reports whether a set of tables is a sports report that needs
narrowing here.

TWO conditions, and both matter.

	At least one table must actually need it — a spec with SportsAssetsOnly. A
	set of Sports* tables is narrowed already by whatever fills them, so reading
	the master for it would be a request that can only confirm what is true.

	And EVERY table that carries assets must be a sports table, either narrowed
	upstream by its own name or narrowed here. All of them, not any: the
	cross-platform Summary merges the sports platforms with the VOD ones into one
	Asset slicer, and narrowing that on the strength of one member would delete
	the other member's titles from a list they belong in.
*/
func sportsOnlySpecSet(specs []reportSpec) bool {
	need := false
	for _, s := range specs {
		if s.AssetCol == "" {
			continue // contributes no asset values either way
		}
		switch {
		case s.SportsAssetsOnly:
			need = true
		case containsFold(s.Table, "sports"):
			// Narrowed by the ETL that fills it.
		default:
			return false
		}
	}
	return need
}

/*
keepSportsAssets drops the titles a sports report may not name from a set of
values keyed by asset id, and says how many went.

`kept` is 0 when nothing was narrowed — either because the set was already
clean or because the whole thing would have gone, which is refused: see below.
*/
func keepSportsAssets(ids map[string]bool, values []string) (keep []string, dropped int) {
	keep = make([]string, 0, len(values))
	for _, v := range values {
		if ids[strings.ToLower(strings.TrimSpace(v))] {
			keep = append(keep, v)
			continue
		}
		dropped++
	}
	/* EVERYTHING dropped is treated as a failure to match, not as a report with
	   no sports titles in it.

	   The two sides key an asset the same way or they do not, and the far more
	   likely reason a fact table's whole asset list is absent from the master's
	   sports list is that one of them is not holding what the other thinks —
	   a client id crossed over, an id column that turned out to be something
	   else. A window in which a sports report genuinely found nothing but films
	   is possible and is the rarer case, and it costs a reader nothing to see
	   the unnarrowed list for it. An empty Asset slicer costs them the screen. */
	if len(keep) == 0 {
		return values, 0
	}
	return keep, dropped
}

// logAssetNarrowing is the one place this narrowing announces itself, so an
// operator reading the log sees the same sentence whichever caller narrowed.
func logAssetNarrowing(what, clientID string, dropped, kept int) {
	log.Printf("[reports] %s held to the %s genre for client=%s: %d title(s) kept, %d dropped",
		what, sportsGenreName, clientID, kept, dropped)
}

/*
assetFilterParam is the slicer the Asset dropdown sends under — the same string
DIMFilterParam returns for the two asset panels, named here so the narrowing can
find its own list in a map keyed by parameter.
*/
const assetFilterParam = "assetId"

/*
narrowSportsAssetOptions holds the Asset slicer of a sports report to that
report's own titles.

Mutates the merged value map in place, which is how every other step of
mergeSpecOptionsViaAPI works on it — the alternative is rebuilding the map and
losing the counts and names already folded into it.

Silent and harmless where it does not apply: a set of tables that is not a
narrowing case, a slicer with no asset values in it, or a master that could not
answer all return with nothing touched.
*/
func narrowSportsAssetOptions(
	ctx context.Context,
	specs []reportSpec,
	clientID string,
	flat map[string]map[string]*slicerValue,
) {
	vals := flat[assetFilterParam]
	if len(vals) == 0 || !sportsOnlySpecSet(specs) {
		return
	}
	ids, err := sportsAssetIDs(ctx, clientID)
	if err != nil {
		// Fail OPEN, loudly. See the header: a slicer two titles too long is
		// yesterday's report, an empty one is a broken screen.
		log.Printf("[reports] Asset slicer left unnarrowed for client=%s: %v", clientID, err)
		return
	}

	listed := make([]string, 0, len(vals))
	for id := range vals {
		listed = append(listed, id)
	}
	keep, dropped := keepSportsAssets(ids, listed)
	if dropped == 0 {
		return
	}
	survives := make(map[string]bool, len(keep))
	for _, id := range keep {
		survives[id] = true
	}
	for id := range vals {
		if !survives[id] {
			delete(vals, id)
		}
	}
	logAssetNarrowing("Asset slicer", clientID, dropped, len(keep))
}
