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

Profiles that never came back after a takedown are dropped (minRepeatOffences).
They are not repeat
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
	"time"
)

/*
dimRepeatOffender is the panel key, mirrored by DIM_FILTER and the render switch
in app/admin/reports/page.tsx.
*/
const dimRepeatOffender = "byRepeatOffender"

/*
repeatPlatformParam narrows THIS PANEL and nothing else.

Every other slicer on the page is global: it narrows the scope, so the KPI band,
the trends and all twenty panels move together. This one does not, and that is
the point of it — the question is "which accounts keep coming back ON TIKTOK",
asked without taking the rest of the report off the platforms it covers.

It is therefore kept OUT of knownFilterParams and out of every spec's Filters:
specHonoursFilters must not drop a spec over it, and apiScope must not send it to
reports_api, because the service would narrow the whole query. It travels in the
request scope, is read in the one branch that builds this panel, and is applied
to the RAW ROWS before they are tallied — which is possible only because this
panel is counted here rather than aggregated by the warehouse.

An unrecognised value leaves the panel whole, the same direction every other
slicer fails in.
*/
const repeatPlatformParam = "repeatPlatform"

// The column it reads. Only the social tables carry it; a platform without one
// is offered no such slicer.
const colPlatform = "Platform"

/*
filterRowsByPlatform narrows raw rows to one platform.

Compared case-insensitively against the column's own value, because the slicer's
options are built from that column and a caller may still type one by hand.
Empty selector returns the rows untouched rather than an empty slice — see the
note on repeatPlatformParam.
*/
func filterRowsByPlatform(rows []map[string]any, platform string) []map[string]any {
	want := strings.TrimSpace(platform)
	if want == "" {
		return rows
	}
	out := make([]map[string]any, 0, len(rows))
	for _, r := range rows {
		if strings.EqualFold(strings.TrimSpace(strFromAny(r[colPlatform])), want) {
			out = append(out, r)
		}
	}
	/* A selection that matches nothing leaves the panel as it was. The values
	   come from this same column so it should not happen; when it does, it is a
	   stale bookmark, and an empty card cannot be told apart from an account
	   list that genuinely has no repeats. */
	if len(out) == 0 {
		return rows
	}
	return out
}

/*
repeatOffenderLimit is how many rows the panel draws.

Ten, and the title says so. The eleventh most persistent account is not a
different kind of finding from the tenth, and a card that scrolls is a card
nobody reaches the bottom of.
*/
const repeatOffenderLimit = 10

/*
── WHAT MAKES AN OFFENDER A REPEAT OFFENDER ─────────────────────────────────

	One completed cycle: content went up, we got it removed, and MORE content
	went up on the same profile afterwards. That last upload is the repeat, and
	minRepeatOffences is how many of them the panel insists on before it will
	draw a row.

	One is enough. Coming back once after a takedown is already the behaviour
	this card exists to name, and a bar of one is a true statement about a
	profile that ignored an enforcement.

	── WHAT THIS REPLACED, AND WHY ──────────────────────────────────────────

	It used to be two distinct DAYS — COUNT(DISTINCT DATE(URLUploadDate)) >= 2
	— which is a different claim and a weaker one. It ranked by how often a
	profile was busy, not by whether it defied enforcement, so the top of the
	chart was whoever posted on the most days regardless of what happened to
	them. Measured on one client's window: the third-ranked account had posted
	across three days and had never once been taken down, while an account
	removed twenty-three times and back twenty-three times read as a "5".

	It also could not see a profile that posted ten times in one afternoon,
	because the whole afternoon was one day. Same-day repetition is the
	commonest shape there is on social, and the measure was blind to it.
*/
const minRepeatOffences = 1

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
/*
repeatRemovalTimeColumns are the spellings of WHEN a row came down.

The repeat count is built on this column: without it there is no line to measure
"uploaded afterwards" against. Ordered like every other candidate list here, and
a table carrying none of them gets no panel rather than a panel of zeroes.
*/
var repeatRemovalTimeColumns = []string{
	"RemovalTime", "RemovalDate", "RemovalDoneAt",
}

/*
distinctColOf recovers the column from a "COUNT(DISTINCT X)" expression.

The SQL path needs the expression and the API path needs the bare column, and
building both separately is how the two come to disagree about which column a
panel counts. One source, read two ways.

Anything that is not that shape yields nothing, so a hand-written expression
cannot be silently misread as a column name.
*/
func distinctColOf(expr string) string {
	const open = "COUNT(DISTINCT "
	e := strings.TrimSpace(expr)
	if !strings.HasPrefix(e, open) || !strings.HasSuffix(e, ")") {
		return ""
	}
	return strings.TrimSpace(e[len(open) : len(e)-1])
}

