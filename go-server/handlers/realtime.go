package handlers

/*
The realtime counts, per platform.

reports_api serves two of these — one for the War Room and one for the sports
reports — and the portal passes them through rather than letting the browser
call that service. The reason is the same one the rest of the report engine
exists for: the API key lives here and only here, and a page that could reach
reports_api directly would have to be given one.

Passing through is also where the CLIENT is decided. A client login never names
its own company: the id it sends is discarded and replaced with the one staff
mapped it to — see reportScope. Without that, this endpoint would be a way to
read another company's discovery counts by editing a query string, which is
exactly the shape of hole a "just a count" endpoint invites.
*/

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/ip-house/iphouse-api/reportsapi"
)

// RealtimePlatform is one platform's count, as the service reports it.
type RealtimePlatform struct {
	Key    string `json:"key"`
	Label  string `json:"label"`
	Family string `json:"family"`
	Count  int64  `json:"count"`
	/* How many of those are DOWN AGAIN.

	   A POINTER, because three answers have to survive the trip and two of them
	   look like zero: this platform reports removals and has none; this VIEW
	   does not report removals at all (only sports does — war-room never asks);
	   and the platform could not be counted, which the service answers with a
	   null count and a null removed. Only the first is a zero worth drawing.
	   The other two rendered as "0 removed" would be a claim neither answer
	   made, on the card whose whole job is telling a quiet platform from an
	   unwatched one. */
	Removed *int64 `json:"removed,omitempty"`
	/* WHAT the service counted as removed, as its own SQL predicate. Read here
	   and blanked before the payload leaves, for the same reason Table is —
	   see scrubRealtimeSchema. RemovalBasis is what survives it. */
	RemovedWhen string `json:"removedWhen,omitempty"`
	/* The same distinction in words, because the two are NOT the same fact and
	   a card putting them in one column should say so: on Open Web a removal is
	   an APPROVED DELISTING NOTICE — we asked and the host agreed — while
	   everywhere else it is a URL the crawler can no longer reach. Derived, not
	   sent: see removalBasis. */
	RemovalBasis string `json:"removalBasis,omitempty"`
	// The table and date column the count came from. Read off the service's
	// answer so a "why is this zero" can be logged here, and dropped again
	// before the payload leaves for the browser — warehouse schema is not a
	// thing any portal user, staff included, is shown. See scrubRealtimeSchema.
	Table      string `json:"table,omitempty"`
	DateColumn string `json:"dateColumn,omitempty"`
}

/*
Blanks the warehouse schema off a reading before it is served.

The counts service names the table and the date column it counted, and that
detail used to travel all the way to a tooltip on the card. It has no reader:
nobody outside this codebase can act on "mediascan._InternetURLsNEW", and
publishing the physical layout of the warehouse to every logged-in browser is
the sort of thing that is only ever useful to someone mapping it.

`removedWhen` joined them later and is the same kind of value in a friendlier
coat: "d.InfringingRemovalStatus = 'Approved'" is a column name, a table alias
and a magic string, sent to every browser holding the card. What a reader
actually needs from it is which of the two things "removed" means here, so that
is taken off it — see removalBasis — and the predicate itself is blanked with
the rest.

Blanked here rather than by dropping the fields, so the values are still parsed
and available to log on this side of the boundary.
*/
func scrubRealtimeSchema(ps []RealtimePlatform) {
	for i := range ps {
		// Derived BEFORE the blanking, and from the same reading, so a platform
		// whose predicate changes upstream cannot end up described by a stale
		// mapping kept on this side.
		ps[i].RemovalBasis = removalBasis(ps[i].RemovedWhen)
		ps[i].RemovedWhen = ""
		ps[i].Table = ""
		ps[i].DateColumn = ""
	}
}

