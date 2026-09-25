package handlers

/*
YouTube: the manual claim, the automatic one, and the whole.

── The two acts ────────────────────────────────────────────────────────────

dashboards.Agg_Daily_Youtube_MasterNew is what was FOUND and reported — the
manual route. dashboards.Rpt_YTAutoClaim_Summary is what Content ID matched and
claimed by itself, where nothing was reported and nothing came down. The report
now shows both and their total, so a reader can see how much of the platform is
handled without anyone sending a notice.

── Why the four combinations are not one rule ──────────────────────────────

	claims  ADD.   Two routes acting on different uploads; 41,095 + 196,487.
	views   ADD.   Views accrue per upload, and an upload is claimed by one
	               route or found by the other, not both.
	assets  UNION. The same title is claimed automatically AND found manually —
	               that is the normal case, not the exception. 170 + 389 would
	               report a catalogue of at most 559 titles as exactly 559
	               whatever the overlap, and the overlap here is most of it.
	channels UNION. Same reason, and worse: a channel that both routes touched
	               is one channel. 4,980 + 36,571 counts it twice.

Adding the two distinct counts is the failure this file exists to avoid. It is
invisible on screen — a larger catalogue looks like a bigger problem, not like a
bug — and it is wrong by exactly the amount of the overlap, which is the part
anybody would most want to know.

── How the unions are computed ─────────────────────────────────────────────

By listing both sides' distinct values and counting the union, at the same scope
the section is drawn for. Exact, one extra grouped query per side, and bounded by
CARDINALITY rather than by rows: the largest measured here is 36,571 channels for
a month, against the 36,806 this warehouse's biggest grouping already returns
without difficulty.

A TRUNCATED list is never published. A capped union is an undercount, and an
undercount on a headline tile is indistinguishable from the truth — the same
rule the TV-channel tile follows.

── The channel key ─────────────────────────────────────────────────────────

The two tables spell a channel differently: the summary keeps the bare handle
(UC1AYXnD5Dm08Ady4A3LWV_g), the daily table the full address
(https://www.youtube.com/channel/UC1AYX...). Both are reduced to the handle
before the union — see youtubeChannelKey — because matching on the raw strings
would find no overlap at all and quietly produce the sum this file exists to
avoid.
*/

import (
	"context"
	"log"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/ip-house/iphouse-api/reportsapi"
)

const (
	autoClaimTable   = "dashboards.Rpt_YTAutoClaim_Summary"
	youtubeMainTable = "dashboards.Agg_Daily_Youtube_MasterNew"
)

/*
autoClaimKPIs are the tiles this contributes, and they are named HERE because no
spec declares them.

The same position perSideKPIs is in: the figures are assembled in the API bridge
once a second source has answered, so there is no ExtraKPI entry for
platformExtraKPIs to find. Without this list the values are computed, put in the
KPI map, given labels and descriptions — and no card is ever drawn for them,
because a tile exists only if the layout was told it could.

Total Infringements is not here: it is the `identified` tile every report
already has, now carrying both routes.
*/
var autoClaimKPIs = []string{"manualClaims", "autoClaims"}

// tableHasAutoClaims reports whether a table is the YouTube daily one, which is
// the single place these figures belong.
func tableHasAutoClaims(table string) bool {
	return strings.EqualFold(strings.TrimSpace(table), youtubeMainTable)
}

// sectionHasAutoClaims is the same question asked of a dataset.
func sectionHasAutoClaims(ds reportsapi.Dataset) bool {
	return tableHasAutoClaims(ds.Table)
}

// autoClaimFigures is what the section needs to build its tiles.
type autoClaimFigures struct {
	claims, views int64
	// Counted unions; -1 where the list could not be had in full, which is the
	// difference between "no answer" and "none".
	assets, channels int64
}

