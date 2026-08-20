package handlers

/*
Removals counted from the rows, for the datasets whose service cannot count them.

reports_api answers with the measures a dataset declares, and the sports social
dataset declares identified, platforms, views, likes, comments, subscribers,
viewsSaved and assets — no `removed`. So every removal figure on that report came
back zero: the KPI tile, the removal rate, the orange series on every panel. Not
"no removals happened" — nobody was ever asked.

The signal is on the ROW: RemovalStatus says whether that infringement came down,
and RemovalProfileStatus says whether the account behind it was suspended. Both
are columns, not measures, so an aggregate cannot reach them and the rows have
to be read. They already are — the turnaround bands need the same rows — so this
costs nothing beyond the arithmetic.

Measured against the live warehouse for one client, year to date:

	identified          41,979   (unchanged)
	removed             15,645   was 0
	removal rate        37.27%   was 0%
	profiles suspended   1,598   absent
	impacted subs    1,373,746   was 2,075,583,505

That last line is the one to look at twice. The old figure summed Subscribers
over every row, and the same profile appears on many rows — so it was counting
one account's audience once per post it made. Three orders of magnitude, on a
tile presented as a fact about reach.
*/

import (
	"strings"

	"github.com/ip-house/iphouse-api/reportsapi"
)

/*
The warehouse's spelling for "this came down".

Compared case-INSENSITIVELY, which is not defensive coding: one client's rows
carry 13,267 'Dead' and 2,378 'DEAD'. An exact match drops fifteen per cent of
the removals and reports the result as the removal rate.
*/
const removalDead = "dead"

func isDead(v any) bool {
	return strings.EqualFold(strings.TrimSpace(strFromAny(v)), removalDead)
}

// The columns this reads, in the spellings the sports tables use.
const (
	colRemovalStatus = "RemovalStatus"
	colProfileStatus = "RemovalProfileStatus"
	colProfileURL    = "ProfileURL"
	colSubscriberCnt = "Subscribers"
)

/*
needsRowRemovals answers whether a dataset has to be counted this way.

Both halves matter. A dataset that DECLARES a removed measure is answered by the
service, which is faster and authoritative — this must never override it. A
dataset that declares none and carries no RemovalStatus either genuinely cannot
say, and is left alone rather than reported as zero removals out of zero.
*/
func needsRowRemovals(ds reportsapi.Dataset) bool {
	return !ds.HasMeasure("removed") && hasColumn(ds, colRemovalStatus)
}

/*
removalStatusFilter is the dimension key that filters a query to the rows that
came down, when the dataset offers one.

This is what makes the removal figures affordable. Counting them from the raw
rows was correct but expensive — the whole window has to be paged, nine requests
for one client's year — and it sat on the critical path of every uncached
report. A dataset that can FILTER on removal status answers the same question as
an ordinary aggregate: one 446ms call, verified against the row count at 15,645
either way.

Rows are still read where the question genuinely needs them — see
hasProfileColumns — because "how many distinct accounts, and what audience did
the largest of each have" is not something the service can be asked.
*/
func removalStatusFilter(ds reportsapi.Dataset) (string, bool) {
	if ds.HasMeasure("removed") {
		return "", false
	}
	for _, d := range ds.Dimensions {
		if strings.EqualFold(d.Column, colRemovalStatus) {
			return d.Key, true
		}
	}
	return "", false
}

/*
removalDeadValue is what to filter that dimension by.

'Dead' rather than 'DEAD' with no case handling, deliberately: the warehouse
stores both, and its collation is case-insensitive — a breakdown by removal
status returns ONE bucket of 15,645, not 13,267 and 2,378. Verified against this
warehouse rather than assumed, because if the collation were ever case-sensitive
this filter would silently drop fifteen per cent of the removals.
*/
const removalDeadValue = "Dead"

func hasColumn(ds reportsapi.Dataset, col string) bool {
	for _, c := range ds.Columns {
		if strings.EqualFold(strings.TrimSpace(c), col) {
			return true
		}
	}
	return false
}

// rowMetrics is everything the rows can say that the aggregates could not.
type rowMetrics struct {
	removed int64
	// Keyed by the dataset's date column value, to patch the daily series.
	removedByDay map[string]int64
	// column → grouping value → removals, to patch each breakdown's orange
	// series. Keyed by the column the SERVICE grouped by, which is not always
	// the column the portal asked for — see rowMetricsFor.
	removedByCol map[string]map[string]int64

	profilesSuspended   int64
	impactedSubscribers int64
}

