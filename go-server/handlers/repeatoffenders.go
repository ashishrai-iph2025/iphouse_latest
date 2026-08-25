package handlers

/*
Repeat offenders — the channels and profiles that keep coming back.

Every other channel panel on a report ranks by VOLUME: which account posted the
most infringing links in the window. That is one question, and it is not the one
enforcement asks second. A channel that dumped four thousand links on a single
match day and was then suspended is a solved problem; one that posts sixty links
every Saturday for eleven weeks is an ongoing one, and on a top-ten by volume it
sits below the first and looks smaller.

So this panel ranks by RECURRENCE instead — how many DISTINCT DAYS the same
channel or profile URL was identified on. Distinct days, not rows and not
timestamps: two hundred URLs found in one afternoon is one day's work by one
account, and counting the timestamps would rank the busiest single session as
the most persistent offender. The gaps do not matter either — consecutive days,
every Saturday, or one day a month all count the same, because each one is the
account being caught again after it was already known.

The identity is the URL, never the name. A display name is editable, repeats
across platforms and is frequently blank; the channel or profile URL is the
account. Two accounts calling themselves "Sports HD Live" are two offenders, and
merging them on the name would report one as twice as persistent as either.

Rows seen on only ONE day are dropped (minRepeatDays). They are not repeat
offenders, and with them in the list a window where nothing recurred would draw
ten single-day bars under a title promising the opposite — an empty panel is the
honest answer there, and the page says why it is empty.

Two paths compute this, because the report engine has two backends:

  - Direct SQL — one GROUP BY with COUNT(DISTINCT DATE(...)); see
    repeatOffenderSQL in reportsrun.go.
  - reports_api — the service answers with named measures and has no measure for
    "distinct days per group", so it is computed from the raw rows the bridge
    already pages for this dataset. See computeRepeatOffenders.

Both produce the same row shape as every other breakdown, plus `repeats`.
*/

import (
	"sort"
	"strings"
)

/*
dimRepeatOffender is the panel key, mirrored by DIM_FILTER and the render switch
in app/admin/reports/page.tsx.
*/
const dimRepeatOffender = "byRepeatOffender"

/*
repeatOffenderLimit is how many rows the panel draws.

Ten, and the title says so. The eleventh most persistent account is not a
different kind of finding from the tenth, and a card that scrolls is a card
nobody reaches the bottom of.
*/
const repeatOffenderLimit = 10

/*
minRepeatDays is what makes an offender a REPEAT offender.

Two distinct days is the smallest number that means "came back". At one, the
panel is only the channel list again in a different order.
*/
const minRepeatDays = 2

/*
repeatURLColumns are the spellings this warehouse gives the account's URL, most
specific first — the same ordered-candidate convention the rest of the column
inference in reportplatforms.go uses, and read by the dimension candidate there
as its Column plus Alts.

Kept beside the code that counts them rather than only in that candidate list,
because which column identifies an account is what this whole file is about: a
table that spells it some fourth way gets its panel by having the spelling added
here, and nothing else changes.
*/
var repeatURLColumns = []string{
	"ChannelURL", "ProfileURL", "ChannelOrProfileURL", "ChannelProfileURL",
}

/*
repeatMeasureColumns are the columns a PRE-AGGREGATED table counts with.

A raw table is one URL per row, so identified is the row count. A daily rollup
is not: Agg_Daily_Youtube_MasterNew carries ChannelURL — so it gets this panel —
and one row of it stands for a whole day's TotalCount. Counting rows there would
report a channel with 40,000 infringements as having 30, under a chart whose
other bars are honest counts.

The pair is resolved from the same measurePairs the spec inference uses (see
inferSpec in reportplatforms.go), so the panel and the KPI band above it count
with the same columns or with neither.

Empty strings mean a raw table: count rows, and read the removal off the status
column. That is the common case and the one the sports social report takes.
*/
func repeatMeasureColumns(columns []string) (ident, removed string) {
	for _, pair := range measurePairs {
		if got := firstColumnOf(columns, []string{pair[0]}); got != "" {
			return got, firstColumnOf(columns, []string{pair[1]})
		}
	}
	return "", ""
}