/*
youtubeChannelKey reduces either spelling of a channel to one comparable value.

The last path segment, lower-cased: ".../channel/UCabc" and "UCabc" both become
"ucabc". Taking the segment rather than stripping a fixed prefix is deliberate —
the daily table also carries /user/ and /@handle forms, and a prefix match would
leave those unreduced and count them against nothing.

Empty for a value that names no channel, including the "(none)" bucket the
service returns for rows with none, so those never join a union.
*/
func youtubeChannelKey(v string) string {
	s := strings.ToLower(strings.TrimSpace(v))
	if s == "" || s == strings.ToLower(nullGroupLabel) {
		return ""
	}
	s = strings.TrimRight(s, "/")
	if i := strings.LastIndex(s, "/"); i >= 0 {
		s = s[i+1:]
	}
	return strings.TrimSpace(s)
}

/*
unionCount counts the distinct values across two breakdowns.

`key` normalises a value before it is counted, so two spellings of one thing are
one thing. Reports -1 when either side was truncated: a union missing an unknown
number of values is not a count, and publishing it would replace a right answer
with a smaller one nobody can see is smaller.
*/
func unionCount(a, b []map[string]any, aTrunc, bTrunc bool, key func(string) string) int64 {
	if aTrunc || bTrunc {
		return -1
	}
	seen := map[string]bool{}
	for _, rows := range [][]map[string]any{a, b} {
		for _, r := range rows {
			k := key(strFromAny(r["value"]))
			if k == "" {
				k = key(strFromAny(r["grp"]))
			}
			if k != "" {
				seen[k] = true
			}
		}
	}
	return int64(len(seen))
}

// identityKey is the union key for values that are already comparable — asset
// ids, which both tables record as the same GUID.
func identityKey(v string) string {
	s := strings.ToLower(strings.TrimSpace(v))
	if s == "" || s == strings.ToLower(nullGroupLabel) {
		return ""
	}
	return s
}

