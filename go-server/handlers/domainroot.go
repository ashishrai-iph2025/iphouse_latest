package handlers

import (
	"sort"
	"strings"
)

/*
The BRAND behind an infringing hostname, and the trick used to spawn it.

A takedown report grouped by hostname counts mirrors, not sites. One operator
running livetv.sx, livetv901.me and cdn.livetv872.me appears three times, each a
third of its real size, while a single-domain site beside it looks more
important than it is. Measured on the live warehouse: "livetv" is 131,333
infringements across 28 hostnames, where the hostname panel showed 57,000 and
gave no way to find the other 27.

COMPUTED HERE, IN THE PORTAL, AND DELIBERATELY NOT IN reports_api.

It was built there first, as two derived SQL columns the service could GROUP BY,
and that is the wrong place for two reasons. The measured one: a GROUP BY over
an expression cannot use an index, so `by=domainRoot` took 22 seconds against 10
for the plain, indexed `by=domain` — every panel, every load. The structural
one: reports_api's job is to hand over rows the warehouse already holds, and a
derivation that will be tuned every time a new mirror pattern appears does not
belong behind a redeploy of the service every other report depends on.

So the portal asks for the ONE indexed breakdown it was already asking for —
hostname by volume — and folds it into brands in memory. Three panels come out
of a single request, the derivation is a pure function that can be unit-tested
without a warehouse, and changing the rule is a portal deploy.

THE RULE IS PORTED FROM THE POWER BI MODEL's `Domain Root Brand` and
`Domain Mirror Type`, with two deliberate departures, both marked below. Keep
them in step: a number here that disagrees with the one the same client reads in
Power BI is worse than no number.
*/

/*
publicSecondLevels are second-level labels that belong to the SUFFIX rather than
to a brand: the "co" in example.co.uk, the "com" in example.com.br.

A short curated list rather than the full public-suffix list, because the full
one is a megabyte of data that changes monthly and would have to be vendored and
kept current to answer a question this narrow. These are the forms that appear
in practice; a suffix not listed here costs one wrong brand, not a wrong report,
and the list is one line to extend.

Only consulted when the LAST label is short — "co.uk" is a suffix, "co.website"
is a brand called "co" under a long TLD.
*/
var publicSecondLevels = map[string]bool{
	"co": true, "com": true, "net": true, "org": true, "gov": true,
	"edu": true, "ac": true, "mil": true, "int": true, "nom": true,
	"or": true, "ne": true, "go": true, "in": true, "web": true,
}

/*
domainRootBrand is the operator behind a hostname.

THE LABEL BEFORE THE PUBLIC SUFFIX — the registrable domain — with a trailing
run of up to four digits removed, so foo, foo2 and foo1234 are one brand and
foo12345 is "foo1".

Taking the label before the suffix is the second departure from the Power BI
model and the one that matters. That model takes the FIRST label after stripping
a short list of known prefixes, which is only the brand when the hostname has no
subdomain or has one the list happens to name. Everything else reports the
subdomain as the operator:

	jackgzh8.4fguseaicu74adjective.sbs  ->  "jackgzh"   (the real site is
	                                                     4fguseaicu74adjective)
	v3.example.com                      ->  "v"
	s-c.example.com                     ->  "s-c"
	481-pull.example.com                ->  "481-pull"

Those are the one- and two-character entries that appeared at the top of the
Root Domain panel, ranked as though they were major operators. Reading the
registrable domain instead needs no list of prefixes at all — cdn., www., en12.
and live3. all fall away for the same reason any other subdomain does — which is
why the prefix tables this file used to carry are gone.

THE POWER BI MEASURE HAS THE SAME FLAW. Until it is changed the two will
disagree on any hostname with an unrecognised subdomain.
*/
func domainRootBrand(host string) string {
	host = strings.ToLower(strings.TrimSpace(host))
	host = strings.TrimSuffix(host, ".")
	if host == "" {
		return ""
	}
	labels := strings.Split(host, ".")
	// Drop empties from a malformed host ("foo..com") so they cannot be picked
	// as the brand.
	clean := labels[:0]
	for _, l := range labels {
		if l != "" {
			clean = append(clean, l)
		}
	}
	labels = clean
	n := len(labels)
	if n == 0 {
		return ""
	}
	if n <= 2 {
		return trimBrandDigits(labels[0])
	}
	i := n - 2
	if publicSecondLevels[labels[i]] && len(labels[n-1]) <= 3 && n >= 3 {
		i = n - 3
	}
	return trimBrandDigits(labels[i])
}