// repeatRemovalTimeColumn picks the spelling a column list actually has.
func repeatRemovalTimeColumn(columns []string) string {
	return firstColumnOf(columns, repeatRemovalTimeColumns)
}

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
	/* ONE ENTRY PER REQUEST, keyed on the upload stamp.

	   URLs that went up at the same moment are one submission, not several
	   offences — a crawl that finds twelve posts in one sweep has found one
	   piece of behaviour. Keying the map on the stamp collapses them, and the
	   value is the LATEST removal within that batch: the request is not
	   answered until its last URL is down, so that is the moment a later
	   upload has to beat to count as a comeback. */
	batches map[time.Time]time.Time
	/* Whether the PROFILE itself was suspended, as against its posts being
	   removed. Any row saying so is enough — a profile does not come back from
	   Dead, so one row carrying it is the account's final state however many
	   earlier rows were written while it was still up. */
	profileDead bool
}

/*
repeatOffences is how many requests arrived AFTER a takedown had landed.

The earliest removal across all of a profile's batches is the line: everything
uploaded after it is a comeback, whether it came back the same afternoon or a
week later. Each request counts once however many URLs it carried.

A profile nothing has ever been removed from scores zero — correctly. It may be
the client's worst problem, but it is not a REPEAT offender, and the card beside
this one already ranks by volume.
*/
func (t *repeatTally) repeatOffences() int64 {
	var first time.Time
	for _, removed := range t.batches {
		if removed.IsZero() {
			continue
		}
		if first.IsZero() || removed.Before(first) {
			first = removed
		}
	}
	if first.IsZero() {
		return 0
	}
	var n int64
	for uploaded := range t.batches {
		if uploaded.After(first) {
			n++
		}
	}
	return n
}

/*
profileStatusLabel is what the panel prints for the account's own state.

Two words, because there are only two states a reader can act on and the
warehouse's vocabulary does not say either of them plainly. 'Dead' is the
suspension; ANYTHING ELSE — 'Active', an empty string, a column this table does
not have — is the absence of one, and they are folded together deliberately:
"Active" and "we were never told" are the same amount of evidence that the
account is still up, and printing them differently invites a reader to trust one
of them more than the other.
*/
func profileStatusLabel(dead bool) string {
	if dead {
		return "Suspended"
	}
	return "Not Available"
}

