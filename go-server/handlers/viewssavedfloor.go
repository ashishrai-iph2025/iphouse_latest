package handlers

/*
Views Saved is never published negative.

── WHAT THE FIGURE IS ──────────────────────────────────────────────────────

The warehouse computes it, per infringing URL, as

	((PerHourAvgViews * 24) * NoDaysContentValue - views) * 0.1

where the two constants come from mediascan.Views_Saved_Compute3 for the
asset's (genre, language) pair and the platform. In words: what the content was
assumed to be worth over its whole valuable life, less what it had already
taken by the time it came down. Ten per cent of the difference is the figure the
tile calls Total Views Saved.

── WHY IT CAME OUT NEGATIVE ────────────────────────────────────────────────

Nothing in that subtraction stops it going under zero. Where a URL had already
out-earned the rate set for its genre, the difference is negative — and on
YouTube that is not the exception. One client's month read

	Total Views          43.5B
	Total Views Saved    -1.1B

on a card a client reads as the value enforcement returned to them.

Two things are wrong with letting that through, and the second outlasts a
reader shrugging at the minus sign: a negative row is SUBTRACTED from the rows
that did save views, so one video that beat its genre's assumed rate quietly
cancels a fortnight of real removals before any total is drawn.

── THE FLOOR ──────────────────────────────────────────────────────────────

Where content had already exceeded its assumed value, taking it down saved
nothing further, and nothing is the honest number for that row. So each row
contributes max(figure, 0).

Applied in three places, which is not belt-and-braces but three genuinely
different paths to the same tile:

  - the SQL, per row, in the ExtraKPI expressions — SUM(GREATEST(col, 0)) — so
    the direct-warehouse backend never adds a negative row to a positive one;
  - reports_api, per row, inside the SUM of its own viewsSaved measures, for
    the same reason on the backend that serves most installs (see
    viewsSavedExpr in that service's internal/api/datasets.go);
  - and HERE, on the assembled figure, which catches what neither can: a
    portal pointed at a reports_api older than that change, and any dataset
    whose measure is still the raw stored column.

The third is the one that stops a redeploy skew from putting a negative back on
a client's screen, so it is deliberately not conditional on which backend
answered.

── WHAT THE FLOOR IS NOT ──────────────────────────────────────────────────

It is not a fix for parameters that are missing or set to zero. A row whose
asset has no active Views_Saved_Compute3 entry contributes nothing at all —
correctly, because nobody stated a value for that title — and a row whose entry
is zero now contributes zero rather than minus a tenth of its views. Both look
the same from the tile: a figure lower than it should be, rather than one
pointing the wrong way. If Views Saved reads implausibly low for a platform
after this, the parameter table is where to look, not the arithmetic.
*/

// viewsSavedFloor is the floor itself, kept as a named function so the three
// call sites cannot drift apart and so grep finds them all from here.
func viewsSavedFloor(v int64) int64 { return max64(0, v) }

/*
floorViewsSaved applies it to an assembled KPI map, in place.

Only where the key is present: a section that publishes no Views Saved tile must
not gain one reading zero, because an absent figure and a zero figure say
different things and the layout already distinguishes them.

savedRevenue is deliberately NOT touched here. It is derived from this figure
further on — see summaryRevenueRates — so flooring the input is what keeps the
revenue range from being quoted as a negative amount, and doing it twice would
put the arithmetic in two places.
*/
func floorViewsSaved(kpi map[string]any) {
	if kpi == nil {
		return
	}
	if v, ok := kpi["viewsSaved"]; ok {
		kpi["viewsSaved"] = viewsSavedFloor(numOf(v))
	}
}
