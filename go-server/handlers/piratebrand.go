package handlers

/*
The PIRATE BRAND slicer — one operator, however many hostnames it is running.

livetv.sx, livetv901.me and cdn.livetv872.me are one site behind three names.
The report has counted them as one for a while — the brand panels and the Pirate
Brands tile all fold hostnames through domainRootBrand — but there was no way to
pick one and narrow the page to it, which is the question a reader has the
moment they see the ranking.

── WHY THE BRAND CANNOT SIMPLY BE SENT ──────────────────────────────────────

There is no brand column anywhere in the warehouse. A brand is DERIVED, by
domainRootBrand: strip the public suffix — including the multi-label ones, so
.co.uk is one suffix and not two — then up to four trailing digits. That rule
lives in Go because the suffix list does, and rewriting it as SQL string surgery
would put a second copy of it in a second language, where the two would drift and
the symptom would be a filter selecting a different set than the panel it was
clicked from.

So the BRAND is resolved to its HOSTNAMES here, and the hostnames are what
travels. reports_api matches them with FIND_IN_SET against its own domain
column — an exact list, one bound parameter, no rule to keep in step. The filter
therefore selects exactly the rows the brand panel counted, by construction
rather than by agreement.

── WHY IT IS THE LINKING SIDE ONLY ──────────────────────────────────────────

dashboards.SportsSourceURLRawData carries SourceDomain and no InfringingDomain —
checked against the warehouse, not assumed. The host half physically cannot
answer a question about linking brands.

Which is why this parameter IS in knownFilterParams, unlike the other two
slicers that name something other than a column. specHonoursFilters then drops
the host spec whenever a brand is chosen, and the report becomes the linking
side for that brand — coherent, and the same shape sourceType produces. Left out
of that list the host spec would run UNFILTERED, and the band would add a
brand-scoped linking figure to an all-hosts one under a single "Total
Infringements", which is the kind of sum nobody can read and everybody trusts.
*/

import (
	"context"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/ip-house/iphouse-api/reportsapi"
)

// pirateBrandParam is the query parameter, as the page addresses it.
const pirateBrandParam = "pirateBrand"

/*
brandDomainsParam is what actually goes to reports_api: the chosen brand's
hostnames, comma-joined.

A different name from the slicer on purpose. The page sends a BRAND; the service
receives DOMAINS; and naming them alike would invite a caller to send a brand
straight through, which would match nothing and report it as a quiet week.
*/
const brandDomainsParam = "brandDomains"

/*
── The brand index, and why it is cached ────────────────────────────────────

	Resolving a brand needs the full hostname list for the window — every group,
	not a top-N, because a brand's mirrors are exactly the long tail a top-N cuts.
	That is one breakdown query, and without a cache it would run once for the
	slicer's options and again for every spec's scope on every poll.

	Keyed on client + window + column, which is everything the answer depends on.
	Short-lived: the domain list moves as the crawler works, and a stale index
	would resolve a brand to a set of hostnames that no longer includes its newest
	mirror — the filter would then quietly under-report the brand it was chosen
	to isolate.
*/
const brandIndexTTL = 5 * time.Minute

type brandIndex struct {
	// brand → its hostnames, and the brands in ranked order for the dropdown.
	domains map[string][]string
	order   []string
	at      time.Time
}

var (
	brandMu    sync.Mutex
	brandCache = map[string]*brandIndex{}
)

func brandCacheKey(clientID, from, to, col string) string {
	return clientID + "|" + from + "|" + to + "|" + col
}

