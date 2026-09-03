package handlers

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	ipauth "github.com/ip-house/iphouse-api/auth"
	"github.com/ip-house/iphouse-api/reportsapi"
)

/*
GET /api/reports/overview?dataset=&days=&asOf= — the landing page's figures.

reports_api serves GET /v1/overview/{dataset}, which already defaults to the
window the client landing page shows: the last seven days, against the seven
before them. This is the portal's door to it.

NOT under /v1/sports, and that is deliberate over there rather than an accident
of routing: the question it answers is "how did this client's enforcement go
this week", across every platform — search engines, Open Web, YouTube, Telegram,
social — which is a question about the dashboards, not about sports. The masters
endpoints sit outside /v1/sports for the same reason. Guessing the sports prefix
is what produced "reports API returned 404" here.

── Passed through, not assembled ────────────────────────────────────────────

The body is returned VERBATIM. That is deliberate and it is what GetJSON exists
for — the same treatment the realtime counts get, and for the reason written on
that method: the answer is the service's, and re-describing its shape here would
be a second definition of it to keep in step with the first. The portal has been
bitten by exactly that already, reading `byPlatform` off the top of a payload
that carries its dimensions under `breakdowns`.

So this file knows three things about the endpoint and no more: where it lives,
that it is scoped by ClientId, and that a client login may only ever see its own.
Whatever measures it grows next are on the screen the day the service ships them,
without a Go change.

── What it does add ─────────────────────────────────────────────────────────

The client, forced from the session — the same rule every other report endpoint
follows. A client login naming somebody else's id is discarded rather than
refused: there is no legitimate reason to name one at all, and an error would
tell an attacker they had guessed a real id.

And the dataset is CHECKED AGAINST THE CATALOG before it reaches the path. It is
a caller-supplied string being concatenated into a URL, so unvalidated it is a
way to address any route on the analytics service; matched against the catalog it
can only ever be a dataset the service already publishes.
*/
/* The dataset the landing page is drawn from.

   `urls` because that is the registry entry whose measures the page actually
   reads: identified, removed, googleDelisted, bingDelisted, delisted,
   delistingBatches, domains, assets. /v1/overview will answer for any dataset
   in the registry, so the wrong key here does not fail — it returns a payload
   whose measures the page finds nothing under and draws as em-dashes. */
const defaultOverviewDataset = "urls"

/*
fallbackOverviewDataset is what a client with NO SPORTS REPORT is shown.

The default above reads the sports URL table, which is the right source for a
sports client and empty for everyone else — so a VOD client opened /welcome and
was told "Nothing new was found this week" for a week in which plenty had been
found. The page was reading the one table their reports do not use.

`unified` is dashboards.Unified_BI_Dashboard: every platform in one row set —
search engines, Open Web, YouTube, Telegram and social. It declares identified,
removed, domains and assets, which are four of the five tiles this page draws,
and the endpoint derives removalRatePct from the first two.

It does NOT declare `delisted`, and that is deliberate upstream rather than a
gap: the unified table records Google and Bing separately, and a URL dropped by
both engines is one delisted URL, so the pair cannot be added. The page already
draws that card only when the figure is present, so it is absent here instead of
wrong.
*/
const fallbackOverviewDataset = "unified"

/*
hasSportsReport reports whether this login can open a sports report at all.

The same two questions ReportsSections asks of every platform — is it enabled,
and is it inside this login's allow-list — so the answer cannot disagree with
what the reader actually has in their navigation. A client whose Report
Configuration grants them Open Web Sports gets the sports overview; one granted
only the VOD platforms does not.

The allow-list is the LOGIN's, and on this page that is the client's: /welcome is
a client route, and an admin viewing a client portal is doing so through an
impersonated session whose claims are that client's. There is no staff-picks-a-
client case here for it to get wrong.

Assignment, not data. A client who holds a sports report and had a quiet week
still sees the sports figures — an empty week in their own report is a true
answer, and probing for rows to decide which table to read would make the page's
source depend on how the week went.
*/
func hasSportsReport(claims *ipauth.Claims) bool {
	allowed := reportsAllowedForClaims(claims)
	for _, p := range loadPlatforms() {
		if !p.Enabled || p.Key == summaryKey {
			continue
		}
		if allowed != nil && !allowed[p.Key] {
			continue
		}
		if isSportsPlatform(p) {
			return true
		}
	}
	return false
}

/*
Where the endpoint lives. A constant so the one fact this file is most likely

	to get wrong is stated once, beside the test that pins it.
*/
const overviewPath = "/v1/overview/"

