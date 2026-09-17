package handlers

/*
WHICH PLATFORM A SUBMITTED URL BELONGS TO.

The take-down form has no platform picker: the platform is read off each URL the
reader pastes in. That detection used to be a hand-written list of regexes in the
page — youtube.com, facebook.com, a catch-all for seven UGC hosts, Open Web for
everything else. Anything not on that list went in as Open Web, which is not a
wrong answer so much as no answer: the notice is routed by platform upstream, and
a bigo.tv link filed under Open Web is a notice sent down the wrong road.

mediascan.OtherUGCAndSocialMediaPlatforms is the list that already knows. It is
the sub-platform table behind the "UGC & other social media" capture family — one
row per site, carrying the site's hostname and whether it is UGC or Social Media.
reports_api serves it as the `ugc-platforms` master (192 rows), and this reads the
whole thing, because unlike the domain routing table it is small enough to hold.

── THE NAMED PLATFORMS ARE NOT DECIDED HERE ─────────────────────────────────

This list does NOT outrank the dedicated platforms, and that is load-bearing.
t.me is a row in it, and Telegram has its own MarkScan endpoint — so a lookup
that answered first would take every Telegram URL off /Telegram/Paged and file it
under the UGC umbrella. YouTube, Facebook, Instagram and Twitter are absent from
the table entirely, so only Telegram actually bites today; the page tries its
named-host list first regardless, and this fills in everything that list does not
know. See tokenFor() in app/(client)/upload-url/page.tsx.

── WHAT A MATCH IS WORTH ────────────────────────────────────────────────────

A token, not a platform. Seven of these sites have a MarkScan platform key of
their own — tiktok, vk, ok, sharechat, dailymotion, bilibili, chomikuj — and the
other 185 are submitted under the umbrella. Which of those the ACCOUNT actually
offers is a different question again, answered against its own master data in the
browser, so what is returned here is the token and the page resolves it.
*/

import (
	"context"
	"errors"
	"log"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/ip-house/iphouse-api/reportsapi"
)

// The master this reads. Named once so the portal and the service cannot drift.
const ugcDomainsMaster = "ugc-platforms"

/*
ugcDomainsTTL is how long the list is held.

Long, because it changes at human speed: a row is added when somebody onboards a
new site to monitor, not by the crawler. Short enough that a site added this
morning is detectable this afternoon without a deploy.
*/
const ugcDomainsTTL = 30 * time.Minute

/*
ugcDomainsTimeout bounds the fetch.

This runs while the take-down page is loading and the page WORKS without it —
the built-in host list still detects the named platforms, and anything unknown
still goes in as Open Web, which is exactly what happened before this existed.
So the budget is small: a slow warehouse must not hold up a form the reader can
already use.
*/
const ugcDomainsTimeout = 15 * time.Second

/*
ugcSiteTokens are the sites MarkScan serves under a key of their OWN.

Everything else in the table is submitted under the umbrella — one endpoint,
/UGCPlatform/Paged, with the platform named in the body. These seven are the ones
where naming the site instead of the umbrella is both possible and more precise.

Keyed by the registrable part of the hostname rather than the full name, so
m.vk.ru and vk.com both reach `vk` without a row each. Matched against the
hostname's labels, never as a substring of the whole string — "vk" as a substring
also matches "vkontakte-mirror.example.com", which is not vk.

The seven are MarkScan's, not this table's: see ugcPlatformMap in
go-server/markscan/client.go. A site gaining its own key upstream is one line
here; until then it routes to the umbrella, which still reaches it.
*/
var ugcSiteTokens = map[string]string{
	"tiktok":      "tiktok",
	"vk":          "vk",
	"vkvideo":     "vk",
	"ok":          "ok",
	"sharechat":   "sharechat",
	"dailymotion": "dailymotion",
	"bilibili":    "bilibili",
	"chomikuj":    "chomikuj",
}

// ugcUmbrellaToken is what the page resolves against its own platform list to
// find "UGC and other social media". Same token the built-in host list uses.
const ugcUmbrellaToken = "ugc"

// UGCDomain is one row of the list, as the page consumes it.
type UGCDomain struct {
	// The hostname, normalised — lower case, no scheme, no path, no port.
	Domain string `json:"domain"`
	// The site's readable name. NOT the hostname: they differ on 56 of the 192
	// rows ("Amazon Music" against music.amazon.com), which is why both are
	// carried. Shown beside the platform chip so the reader can see WHY a URL
	// was routed where it was.
	Site string `json:"site"`
	// "UGC" or "Social Media" — the only two values the column holds.
	PlatformType string `json:"platformType"`
	// The platform token to submit under; resolved against the account's own
	// platform list in the browser.
	Token string `json:"token"`
}

type ugcDomainsCache struct {
	rows []UGCDomain
	at   time.Time
	// Whether the last fetch actually answered. A failure is cached for a short
	// while too — see ugcDomainsList.
	ok bool
}

var (
	ugcDomainsMu    sync.Mutex
	ugcDomainsState ugcDomainsCache
)

/*
ugcDomainFailTTL is how long a FAILED fetch is remembered.

Much shorter than a successful one, because the answer it caches is "nothing" and
that must not persist past the outage that caused it. Long enough that thirty
readers opening the page during a warehouse restart do not become thirty requests
that are all going to fail.
*/
const ugcDomainFailTTL = 60 * time.Second

/*
ugcHostTokenFor picks the platform token for one hostname.

Matched on the hostname's LABELS, not on the string. "ok" as a substring appears
in kooapp.com and tokyvideo.com; as a label it appears only in ok.ru. Getting
that wrong routes a site to a platform it has nothing to do with, and the
submission still succeeds — it just goes to the wrong queue.
*/
func ugcHostTokenFor(host string) string {
	for _, label := range strings.Split(host, ".") {
		if tok, ok := ugcSiteTokens[label]; ok {
			return tok
		}
	}
	return ugcUmbrellaToken
}