/*
removalBasis says, in words, what this platform's `removed` counts.

Two spellings exist upstream and they are different claims. Thirteen platforms
record the fact themselves — the crawler went back and the URL was gone — while
Open Web has no such column and is joined to the delisting table, where what is
counted is a notice somebody APPROVED. A card that stacked those in one bar
without saying which is which would be reporting intent as outcome on the one
platform that carries most of the volume.

Anything it does not recognise gets no description rather than a guess: an
unlabelled figure is read as "removed", which is true, and a wrongly labelled one
is not.
*/
func removalBasis(when string) string {
	w := strings.ToLower(when)
	switch {
	case w == "":
		return ""
	case strings.Contains(w, "delisting"), strings.Contains(w, "approved"):
		return "approved delisting notice"
	case strings.Contains(w, "dead"):
		return "URL no longer reachable"
	}
	return ""
}

type realtimeResponse struct {
	View     string `json:"view"`
	ClientID string `json:"clientId"`
	Total    int64  `json:"total"`
	/* The removed half of the headline, and a POINTER for the reason Removed is
	   — absent on the war-room view, which never asks. Passed through as the
	   service sends it rather than summed from Platforms here: on a partial
	   reading those rows carry nulls, and adding up what decoded to zero would
	   turn "one platform could not be counted" into a smaller removal figure
	   presented as exact. */
	TotalRemoved *int64             `json:"totalRemoved"`
	Platforms    []RealtimePlatform `json:"platforms"`
}

/*
── How far back the count reaches ────────────────────────────────────────────

	It used to ask for everything — an absolute `since` before any row — because
	"realtime" was taken to mean "the live total". Right idea, wrong query:
	against production that is a full count per platform over the whole history,
	and the service answers 504. No timeout on this side fixes a gateway that
	gave up; the request itself has to be one that can finish.

	So the count is always bounded. WHAT bounds it differs by view:

	· SPORTS reads the configured period for this client, whole — see
	  sportsPeriodScope. Not the report's date range. The card answers "how much
	  is out there this season", which the date slicer is not a question about,
	  and a season is already a window a count can finish inside.

	· WAR ROOM reads the window the caller names, which is its report's own
	  range, falling back to a bounded default rather than to all-time: a
	  default that cannot complete is not a default.
*/

// Used when the caller names no window and no period governs it — the War Room,
// and a sports client whose period is switched off. Thirty days because that is
// the reports page's own default range, so a card falling back this far and the
// tiles under it start out saying the same thing.
const realtimeFallbackDays = 30

// realtimeScope is the date range a count covers, and where that range came
// from. `period` is true where it is the client's configured sports season
// rather than anything the caller asked for — the card captions itself from it,
// so a figure covering a season is not read as covering the slicer's dates.
//
// `since` and `until` are warehouse timestamps because that is what the card
// DISPLAYS — dayWords in RealtimeCard.tsx parses them to write "1 Aug 2026".
// What reports_api receives is not these: see apiWindow.
type realtimeScope struct {
	since, until string
	period       bool
}

/*
apiWindow is the window as reports_api must be ASKED for it: bare calendar days.

WHY THIS IS NOT `since`/`until` AS THEY STAND.

The capture tables reports_api counts are UTC. The report's calendar — every
figure in dashboards.* and every number in the panels beside this card — is IST.
reports_api reconciles the two by reading a BARE DATE as a calendar day in the
report's zone, and a value carrying a TIME as a literal instant, which is the
only way both kinds of caller can be served.

Sending "2026-08-01 00:00:00" therefore asks for UTC midnight when the report
means IST midnight, and the window lands 5h30m late at both ends: it drops
00:00–05:30 IST on the first day and picks up 00:00–05:30 IST on the day after
the last. Measured against the reference query for DAZN over August 2026 that was
Telegram 525 against 509, Facebook 258 against 238, YouTube 461 against 471 —
small, in both directions, and impossible to read as anything but noise. As bare
days every platform matches the report exactly.

So the timestamps stay for the caption and the days go on the wire. The two are
built from one value and cannot drift.

Empty in, empty out: `until` is legitimately absent — see scopeFromRequest — and
a blank must not become a date.
*/
func (sc realtimeScope) apiWindow() (since, until string) {
	return dateOnly(sc.since), dateOnly(sc.until)
}

