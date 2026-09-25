package handlers

/*
What "Removed" MEANS on a two-sided open-web report.

── THE TWO SIDES ENFORCE DIFFERENTLY ───────────────────────────────────────

Open Web is two halves. The LINKING side is the pages that point at infringing
content; the HOST side is the machines actually serving it. Enforcement against
them is not the same act and does not produce the same outcome:

	linking   the link is DE-INDEXED — dropped from Google and Bing, so nobody
	          finds it. The page is still there. Nothing came down.
	host      the file is TAKEN DOWN. The content stops existing at that address.

The report's Removed tile summed each side's own RemovalCount, which counts the
linking side's takedowns — a figure that exists in the column but is not what
enforcement on that side is FOR — and left out de-indexing entirely, although it
is the whole of what the linking half achieves and the report draws two cards of
it (Google De-Indexed, Bing De-Indexed) right beside the tile.

So the figure this publishes is

	removed = de-indexed (linking) + removed (host)

which is "how much of what we found has been dealt with", counted by what
dealing with it actually means on each side.

── WHY IT IS A REPLACEMENT AND NOT AN ADDITION ─────────────────────────────

The linking side's own RemovalCount drops OUT. Adding de-indexing on top of it
would count one URL twice wherever a link was both de-indexed and taken down,
and that is the common case rather than the exceptional one — a delisting batch
and a takedown notice are often sent for the same link. A tile that can exceed
the identified count above it is a tile nobody can read.

── WHAT MOVES WITH IT ──────────────────────────────────────────────────────

`pending` and `removalPct` are derived from this figure by the caller, so both
follow without being computed here — which is the reason this returns a number
rather than writing into the map.

The DAILY series is recomposed the same way, and that is not optional: the
removal-rate chart is drawn from the daily rows, so a tile recomposed while the
trend beneath it stayed summed would put 66% on a card over a line sitting at
40%, with nothing on the page to say which was meant.

── WHEN IT DOES NOT APPLY ──────────────────────────────────────────────────

Both sides must be present AND the linking side must actually report de-indexing.
A report narrowed to one side by the Source Type slicer keeps the plain sum,
because with one side there is nothing to recompose — and a linking-only view
whose "removals" became de-indexings would be answering a question the reader
did not ask by switching a definition under them.
*/

// openWebRemovedFromDelisting is the figure above, and whether the rule applies.
//
// `roles` is the platform's own role list — from the TABLES it reads, not from
// whichever sides answered — for the same reason the per-side trends use it: a
// slicer narrowing the view must not change what a figure means.
func openWebRemovedFromDelisting(roleKPI map[string]map[string]int64, roles map[string]bool) (int64, bool) {
	if len(roles) < 2 {
		return 0, false
	}
	linking, hasLinking := roleKPI["linking"]
	host, hasHost := roleKPI["host"]
	if !hasLinking || !hasHost {
		return 0, false
	}
	/* The linking side has to have REPORTED de-indexing, not merely be capable
	   of it. A table with no delisting columns yields no `delisted` key at all,
	   and reading a missing key as zero would publish "removed = host only" —
	   silently dropping the entire linking half of the report's enforcement. */
	delisted, ok := linking["delisted"]
	if !ok {
		return 0, false
	}
	return delisted + host["removed"], true
}

/*
openWebDailyFromDelisting applies the same rule to one day.

Takes the per-side daily figures rather than the whole map so the caller's loop
stays the shape it is, and returns the day's recomposed removal.

A day on which one side has no row contributes that side's zero, which is
correct: no rows means nothing was found and nothing was enforced on that side
that day, not that the day is unknown.
*/
func openWebDailyFromDelisting(linkingDay, hostDay map[string]int64) int64 {
	return linkingDay["delisted"] + hostDay["removed"]
}
