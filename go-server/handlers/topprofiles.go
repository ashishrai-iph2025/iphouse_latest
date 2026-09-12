package handlers

/*
The accounts with the biggest AUDIENCE, rather than the most posts.

Every other account panel on a social report ranks by volume — how many
infringing posts, how many came down, how many days an account kept coming back.
That is the enforcement view, and it answers "who is giving us the most work".

It does not answer "who is doing the most damage". An account with eleven posts
and four million followers reaches further than one with four hundred posts and
a thousand, and on a volume ranking the first never appears at all. This panel is
that second question: the ten accounts by REACH, with what was found on them,
what came down, and whether the account itself is still up.

── WHY IT IS COUNTED HERE AND NOT BY THE SERVICE ────────────────────────────

The audience is a MAX per profile, not a sum. One account appears on every post
it made, so a warehouse SUM(Subscribers) counts the same followers once per post
— the mistake impactedSubscribers was corrected for, where the figure read 2.1
billion against accounts holding 1.4 million. A breakdown aggregates before it
answers, so the max has to be taken over raw rows, which is the same reason
computeRepeatOffenders lives beside this.

The subscriber count also MOVES between crawls, which is why it is a max and not
a first or last reading: it is the account's own number, and the highest one seen
is the closest thing the window holds to it.
*/

import "sort"

// dimTopProfiles is the panel key. Its own, not a variant of the repeat-offender
// one: same grouping column, different question, and a reader comparing the two
// is comparing reach against persistence.
const dimTopProfiles = "byTopProfiles"

// topProfileLimit is how many accounts it draws, and the title says so.
const topProfileLimit = 10

type profileTally struct {
	url      string
	subs     int64
	urls     int64
	removed  int64
	dead     bool
	firstSaw int
}

/*
computeTopProfiles ranks accounts by audience.

`identCol` and `removedCol` are the pre-aggregated table's own count columns and
are empty on a raw one — where identified is the row count and a removal is read
off the row's status. Same contract as computeRepeatOffenders, and resolved by
the same helper, so the two panels on one page cannot disagree about what a
removal is.

`subsCol` and `statusCol` are the audience and the account's own state. A dataset
carrying neither gets no panel: a ranking by reach with no reach to rank on is a
list of accounts in arbitrary order, which is worse than no card.
*/
func computeTopProfiles(rows []map[string]any, urlCol, subsCol, statusCol, identCol, removedCol string, limit int) []map[string]any {
	if urlCol == "" || subsCol == "" {
		return []map[string]any{}
	}
	if limit <= 0 {
		limit = topProfileLimit
	}

	byURL := map[string]*profileTally{}
	order := 0
	for _, r := range rows {
		url := strFromAny(r[urlCol])
		if url == "" {
			continue
		}
		t, seen := byURL[url]
		if !seen {
			t = &profileTally{url: url, firstSaw: order}
			order++
			byURL[url] = t
		}

		// THE MAX, per profile — see the file comment.
		if s := numOf(r[subsCol]); s > t.subs {
			t.subs = s
		}

		/* Identified and removed, counted the way the rest of the report counts
		   them: a pre-aggregated table carries its own totals per row, a raw one
		   is one row per finding. */
		if identCol != "" {
			t.urls += numOf(r[identCol])
		} else {
			t.urls++
		}
		switch {
		case removedCol != "":
			t.removed += numOf(r[removedCol])
		case rowRemoved(r):
			t.removed++
		}

		/* The ACCOUNT's state, which is not the post's. A post can come down
		   while the account stays up. Sticky once seen dead: the column is
		   stamped per row and a profile suspended after some of its posts were
		   crawled carries both values across its rows. */
		if statusCol != "" && isDead(r[statusCol]) {
			t.dead = true
		}
	}

	out := make([]map[string]any, 0, len(byURL))
	for _, t := range byURL {
		out = append(out, map[string]any{
			"label": t.url, "value": t.url,
			"urls": t.urls, "removed": t.removed,
			// The audience, carried as the panel's third figure — drawn beside
			// the account name rather than as a third bar, because followers and
			// post counts are orders of magnitude apart. See HBarChart.
			"extra":         t.subs,
			"profileStatus": profileStatusLabel(t.dead),
			"_seen":         t.firstSaw,
		})
	}

	/* Biggest audience first. Ties broken by volume and then by the order the
	   rows arrived, so a report run twice over one window draws the same chart
	   rather than reshuffling accounts that share a follower count — which is
	   common, because a count nobody has crawled recently is often zero. */
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if numOf(a["extra"]) != numOf(b["extra"]) {
			return numOf(a["extra"]) > numOf(b["extra"])
		}
		if numOf(a["urls"]) != numOf(b["urls"]) {
			return numOf(a["urls"]) > numOf(b["urls"])
		}
		return numOf(a["_seen"]) < numOf(b["_seen"])
	})
	if len(out) > limit {
		out = out[:limit]
	}
	for _, r := range out {
		delete(r, "_seen")
	}
	return out
}