/*
sportsPeriodScope is the whole of a configured period, as a window.

Takes the period rather than looking it up, so the decision it encodes can be
tested without a database — the same split clampToSportsPeriod is on, and for
the same reason. Which period a client gets is resolveSportsPeriod's answer and
is stated only there: the client's own row if it has one, the default if not.

`ok` is false where no period is usable at all, and the caller then falls back to
the request's window like any other view.

Deliberately NOT the report's date range. The card and the tiles below it were
reading the same dates and still disagreeing, because they read different layers
of the warehouse — the tiles the curated dashboards.* tables, the card the raw
mediascan.* ones, which de-duplicate URLs the tiles count per day. Matching the
dates never made those two figures comparable and only made the card re-count
every time the slicer moved. So it answers a question the date slicer does not
ask: how much is out there for this client's season, all of it.
*/
func sportsPeriodScope(p sportsPeriodConfig) (from, to string, ok bool) {
	if !p.active() {
		return "", "", false
	}
	return p.Start, p.End, true
}

/*
scopeFromRequest decides the window one count covers.

Sports takes the configured period and ignores `from`/`to` entirely — see
sportsPeriodScope. Every other view reads them off the query string, where they
are the report page's own filter values (YYYY-MM-DD).

`to` is passed through to `until` unchanged: unlike MarkScan's, this service's
bound is inclusive of the day — verified against it — so there is no final day
to lose.
*/
func scopeFromRequest(r *http.Request, view, clientID string) realtimeScope {
	from := strings.TrimSpace(r.URL.Query().Get("from"))
	to := strings.TrimSpace(r.URL.Query().Get("to"))

	/* The season, whole, whatever the page asked for. A client with a period of
	   its own gets that one; everyone else gets the default. Where neither is
	   enabled there is no period to read and the request's own window stands —
	   the same fall-back every other view uses. */
	fromPeriod := false
	if view == "sports" {
		if pf, pt, ok := sportsPeriodScope(resolveSportsPeriod(clientID)); ok {
			from, to, fromPeriod = pf, pt, true
		}
	}

	if from == "" {
		from = time.Now().UTC().AddDate(0, 0, -realtimeFallbackDays+1).Format("2006-01-02")
	}

	sc := realtimeScope{since: from + " 00:00:00", period: fromPeriod}
	if to != "" {
		sc.until = to + " 23:59:59"
	}
	return sc
}

