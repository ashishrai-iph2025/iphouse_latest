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
		label := strFromAny(r["label"])
		/* One of our own five: keyed on its band's LOWER EDGE rather than on
		   parsing the label back.

		   Two of the band labels lead with the same quantity — tatSortKey reads
		   both "15-30 min" and "30 min-1 hr" as 30, because it takes the first
		   number that carries a unit — so the parse alone leaves their order to
		   whatever the caller happened to build first.

		   The lower edge and not the band's INDEX, which is the mistake this
		   replaces: an index is 0-4 and a parsed label is a count of minutes, so
		   a list holding both kinds put "2 hr+" (index 4) ahead of "15 - 30 min"
		   (30 minutes). Both scales have to be minutes or neither is. */
		if b := canonicalTATIndex(label); b >= 0 {
			cells[i] = cell{row: r, key: sportsTATBands[b].lo, known: true}
			continue
		}
		k, ok := tatSortKey(label)
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
canonicalTATIndex is the position of one of our own band labels, or -1.

Matched on the exact label rather than by parsing, because these strings are
this file's own output and an exact match cannot be fooled by a coincidence of
spelling the way tatSortKey can.
*/
func canonicalTATIndex(label string) int {
	for i, b := range sportsTATBands {
		if b.label == label {
			return i
		}
	}
	return -1
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
		// The same fold the API path applies, for the same reason: one set of
		// bands across every platform, whichever road the panel came down. nil
		// only where the breakdown was empty, and an empty panel needs no order.
		if folded := foldTATRows(out); folded != nil {
			return folded
		}
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
sportsTATBands are the bands a live event is judged on, and they are the ONLY
bands any turnaround panel draws.

Fixed, not adaptive. The equivalent in the War Room (lib/warroom.ts) collapses
its bands against the data so no band renders under a threshold — right for a
panel someone is exploring, wrong here, where the same five bands have to mean
the same thing on every client and every platform so two reports can be read
against each other.

Every panel now reaches them by one of two roads:

	· the table carries both timestamps → bandTATRows counts real minutes into
	  them, which is the answer worth having;
	· it does not → foldTATRows folds whatever the stored TATBucket column says
	  into them.

Before the second road existed, the summary of one client's sports report drew
TEN rows — "00 - 30min", "Pending", "1hr - 2hr", "2 hr+", "2 hrs and above",
"30min - 1hr", "1-2 hr", "30 min-1 hr", "15-30 min", "0-15 min" — because each
platform's table had been banded by whoever wrote it and the summary merged the
spellings verbatim. Four of those ten are the same two bands said differently.
*/
var sportsTATBands = []tatBand{
	{"0-15 min", -1, 15},
	{"15-30 min", 15, 30},
	{"30 min-1 hr", 30, 60},
	{"1-2 hr", 60, 120},
	{"2 hr+", 120, math.Inf(1)},
}

/*
── Folding somebody else's bands into ours ───────────────────────────────────

	For the tables that cannot be measured, the stored TATBucket column is all
	there is — and every table was banded by a different hand. Rather than draw
	those spellings, each one is READ and folded into the band it belongs to.

	PLACED BY ITS UPPER EDGE, and that is the one judgement call in this file.
	"00 - 30min" spans two of our bands and there is no way to know how its
	1,011 rows divide between them. Its upper edge is 30 minutes, so the
	strongest thing the data supports is "no later than 15-30 min" — and that is
	where it goes. The other direction would have claimed those rows came down
	inside a quarter of an hour, which is a claim about enforcement performance
	that nothing in the row supports. A fold never flatters the number.

	A label that is not a duration at all — "Pending", "Unknown", a blank — is
	DROPPED. The panel's own description says it covers the URLs that have come
	down; a row still waiting has not, and it was only ever in the panel because
	the stored column had nowhere else to put it.
*/

// Every quantity in a label, not just the first: a range has two.
var tatQuantity = regexp.MustCompile(`(?i)(\d+(?:\.\d+)?)\s*(sec|second|min|minute|hr|hour|day|week|month)s?`)

// "2 hr+", "2 hrs and above", "60 min or more" — a band with no upper edge.
var tatOpenEnded = regexp.MustCompile(`(?i)(\+|\babove\b|\bplus\b|\bmore\b|\bover\b|\bonward)`)

// What separates the two edges of a range, as against the parts of one
// duration: "30 min - 1 hr" is a range, "1 hr 30 min" is ninety minutes.
var tatRangeSep = regexp.MustCompile(`(?i)(-|–|—|\bto\b|\bupto\b|\bup to\b)`)

/*
tatBandFor is the band a stored label belongs to, or -1 for a label that is not
a duration.

Lenient about spelling on purpose. This reads a column three different systems
write into, and the alternative to being lenient is a bucket silently vanishing
from the report the day somebody adds a space.
*/
func tatBandFor(label string) int {
	s := strings.ToLower(strings.TrimSpace(label))
	if s == "" {
		return -1
	}
	matches := tatQuantity.FindAllStringSubmatch(s, -1)
	if len(matches) == 0 {
		return -1
	}
	mins := make([]float64, 0, len(matches))
	for _, m := range matches {
		n, err := strconv.ParseFloat(m[1], 64)
		if err != nil {
			continue
		}
		if mult, ok := tatUnitMinutes[strings.TrimSuffix(m[2], "s")]; ok {
			mins = append(mins, n*mult)
		}
	}
	if len(mins) == 0 {
		return -1
	}

	var upper float64
	if tatRangeSep.MatchString(s) {
		// A range: the last quantity is its upper edge.
		upper = mins[len(mins)-1]
	} else {
		// One duration, possibly spelled in two units. "1 hr 30 min" is 90.
		for _, m := range mins {
			upper += m
		}
	}
	if tatOpenEnded.MatchString(s) {
		/* Open-ended: the edge is the FLOOR, not the ceiling, so nudge past it.
		   Without this "2 hr+" lands on 120 exactly, which the band below it
		   closes on (mins <= 120) — and the slowest bucket would be filed as
		   the second slowest. */
		upper = mins[len(mins)-1] + 0.001
	}

	for i, b := range sportsTATBands {
		if upper > b.lo && upper <= b.hi {
			return i
		}
	}
	// Past the last edge, which the open-ended band should already have caught.
	return len(sportsTATBands) - 1
}

/*
foldTATRows rebuilds a stored-label breakdown as the five bands.

── The case this got wrong first time ────────────────────────────────────────

	It used to return nil when NOTHING in the breakdown parsed as a duration, so
	the caller could "leave the panel as it found it" rather than assert that
	every band was empty. That reasoning was about a table storing statuses
	instead of turnarounds — a table that does not exist.

	What does exist is dashboards.SportsSourceURLRawData, whose TATBucket column
	for a live window holds exactly one value: "Pending", 4,676 rows. Nothing
	parsed, so the fold declined, the raw row passed straight through, and the
	summary merged a "Pending" band into a panel every other platform had already
	had it removed from. It was the only Pending left on the page and it looked
	like the fold had never run.

	So the fold no longer declines on its own account. A breakdown is folded into
	the five bands and anything that is not a duration is dropped — 4,676 rows of
	"Pending" leave nothing behind, which is the correct reading: nothing came
	down, so nothing has a turnaround, and the removal-rate card is where the
	outstanding work is reported.

	Where that leaves every band at zero, tatBandRows returns nil and the panel
	says "no data for this period" rather than drawing an empty ring under a
	legend of five noughts.
*/
func foldTATRows(rows []map[string]any) []map[string]any {
	if len(rows) == 0 {
		return nil
	}
	urls := make([]int64, len(sportsTATBands))
	removed := make([]int64, len(sportsTATBands))

	for _, r := range rows {
		i := tatBandFor(strFromAny(r["label"]))
		if i < 0 {
			// "Pending", "Unknown", a blank. Found, but not a turnaround.
			continue
		}
		urls[i] += numOf(r["urls"])
		removed[i] += numOf(r["removed"])
	}
	return tatBandRows(urls, removed)
}

/*
tatBandRows is the five bands as panel rows, always all five and always in
order.

An empty band is DRAWN. "Nothing took more than two hours" is a finding, and a
panel that simply omits the band says instead that the question was not asked —
which on a page comparing two platforms is the difference between a clean result
and a missing measurement. It is also what makes the summary's merge work: five
rows with the same five labels on every platform add up; a variable set does not.

── Except when every one of them is empty ───────────────────────────────────

	Then there is no panel. A window in which nothing has come down has no
	turnaround to distribute, and five zeroes drawn as a ring is a ring with no
	arc in it under a legend of five noughts — which reads as a broken chart
	rather than as a finding. "No data for this period" is what the card says
	instead, and it is true.

	This costs the summary nothing: a platform contributing five zeroes and one
	contributing nothing add up the same.
*/
func tatBandRows(urls, removed []int64) []map[string]any {
	empty := true
	for i := range urls {
		if urls[i] != 0 || removed[i] != 0 {
			empty = false
			break
		}
	}
	if empty {
		return nil
	}

	out := make([]map[string]any, 0, len(sportsTATBands))
	for i, b := range sportsTATBands {
		out = append(out, map[string]any{
			/* No `value`. A band is computed rather than stored, so there is
			   nothing in the warehouse a click could narrow to — see the note on
			   the turnaround filter in reportplatforms.go. */
			"label": b.label,
			"urls":  urls[i], "removed": removed[i],
		})
	}
	return out
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

/*
The removal timestamp, in the spellings the sports tables use.

InfringingRemovalTime and SourceRemovalTime are the mobile-apps pair, and they
are why that report's turnaround panel was empty rather than wrong: the table
carries DiscoveryDoneAt and both of those, has no TATBucket column at all, so
the panel fell through to a dimension the dataset does not offer and drew
nothing. The infringing lane is preferred — a download link is the thing the
listing exists to serve, and it is the removal the rest of that report counts.
*/
var tatRemovedCols = []string{
	"RemovalTime", "InfringingRemovalTime", "SourceRemovalTime", "RemovalDate", "RemovedAt",
}

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

	for _, r := range rows {
		mins, ok := tatMinutes(r, foundCol, removedCol)
		if !ok {
			/* Not removed yet, or removed before it was found. Neither is a
			   turnaround, and neither is in this panel.

			   "Pending" used to be a sixth row here, on the reasoning that a
			   chart of only the successes reports the fastest numbers the data
			   can produce. That reasoning still holds and the row is still gone,
			   for two better ones: this panel's own description says it covers
			   the URLs that HAVE come down, so the row contradicted the card it
			   was on; and a "Pending" that exists on the two tables carrying
			   timestamps and not on the six that do not made the summary's
			   pending figure a fact about which tables have a RemovalTime
			   column. What is outstanding is the removal-rate card's subject,
			   and it answers it over the whole report rather than over one. */
			continue
		}
		for i, b := range sportsTATBands {
			if mins > b.lo && mins <= b.hi {
				counts[i]++
				break
			}
		}
	}

	// Every row in a measured band has, by definition, come down, so the two
	// series carry the same count.
	return tatBandRows(counts, counts)
}
