package handlers

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/ip-house/iphouse-api/reportsapi"
)

/*
GET /api/reports/assets — the client's title list, for the programme calendar.

reports_api serves the asset master at /v1/masters/assets. Every row carries the
three dates the calendar is drawn from — StartDate, EndDate and ReleaseDate —
alongside FranchiseName, MatchDay and the exclusivity flags. This is the portal's
door to it, and it exists for the same reason ReportsOverview does: the browser
must not hold an API key, and the client a login may read is the SESSION'S to
decide, never a query parameter's.

── Passed through, not assembled ────────────────────────────────────────────

The rows are returned as the service sent them. Same treatment, same reasoning as
ReportsOverview: re-describing the master's shape here would be a second
definition to keep in step with the first, and the calendar reads the columns by
name. A column the warehouse adds to mediascan.Asset is on the page the day
reports_api starts returning it.

── Why the whole list, and why that is affordable ───────────────────────────

The calendar is browsable across months, so it cannot ask for "this month's
assets" — the master has no endpoint shaped that way, and paging it per month
would be a request per arrow press. The largest client holds roughly 1,700 rows
of a dozen narrow columns; that is one request, gzipped to a fraction of its
size, and the page holds it for the session rather than re-fetching per month.

`limit` is forwarded so a caller can ask for less, and defaults to the service's
own maximum so a list is never silently cut in half — the same reason
MasterNames asks for 100000. Half a calendar looks exactly like a full one.
*/

// assetsDefaultLimit is what the portal asks for when the caller names no limit.
// The service caps this itself; asking high means the answer is complete.
const assetsDefaultLimit = 100000

func ReportsAssets(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	/* The CALENDAR module, not Reports. The calendar is its own panel with its
	   own endpoint and its own failure state, so it is its own grant — a client
	   who should see the week's figures but not the fixture schedule could not
	   be given one without the other while these shared a gate. See
	   handlers/calendarmodule.go, and the backfill that makes the split safe to
	   deploy. */
	if !mayOpenCalendar(claims) {
		Fail(w, 403, "The Calendar module is not enabled for this account")
		return
	}
	if !reportsapi.Configured() {
		reportsUnavailable(w, r, fmt.Errorf(
			"no report backend is configured — set REPORTS_API_URL to read through reports_api"))
		return
	}

	/* The client is the SESSION'S. A client login naming somebody else's id is
	   discarded rather than refused — there is no legitimate reason to name one,
	   and an error would confirm to an attacker that they had guessed a real id.
	   Identical to ReportsOverview; the asset master is client-scoped upstream
	   (ClientMasterId is required over there) and this is what fills it. */
	clientID, scoped, why := reportScope(claims, r.URL.Query().Get("clientId"))
	if !scoped {
		Fail(w, 403, why)
		return
	}
	if clientID == "" {
		Fail(w, 422, "A client is required")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()

	limit := assetsDefaultLimit
	if v := strings.TrimSpace(r.URL.Query().Get("limit")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}

	body, err := fetchAssetMaster(ctx, clientID, limit, r.URL.Query().Get("q"))
	if err != nil {
		reportsUnavailable(w, r, err)
		return
	}
	body["ok"] = true
	body["available"] = true
	OK(w, body)
}

/*
fetchAssetMaster is the one place this service reads the asset master.

Extracted when the asset register was added rather than copied into it. The two
callers differ only in who is allowed to ask — the calendar needs Reports, the
register needs its own grant — and everything after that point is identical: the
same path, the same client scoping, the same failure to translate. A second copy
would be a second thing to fix the day the master moves or gains a parameter.

The client id is the CALLER'S to establish. This function does not look at a
session; it is handed a client and trusts it, which is only safe because both
callers derive it from reportScope and neither takes it from the query string.
*/
func fetchAssetMaster(ctx context.Context, clientID string, limit int, search string) (map[string]any, error) {
	q := url.Values{}
	q.Set("ClientMasterId", clientID)
	if limit <= 0 {
		limit = assetsDefaultLimit
	}
	q.Set("limit", strconv.Itoa(limit))

	// A name search, forwarded rather than filtered here: the master serves `q`
	// itself, and 1,700 rows filtered upstream is 1,700 rows not sent.
	if s := strings.TrimSpace(search); s != "" {
		q.Set("q", s)
	}
	return queryAssetMaster(ctx, clientID, q)
}

// queryAssetMaster is the raw call, for callers that build their own parameters
// — the register pages and filters upstream, so it needs the full query rather
// than the three arguments the calendar happens to use.
func queryAssetMaster(ctx context.Context, clientID string, q url.Values) (map[string]any, error) {
	const path = "/v1/masters/assets"

	var body map[string]any
	if err := reportsapi.Get().GetJSON(ctx, path, q, &body); err != nil {
		// The path, in the message — the lesson ReportsOverview records: "reports
		// API returned 404" is true and unactionable on its own.
		log.Printf("[assets] %s client=%s: %v", path, clientID, err)
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if body == nil {
		body = map[string]any{}
	}
	return body, nil
}