/*
GET /api/realtime/{view} — war-room or sports.

The count covers the window the caller names — see scopeFromRequest — which is
the one the report beside the card is showing. One answer is shared across polls
and tabs for a couple of minutes (cachedRealtimeCount), and the card pauses
while its tab is hidden.
*/
func Realtime(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)

	view := strings.ToLower(strings.TrimSpace(r.PathValue("view")))
	switch view {
	case "war-room", "sports":
	default:
		Fail(w, 404, "Unknown realtime view")
		return
	}

	if !reportsViaAPI() {
		/* Only reports_api serves these. Said plainly rather than answered with
		   zeroes, which would read as "nothing was found in the last two days"
		   — a very different and much more alarming statement. */
		Fail(w, 503, "Realtime counts need the reports API — this portal is reading the warehouse directly")
		return
	}

	/* Staff may name the client either way, and both go through the SAME
	   mapping a client login is scoped by.

	   `userId` exists because the War Room picks clients by portal user — its
	   dropdown is built from dcp_user — while the reports screens carry the
	   warehouse GUID. Resolving the first through warehouseClientFor rather
	   than adding a second lookup keeps one answer to "which warehouse client
	   is this login", which is the mapping staff maintain on one screen. */
	requested := strings.TrimSpace(r.URL.Query().Get("clientId"))
	if uid := strings.TrimSpace(r.URL.Query().Get("userId")); uid != "" && isStaff(claims) {
		n, err := parseIntSafe(uid)
		if err != nil || n <= 0 {
			Fail(w, 422, "userId must be a whole number")
			return
		}
		id, mapped := warehouseClientFor(int64(n))
		if !mapped {
			Fail(w, 422, "That client is not linked to a reporting client yet")
			return
		}
		requested = id
	}

	clientID, ok, why := reportScope(claims, requested)
	if !ok {
		Fail(w, 403, why)
		return
	}
	if clientID == "" {
		Fail(w, 422, "A client is required")
		return
	}

	/* Generous, and under the reports client's own 90s ceiling.

	   Thirty seconds was not enough and the card showed a raw
	   "context deadline exceeded". An all-time count is a full count per
	   platform — 3.1s against a local warehouse, evidently far longer against
	   production — so the limit has to fit the work rather than the other way
	   round. What keeps it affordable is the memo below, not a short deadline. */
	ctx, cancel := context.WithTimeout(r.Context(), realtimeCountTimeout)
	defer cancel()

	/* The assets the card is scoped to, as GUIDs.

	   The War Room picks assets by NAME — MarkScan's war-room list carries no
	   ids at all (see assetOptions) — while this endpoint takes an asset GUID.
	   Names are resolved here against the asset master rather than in the
	   browser, because the master is 126k rows and the lookup is already cached
	   in the reports client. */
	assetIDs, err := realtimeAssetIDs(ctx, r, clientID)
	if err != nil {
		Fail(w, 502, err.Error())
		return
	}

	scope := scopeFromRequest(r, view, clientID)
	body, err := cachedRealtimeCount(ctx, view, clientID, assetIDs, scope)
	if err != nil {
		// Detail to the log for the same reason as above: a warehouse error is
		// usually a failed statement, and the card renders whatever it is told
		// straight onto the page.
		log.Printf("[realtime] count failed view=%s client=%s: %v", view, clientID, err)
		Fail(w, 502, "Realtime counts are unavailable")
		return
	}

	/* Sorted busiest first, and the empties kept.

	   A platform reading zero is information — it is being watched and nothing
	   turned up — and dropping it would make the card silently change length as
	   discoveries move between platforms. The page decides what to show; this
	   decides the order. */
	sortRealtime(body.Platforms)
	scrubRealtimeSchema(body.Platforms)

	out := map[string]any{
		"ok": true, "view": view, "clientId": clientID,
		"total": body.Total, "platforms": body.Platforms,
		// How many assets the number covers, so the card can say "2 assets"
		// rather than leaving a filtered figure looking like the whole client.
		"assets": len(assetIDs),
		// Echoed so the card describes what it is showing rather than guessing.
		"startDate": scope.since, "endDate": scope.until,
		/* And WHERE that window came from. "period" means the client's
		   configured season — the card says so, because "in this range" over a
		   figure the range slicer cannot move is a caption that lies. */
		"scope": scopeName(scope),
		// When the count was taken, so the card can say how old it is rather
		// than implying the moment it is read.
		"asOf": time.Now().UTC().Format(time.RFC3339),
	}
	/* Only where the view reported it. Sending 0 on the war-room card would put
	   "0 removed" beside a real discovery total on a screen that never counted
	   removals — the strongest possible statement about enforcement, made by a
	   field that was simply absent. Omitted, and the card draws no removal at
	   all. See RealtimePlatform.Removed for the same rule per platform. */
	if body.TotalRemoved != nil {
		out["totalRemoved"] = *body.TotalRemoved
	}
	OK(w, out)
}

// scopeName is what the payload calls the window, for the card's caption.
func scopeName(sc realtimeScope) string {
	if sc.period {
		return "period"
	}
	return "request"
}

func sortRealtime(ps []RealtimePlatform) {
	// Insertion sort: this is a dozen entries, and a stable order means two
	// platforms both on zero keep the service's own ordering rather than
	// swapping places between refreshes.
	for i := 1; i < len(ps); i++ {
		for j := i; j > 0 && ps[j].Count > ps[j-1].Count; j-- {
			ps[j], ps[j-1] = ps[j-1], ps[j]
		}
	}
}

