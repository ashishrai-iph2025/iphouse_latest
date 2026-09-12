package handlers

/*
WHETHER A HOST HAS EVER HONOURED A NOTICE.

The host panels rank domains by how much was found on them and how much came
down. Both figures are about this window. Neither says the thing a reader asks
next about a host sitting at the top of the list: is there any point sending it
a notice at all.

mediascan.DomainReportingMethod answers that. It is the takedown ROUTING table —
one row per domain, naming how a notice reaches it and carrying a CompliantType
flag recording whether that domain has complied before. reports_api serves the
same table at /v1/masters/domain-reporting; this reads it directly, because a
panel needs the status of ten hostnames and that endpoint returns 153,951 rows.

── WHY IT IS RESOLVED AFTER THE MERGE, NOT IN THE FOLD ──────────────────────

A breakdown row travels through two merges on its way to the page, and both of
them REBUILD the row out of a map of int64 (see accumulateBreakdown). A string
put on a row before that point is gone by the time anything draws it — which is
how `mirrors` was lost once and `extra` twice.

Resolving it afterwards avoids that entirely and is cheaper besides: the status
is a property of the hostname, so it is looked up once for the ten labels that
survived the ranking rather than once per table per platform for every hostname
any of them saw.

── THE HOST SIDE ONLY, AND NOT THE BRAND CARDS ──────────────────────────────

Compliance is recorded against a DOMAIN, so it can only be put on a panel whose
rows are domains. "Top 10 Host Websites" is one. The root-domain cards are not:
their rows are BRANDS, and owledge's twelve mirrors can hold twelve different
answers — a single status over them would be a claim the table does not make.

The linking panel is excluded because the question is about notices, and a
notice goes to the host. Adding the linking side is one entry in the map below
if it is ever wanted.
*/

import (
	"context"
	"fmt"
	"log"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/ip-house/iphouse-api/db"
	"github.com/ip-house/iphouse-api/reportsapi"
)

/*
complianceDomainPanels are the panels whose rows get a status.

Keyed by panel key rather than by column, because the panel is what decides
whether its label is a domain — see the note above on the brand cards.
*/
var complianceDomainPanels = map[string]bool{
	// "Top 10 Host Websites" — one row per host domain, on both the Open Web
	// report and the summary.
	"byDomainSource": true,
}

// The four answers, as the page prints them.
const (
	complianceYes = "Compliant"
	complianceNo  = "Non-Compliant"
	/* The routing table HAS this domain and its flag is neither 1 nor 0. 167 of
	   the 153,951 rows are in that state; calling them non-compliant would be a
	   claim the data does not make. Same wording reports_api uses. */
	complianceUnknown = "Unknown"
	/* The routing table does NOT have this domain — a different fact from
	   Unknown, and one worth telling apart: it means no notice route has been
	   recorded for a host the crawler is finding content on. */
	complianceAbsent = "Not recorded"
)

/*
complianceTTL is how long a status is kept.

Long, because this changes at human speed: a domain's compliance is updated when
somebody watches how it answered a notice, not by the crawler. Short enough that
a correction made in the morning is on the afternoon's reports.
*/
const complianceTTL = 30 * time.Minute

// complianceMaster is the endpoint this reads through — reports_api's own view
// of the same table. Named once so the portal and the service cannot drift.
const complianceMaster = "domain-reporting"

/*
complianceAPITimeout bounds the lookup.

Shorter than the client's own ninety seconds on purpose: this runs while a
report is being assembled, and an extra column is never worth holding the page
that carries it. Past this the lookup fails, the column is dropped, and every
figure on the card is still correct.
*/
const complianceAPITimeout = 20 * time.Second

type complianceEntry struct {
	status string
	at     time.Time
}

var (
	complianceMu    sync.Mutex
	complianceCache = map[string]complianceEntry{}
)

/*
normaliseDomain puts a hostname into the form the routing table stores.

Lower-cased, with a scheme, a path, a port and a trailing dot removed. The
report's own domain columns hold bare hostnames, so most of this never fires —
it is here because the two sides are populated by different pipelines and a
single "https://" prefix on one of them would turn the whole column into "Not
recorded" with nothing on screen saying why.

www. is NOT stripped here. It is a real label and dropping it would match
www.example.com against a row about example.com, which may be a different site
with a different answer. It is tried as a SEPARATE candidate instead — see
complianceCandidates — so a match on it is a match on a row that exists rather
than on one this function invented.
*/
func normaliseDomain(host string) string {
	h := strings.ToLower(strings.TrimSpace(host))
	if i := strings.Index(h, "://"); i >= 0 {
		h = h[i+3:]
	}
	if i := strings.IndexAny(h, "/?#"); i >= 0 {
		h = h[:i]
	}
	if i := strings.LastIndex(h, ":"); i > 0 && !strings.Contains(h[i:], "]") {
		h = h[:i]
	}
	return strings.TrimSuffix(h, ".")
}

