package handlers

import (
	"strings"
	"testing"
)

/*
The summary totals only the channels its reader's platforms actually cover.

── WHAT WENT WRONG ──────────────────────────────────────────────────────────

A sports report's Summary drew four bars — Open Web, Social Media / UGC,
Telegram and Mobile Apps — over a navigation that offered three sections. There
was no Mobile Apps platform enabled for the client; the bar came from the
summary's own source list, which still named
dashboards.UnifiedMobileAppsDashboardTable. sourceChannelsFor saw a channel,
bySourcePlatform drew it, and because that panel deliberately keeps channels
that found nothing, it drew at zero.

The bar was the half anybody could see. The table was also QUERIED, so its rows
were inside Total Infringements and Removed — nought on that client, and not
nought on a client with app data and no Mobile Apps section.

── WHAT IS PINNED HERE ──────────────────────────────────────────────────────

The rule, not the symptom: a summary reads a channel only where an attached
platform reads it. These cases are the ones where getting it wrong is silent —
a figure that is too big, or a report emptied by its own guard.
*/

// A configured summary as the failing report had it: five tables, four channels.
func sportsSummary() platformDef {
	return platformDef{Key: summaryKey, Label: "Summary", Enabled: true, Tables: []string{
		"dashboards.SportsURLRawData",
		"dashboards.SportsSourceURLRawData",
		"dashboards.SocialMedia_Sports_Raw",
		"dashboards.Agg_Daily_Telegram_Sports_Raw",
		"dashboards.UnifiedMobileAppsDashboardTable",
	}}
}

func openWebPlatform() platformDef {
	return platformDef{Key: "open-web-sports", Label: "Open Web", Enabled: true, Tables: []string{
		"dashboards.SportsURLRawData", "dashboards.SportsSourceURLRawData",
	}}
}
func socialPlatform() platformDef {
	return platformDef{Key: "social-sports", Label: "Social Media & UGC", Enabled: true, Tables: []string{
		"dashboards.SocialMedia_Sports_Raw",
	}}
}
func telegramPlatform() platformDef {
	return platformDef{Key: "telegram-sports", Label: "Telegram", Enabled: true, Tables: []string{
		"dashboards.Agg_Daily_Telegram_Sports_Raw",
	}}
}
func mobileAppsPlatform() platformDef {
	return platformDef{Key: "mobile-apps-sports", Label: "Mobile Apps", Enabled: true, Tables: []string{
		"dashboards.UnifiedMobileAppsDashboardTable",
	}}
}

func tablesOf(p platformDef) string { return strings.Join(p.Tables, ",") }

// The reported case: three platforms attached, five tables configured, and the
// app table is the one that goes.
func TestSummaryDropsAnUnattachedChannel(t *testing.T) {
	attached := attachedChannels([]platformDef{
		openWebPlatform(), socialPlatform(), telegramPlatform(),
	})
	got := narrowToChannels(sportsSummary(), attached, 1)

	if strings.Contains(tablesOf(got), "UnifiedMobileApps") {
		t.Errorf("the mobile-apps table survived: %s", tablesOf(got))
	}
	if len(got.Tables) != 4 {
		t.Errorf("kept %d tables (%s), want the four an attached platform covers",
			len(got.Tables), tablesOf(got))
	}
	// And the bar goes with the table, which is the whole point of narrowing the
	// list rather than filtering the finished rows.
	for _, ch := range sourceChannelsFor(got) {
		if ch == "Mobile Apps" {
			t.Error("Mobile Apps is still a channel of the summary, so it will still draw a bar")
		}
	}
	if n := len(sourceChannelsFor(got)); n != 3 {
		t.Errorf("summary covers %d channels, want 3 — one per attached platform", n)
	}
}

// "If open web is there, the summary holds the data of open web only."
func TestSummaryWithOneAttachedPlatformReadsOnlyThatChannel(t *testing.T) {
	attached := attachedChannels([]platformDef{openWebPlatform()})
	got := narrowToChannels(sportsSummary(), attached, 1)

	if n := len(got.Tables); n != 2 {
		t.Fatalf("kept %d tables (%s), want the two open-web ones", n, tablesOf(got))
	}
	for _, tbl := range got.Tables {
		if ch := sourceChannelName(tbl); ch != "Open Web" {
			t.Errorf("kept %s, which is %s — the reader has no such platform", tbl, ch)
		}
	}
}

// A summary already matching its platforms must come back untouched — the guard
// is a trim, and a trim that rewrites a correct configuration is a change
// nobody asked for.
func TestSummaryMatchingItsPlatformsIsUnchanged(t *testing.T) {
	attached := attachedChannels([]platformDef{
		openWebPlatform(), socialPlatform(), telegramPlatform(), mobileAppsPlatform(),
	})
	in := sportsSummary()
	got := narrowToChannels(in, attached, 1)
	if tablesOf(got) != tablesOf(in) {
		t.Errorf("a correctly configured summary was rewritten:\n  %s\n  %s",
			tablesOf(in), tablesOf(got))
	}
}