/*
trimBrandDigits removes a trailing run of at most FOUR digits.

Four, not "all of them", because that is what the model does and a brand whose
name genuinely ends in digits must keep the rest: foo1234 folds into foo,
foo12345 stays foo1.
*/
func trimBrandDigits(label string) string {
	cut := len(label)
	for cut > 0 && len(label)-cut < 4 && isDigit(label[cut-1]) {
		cut--
	}
	if cut == 0 {
		// An all-digit label is its own brand rather than nothing at all.
		return label
	}
	return label[:cut]
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

/*
foldDomainRows turns a hostname breakdown into a brand one.

`rows` are the panel rows the bridge already built — label, value, urls, removed
— for the plain domain dimension. Folding them here is what makes three panels
cost one indexed request instead of three unindexed ones.

`mirrors` counts DISTINCT hostnames per brand, which is the second number the
report wants: 131,333 infringements is one fact about livetv and "spread over 28
hostnames" is the other, and neither is much use alone.

Sorted by volume, because that is the order every other ranked panel uses and
the caller cuts a top N off the front.
*/
func foldDomainRows(rows []map[string]any, key func(string) string) []map[string]any {
	type agg struct {
		label            string
		urls, removed    int64
		mirrors          int64
		firstAppearedAtI int
	}
	byKey := map[string]*agg{}
	order := []string{}

	for i, r := range rows {
		host := strFromAny(r["label"])
		if host == "" {
			host = strFromAny(r["value"])
		}
		k := key(host)
		if k == "" {
			continue
		}
		a := byKey[k]
		if a == nil {
			a = &agg{label: k, firstAppearedAtI: i}
			byKey[k] = a
			order = append(order, k)
		}
		a.urls += numOf(r["urls"])
		a.removed += numOf(r["removed"])
		a.mirrors++
	}

	out := make([]map[string]any, 0, len(order))
	for _, k := range order {
		a := byKey[k]
		out = append(out, map[string]any{
			"label": a.label,
			// No `value`: a brand is not something the warehouse holds, so there
			// is no id a drill-down could filter on. See the note in the bridge.
			"urls":    a.urls,
			"removed": a.removed,
			"mirrors": a.mirrors,
		})
	}
	sortRowsByURLs(out)
	return out
}

// sortRowsByURLs is the ranking every other breakdown panel arrives in.
func sortRowsByURLs(rows []map[string]any) {
	sort.SliceStable(rows, func(i, j int) bool {
		return numOf(rows[i]["urls"]) > numOf(rows[j]["urls"])
	})
}

// The three panel keys this file answers for. Named as constants because the
// bridge, the registry and the summary all have to agree on them, and a typo in
// any one of the three is a panel that silently never fills.
const (
	dimDomainRoot        = "byDomainRoot"
	dimDomainRootMirrors = "byDomainRootMirrors"
)

/*
domainFoldFor says whether a panel is derived from the hostname breakdown, and
what to fold each hostname into.

Returning the function rather than a flag keeps the bridge from having to know
that two of these group by brand and one by class — it just folds and cuts.
*/
func domainFoldFor(dimKey string) (func(string) string, bool) {
	switch dimKey {
	case dimDomainRoot, dimDomainRootMirrors:
		return domainRootBrand, true
	}
	return nil, false
}