/*
complianceCandidates are the spellings of one hostname to look for, best first.

Two of them, and the order is the precedence: the hostname exactly as the report
holds it, then the same name with www. added or removed. The second exists
because the two pipelines disagree about that prefix often enough to matter, and
it is only ever consulted when the first found nothing — so an exact row always
wins over a www-shifted one.
*/
func complianceCandidates(host string) []string {
	h := normaliseDomain(host)
	if h == "" {
		return nil
	}
	if alt := strings.TrimPrefix(h, "www."); alt != h {
		return []string{h, alt}
	}
	return []string{h, "www." + h}
}

/*
complianceFor resolves a set of hostnames to their statuses.

One query for everything not already cached, and the cache holds MISSES as well
as hits — a host with no routing row is the answer "Not recorded", and looking
it up again on every poll to be told the same thing costs a round trip per
refresh for a column that will not change.

Returns nil where there is no road to the routing table at all, or where the
lookup failed. The caller then adds no status, which leaves the panel exactly as
it was — a column of "Not recorded" over a table that was merely unreachable
would read as a finding about the client's hosts.
*/
func complianceFor(hosts []string) map[string]string {
	// Either road will do — see complianceRows. Neither open means no column,
	// which is the same answer a failed lookup gives.
	if len(hosts) == 0 || (!reportsViaAPI() && !db.ReportsConfigured()) {
		return nil
	}

	out := map[string]string{}
	want := map[string]bool{} // the spellings still to be asked about
	pending := map[string][]string{}

	complianceMu.Lock()
	for _, h := range hosts {
		cands := complianceCandidates(h)
		if len(cands) == 0 {
			continue
		}
		if e, hit := complianceCache[cands[0]]; hit && time.Since(e.at) < complianceTTL {
			out[h] = e.status
			continue
		}
		pending[h] = cands
		for _, c := range cands {
			want[c] = true
		}
	}
	complianceMu.Unlock()

	found := map[string]string{}
	if len(want) > 0 {
		list := make([]string, 0, len(want))
		for c := range want {
			list = append(list, c)
		}
		rows, err := complianceRows(list)
		if err != nil {
			/* Reported and then dropped. A status is an extra column on a panel
			   whose figures are all still correct, so a warehouse that would not
			   answer this one question must not cost the reader the card. */
			log.Printf("[reports] domain compliance lookup failed: %v", err)
			return nil
		}
		found = rows
	}

	now := time.Now()
	complianceMu.Lock()
	for h, cands := range pending {
		status := complianceAbsent
		for _, c := range cands {
			if s, hit := found[c]; hit {
				status = s
				break
			}
		}
		out[h] = status
		// Cached under the FIRST candidate, which is the spelling the report
		// asked about — that is the key the next lookup will present.
		complianceCache[cands[0]] = complianceEntry{status: status, at: now}
	}
	complianceMu.Unlock()
	return out
}

/*
complianceRows reads the routing table for one batch of spellings.

TWO ROADS, and which one is open is a deployment fact rather than a choice.

reports_api first, because that is how this portal reads the warehouse: the
reports database credentials are env-only and are simply absent on a deployment
that reads through the service, so the direct query below would answer "not
configured" and the column would never appear. The service exposes the same
table as a master, and that master takes a domain list — see the `domains`
filter on it — so ten hostnames cost one request rather than 153,951 rows.

The direct query is the fallback for a portal wired straight to the warehouse,
which is the same pair of roads every other report path here already has.

── THE DOMAINS WITH MORE THAN ONE ROW ───────────────────────────────────────

153,951 rows over 153,936 distinct domains, so a handful carry two routing rows
and the two can disagree. An ACTIVE row wins; where neither or both are active,
the first seen stands. Decided here rather than left to whichever row the
warehouse returns first, so one domain does not read Compliant on one refresh
and Non-Compliant on the next.

Active is read for that tie-break ONLY, never as a filter. A retired routing row
still records how the domain behaved, and hiding it would report a host whose
route was withdrawn as one nobody has ever assessed.
*/
func complianceRows(names []string) (map[string]string, error) {
	if reportsViaAPI() {
		return complianceViaAPI(names)
	}
	if !db.ReportsConfigured() {
		return nil, fmt.Errorf("neither the reports API nor the reports database is configured")
	}
	return complianceViaWarehouse(names)
}

/*
complianceViaAPI asks the master endpoint about exactly these domains.

The master already applies the three-way CASE, so what comes back is the WORD
rather than the flag — and it is checked against the three this portal knows
rather than printed as received. A service that grew a fourth answer would
otherwise put an unrecognised word straight onto the card.

NO SPACES after the commas: FIND_IN_SET compares the list verbatim, so a space
would be part of the value it looks for and every name after the first would
miss. Same rule, and the same trap, as the pirate-brand filter.
*/
func complianceViaAPI(names []string) (map[string]string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), complianceAPITimeout)
	defer cancel()

	q := url.Values{}
	q.Set("domains", strings.Join(names, ","))
	// The list is bounded by the panel's top-N, so "all" is a few dozen rows.
	q.Set("limit", "all")

	var body struct {
		Rows []map[string]any `json:"rows"`
	}
	if err := reportsapi.Get().GetJSON(ctx, "/v1/masters/"+complianceMaster, q, &body); err != nil {
		return nil, err
	}
	return complianceFromRows(body.Rows), nil
}