/*
computeRepeatOffenders builds the panel from raw rows.

`urlCol` identifies the account and `dateCol` is the upload stamp. `identCol`
and `removedCol` are the pre-aggregated table's count columns, empty on a raw one
— where identified is the row count and a removal is read off the row's status.
Passing them in rather than resolving them here keeps this a counter: which
columns to read is the caller's business, and the two backends resolve them from
different catalogues.

`removalTimeCol` is WHEN a row came down, and it is what the repeat count is
built on. Without it there is no line to measure "afterwards" against, and the
panel reports every profile as having no repeats — which is why it is checked
for and reported rather than quietly defaulted.

A ROLLUP CANNOT ANSWER THIS. A daily aggregate holds one row per account per day
with no removal stamp on it, so its batches have no removal times and every
profile scores zero. That is honest — the table genuinely cannot say when
anything came down — and the caller gets an empty panel rather than a wrong one.
*/
func computeRepeatOffenders(rows []map[string]any, urlCol, dateCol, identCol, removedCol, removalTimeCol string, limit int) []map[string]any {
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
			t = &repeatTally{batches: map[time.Time]time.Time{}}
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
		// The profile's own state, from whichever row carries it.
		if isDead(r[colProfileStatus]) {
			t.profileDead = true
		}

		if dateCol == "" || removalTimeCol == "" {
			continue
		}
		/* The FULL stamp, time included — the opposite of what the day count
		   needed. Two uploads at the same moment are one request and collapse
		   onto one key; two an hour apart are two requests, and the second can
		   be a comeback if a removal landed between them. Cutting the time off
		   would put a whole day's activity in one bucket and lose every
		   same-day return. */
		uploaded, ok := parseTATTime(r[dateCol])
		if !ok {
			continue
		}
		removed, hasRemoval := parseTATTime(r[removalTimeCol])
		if prev, seen := t.batches[uploaded]; !seen || (hasRemoval && removed.After(prev)) {
			if hasRemoval {
				t.batches[uploaded] = removed
			} else if !seen {
				t.batches[uploaded] = time.Time{}
			}
		}
	}

	out := make([]map[string]any, 0, len(tally))
	for url, t := range tally {
		repeats := t.repeatOffences()
		if repeats < minRepeatOffences {
			continue
		}
		out = append(out, map[string]any{
			"label": url, "value": url,
			"urls": t.urls, "removed": t.removed,
			"repeats":       repeats,
			"profileStatus": profileStatusLabel(t.profileDead),
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

/*
── The same question, asked of a DAILY ROLLUP ───────────────────────────────

computeRepeatOffenders measures the comeback against a removal TIMESTAMP, and
the VOD aggregates do not carry one. Agg_Daily_Youtube_MasterNew,
Agg_Daily_Telegram_MasterNew, SocialMediaDashboard and Unified_BI_Dashboard all
carry the account URL — so they are offered the panel — and none of them carries
RemovalTime, RemovalDate or RemovalDoneAt. The stamp path therefore recorded no
batches at all, repeatOffences() returned 0 for every account, and the card read
"No channel or profile came back after a takedown in this window" on every VOD
report, for every client, always. An empty panel that can never be non-empty is
worse than no panel: it is a standing claim that nobody reoffends.

── What replaces the stamp ─────────────────────────────────────────────────

The rollup's grain IS the answer. One row is one account on one day, carrying
that day's identified and removed counts, so the day is the clock:

	the takedown  — the EARLIEST day the account has RemovedCount > 0
	a comeback    — any LATER day the account was identified on at all

which is the same cycle the timestamp path measures — content up, content
removed, more content up afterwards — read at the only resolution this table
has. Each qualifying day counts once, matching the stamp path's rule that one
request counts once however many URLs it carried.

── The two ways this could have been got wrong ─────────────────────────────

Counting every day with activity would rank the busiest account rather than the
most defiant one, which is the exact mistake the day-count version of the
timestamp path was replaced for — see minRepeatOffences' own note. Only days
strictly AFTER the first removal count here.

Counting the removal day itself as a comeback would give every account that was
ever removed a score of at least one, since a day with a removal is nearly
always a day with activity. `After`, not `!Before`.
*/
func computeRepeatOffendersDaily(rows []map[string]any, urlCol, dateCol, identCol, removedCol string, limit int) []map[string]any {
	// Every one of these is required: without the removed count there is no
	// takedown to measure from, and without the date there is no clock.
	if urlCol == "" || dateCol == "" || removedCol == "" {
		return []map[string]any{}
	}
	if limit <= 0 {
		limit = repeatOffenderLimit
	}

	type dayFigures struct{ identified, removed int64 }
	type acct struct {
		urls, removed int64
		days          map[time.Time]*dayFigures
		dead          bool
	}
	tally := map[string]*acct{}

	for _, r := range rows {
		url := strings.TrimSpace(strFromAny(r[urlCol]))
		if url == "" {
			continue
		}
		a := tally[url]
		if a == nil {
			a = &acct{days: map[time.Time]*dayFigures{}}
			tally[url] = a
		}

		ident := numOf(r[identCol])
		if identCol == "" {
			ident = 1
		}
		removed := numOf(r[removedCol])
		a.urls += ident
		a.removed += removed

		/* The account's own state, read off whichever column this table spells
		   it with — the same pair accountStatusCol resolves for the subscriber
		   tiles, so the panel's "Suspended" and that tile agree. */
		if isDead(r[colProfileStatus]) || accountTakenDown(r[colChannelStatus]) {
			a.dead = true
		}

		ts, ok := parseTATTime(r[dateCol])
		if !ok {
			continue
		}
		/* TRUNCATED TO THE DAY, which is the opposite of what the timestamp
		   path needs and right for the same reason: a rollup row already stands
		   for a whole day, and any time component on it is an artefact of how
		   the column is typed rather than a moment anything happened. Left
		   whole, two rows for one day could sort either side of a removal. */
		day := ts.Truncate(24 * time.Hour)
		f := a.days[day]
		if f == nil {
			f = &dayFigures{}
			a.days[day] = f
		}
		f.identified += ident
		f.removed += removed
	}

	out := make([]map[string]any, 0, len(tally))
	for url, a := range tally {
		var firstRemoval time.Time
		for day, f := range a.days {
			if f.removed <= 0 {
				continue
			}
			if firstRemoval.IsZero() || day.Before(firstRemoval) {
				firstRemoval = day
			}
		}
		// Never removed from: not a repeat offender, however much it posted.
		// The volume panel beside this one is where that account belongs.
		if firstRemoval.IsZero() {
			continue
		}
		var repeats int64
		for day, f := range a.days {
			if f.identified > 0 && day.After(firstRemoval) {
				repeats++
			}
		}
		if repeats < minRepeatOffences {
			continue
		}
		out = append(out, map[string]any{
			"label": url, "value": url,
			"urls": a.urls, "removed": a.removed,
			"repeats":       repeats,
			"profileStatus": profileStatusLabel(a.dead),
		})
	}
	sortRepeatRows(out)
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}