/*
The two ways this could empty a report, and it must do neither.

A guard that silences a misconfiguration by reporting zeroes is worse than the
misconfiguration: the reader sees a clean, wrong answer instead of a bar they
can ask about. Both cases leave the summary whole and say so in the log.
*/
func TestSummaryIsNeverNarrowedToNothing(t *testing.T) {
	in := sportsSummary()

	// No attached platforms at all — the callers answer this with a 403.
	if got := narrowToChannels(in, map[string]bool{}, 1); tablesOf(got) != tablesOf(in) {
		t.Errorf("an unattached reader emptied the summary: %s", tablesOf(got))
	}
	// Attached platforms that share no channel with the summary's sources.
	odd := attachedChannels([]platformDef{{
		Key: "yt", Label: "YouTube", Tables: []string{"dashboards.Agg_Daily_Youtube_MasterNew"},
	}})
	if got := narrowToChannels(in, odd, 1); tablesOf(got) != tablesOf(in) {
		t.Errorf("a summary sharing no channel was emptied: %s", tablesOf(got))
	}
}

// Only the summary is narrowed. Every other section's sources are its own, and
// a platform reading a table outside its own channel is not this guard's
// business.
func TestOnlyTheSummaryIsNarrowed(t *testing.T) {
	in := mobileAppsPlatform()
	got := narrowSummaryToAttached(in, nil, "")
	if tablesOf(got) != tablesOf(in) {
		t.Errorf("a non-summary platform was narrowed: %s", tablesOf(got))
	}
	// A summary with no sources configured has nothing to trim, and must not
	// reach the database to find that out.
	empty := platformDef{Key: summaryKey}
	if got := narrowSummaryToAttached(empty, nil, ""); len(got.Tables) != 0 {
		t.Errorf("an empty summary gained tables: %s", tablesOf(got))
	}
}

/*
The channel derivation has to be the SAME on both sides.

attachedChannels and the summary's own channels both go through
sourceChannelName, which is what makes the comparison safe: the platform
labelled "Social Media & UGC" in the navigation and the channel named
"Social Media / UGC" in the breakdown are the same thing, and matching on the
labels would have decided they were not.
*/
func TestChannelsAreMatchedByDerivationNotByLabel(t *testing.T) {
	social := socialPlatform()
	if social.Label == "Social Media / UGC" {
		t.Fatal("fixture no longer differs from the channel name — the trap it guards is gone")
	}
	attached := attachedChannels([]platformDef{social})
	if !attached["Social Media / UGC"] {
		t.Errorf("a platform labelled %q did not resolve to its channel: %v", social.Label, attached)
	}
	got := narrowToChannels(sportsSummary(), attached, 1)
	if !strings.Contains(tablesOf(got), "SocialMedia_Sports_Raw") {
		t.Errorf("the social table was dropped despite its platform being attached: %s", tablesOf(got))
	}
}

/*
The reported case, which is the guard's whole reason for existing: THREE
platforms attached and a summary still listing a fourth channel's table.

Navigation offered Summary, Open Web, Social Media & UGC and Telegram, and the
summary's "Identification & Removal basis Platform" panel drew a fourth bar for
Mobile Apps at zero. The bar was the visible half; the table was also QUERIED,
so a client with real app data would have had it folded into Total
Infringements and every merged breakdown beside it without a section admitting
the platform existed.

Note the LABELS differ from the channel names on purpose — the platform is
called "Social Media & UGC" and its channel is "Social Media / UGC". The guard
must match on channel, derived from the table through sourceChannelName on both
sides, because those two strings are not equal and never were.
*/
func TestTheFourthChannelIsDroppedWhenItsPlatformIsNotAttached(t *testing.T) {
	attached := attachedChannels([]platformDef{
		openWebPlatform(), socialPlatform(), telegramPlatform(),
	})
	got := narrowToChannels(sportsSummary(), attached, 1)

	for _, tbl := range got.Tables {
		if ch := sourceChannelName(tbl); ch == "Mobile Apps" {
			t.Errorf("kept %s (%s) — no attached platform reads that channel, so the "+
				"summary must neither query it nor draw a bar for it", tbl, ch)
		}
	}
	// And everything the reader DOES have survives: a guard that trims the one
	// wrong table and a guard that trims three right ones look identical on the
	// panel that was complained about.
	if n := len(got.Tables); n != 4 {
		t.Errorf("kept %d tables (%s), want the four belonging to the three "+
			"attached platforms", n, tablesOf(got))
	}
}