/*
pirateBrands builds the brand index for one window.

`ok` is false where the list could not be read at all — a service that is down,
or a dataset with no domain column. The callers then offer no slicer and apply
no filter, which leaves the report exactly as it was: a control that cannot be
honoured must not appear, and a filter that cannot be resolved must not narrow
anything to nothing.
*/
func pirateBrands(ctx context.Context, ds reportsapi.Dataset, q map[string]string, col string) (*brandIndex, bool) {
	clientID := strings.TrimSpace(q["clientId"])
	from, to := strings.TrimSpace(q["from"]), strings.TrimSpace(q["to"])
	if clientID == "" || col == "" {
		return nil, false
	}
	key := brandCacheKey(clientID, from, to, col)

	brandMu.Lock()
	if idx, hit := brandCache[key]; hit && time.Since(idx.at) < brandIndexTTL {
		brandMu.Unlock()
		return idx, true
	}
	brandMu.Unlock()

	dim, ok := ds.DimByColumn(col)
	if !ok {
		return nil, false
	}
	scope := url.Values{}
	scope.Set("ClientId", clientID)
	if from != "" && to != "" {
		scope.Set(ds.DateFromParam, from)
		scope.Set(ds.DateToParam, to)
	}
	/* EVERY group. A brand resolved from a truncated hostname list is missing
	   whichever mirrors fell outside the cut, and the filter built from it
	   under-reports the brand with nothing on screen saying so — the same
	   reasoning domainRows is uncapped for. */
	rows, err := reportsapi.Get().Breakdown(ctx, ds, scope, dim, 0)
	if err != nil {
		return nil, false
	}

	idx := &brandIndex{domains: map[string][]string{}, at: time.Now()}
	volume := map[string]int64{}
	for _, r := range rows {
		host := strFromAny(r["label"])
		if host == "" {
			host = strFromAny(r["grp"])
		}
		brand := domainRootBrand(host)
		if brand == "" {
			continue
		}
		idx.domains[brand] = append(idx.domains[brand], host)
		volume[brand] += numOf(r["identified"]) + numOf(r["urls"])
	}
	for b := range idx.domains {
		idx.order = append(idx.order, b)
	}
	// Busiest first, so the dropdown opens on the operators worth looking at;
	// ties by name so the list is stable between polls.
	sort.Slice(idx.order, func(i, j int) bool {
		a, b := idx.order[i], idx.order[j]
		if volume[a] != volume[b] {
			return volume[a] > volume[b]
		}
		return a < b
	})

	brandMu.Lock()
	brandCache[key] = idx
	brandMu.Unlock()
	return idx, true
}

// pirateBrandOptions is the dropdown: the brand is both the value and the label,
// because a brand IS its name — there is no id behind it to resolve.
func pirateBrandOptions(ctx context.Context, ds reportsapi.Dataset, q map[string]string, col string) []map[string]any {
	idx, ok := pirateBrands(ctx, ds, q, col)
	if !ok {
		return nil
	}
	out := make([]map[string]any, 0, len(idx.order))
	for _, b := range idx.order {
		out = append(out, map[string]any{"id": b, "name": b})
	}
	return out
}

/*
brandDomainList is the chosen brand's hostnames, comma-joined for FIND_IN_SET.

Empty for an absent or unrecognised brand, and the caller then sends no filter —
so a stale bookmark naming a brand that has since gone quiet returns the
unfiltered report rather than an empty one. That is the same direction every
other slicer in this product fails in, and the only safe one: an empty report
cannot be told apart from a genuinely quiet window.

NO SPACES after the commas. FIND_IN_SET compares against the list verbatim, so a
space is part of the value it is looking for and every match after the first
would fail.
*/
func brandDomainList(ctx context.Context, ds reportsapi.Dataset, q map[string]string, col string) string {
	brand := strings.TrimSpace(q[pirateBrandParam])
	if brand == "" || col == "" {
		return ""
	}
	idx, ok := pirateBrands(ctx, ds, q, col)
	if !ok {
		return ""
	}
	hosts := idx.domains[brand]
	if len(hosts) == 0 {
		// Folded rather than matched: a caller may send a hostname where the page
		// would have sent a brand, and resolving it is kinder than an empty page.
		hosts = idx.domains[domainRootBrand(brand)]
	}
	if len(hosts) == 0 {
		return ""
	}
	return strings.Join(hosts, ",")
}