/*
autoClaimCombine gathers the claim figures and the two unions, for the SAME
scope the section is drawn for.

apiScope resolves each of the spec's filters through the TARGET dataset, so a
filter the summary does not carry — genre, infringement type — is dropped rather
than sent and refused, while the client and the window always survive. That is
what makes the two sets of figures describe one window.

The four requests run together: they are independent, and run in series they
would add their latencies to a page that already waits on several.
*/
func autoClaimCombine(ctx context.Context, c *reportsapi.Client, s reportSpec,
	ytDS reportsapi.Dataset, q map[string]string) (autoClaimFigures, bool) {

	out := autoClaimFigures{assets: -1, channels: -1}

	acDS, ok := c.ByTable(ctx, autoClaimTable)
	if !ok {
		return out, false
	}
	acScope := apiScope(s, acDS, q, "")
	ytScope := apiScope(s, ytDS, q, "")

	/* The summary FIRST, on its own, and the lists only if it found anything.

	   Eight of eighty-nine clients have auto-claim data. Running the four
	   grouped queries alongside the summary would mean, for the other
	   eighty-one, four full-cardinality scans per report load whose every
	   answer is discarded — one of them over 36,000 channels. One extra round
	   trip in the rare case is the cheaper trade by a wide margin. */
	sum, sumErr := c.Summary(ctx, acDS, acScope)
	if sumErr != nil || sum == nil || numOf(sum["rowCount"]) == 0 {
		return out, false
	}

	var (
		wg                   sync.WaitGroup
		acAssets, ytAssets   []map[string]any
		acAssetsT, ytAssetsT bool
		acChans, ytChans     []map[string]any
		acChansT, ytChansT   bool
		acChErr, ytChErr     error
		acAsErr, ytAsErr     error
	)
	wg.Add(4)
	go func() {
		defer wg.Done()
		acAssets, acAssetsT, acAsErr = c.BreakdownFull(ctx, acDS, acScope, "assetId", reportsapi.BreakdownAll)
	}()
	go func() {
		defer wg.Done()
		ytAssets, ytAssetsT, ytAsErr = c.BreakdownFull(ctx, ytDS, ytScope, "assetId", reportsapi.BreakdownAll)
	}()
	go func() {
		defer wg.Done()
		acChans, acChansT, acChErr = c.BreakdownFull(ctx, acDS, acScope, "channel", reportsapi.BreakdownAll)
	}()
	go func() {
		defer wg.Done()
		ytChans, ytChansT, ytChErr = c.BreakdownFull(ctx, ytDS, ytScope, "channelUrl", reportsapi.BreakdownAll)
	}()
	wg.Wait()

	out.claims = numOf(sum["autoClaims"])
	out.views = numOf(sum["views"])

	/* Each union stands on its own: a failure to list channels must not also
	   withdraw the asset figure, and neither withdraws the claim count, which
	   came from the summary and is complete. */
	/*
		Each union stands on its own: a failure to list channels must not also
		withdraw the asset figure, and neither withdraws the claim count, which
		came from the summary and is complete.

		AND EACH SAYS WHY IT GAVE UP. The first version swallowed these errors,
		so a union that silently failed left the section's own counts in place —
		which is the correct fallback and completely indistinguishable, from the
		outside, from the combination having been forgotten. It cost a round of
		guessing at a screenshot to find out which it was.
	*/
	if acAsErr != nil || ytAsErr != nil {
		log.Printf("[reports] auto-claim asset union skipped: autoclaim=%v youtube=%v",
			acAsErr, ytAsErr)
	} else {
		out.assets = unionCount(acAssets, ytAssets, acAssetsT, ytAssetsT, identityKey)
		if out.assets < 0 {
			log.Printf("[reports] auto-claim asset union skipped: a list was truncated "+
				"(autoclaim=%v youtube=%v)", acAssetsT, ytAssetsT)
		}
	}
	if acChErr != nil || ytChErr != nil {
		log.Printf("[reports] auto-claim channel union skipped: autoclaim=%v youtube=%v",
			acChErr, ytChErr)
	} else {
		out.channels = unionCount(acChans, ytChans, acChansT, ytChansT, youtubeChannelKey)
		if out.channels < 0 {
			log.Printf("[reports] auto-claim channel union skipped: a list was truncated "+
				"(autoclaim=%v youtube=%v)", acChansT, ytChansT)
		}
	}
	return out, true
}

/*
applyAutoClaimKPIs folds the figures into a section's KPI map.

`identified` is read back rather than passed in, so the manual and total tiles
are built from the figure the section actually published — after every
substitution the KPI block makes — rather than from a second reading.

A union that could not be computed leaves the existing tile alone. The YouTube
figure standing on its own is an undercount of the combination and says so by
being the number it always was; a zero, or a sum, would be a new wrong answer.
*/
func applyAutoClaimKPIs(kpi map[string]any, f autoClaimFigures) {
	if kpi == nil {
		return
	}
	manual := numOf(kpi["identified"])

	kpi["manualClaims"] = manual
	kpi["autoClaims"] = f.claims
	/* The headline. Both routes acted on this platform, and the tile is the
	   whole of it — the two are on their own cards above so the split is never
	   inferred from the difference between two screens. */
	kpi["identified"] = manual + f.claims
	/* AND THE SAME CLAIMS COUNT AS REMOVED.

	   A Content ID claim IS the enforcement on that upload: it was caught and
	   acted on without a notice being sent, so nothing about it is outstanding.
	   Counting the claims in the total and not in the removals made every one
	   of them look unresolved — 196,487 of one client's 237,582 infringements
	   sat in Pending Removal — and pulled the rate down to 16.5%, which was
	   then rescued by measuring against manual claims instead.

	   Putting the claims on the side they belong to removes both problems at
	   once: Pending Removal is what manual enforcement still owes, and the rate
	   is removals over the total, which is what it is on every other platform.
	   That also retires the manual-claims denominator in runPlatform, which
	   existed only to compensate for this. */
	kpi["removed"] = numOf(kpi["removed"]) + f.claims
	kpi["pending"] = max64(0, numOf(kpi["identified"])-numOf(kpi["removed"]))

	pct := 0.0
	if ident := numOf(kpi["identified"]); ident > 0 {
		pct = float64(numOf(kpi["removed"])) / float64(ident) * 100
	}
	kpi["removalPct"] = roundTo(pct, 2)

	kpi["views"] = numOf(kpi["views"]) + f.views
	if f.assets >= 0 {
		kpi["totalAssets"] = f.assets
	}
	if f.channels >= 0 {
		kpi["totalChannels"] = f.channels
	}
}