/*
And the channels the PANEL would draw, which is the figure the reader actually
sees.

Asserted separately from the table list because they are separate failures: a
table correctly dropped from the query but still named in sourceChannelsFor
would query nothing and draw a bar of zero, which is exactly what was reported.
*/
func TestTheNarrowedSummaryDrawsNoBarForAnUnattachedChannel(t *testing.T) {
	attached := attachedChannels([]platformDef{
		openWebPlatform(), socialPlatform(), telegramPlatform(),
	})
	got := narrowToChannels(sportsSummary(), attached, 1)

	want := map[string]bool{"Open Web": true, "Social Media / UGC": true, "Telegram": true}
	for _, ch := range sourceChannelsFor(got) {
		if !want[ch] {
			t.Errorf("the panel would draw a %q bar, which the navigation has no section for", ch)
		}
		delete(want, ch)
	}
	for ch := range want {
		t.Errorf("the panel lost its %q bar, which the reader does have", ch)
	}
}

/*
THE SPORTS SUMMARY, which the guard could not see.

Recognising a summary by its key being exactly "summary" worked for one install
and one summary. Report Configuration lets an admin create as many as they like,
and on the install this was reported from there are two: "summary" over the
unified table, and "summary-sprts" over five sports tables — four channels'
worth, including a Mobile Apps table the client has no section for.

The sports one matched neither half of the guard, so it was never trimmed AND it
counted among the reader's own attached platforms — vouching for the very
channel it should have been measured against. Two failures from one string
comparison, which is why the recognition is structural now.
*/
func sportsSummaryPlatform() platformDef {
	return platformDef{Key: "summary-sprts", Label: "Summary - Sports", Enabled: true, Tables: []string{
		"dashboards.SportsURLRawData",
		"dashboards.SportsSourceURLRawData",
		"dashboards.SocialMedia_Sports_Raw",
		"dashboards.Agg_Daily_Telegram_Sports_Raw",
		"dashboards.UnifiedMobileAppsDashboardTable",
	}}
}

func TestASummaryIsRecognisedByShapeNotByItsKey(t *testing.T) {
	if !isSummaryPlatform(sportsSummaryPlatform()) {
		t.Error("summary-sprts is not recognised as a summary — it would be neither " +
			"trimmed nor excluded from the channels it is measured against")
	}
	// The reserved key stays a summary whatever it reads: the built-in one is a
	// single unified table and is still a fan-out.
	if !isSummaryPlatform(platformDef{Key: summaryKey, Tables: []string{"dashboards.Unified_BI_Dashboard"}}) {
		t.Error("the reserved summary key stopped being a summary")
	}
	/* And an ordinary platform is NOT one, however many tables it reads. Open
	   Web reads two, both of the same channel — the linking side and the host
	   side — and trimming it would be this guard reaching a report it has no
	   business in. */
	for _, p := range []platformDef{openWebPlatform(), socialPlatform(), telegramPlatform(), mobileAppsPlatform()} {
		if isSummaryPlatform(p) {
			t.Errorf("%s was taken for a summary; it reads one channel", p.Key)
		}
	}
}

/*
The reported case, end to end: the sports summary loses the channel its reader
has no platform for.
*/
func TestTheSportsSummaryDropsAnUnattachedChannel(t *testing.T) {
	attached := attachedChannels([]platformDef{
		openWebPlatform(), socialPlatform(), telegramPlatform(),
	})
	got := narrowToChannels(sportsSummaryPlatform(), attached, 1)

	for _, tbl := range got.Tables {
		if ch := sourceChannelName(tbl); ch == "Mobile Apps" {
			t.Errorf("kept %s (%s) — the client has no Mobile Apps section, so the "+
				"summary must neither query it nor draw a bar for it", tbl, ch)
		}
	}
	if n := len(got.Tables); n != 4 {
		t.Errorf("kept %d tables (%s), want the four the reader's platforms cover",
			n, tablesOf(got))
	}
}

/*
And the summary is not counted among the platforms it is measured against.

This is the half that made the other half useless: with summary-sprts in the
attached set, its Mobile Apps channel was attached BECAUSE the summary read it,
so even a working trim would have found nothing to remove.
*/
func TestASummaryDoesNotVouchForItsOwnChannels(t *testing.T) {
	all := []platformDef{
		sportsSummaryPlatform(), openWebPlatform(), socialPlatform(), telegramPlatform(),
	}
	kept := []platformDef{}
	for _, p := range all {
		if isSummaryPlatform(p) {
			continue
		}
		kept = append(kept, p)
	}
	if attachedChannels(kept)["Mobile Apps"] {
		t.Error("Mobile Apps counted as attached, and only the summary reads it — " +
			"the guard is asking the summary to vouch for itself")
	}
}
