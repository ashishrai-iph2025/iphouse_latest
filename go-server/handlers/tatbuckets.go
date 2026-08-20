package handlers

// Turnaround buckets, put in the order a reader expects to see them.
//
// A turnaround panel is drawn as an ORDERED ramp — see the `share` and
// `ordinal` shapes in reportvizprefs.go — and an ordered ramp whose rows are not
// in order is worse than a plain bar list, because the shading asserts a
// sequence the labels contradict.
//
// The bucket values arrive as free text from whatever computed them: the
// warehouse's TATBucket column today, and whatever a later one puts there. They
// come back in the order the aggregate produced, which is by volume or by
// string — and neither is duration. With day-scale labels that was survivable,
// since "0-20 days" and "Pending" happen to sort correctly either way. With
// minute-scale labels it is not: sorted as strings, 0-15 min, 1hr-2hr,
// 15-30 min, 2hr+, 30min-1hr is the order, and every one of those neighbours is
// wrong.
//
// So the label is READ rather than compared. Whatever spelling the upstream
// picks — "0-15 min", "0-15min", "15 to 30 minutes", "1hr-2hr", "2 hr+" — the
// leading quantity and its unit are what the row is placed by.

import (
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

/*
tatLeading finds the first quantity and unit in a bucket label.

Deliberately lenient about the separator and the unit's spelling. This parses
somebody else's column, and the alternative to being lenient is a panel that
silently mis-orders itself the day a label gains a space.
*/
var tatLeading = regexp.MustCompile(`(?i)(\d+(?:\.\d+)?)\s*(min|minute|hr|hour|day|week|month|sec|second)`)

// Minutes per unit, so every bucket is compared on one scale.
var tatUnitMinutes = map[string]float64{
	"sec": 1.0 / 60, "second": 1.0 / 60,
	"min": 1, "minute": 1,
	"hr": 60, "hour": 60,
	"day": 60 * 24, "week": 60 * 24 * 7, "month": 60 * 24 * 30,
}

/*
tatSortKey is where a bucket sits on the time axis, in minutes.

`ok` is false for a value that is not a duration at all — "Pending", "(none)",
an empty cell. Those are NOT zero: a row still waiting has the longest
turnaround there is, and sorting it first would put the worst outcome at the
head of a ramp that reads best-to-worst.
*/
func tatSortKey(label string) (float64, bool) {
	s := strings.ToLower(strings.TrimSpace(label))
	if s == "" {
		return 0, false
	}
	m := tatLeading.FindStringSubmatch(s)
	if m == nil {
		return 0, false
	}
	n, err := strconv.ParseFloat(m[1], 64)
	if err != nil {
		return 0, false
	}
	unit := strings.TrimSuffix(m[2], "s")
	mult, ok := tatUnitMinutes[unit]
	if !ok {
		return 0, false
	}
	return n * mult, true
}

/*
sortTATRows orders turnaround rows shortest-first, with anything that is not a
duration left at the end in the order it arrived.

Stable, so two buckets that parse to the same start — which should not happen,
but does the moment an upstream emits both "1hr-2hr" and "60-120 min" — keep the
order the aggregate gave them rather than swapping about between requests.
*/
func sortTATRows(rows []map[string]any) {
	if len(rows) < 2 {
		return
	}
	type cell struct {
		row   map[string]any
		key   float64
		known bool
	}
	cells := make([]cell, len(rows))
	for i, r := range rows {
		k, ok := tatSortKey(strFromAny(r["label"]))
		cells[i] = cell{row: r, key: k, known: ok}
	}
	sort.SliceStable(cells, func(a, b int) bool {
		ca, cb := cells[a], cells[b]
		// A non-duration ("Pending") always trails the measured buckets, and
		// SliceStable keeps several of them in the order they arrived.
		if ca.known != cb.known {
			return ca.known
		}
		if !ca.known {
			return false
		}
		return ca.key < cb.key
	})
	for i, c := range cells {
		rows[i] = c.row
	}
}

/*
dimTAT is the turnaround panel's key. A constant because the registry, both
query paths and the summary all have to agree on it, and a typo in any one of
them is a panel that silently keeps the wrong order.
*/
const dimTAT = "byTAT"

/*
sortedDimRows maps a breakdown result and puts it in order, for the direct-SQL
path.

The query already sorts by volume, which is right for every dimension except
this one — a distribution over an ordered axis is read along the axis.
*/
func sortedDimRows(key string, rows []map[string]any) []map[string]any {
	out := mapRows(rows, "label", "value", "urls", "removed")
	if key == dimTAT {
		sortTATRows(out)
	}
	return out
}

/*
── Recomputing the buckets, where the data allows it ─────────────────────────

	TATBucket is bucketed by whatever wrote it, and what wrote it was the
	takedown flow: "0-20 days", "Pending". On an open-web notice that is the
	right grain — a host takes days to answer. On a live sports stream it is
	useless, because the whole event is over inside two hours and every row
	lands in the first bucket or in "Pending".

	So where the dataset also carries the turnaround as a NUMBER, the panel is
	built from that instead: group by the raw column, then fold the values into
	fixed bands. Folding a full breakdown in memory rather than asking the
	service for bands is the same shape as the hostname panels — see
	domainroot.go — and for the same reason: the banding is a product decision
	and belongs where it can change without redeploying the service every other
	report depends on.

	Where the dataset carries no such column the panel is left exactly as it was.
	This is additive: a table with only TATBucket shows what it always showed.
*/

// tatBand is one band on the time axis: lo < minutes <= hi.
type tatBand struct {
	label  string
	lo, hi float64
}

/*
sportsTATBands are the bands a live event is judged on.

Fixed, not adaptive. The equivalent in the War Room (lib/warroom.ts) collapses
its bands against the data so no band renders under a threshold — right for a
panel someone is exploring, wrong here, where the same five bands have to mean
the same thing on every client and every platform so two reports can be read
against each other.
*/
var sportsTATBands = []tatBand{
	{"0-15 min", -1, 15},
	{"15-30 min", 15, 30},
	{"30 min-1 hr", 30, 60},
	{"1-2 hr", 60, 120},
	{"2 hr+", 120, math.Inf(1)},
}

/*
── Where the minutes come from ───────────────────────────────────────────────

	Two timestamps on the row: DiscoveryDoneAt, when we first saw it, and
	RemovalTime, when it came down. Their difference is the turnaround, and it is
	the number this panel is about.

	It has to be computed HERE, on rows, rather than asked for as an aggregate.
	reports_api groups by columns, and while both timestamps are on the row there
	is no dimension over the INTERVAL between them — so no breakdown can produce
	it. Reading the rows and subtracting is what the service's shape allows.

	Verified against the live warehouse: a DAZN post discovered at 10:37:32 and
	removed at 11:22:02 is a forty-four minute turnaround, and TATBucket filed it
	under "0-20 days". That single row is the whole reason this file exists — the
	stored column is not a coarser answer to the same question, it is an answer to
	a different one.
*/

// The two timestamps, in the spellings the sports tables use. Both are needed;
// a table carrying one of them can say when something happened but not how long
// it took.
var tatFoundCols = []string{"DiscoveryDoneAt", "URLUploadDate"}
var tatRemovedCols = []string{"RemovalTime", "RemovalDate", "RemovedAt"}

/*
tatTimeCols picks the pair a dataset carries, if it carries one.

DiscoveryDoneAt is preferred over URLUploadDate where both exist, and the
difference is not cosmetic: the upload date is a DATE, so every turnaround
computed from it would be a whole number of days — which is how the panel came
to be in days in the first place.
*/
func tatTimeCols(columns []string) (found, removed string, ok bool) {
	have := make(map[string]string, len(columns))
	for _, c := range columns {
		have[strings.ToLower(strings.TrimSpace(c))] = c
	}
	pick := func(cands []string) string {
		for _, c := range cands {
			if actual, hit := have[strings.ToLower(c)]; hit {
				return actual
			}
		}
		return ""
	}
	found, removed = pick(tatFoundCols), pick(tatRemovedCols)
	// A found time with no removal time cannot measure anything. Saying so is
	// what keeps the panel on its stored column instead of showing every row as
	// Pending, which would read as a total enforcement failure.
	return found, removed, found != "" && removed != ""
}

/*
tatTimeLayouts are how the service writes a timestamp.

RFC3339 is what /v1/sports/{dataset} returns ("2025-06-03T10:37:32Z"); the
others are what a direct warehouse read gives, and cost nothing to accept.
*/
var tatTimeLayouts = []string{
	time.RFC3339, "2006-01-02T15:04:05", "2006-01-02 15:04:05", "2006-01-02",
}

func parseTATTime(v any) (time.Time, bool) {
	s := strings.TrimSpace(strFromAny(v))
	if s == "" || strings.EqualFold(s, "null") {
		return time.Time{}, false
	}
	for _, layout := range tatTimeLayouts {
		if t, err := time.Parse(layout, s); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

/*
tatMinutes is one row's turnaround.

`measured` is false for a row that has not been removed — which is not zero
minutes and not an error, but the third outcome this panel has to show.
*/
func tatMinutes(row map[string]any, foundCol, removedCol string) (float64, bool) {
	found, okF := parseTATTime(row[foundCol])
	removed, okR := parseTATTime(row[removedCol])
	if !okF || !okR {
		return 0, false
	}
	d := removed.Sub(found)
	if d < 0 {
		/* Removed before it was found. That is a clock or a backfill upstream,
		   not an instant takedown, and counting it in the fastest band would
		   flatter the number this panel exists to report. */
		return 0, false
	}
	return d.Minutes(), true
}

/*
bandTATRows counts rows into the bands.

Every row in a measured band has, by definition, been removed — so `removed`
carries the same count as `urls`, which is what the panel's Identified/Removed
pair means here.
*/
func bandTATRows(rows []map[string]any, foundCol, removedCol string) []map[string]any {
	counts := make([]int64, len(sportsTATBands))
	var pending int64

	for _, r := range rows {
		mins, ok := tatMinutes(r, foundCol, removedCol)
		if !ok {
			pending++
			continue
		}
		for i, b := range sportsTATBands {
			if mins > b.lo && mins <= b.hi {
				counts[i]++
				break
			}
		}
	}

	out := make([]map[string]any, 0, len(sportsTATBands)+1)
	for i, b := range sportsTATBands {
		out = append(out, map[string]any{
			// value is what a click filters on. A band is computed, not stored,
			// so it filters on its own label — this panel is a distribution to
			// read rather than a slicer into the warehouse.
			"label": b.label, "value": b.label,
			"urls": counts[i], "removed": counts[i],
		})
	}
	/* Kept, and kept LAST. A stream nobody has taken down yet is the most
	   important row on this panel, and a turnaround chart covering only the
	   successes would report the fastest numbers the data can produce. */
	if pending > 0 {
		out = append(out, map[string]any{
			"label": "Pending", "value": "Pending", "urls": pending, "removed": int64(0),
		})
	}
	return out
}