/*
── Whether this client has any auto-claim data at all ──────────────────────

The tiles are offered per CLIENT, not per platform, because the table is not
populated for most of them: eight of eighty-nine on 21 September 2026. A card
the layout offers is drawn whatever the figures say — an absent value renders as
an em dash rather than disappearing, deliberately, because "hiding the card is
the layout's call" (see the tile branch in app/admin/reports/page.tsx). So the
layout has to make that call here, or every other client gets two permanently
empty cards.

Asked WITHOUT a date window on purpose. The window moves as the reader changes
it, and a card that vanished whenever they scrolled past a quiet fortnight would
read as a fault. The question is "does this client use Content ID", which is a
property of the client.
*/
type autoClaimPresence struct {
	has bool
	at  time.Time
}

var autoClaimSeen sync.Map // clientID -> autoClaimPresence

// How long an answer stands. Long enough that a report's several sections share
// one query, short enough that a client newly onboarded to Content ID does not
// wait a day for its cards.
const autoClaimPresenceTTL = 10 * time.Minute

func clientHasAutoClaims(ctx context.Context, clientID string) bool {
	clientID = strings.TrimSpace(clientID)
	if clientID == "" {
		return false
	}
	if v, ok := autoClaimSeen.Load(clientID); ok {
		if p, ok := v.(autoClaimPresence); ok && time.Since(p.at) < autoClaimPresenceTTL {
			return p.has
		}
	}
	c := reportsapi.Get()
	ds, ok := c.ByTable(ctx, autoClaimTable)
	if !ok {
		return false
	}
	q := url.Values{}
	q.Set("ClientId", clientID)
	sum, err := c.Summary(ctx, ds, q)
	if err != nil {
		/* NOT cached. A failed lookup is not an answer, and storing it would
		   hide the cards for the next ten minutes on the strength of one
		   timeout. */
		return false
	}
	has := numOf(sum["rowCount"]) > 0
	autoClaimSeen.Store(clientID, autoClaimPresence{has: has, at: time.Now()})
	return has
}

/*
withAutoClaimTiles adds the claim cards to a section's tile list.

Added HERE rather than in platformExtraKPIs, and that distinction is the whole
reason the cards did not appear the first time: platformExtraKPIs feeds the
layout EDITOR, while the list the page actually draws from is built separately
in ReportsSections out of each spec's ExtraKPI. A metric in one and not the
other is offered to an admin arranging panels and never rendered for a reader.

Both conditions have to hold: the section reads the YouTube table, and the
client has claims to show.
*/
func withAutoClaimTiles(ctx context.Context, extras []string, specs []reportSpec, clientID string) []string {
	yt := false
	for _, sp := range specs {
		if tableHasAutoClaims(sp.Table) {
			yt = true
			break
		}
	}
	if !yt || !clientHasAutoClaims(ctx, clientID) {
		return extras
	}
	seen := map[string]bool{}
	for _, k := range extras {
		seen[k] = true
	}
	for _, k := range autoClaimKPIs {
		if !seen[k] {
			extras = append(extras, k)
		}
	}
	sort.Strings(extras)
	return extras
}