func parseIntSafe(s string) (int, error) {
	var n int
	if _, err := fmt.Sscanf(s, "%d", &n); err != nil {
		return 0, err
	}
	return n, nil
}

/*
realtimeAssetIDs reads the asset scope off the request.

Accepts ids directly (`assetId`) and names (`assetName`), each repeatable and
each also accepting a comma-separated list, because the two callers differ: the
reports screens hold GUIDs and the War Room holds names.

An empty result means "every asset", which is the unfiltered card. A name that
matches nothing is an ERROR rather than an empty scope — silently widening a
filtered count back to the whole client is the wrong direction to fail in, and
the number would look plausible.
*/
func realtimeAssetIDs(ctx context.Context, r *http.Request, clientID string) ([]string, error) {
	ids := splitParams(r.URL.Query()["assetId"])
	names := splitParams(r.URL.Query()["assetName"])
	if len(names) == 0 {
		return ids, nil
	}

	byName, err := assetIDsByName(ctx, clientID)
	if err != nil {
		// The upstream text can carry the query that failed, table names and
		// all. It goes to the log, where an operator can act on it; the caller
		// gets a sentence a client can read.
		log.Printf("[realtime] asset name lookup failed for client=%s: %v", clientID, err)
		return nil, fmt.Errorf("asset names could not be resolved")
	}

	missing := []string{}
	for _, n := range names {
		found := byName[strings.ToLower(strings.TrimSpace(n))]
		if len(found) == 0 {
			missing = append(missing, n)
			continue
		}
		// One title can be recorded more than once. All of them count, or the
		// figure silently covers a subset of the asset that was asked for.
		ids = append(ids, found...)
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("no asset named %s for this client", strings.Join(missing, ", "))
	}
	return dedupe(ids), nil
}

// assetIDsByName inverts the asset master: one lowercased name to every id
// recorded under it. The master read is cached by the reports client.
func assetIDsByName(ctx context.Context, clientID string) (map[string][]string, error) {
	names, err := reportsapi.Get().MasterNames(ctx, "assets", clientID)
	if err != nil {
		return nil, err
	}
	out := make(map[string][]string, len(names))
	for id, name := range names {
		k := strings.ToLower(strings.TrimSpace(name))
		if k == "" {
			continue
		}
		out[k] = append(out[k], id)
	}
	return out, nil
}

/*
realtimeCount asks the service for the whole asset scope in ONE call.

The endpoint takes a comma-separated list of asset GUIDs and sums them itself.
Verified against this warehouse: twenty-one assets in one request returned
6,508, exactly the total of the same twenty-one asked for one at a time — in
0.12s rather than twenty-one round trips.

This replaced a fan-out that summed the answers here, which existed because the
service used to match the whole comma-joined string as a single id and return a
confident zero for any multi-asset selection. That is worth remembering rather
than deleting silently: the failure was not an error, it was a plausible number,
and the only thing that caught it was comparing the two ways of asking. The
check is now a test — see realtime_test.go.

An id the service does not recognise is ignored rather than refused, so a stale
selection narrows the count instead of failing it. Unknown NAMES are still
rejected upstream in realtimeAssetIDs, where widening a filtered count back to
the whole client would be the dangerous direction to fail in.
*/
func realtimeCount(ctx context.Context, view, clientID string, assetIDs []string, scope realtimeScope) (realtimeResponse, error) {
	return realtimeFetch(ctx, view, clientID, strings.Join(assetIDs, ","), scope)
}

func realtimeFetch(ctx context.Context, view, clientID, assetIDs string, scope realtimeScope) (realtimeResponse, error) {
	/* Bare calendar days, NOT the scope's display timestamps — see apiWindow.
	   This is the difference between a count that agrees with the panels beside
	   the card and one that is a few percent out in both directions. */
	since, until := scope.apiWindow()

	q := url.Values{}
	q.Set("clientId", clientID)
	q.Set("since", since)
	if until != "" {
		q.Set("until", until)
	}
	if assetIDs != "" {
		q.Set("assetId", assetIDs)
	}
	var body realtimeResponse
	err := reportsapi.Get().GetJSON(ctx, "/v1/realtime/"+view, q, &body)
	return body, err
}