/*
firstColumnOf picks the first candidate a column list actually has, matched
case-insensitively, and answers with the list's own spelling of it.

The API-side twin of tableShape.firstOf: a dataset's catalogue gives column
NAMES rather than an information_schema row, and the two sides disagree about
case often enough that an exact match silently loses the column.
*/
func firstColumnOf(columns, candidates []string) string {
	have := make(map[string]string, len(columns))
	for _, c := range columns {
		have[strings.ToLower(strings.TrimSpace(c))] = strings.TrimSpace(c)
	}
	for _, want := range candidates {
		if got, ok := have[strings.ToLower(want)]; ok {
			return got
		}
	}
	return ""
}

/*
rowRemoved says whether one raw row came down.

RemovalStatus first, because that is the column the sports tables carry and the
one rowmetrics.go already counts removals from — same column, same
case-insensitive 'Dead' match, so this panel's orange bars and the KPI tile
above them cannot disagree. IsRemoved is the raw open-web tables' spelling, and
is only consulted where there is no status column at all.

A table with neither answers "no", which draws the panel with its removed series
flat at zero rather than dropping the panel: the recurrence figure is the point
of the card and it is still correct.
*/
func rowRemoved(r map[string]any) bool {
	if v, ok := r[colRemovalStatus]; ok {
		return isDead(v)
	}
	if v, ok := r["IsRemoved"]; ok {
		return numOf(v) == 1
	}
	return false
}

// repeatTally is one account's running figures during the walk.
type repeatTally struct {
	urls    int64
	removed int64
	// A SET of days rather than a counter: the measure is how many distinct
	// days the account appeared on, and rows arrive in no particular order and
	// many to a day.
	days map[string]bool
}

/*
computeRepeatOffenders builds the panel from raw rows.

`urlCol` identifies the account and `dateCol` is the column the report's days are
bucketed by. `identCol` and `removedCol` are the pre-aggregated table's count
columns, empty on a raw one — where identified is the row count and a removal is
read off the row's status. Passing all four in rather than resolving them here
keeps this a counter: which columns to read is the caller's business, and the two
backends resolve them from different catalogues.

The DAY count is unaffected by any of that. A rollup already holds one row per
account per day, and a raw table holds many — collecting the dates into a set
gives the same answer for both, which is the point of counting them that way.
*/
func computeRepeatOffenders(rows []map[string]any, urlCol, dateCol, identCol, removedCol string, limit int) []map[string]any {
	if urlCol == "" {
		return []map[string]any{}
	}
	if limit <= 0 {
		limit = repeatOffenderLimit
	}

	tally := map[string]*repeatTally{}
	for _, r := range rows {
		url := strings.TrimSpace(strFromAny(r[urlCol]))
		if url == "" {
			continue
		}
		t := tally[url]
		if t == nil {
			t = &repeatTally{days: map[string]bool{}}
			tally[url] = t
		}
		if identCol == "" {
			t.urls++
		} else {
			t.urls += numOf(r[identCol])
		}
		switch {
		case removedCol != "":
			t.removed += numOf(r[removedCol])
		case rowRemoved(r):
			t.removed++
		}
		if dateCol == "" {
			continue
		}
		/* The DATE, with any time cut off. URLUploadDate is a datetime on some
		   of these tables, and keeping the time would make every row its own
		   "day" — which turns the recurrence count into the row count and ranks
		   the busiest single session as the most persistent account. */
		if day := dayKey(strFromAny(r[dateCol])); day != "" {
			t.days[day] = true
		}
	}

	out := make([]map[string]any, 0, len(tally))
	for url, t := range tally {
		if len(t.days) < minRepeatDays {
			continue
		}
		out = append(out, map[string]any{
			"label": url, "value": url,
			"urls": t.urls, "removed": t.removed,
			"repeats": int64(len(t.days)),
		})
	}
	sortRepeatRows(out)
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}

/*
sortRepeatRows puts the panel in the order it is read in: most days first, then
the heavier account, then the URL.

Volume breaks the first tie rather than leaving it to map order, because two
accounts seen on the same eleven days are not equally interesting — and the URL
breaks that one, so a report run twice over the same window draws the same
chart rather than reshuffling its ties.
*/
func sortRepeatRows(rows []map[string]any) {
	sort.SliceStable(rows, func(i, j int) bool {
		if a, b := numOf(rows[i]["repeats"]), numOf(rows[j]["repeats"]); a != b {
			return a > b
		}
		if a, b := numOf(rows[i]["urls"]), numOf(rows[j]["urls"]); a != b {
			return a > b
		}
		return strFromAny(rows[i]["label"]) < strFromAny(rows[j]["label"])
	})
}