/*
ugcRowsFrom folds the service's rows into the list the page reads.

Its own function so it can be tested against a REAL response body rather than an
invented one — the column names are a contract with another service, and a rename
there would otherwise show up as an empty list rather than as a failing test.

TWO SPELLINGS PER COLUMN, and that is not defensiveness for its own sake. The
master publishes the hostname as UGCDomain and the label as UGCDomainName; an
older build of reports_api published the same two columns as Domain and Name. The
portal and the service are deployed separately, so there is a window in which the
portal asking for the new names gets the old ones — and the failure mode is an
empty platform list with nothing on screen saying why.

A row with no usable hostname is DROPPED rather than kept with an empty domain: it
would match the empty host of an unparseable URL and route it somewhere arbitrary.
*/
func ugcRowsFrom(rows []map[string]any) []UGCDomain {
	out := make([]UGCDomain, 0, len(rows))
	seen := map[string]bool{}

	for _, r := range rows {
		host := normaliseDomain(strFromAny(firstOf(r, "UGCDomain", "Domain")))
		if host == "" {
			continue
		}
		/* Five domains carry two rows each — the same site entered once under a
		   display name and once under its own hostname, so bsky.app arrives as
		   both "BlueSky" and "bsky.app". They agree about the platform, so the
		   first wins and the duplicate is dropped rather than shadowing it. */
		if seen[host] {
			continue
		}
		seen[host] = true

		site := strFromAny(firstOf(r, "UGCDomainName", "Name"))
		out = append(out, UGCDomain{
			Domain:       host,
			Site:         strings.TrimSpace(site),
			PlatformType: strFromAny(r["PlatformType"]),
			Token:        ugcHostTokenFor(host),
		})
	}

	// Sorted so the payload is stable between fetches; the page indexes it by
	// domain and never reads the order, but a stable body is a cacheable one.
	sort.Slice(out, func(i, j int) bool { return out[i].Domain < out[j].Domain })
	return out
}

/*
firstOf reads the first of several keys that is present and non-empty.

Exists for the two-spellings problem above. A plain map read cannot express "this
column, or the name it used to have" without the caller repeating itself at every
site.
*/
func firstOf(r map[string]any, keys ...string) any {
	for _, k := range keys {
		if v, ok := r[k]; ok && strFromAny(v) != "" {
			return v
		}
	}
	return nil
}

/*
ugcDomainsList returns the list, from cache where it can.

Returns nil where there is no road to reports_api at all, or where the fetch
failed. The page then falls back to its built-in host list, which is exactly the
detection it had before this existed — so an unreachable warehouse costs
precision, never the ability to submit.
*/
func ugcDomainsList() []UGCDomain {
	ugcDomainsMu.Lock()
	if !ugcDomainsState.at.IsZero() {
		age := time.Since(ugcDomainsState.at)
		if (ugcDomainsState.ok && age < ugcDomainsTTL) || (!ugcDomainsState.ok && age < ugcDomainFailTTL) {
			rows := ugcDomainsState.rows
			ugcDomainsMu.Unlock()
			return rows
		}
	}
	ugcDomainsMu.Unlock()

	rows, err := ugcDomainsFetch()
	now := time.Now()

	ugcDomainsMu.Lock()
	defer ugcDomainsMu.Unlock()
	if err != nil {
		/* Logged once per failure window rather than per request, which is what
		   the short failure TTL above buys. The previous good list is KEPT and
		   handed back: a list that worked ten minutes ago is a better answer than
		   no list, and none of these rows goes stale in an hour. */
		log.Printf("[upload] UGC platform list unavailable: %v", err)
		ugcDomainsState.at, ugcDomainsState.ok = now, false
		return ugcDomainsState.rows
	}
	ugcDomainsState = ugcDomainsCache{rows: rows, at: now, ok: true}
	return rows
}

func ugcDomainsFetch() ([]UGCDomain, error) {
	if !reportsViaAPI() {
		/* Not an outage. A portal wired straight to the warehouse has no
		   reports_api at all, and the page is expected to run on its built-in
		   host list there — so this is logged once per failure window like any
		   other miss and never surfaced to the reader. */
		return nil, errors.New("reports_api is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), ugcDomainsTimeout)
	defer cancel()

	q := url.Values{}
	// The whole list, which is 192 rows — a master has no maximum and the
	// default 500 would silently cut a longer one off without saying so.
	q.Set("limit", "all")

	var body struct {
		Rows []map[string]any `json:"rows"`
	}
	if err := reportsapi.Get().GetJSON(ctx, "/v1/masters/"+ugcDomainsMaster, q, &body); err != nil {
		return nil, err
	}
	return ugcRowsFrom(body.Rows), nil
}

/*
UGCDomains serves the list to the take-down page.

GET /api/ugc-domains

ALWAYS 200, even when the lookup failed. The page treats this as an enhancement
to detection it can already do without, so an error status would put a red toast
in front of a reader whose form works perfectly — `available: false` says the same
thing to the code that cares and nothing to the one that does not.
*/
func UGCDomains(w http.ResponseWriter, r *http.Request) {
	rows := ugcDomainsList()
	if rows == nil {
		rows = []UGCDomain{}
	}
	OK(w, map[string]any{
		"success":   true,
		"available": len(rows) > 0,
		"count":     len(rows),
		"domains":   rows,
		// The token an unmatched row resolves to, named here rather than
		// hard-coded in the page, so the two sides cannot disagree about it.
		"umbrellaToken": ugcUmbrellaToken,
	})
}