// splitParams flattens repeated query parameters and comma-separated lists into
// one trimmed, non-empty list.
func splitParams(vals []string) []string {
	out := []string{}
	for _, v := range vals {
		for _, part := range strings.Split(v, ",") {
			if p := strings.TrimSpace(part); p != "" {
				out = append(out, p)
			}
		}
	}
	return out
}

func dedupe(in []string) []string {
	seen := make(map[string]bool, len(in))
	out := make([]string, 0, len(in))
	for _, v := range in {
		k := strings.ToLower(v)
		if seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, v)
	}
	return out
}

/*
── One answer, shared ────────────────────────────────────────────────────────

	The all-time count is expensive — a full count per platform — and the card
	polls it. Without this, N tabs open on the same client are N of those
	queries every refresh, and against a slow warehouse they become overlapping
	scans that make each other slower. That is how a backend that is merely slow
	becomes one that times out.

	So one answer is computed and shared. Two minutes, against a poll every
	five: a second tab costs nothing, and the figure is never more than a couple
	of minutes behind a fresh count — which the card says outright with its "x
	ago" stamp rather than implying the moment it is read.

	Single-flight: the first caller for a key computes while the rest WAIT on
	the same result. Letting them race would defeat the point exactly when load
	is highest.
*/

const (
	realtimeCountTimeout = 75 * time.Second
	realtimeMemoTTL      = 2 * time.Minute
	// A failure is held far more briefly. Caching it for the full window would
	// keep showing the error long after the warehouse recovered; not caching it
	// at all would let every poll retry a query that is already timing out.
	realtimeMemoErrTTL = 20 * time.Second
)

type realtimeEntry struct {
	done chan struct{}
	at   time.Time
	body realtimeResponse
	err  error
}

var (
	realtimeMemoMu sync.Mutex
	realtimeMemo   = map[string]*realtimeEntry{}
)

func realtimeMemoAge(e *realtimeEntry) time.Duration {
	if e.err != nil {
		return realtimeMemoErrTTL
	}
	return realtimeMemoTTL
}

func cachedRealtimeCount(ctx context.Context, view, clientID string, assetIDs []string, scope realtimeScope) (realtimeResponse, error) {
	// The window is part of the key: two readers on different date ranges are
	// asking different questions, and sharing one answer between them would
	// hand one of them the other's numbers.
	key := view + "\x00" + clientID + "\x00" + strings.Join(assetIDs, ",") +
		"\x00" + scope.since + "\x00" + scope.until

	realtimeMemoMu.Lock()
	if e, ok := realtimeMemo[key]; ok {
		select {
		case <-e.done:
			// Finished. Reuse it while it is fresh; otherwise fall through and
			// replace it, still holding the lock so only one caller does.
			if time.Since(e.at) < realtimeMemoAge(e) {
				realtimeMemoMu.Unlock()
				return e.body, e.err
			}
		default:
			// Still running. Wait for it rather than starting a second.
			realtimeMemoMu.Unlock()
			select {
			case <-e.done:
				return e.body, e.err
			case <-ctx.Done():
				return realtimeResponse{}, ctx.Err()
			}
		}
	}

	e := &realtimeEntry{done: make(chan struct{})}
	realtimeMemo[key] = e
	realtimeMemoMu.Unlock()

	/* context.Background(), not the caller's: a reader who navigates away
	   mid-count would otherwise cancel the query every other tab is waiting on.
	   realtimeCountTimeout is what bounds it. */
	cctx, cancel := context.WithTimeout(context.Background(), realtimeCountTimeout)
	e.body, e.err = realtimeCount(cctx, view, clientID, assetIDs, scope)
	cancel()
	e.at = time.Now()
	close(e.done)

	return e.body, e.err
}