/*
hasProfileColumns answers whether a dataset can report on suspended ACCOUNTS at
all.

Asked of the dataset rather than of the rows, so a client with no suspensions in
the window shows the tile at zero — which is a finding — instead of the tile
disappearing, which reads as "this report does not measure that".
*/
func hasProfileColumns(ds reportsapi.Dataset) bool {
	return hasColumn(ds, colProfileStatus) && hasColumn(ds, colProfileURL)
}

/*
groupValue reproduces how the service labels a grouping value.

It groups on COALESCE(NULLIF(CAST(col AS CHAR), ”), '(none)'), so a null or
empty column arrives as the literal "(none)". Counting removals under "" while
the breakdown filed its rows under "(none)" would leave that row's orange bar at
zero — the one bar most likely to be large.
*/
func groupValue(v any) string {
	s := strings.TrimSpace(strFromAny(v))
	if s == "" {
		return "(none)"
	}
	return s
}

/*
computeRowMetrics walks the rows once.

`dateCol` is the column the daily series is bucketed by; `groupCols` are the
columns the breakdowns group by. Passing them in rather than deriving them here
keeps this a counter — what to count is the caller's business.
*/
func computeRowMetrics(rows []map[string]any, dateCol string, groupCols []string) rowMetrics {
	m := rowMetrics{
		removedByDay: map[string]int64{},
		removedByCol: make(map[string]map[string]int64, len(groupCols)),
	}
	for _, c := range groupCols {
		m.removedByCol[c] = map[string]int64{}
	}

	/* The audience of a suspended account, counted ONCE.

	   The same profile appears on every post it made, carrying its subscriber
	   count each time. Summing the column adds that audience once per post; the
	   figure wanted is the audience itself, so the profiles are collected here
	   and added up after the walk.

	   MAX rather than first-seen: the count is a snapshot taken when the row was
	   written, so the same profile carries different numbers on different rows,
	   and the largest is the one that reflects the account at its reach. */
	var profileSubs map[string]int64

	for _, r := range rows {
		if isDead(r[colRemovalStatus]) {
			m.removed++
			if dateCol != "" {
				if d := strings.TrimSpace(strFromAny(r[dateCol])); d != "" {
					// The service buckets a day as a date; a datetime column
					// would carry a time here that no bucket would match.
					if len(d) > 10 {
						d = d[:10]
					}
					m.removedByDay[d]++
				}
			}
			for _, c := range groupCols {
				m.removedByCol[c][groupValue(r[c])]++
			}
		}

		/* The PROFILE's status, which is a different question from the post's.
		   A post can come down while the account stays up, and an account can be
		   suspended with its posts still listed — so this is counted from its
		   own column rather than inferred from the one above. */
		if isDead(r[colProfileStatus]) {
			url := strings.TrimSpace(strFromAny(r[colProfileURL]))
			if url == "" {
				continue
			}
			if profileSubs == nil {
				profileSubs = map[string]int64{}
			}
			subs := numOf(r[colSubscriberCnt])
			if cur, seen := profileSubs[url]; !seen || subs > cur {
				profileSubs[url] = subs
			}
		}
	}

	for _, subs := range profileSubs {
		m.impactedSubscribers += subs
	}
	m.profilesSuspended = int64(len(profileSubs))
	return m
}

/*
dateColOf is the column a dataset's daily series is bucketed by.

The catalogue names the PARAMETER (URLUploadDateFrom / URLUploadDateTo) rather
than the column, so the column is the parameter with the range suffix taken off
— which is how every sports dataset spells the pair. Where it cannot be worked
out the daily removals are simply not filed by day, and the series keeps what
the service gave it.
*/
func dateColOf(ds reportsapi.Dataset) string {
	for _, p := range []string{ds.DateParam, ds.DateFromParam} {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		for _, suffix := range []string{"From", "To"} {
			p = strings.TrimSuffix(p, suffix)
		}
		if p != "" && hasColumn(ds, p) {
			return p
		}
	}
	return ""
}

/*
dayKey normalises a bucket to the date the rows are filed under.

The service buckets a day and returns it as a date, but a grain other than day —
or a datetime bucket — would carry a time that no row key would match, and every
bar would silently read zero.
*/
func dayKey(bucket string) string {
	b := strings.TrimSpace(bucket)
	if len(b) > 10 {
		b = b[:10]
	}
	return b
}