// A dataset key, and nothing that could steer the path elsewhere: lowercase,
// digits and hyphens only, so no separator, dot segment or percent escape can
// reach the URL.
var datasetKeyOK = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)

func ReportsOverview(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	if !mayOpenReports(claims) {
		Fail(w, 403, "The Reports module is not enabled for this account")
		return
	}
	if !reportsapi.Configured() {
		reportsUnavailable(w, r, fmt.Errorf(
			"no report backend is configured — set REPORTS_API_URL to read through reports_api"))
		return
	}

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

	/*
		Which dataset the overview is asked of.

		The default is NAMED rather than taken from the catalog's first entry,
		which is what it was. /v1/sports/datasets lists every dataset the service
		can be queried over — open-web, open-web-source and the rest — in an
		order that is the registry's business, so the first of them is whichever
		one happens to be declared first and has no relationship to the measures
		this page reads.
	*/
	ds := strings.TrimSpace(r.URL.Query().Get("dataset"))
	if ds == "" {
		/* The sports table for a sports client, the unified one for everybody
		   else — see fallbackOverviewDataset. An explicit ?dataset= still wins,
		   so this only decides what an unqualified request means. */
		if hasSportsReport(claims) {
			ds = defaultOverviewDataset
		} else {
			ds = fallbackOverviewDataset
		}
	}
	/* Shape-checked, not membership-checked.

	   It is a caller-supplied string being concatenated into a URL, so it has to
	   be constrained — but the constraint that matters is that it cannot contain
	   a path separator, a dot segment or an escape. Requiring it to be IN the
	   catalog was the stronger-sounding rule and the wrong one twice over: it
	   made every overview depend on a second round trip that can fail on its own,
	   and the catalog does not describe which datasets serve THIS endpoint. */
	if !datasetKeyOK.MatchString(ds) {
		Fail(w, 422, "Unknown dataset: "+ds)
		return
	}

	c := reportsapi.Get()
	path := overviewPath + ds

	q := url.Values{}
	q.Set("ClientId", clientID)
	/* The window is the ENDPOINT'S to compute, and it is moved by naming its
	   SHAPE rather than its edges: `days` is how long each of the two periods
	   is, `asOf` the last day of the current one. Neither is sent unless asked
	   for; absent, the service applies its own default, which is already the
	   seven-day pair this exists to serve.

	   A from/to range is REFUSED upstream with a 422, not intersected — two
	   periods that are no longer `days` long would be compared as if they were.
	   So there is nothing to forward here even if a caller sent one: passing it
	   through would turn a page that works into a 422, and the parameters that
	   do work are these two. Their values are handed over unchecked because the
	   service already bounds them (1–366 days, a calendar date) and says so in a
	   message worth more than anything this side could invent. */
	for _, k := range []string{"days", "asOf"} {
		if v := strings.TrimSpace(r.URL.Query().Get(k)); v != "" {
			q.Set(k, v)
		}
	}

	var body map[string]any
	if err := c.GetJSON(ctx, path, q, &body); err != nil {
		/* The PATH, in the message. "reports API returned 404" was true and
		   unactionable — it named neither the endpoint nor the dataset, so the
		   one fact needed to fix it was the one fact missing. */
		log.Printf("[overview] %s client=%s: %v", path, clientID, err)
		reportsUnavailable(w, r, fmt.Errorf("%s: %w", path, err))
		return
	}
	if body == nil {
		body = map[string]any{}
	}
	// Table and column names are the warehouse's, not the client's — the same
	// scrub ReportsData applies before answering a client login.
	if !maySeeWarehouseNames(r) {
		scrubReportPayload(body)
		/* And `measureNotes`, which scrubReportPayload does not reach because it
		   is a nested object rather than one of the keys it knows.

		   Its content is not a description of the measure, it is the warehouse's
		   own state: "802,125 of 3,029,174 rows carry one, 2,711 distinct". Those
		   are totals across EVERY client, handed to one of them. Useful to staff
		   reading a figure they distrust, nobody else's business.

		   Dropped wholesale rather than filtered — a note is prose written
		   upstream, and matching on what today's happens to say is a guard that
		   holds until the next sentence is added. `notes` beside it stays: that
		   one explains what a period and a percentage-point mean, which is the
		   reader's business and says nothing about the warehouse. */
		delete(body, "measureNotes")
	}
	body["ok"] = true
	body["available"] = true
	body["dataset"] = ds
	OK(w, body)
}