/*
complianceFromRows folds the service's rows into one answer per domain.

Its own function so it can be tested against a REAL response body rather than an
invented one — the three keys it reads are a contract with another service, and
a rename there would otherwise show up as a column of "Not recorded" rather than
as a failing test. See domaincompliance_test.go, which pins it to rows captured
off the live endpoint.
*/
func complianceFromRows(rows []map[string]any) map[string]string {
	out := map[string]string{}
	active := map[string]bool{}
	for _, r := range rows {
		name := strings.ToLower(strFromAny(r["DomainName"]))
		if name == "" {
			continue
		}
		/* An ACTIVE row wins; otherwise the first seen stands. Fifteen domains
		   carry two routing rows and the endpoint returns both — patreon.com
		   comes back Active=1 and Active=0 — so which one answers has to be
		   decided rather than left to the order they arrive in. */
		isActive := numOf(r["Active"]) == 1
		if _, seen := out[name]; seen && (!isActive || active[name]) {
			continue
		}
		out[name] = complianceWord(strFromAny(r["CompliantType"]))
		active[name] = isActive
	}
	return out
}

/*
complianceViaWarehouse is the same answer read straight from the table.

A bound parameter per name, never interpolation: these strings come from
warehouse data and reach here as the values of a column a crawler wrote.

The ORDER BY is the tie-break, done in SQL because it can be: inactive rows
first, then active, so the LAST write into the map is the one that should stand.
*/
func complianceViaWarehouse(names []string) (map[string]string, error) {
	args := make([]any, len(names))
	for i, n := range names {
		args[i] = n
	}
	q := fmt.Sprintf(
		`SELECT Domain, CompliantType
		   FROM mediascan.DomainReportingMethod
		  WHERE Domain IN (%s)
		  ORDER BY COALESCE(Active, 0) ASC, Id ASC`,
		strings.TrimSuffix(strings.Repeat("?,", len(names)), ","))

	rows, err := db.ReportsQuery(q, args...)
	if err != nil {
		return nil, err
	}
	out := make(map[string]string, len(rows))
	for _, r := range rows {
		name := strings.ToLower(strFromAny(r["Domain"]))
		if name == "" {
			continue
		}
		out[name] = complianceLabel(r["CompliantType"])
	}
	return out, nil
}

/*
complianceWord checks a word the service sent against the three this page draws.

Not a passthrough. The master applies its own CASE and the two are meant to say
the same thing — this is what makes "meant to" enforceable: a fourth answer
added there arrives here as Unknown, which is true, instead of as an unrecognised
string rendered verbatim into a column of verdicts.
*/
func complianceWord(s string) string {
	switch strings.TrimSpace(s) {
	case complianceYes:
		return complianceYes
	case complianceNo:
		return complianceNo
	}
	return complianceUnknown
}

/*
complianceLabel turns the stored flag into the word the page prints.

The same three-way CASE reports_api applies, in Go, so the portal's column and
the master endpoint cannot say different things about one domain. A NULL is
Unknown for the same reason a 7 is: the row exists and does not answer.
*/
func complianceLabel(v any) string {
	if v == nil {
		return complianceUnknown
	}
	switch numOf(v) {
	case 1:
		return complianceYes
	case 0:
		/* Guarded, because numOf returns 0 for anything it cannot read as a
		   number — and "unreadable" must not print as a finding about the host. */
		if s := strings.TrimSpace(strFromAny(v)); s != "" && s != "0" {
			return complianceUnknown
		}
		return complianceNo
	}
	return complianceUnknown
}

/*
annotateHostCompliance is what the two merges call.

It walks the finished breakdowns, picks out the panels whose rows are host
domains, and puts a status on each row. Called at the END of runPlatform and
runSummary — after everything that rebuilds a row, and after the top-N cut, so
the lookup covers the ten domains that will actually be drawn.

Silent where there is nothing to add: a report with no host panel, a warehouse
that is not configured, a lookup that failed. In each case the panel keeps
exactly the columns it had.
*/
func annotateHostCompliance(bd map[string]any) {
	if len(bd) == 0 {
		return
	}
	hosts := []string{}
	seen := map[string]bool{}
	for key, rows := range bd {
		if !complianceDomainPanels[key] {
			continue
		}
		for _, row := range asRows(rows) {
			h := strFromAny(row["label"])
			if h == "" || seen[h] {
				continue
			}
			seen[h] = true
			hosts = append(hosts, h)
		}
	}
	if len(hosts) == 0 {
		return
	}
	status := complianceFor(hosts)
	if len(status) == 0 {
		return
	}
	for key, rows := range bd {
		if !complianceDomainPanels[key] {
			continue
		}
		for _, row := range asRows(rows) {
			if s := status[strFromAny(row["label"])]; s != "" {
				row["complianceStatus"] = s
			}
		}
	}
}
