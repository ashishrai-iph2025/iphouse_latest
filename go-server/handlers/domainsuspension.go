package handlers

/*
HOW MANY OF THIS CLIENT'S PIRATE SITES HAVE BEEN TAKEN OFFLINE, AND HOW MUCH
AUDIENCE WENT WITH THEM.

Two headline tiles on a website report — Domains Suspended and Total Traffic
Impacted — read from reports_api's domain-reporting master, which carries
WebsiteStatus (mediascan.WebsiteSuspension, latest record per domain) and
Traffic (the domain's peak monthly SimilarWeb visits) on every routed domain.

── SCOPED TO THE CLIENT BY ITS OWN HOSTNAMES ────────────────────────────────

Suspension is a fact about a DOMAIN, not about a client, so the master has no
client column to scope by. The client's share is the intersection: of the
domains this report found carrying the client's content in this window — every
hostname on either side, not the top ten a panel draws — how many are
suspended. A suspended site that never carried this client's content is not
this client's number, and is not counted.

The hostnames come from the per-spec domain breakdown the API bridge already
fetches in full for the brand count (see domainRows), so this costs no extra
warehouse query for the client side. They follow every slicer the report does:
narrow to one asset and the tiles narrow with it.

── WHY THE SUSPENDED LIST IS FETCHED WHOLE ─────────────────────────────────

The other direction — sending the client's hostnames as ?domains= — is how the
compliance column works, and it is right there because that column needs ten.
Here it would be every hostname in the window, thousands on a busy client,
which outgrows a URL. The suspended list is ~470 rows, the same for every
client, and changes when someone records a suspension; so it is fetched once
with ?WebsiteStatus=Suspended, cached, and intersected here.

── WHAT A MISSING FIGURE MEANS ─────────────────────────────────────────────

No tile value — an em dash — when the report did not reach the reports API or
the lookup failed. A zero would read as "none of this client's sites have been
suspended", which is a finding; an unreachable table is not one.
*/

import (
	"context"
	"log"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/ip-house/iphouse-api/reportsapi"
)

// The two tiles, in the order they read on the band.
const (
	kpiDomainsSuspended = "domainsSuspended"
	kpiTrafficImpacted  = "trafficImpacted"
)

var suspensionKPIs = []string{kpiDomainsSuspended, kpiTrafficImpacted}

/*
specHostnamesKey carries a spec's full hostname list up to runPlatform.

Underscored because it is internal: runPlatform builds its response map fresh
and never copies a spec's keys through, so the list — potentially thousands of
names — never reaches the page.
*/
const (
	specHostnamesKey        = "_hostnames"
	specHostnamesPartialKey = "_hostnamesPartial"
)

// suspensionTTL: a suspension is recorded by a person, at human speed — same
// reasoning, and the same figure, as complianceTTL.
const suspensionTTL = 30 * time.Minute

var (
	suspensionMu   sync.Mutex
	suspensionAt   time.Time
	suspensionList map[string]int64 // normalised domain → peak monthly traffic (0 when unknown)
)

/*
suspendedDomains is every suspended domain with its traffic, cached.

A failed refresh keeps serving the previous list while it is still fresh
enough to be the last good answer, and reports ok=false only when there has
never been one — the tiles then draw an em dash rather than a zero.
*/
func suspendedDomains() (map[string]int64, bool) {
	suspensionMu.Lock()
	defer suspensionMu.Unlock()
	if suspensionList != nil && time.Since(suspensionAt) < suspensionTTL {
		return suspensionList, true
	}
	if !reportsViaAPI() {
		return nil, false
	}

	ctx, cancel := context.WithTimeout(context.Background(), complianceAPITimeout)
	defer cancel()
	q := url.Values{}
	q.Set("WebsiteStatus", "Suspended")
	q.Set("limit", "all")
	var body struct {
		Rows []map[string]any `json:"rows"`
	}
	if err := reportsapi.Get().GetJSON(ctx, "/v1/masters/"+complianceMaster, q, &body); err != nil {
		log.Printf("[reports] suspended-domain lookup failed: %v", err)
		return suspensionList, suspensionList != nil
	}
	suspensionList = suspendedFromRows(body.Rows)
	suspensionAt = time.Now()
	return suspensionList, true
}

/*
suspendedFromRows folds the master's rows into domain → traffic.

Re-checks WebsiteStatus rather than trusting the filter, so a reports_api that
predates the filter — and ignores the unknown parameter, returning a page of
EVERY domain — yields the suspended ones only instead of counting the lot.

A domain can carry two routing rows; Traffic and WebsiteStatus are properties
of the domain, so both rows say the same and folding by name loses nothing.
*/
func suspendedFromRows(rows []map[string]any) map[string]int64 {
	out := make(map[string]int64, len(rows))
	for _, r := range rows {
		if strings.TrimSpace(strFromAny(r["WebsiteStatus"])) != "Suspended" {
			continue
		}
		name := normaliseDomain(strFromAny(r["DomainName"]))
		if name == "" {
			continue
		}
		out[name] = numOf(r["Traffic"])
	}
	return out
}

/*
suspensionImpact counts a client's suspended hostnames and sums their traffic.

Each suspended domain counts ONCE however it is spelled in the client's rows:
www.example.com and example.com are matched through complianceCandidates —
exact first, then the www-shifted form — and keyed on the suspended entry they
resolve to, so the pair is one site and one traffic figure, not two.
*/
func suspensionImpact(hosts []string, suspended map[string]int64) (count, traffic int64) {
	hit := map[string]bool{}
	for _, h := range hosts {
		for _, c := range complianceCandidates(h) {
			if _, ok := suspended[c]; ok {
				hit[c] = true
				break
			}
		}
	}
	for d := range hit {
		count++
		traffic += suspended[d]
	}
	return count, traffic
}

/*
applySuspensionKPIs sets the two tiles from the hostnames every spec reported.

`reported` is false when no spec produced a hostname list at all — a platform
with no domain column, or one not reading through the API — and then nothing is
set, which is the em dash. An empty list from a spec that DID report is a real
zero: the client had no sites in the window.
*/
func applySuspensionKPIs(kpiOut map[string]any, hosts map[string]bool, reported bool) {
	if !reported {
		return
	}
	suspended, ok := suspendedDomains()
	if !ok {
		return
	}
	list := make([]string, 0, len(hosts))
	for h := range hosts {
		list = append(list, h)
	}
	count, traffic := suspensionImpact(list, suspended)
	kpiOut[kpiDomainsSuspended] = count
	kpiOut[kpiTrafficImpacted] = traffic
}

// platformHasHostnames is whether any of a platform's tables records a website,
// which is what makes the two tiles meaningful on it.
func platformHasHostnames(specs []reportSpec) bool {
	for _, sp := range specs {
		if sp.DomainCol != "" {
			return true
		}
	}
	return false
}

/*
withSuspensionTiles adds the two tiles to the list a section draws.

Here for the reason withPerSideTiles is: no spec declares them in ExtraKPI —
they are assembled in runPlatform from every side's hostnames — and a metric
missing from this list is drawn for nobody however faithfully it is computed.
*/
func withSuspensionTiles(extras []string, specs []reportSpec) []string {
	if !platformHasHostnames(specs) {
		return extras
	}
	for _, k := range suspensionKPIs {
		if !containsString(extras, k) {
			extras = append(extras, k)
		}
	}
	return extras
}
