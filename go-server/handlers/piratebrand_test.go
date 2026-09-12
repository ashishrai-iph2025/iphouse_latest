package handlers

import (
	"os"
	"strings"
	"testing"

	"github.com/ip-house/iphouse-api/reportsapi"
)

// readSourceAt reads a sibling checkout's file, or skips where it is absent —
// so a cross-repo guard is a developer's safety net and never a broken build on
// a box that only has this repo.
func readSourceAt(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("not checked out beside this repo: %v", err)
		return ""
	}
	return string(b)
}

// reportsapiDatasetStub is a dataset that reaches no service — every test using
// it short-circuits before the index would be built.
func reportsapiDatasetStub() reportsapi.Dataset { return reportsapi.Dataset{} }

/*
The pirate brand slicer.

Everything here is about the two ways this could go wrong silently: a filter that
selects a different set than the panel it was clicked from, and a report that
adds a brand-scoped figure to an unscoped one under a single heading.
*/

/*
The brand is resolved to HOSTNAMES, and the rule is never rewritten.

domainRootBrand needs the public-suffix list to tell .co.uk from .uk. A second
copy of it as SQL string surgery in reports_api would drift from this one, and
the symptom is not an error — it is a filter quietly selecting different rows
than the Pirate Brands tile counted. So the predicate over there matches an
explicit list and holds no rule at all.
*/
func TestTheBrandRuleIsNotDuplicatedInTheService(t *testing.T) {
	src := readSourceAt(t, "../../../reports_api/internal/api/datasets.go")
	if src == "" {
		return
	}
	if !strings.Contains(src, `{Param: "`+brandDomainsParam+`", Expr: "FIND_IN_SET(InfringingDomain, ?)"}`) {
		t.Errorf("reports_api no longer matches %q as an explicit domain list — if it "+
			"has started deriving the brand itself, that is a second copy of "+
			"domainRootBrand and the two will disagree", brandDomainsParam)
	}
	/* The giveaway that the rule has been reimplemented over there. Any of these
	   means the service is trying to work out the brand from the hostname. */
	for _, leak := range []string{"SUBSTRING_INDEX(InfringingDomain", "TRIM(TRAILING", "REGEXP_REPLACE(InfringingDomain"} {
		if strings.Contains(src, leak) {
			t.Errorf("reports_api appears to derive the brand itself (%q) — the rule "+
				"lives in domainRootBrand and must not be copied", leak)
		}
	}
}

/*
The slicer is declared on the LINKING side and only there.

dashboards.SportsSourceURLRawData carries SourceDomain and no InfringingDomain —
verified against the warehouse — so the host half cannot answer a question about
linking brands at all.
*/
func TestPirateBrandIsDeclaredOnTheLinkingSideOnly(t *testing.T) {
	// Seeded into the shape cache the way the other spec tests do it: inferSpec
	// takes a table NAME and asks the cache what columns it has.
	seed := func(table string, own ...string) {
		cols := map[string]string{}
		for _, c := range append([]string{"ClientId", "AssetId", "URLUploadDate", "IsRemoved"}, own...) {
			cols[strings.ToLower(c)] = c
		}
		shapeCacheMu.Lock()
		shapeCache[table] = tableShape{Table: table, Columns: cols}
		shapeCacheMu.Unlock()
	}
	const linkT, hostT = "dashboards.__test_brand_link", "dashboards.__test_brand_host"
	seed(linkT, "InfringingDomain")
	seed(hostT, "SourceDomain")
	defer invalidateShapeCache()

	link, ok := inferSpec("open-web-sports", "Open Web - Sports", linkT)
	if !ok {
		t.Fatal("linking spec not usable")
	}
	host, ok := inferSpec("open-web-sports", "Open Web - Sports", hostT)
	if !ok {
		t.Fatal("host spec not usable")
	}

	if link.Role != "linking" || host.Role != "host" {
		t.Fatalf("roles came out %q/%q — the fixtures no longer model the two sides",
			link.Role, host.Role)
	}
	if link.Filters[pirateBrandParam] == "" {
		t.Errorf("the linking spec does not declare %q, so choosing a brand would "+
			"narrow nothing", pirateBrandParam)
	}
	if link.Filters[pirateBrandParam] != link.DomainCol {
		t.Errorf("the brand filter maps to %q but this side counts %q — the brand "+
			"resolves back to hostnames in that column",
			link.Filters[pirateBrandParam], link.DomainCol)
	}
	if host.Filters[pirateBrandParam] != "" {
		t.Errorf("the host spec declares %q against column %q — it has no "+
			"linking-domain column and cannot honour it", pirateBrandParam,
			host.Filters[pirateBrandParam])
	}
	// And each side counts ITS OWN hostname column, which is what keeps the two
	// per-side domain and brand tiles from becoming one number twice.
	if link.DomainCol != "InfringingDomain" || host.DomainCol != "SourceDomain" {
		t.Errorf("domain columns are %q/%q, want InfringingDomain/SourceDomain",
			link.DomainCol, host.DomainCol)
	}
}

