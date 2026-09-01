package handlers

/*
The SOURCE TYPE slicer — which SIDE of the open web a report is reading.

Every other slicer names a value in a column: pick "Netflix" and the WHERE gains
`AssetName = ?`. This one names a TABLE. Open Web is two of them —

	dashboards.InternetInfringingURLMainDashboardTable   the linking pages
	dashboards.InternetSourceURLMainDashboardTable       the hosts behind them

— and the report adds them together, which is why "Total Infringements" on the
open web is links PLUS hosts and its two trend panels are drawn separately. A
reader who wants one side has, until now, had to read the two charts and ignore
the KPI band, because nothing on the page could narrow it.

So the filter is applied by DROPPING SPECS rather than by adding a predicate,
and it has to be: there is no SourceType column in either table to filter on.
The two sides are distinguished by shape — see inferRole, which reads
InfringingDomain as the linking side and SourceDomain as the hosting one — and
that is the same distinction the per-role trends are already built from, so the
slicer cannot disagree with the panels beneath it.

── Why not every platform ───────────────────────────────────────────────────

	Only where dropping a side leaves a report that still means something: every
	table the platform reads has to carry a role, and both roles have to be
	present.

	The second half is what makes the control worth drawing — a platform with
	one side has a slicer whose only choice is what it already shows. The FIRST
	half is what stops it doing damage: Summary - Sports reads five tables of
	which only the two open-web ones have a side at all, so a source-type
	choice there would silently drop Telegram, social media and the app stores
	from every figure on the page. A slicer that removes three quarters of a
	report as a side effect is not a filter, and the safest place to say so is
	here, once, rather than in each of the three call sites.
*/

import "strings"

// sourceTypeParam is the query parameter, as the page addresses it.
const sourceTypeParam = "sourceType"

/*
The values, and the role each one selects.

The VOCABULARY is the warehouse's — the tables are named InternetInfringingURL
and InternetSourceURL — while the roles are this codebase's own words for the
same two things. Mapped rather than merged so neither has to be renamed to suit
the other: `inferRole` keeps saying linking/host, the slicer keeps saying what
the data is called, and this is the one line that has to know both.
*/
var sourceTypeRoles = map[string]string{
	"infringing": "linking",
	"source":     "host",
}

// The dropdown, in reading order: the link is found first and the host behind
// it, which is the order roleOrder puts the trends in.
func sourceTypeOptions() []map[string]any {
	return []map[string]any{
		{"id": "infringing", "name": "Infringing"},
		{"id": "source", "name": "Source"},
	}
}

/*
rolesIn is the distinct sides a set of specs carries.

Named, and used on BOTH sides of the filter, because the difference between the
two answers is where this slicer's one real hazard lives. The layout is built
from the unfiltered specs — see rolesForPlatform — so anything that decides
whether to emit per-side figures has to ask the same question of the same set. It
did not: runPlatform tested how many sides SURVIVED, so choosing one left the
selected trend card with no data behind it and the page reported "No host data
for this period" over a table holding 27,115 rows.

Role-less tables are not sides and are not counted. A platform of three sideless
tables has no sides, not three.
*/
func rolesIn(specs []reportSpec) map[string]bool {
	out := map[string]bool{}
	for _, s := range specs {
		if s.Role != "" {
			out[s.Role] = true
		}
	}
	return out
}

/*
platformOffersSourceType answers whether this slicer belongs on a platform.

Both conditions from the note above, and the empty case is false rather than
true: a platform whose tables could not be read at all offers nothing.
*/
func platformOffersSourceType(specs []reportSpec) bool {
	if len(specs) == 0 {
		return false
	}
	seen := map[string]bool{}
	for _, s := range specs {
		if s.Role == "" {
			// One role-less table is enough to make the choice destructive.
			return false
		}
		seen[s.Role] = true
	}
	return len(seen) > 1
}

/*
specsForSourceType applies the slicer, where the platform offers it.

Returns the specs unchanged for an absent or unrecognised value, which is the
only safe direction to fail in: a typo in a query string must not empty a
report, and it cannot be told apart from a genuinely quiet side once it has.

The platform test is repeated here rather than assumed, because this runs on
every read path and the caller that forgets it is the one that would drop four
of the summary's five tables.
*/
func specsForSourceType(specs []reportSpec, q map[string]string) []reportSpec {
	if !platformOffersSourceType(specs) {
		return specs
	}
	role, ok := sourceTypeRoles[strings.TrimSpace(q[sourceTypeParam])]
	if !ok {
		return specs
	}
	out := make([]reportSpec, 0, len(specs))
	for _, s := range specs {
		if s.Role == role {
			out = append(out, s)
		}
	}
	// A side the platform offers but cannot fill is still the caller's answer —
	// but an EMPTY spec list reads downstream as "none of this platform's
	// tables can be read", which is a different and much more alarming
	// statement. There is no such case while the offer test above holds; this
	// is the guard that keeps it true if it ever stops holding.
	if len(out) == 0 {
		return specs
	}
	return out
}