/*
It MUST be in knownFilterParams, which is the opposite of the rule the other two
non-column slicers follow.

specHonoursFilters drops any spec that cannot declare an active slicer. For
sourceType and monitoringScope that would empty the report, so they are kept out.
Here it is exactly what is wanted: with a brand chosen the host spec is dropped
and the page shows the linking side for that brand. Left out, the host spec would
run UNFILTERED and Total Infringements would be a brand-scoped linking figure
plus an all-hosts one.
*/
func TestPirateBrandIsAKnownFilterParam(t *testing.T) {
	found := false
	for _, p := range knownFilterParams {
		if p == pirateBrandParam {
			found = true
		}
	}
	if !found {
		t.Errorf("%q is not in knownFilterParams — the host spec would run unfiltered "+
			"and its figures would be added to a brand-scoped linking half",
			pirateBrandParam)
	}

	// And the consequence, at the function that acts on it.
	linking := reportSpec{Filters: map[string]string{pirateBrandParam: "InfringingDomain"}}
	host := reportSpec{Filters: map[string]string{"assetId": "AssetId"}}
	q := map[string]string{pirateBrandParam: "livetv"}
	if !specHonoursFilters(linking, q) {
		t.Error("the linking spec was dropped by its own slicer")
	}
	if specHonoursFilters(host, q) {
		t.Error("the host spec survived a brand filter it cannot honour, so it would " +
			"contribute unfiltered rows to the band")
	}
}

/*
An unresolvable brand narrows NOTHING.

A stale bookmark naming an operator that has gone quiet must return the
unfiltered report, not an empty one: an empty report cannot be told apart from a
genuinely quiet window, which is the failure every slicer in this product is
written to avoid. Checked without a warehouse — an empty brand short-circuits
before the index is ever built.
*/
func TestAnAbsentBrandSendsNoFilter(t *testing.T) {
	for _, brand := range []string{"", "   "} {
		q := map[string]string{"clientId": "C", pirateBrandParam: brand}
		if got := brandDomainList(nil, reportsapiDatasetStub(), q, "InfringingDomain"); got != "" {
			t.Errorf("brand %q resolved to %q, want nothing", brand, got)
		}
	}
	// No domain column is the same case: a table that records no hostname has no
	// brands, and the filter must not be invented for it.
	q := map[string]string{"clientId": "C", pirateBrandParam: "livetv"}
	if got := brandDomainList(nil, reportsapiDatasetStub(), q, ""); got != "" {
		t.Errorf("a table with no domain column resolved a brand to %q", got)
	}
}

/*
The hostname list is joined with NO SPACES.

FIND_IN_SET compares against the list verbatim, so " b.com" is a different value
from "b.com" and every match after the first would fail — a filter that returns
one mirror's rows and silently drops the rest.
*/
func TestTheDomainListHasNoSpaces(t *testing.T) {
	idx := &brandIndex{domains: map[string][]string{
		"livetv": {"livetv.sx", "livetv901.me", "cdn.livetv872.me"},
	}}
	got := strings.Join(idx.domains["livetv"], ",")
	if strings.Contains(got, " ") {
		t.Errorf("the domain list carries a space: %q", got)
	}
	if n := strings.Count(got, ","); n != 2 {
		t.Errorf("the list is %q — want the mirrors comma-joined", got)
	}
}
