package handlers

import (
	"strings"
	"testing"
)

/*
"How many channels or accounts has enforcement CLOSED" — on all three VOD
platforms.

Every VOD section drew a Channels tile and none of them drew this one beside it,
so the reports said how many accounts were carrying infringements and never how
many had been shut. Three separate causes, one per platform, which is why it had
never been noticed as a single missing card:

  YouTube    inferSpec offers channelsSuspended off RemovalChannelStatus. The
             daily rollup has no such column — it records the channel's status
             in ChannelStatus — so the tile was never offered. The static spec
             did name it, against LIKE '%Suspend%', which matches nothing in a
             column holding exactly 'Dead' and 'Active'.
  Telegram   the same, and reports_api declared no channelsSuspended measure for
             the Telegram rollup at all, though its table is identical to
             YouTube's in every respect this depends on.
  Social     the account is a PROFILE. The figure reached a section only from a
             row walk over RemovalProfileStatus, a column the social dashboard
             does not carry — it spells the same thing ProfileRemovalStatus —
             and the portal had no measure alias to ask the service for the one
             it has been declaring all along.

What each test pins is the RULE, not the number: which column decides, which
identity it is counted over, and that it is counted rather than summed.
*/

// Shapes are built with namedShape, from sportskpis_test.go — WHICH TABLE
// matters to several of these, and building a second helper beside it is how
// two test files come to disagree about what a shape is.

func TestVODRollupsOfferTheSuspendedChannelTile(t *testing.T) {
	for _, tc := range []struct {
		name, table string
		cols        []string
		wantID      string
	}{{
		name: "YouTube daily", table: youtubeMainTable,
		cols:   []string{"ChannelStatus", "ChannelURL", "ChannelName", "Subscribers"},
		wantID: "ChannelURL",
	}, {
		/* Telegram's VOD table carries no ChannelURL, so the NAME is the
		   identity — the same column its own Channels tile counts. Counting the
		   two off different columns is how a subset comes out larger than the
		   set it belongs to. */
		name: "Telegram daily", table: "dashboards.Agg_Daily_Telegram_MasterNew",
		cols:   []string{"ChannelStatus", "ChannelName", "Subscribers"},
		wantID: "ChannelName",
	}} {
		out := vodAccountsSuspendedKPI(namedShape(tc.table, tc.cols...))
		expr, ok := out["channelsSuspended"]
		if !ok {
			t.Errorf("%s: no suspended-channel tile offered — the section draws "+
				"Channels with nothing beside it saying how many are gone", tc.name)
			continue
		}
		if !strings.Contains(expr, "ChannelStatus = 'Dead'") {
			t.Errorf("%s: wrong test for a closed channel — the column holds 'Dead' "+
				"and 'Active', and LIKE '%%Suspend%%' matched neither:\n  %s", tc.name, expr)
		}
		if !strings.Contains(expr, "COUNT(DISTINCT") {
			t.Errorf("%s: must count accounts, not rows — a channel appears once per "+
				"day it was active:\n  %s", tc.name, expr)
		}
		if !strings.Contains(expr, "THEN "+tc.wantID+" END") {
			t.Errorf("%s: counted over the wrong identity, want %s:\n  %s",
				tc.name, tc.wantID, expr)
		}
	}
}

/*
And the guard that keeps the old column mix-up from coming back.

ChannelStatus is present on the sports raw tables too, where it is about
something else and RemovalChannelStatus is the channel's own status. Offering
this expression there would put a second, wrong definition on the same tile —
and it would run, and return a plausible near-zero, which is the failure mode
that made the original mix-up survive as long as it did.
*/
func TestASportsTableIsLeftToItsOwnStatusColumn(t *testing.T) {
	sports := namedShape("dashboards.Agg_Daily_Telegram_Sports_Raw",
		"ChannelStatus", "RemovalChannelStatus", "ChannelURL")
	if out := vodAccountsSuspendedKPI(sports); len(out) != 0 {
		t.Errorf("a table carrying RemovalChannelStatus must be left to inferSpec's "+
			"own branch, got %v", out)
	}

	// And a table with no status column at all gets no tile, rather than one
	// reading zero — absent says "not measured", zero says "none were closed".
	if out := vodAccountsSuspendedKPI(namedShape("x", "ChannelURL")); len(out) != 0 {
		t.Errorf("a table with no channel status must offer nothing, got %v", out)
	}
	// Nor one with a status and no account to count it over.
	if out := vodAccountsSuspendedKPI(namedShape("x", "ChannelStatus")); len(out) != 0 {
		t.Errorf("a table with no channel identity must offer nothing, got %v", out)
	}
}

/*
Social's twin, which is the same act under the name that report uses.

The two signals are OR-ed on purpose: the warehouse fills TotalProfilesSuspended
on some rows and ProfileRemovalStatus on others, and requiring both would report
the intersection of the two rather than the accounts.
*/
func TestSocialOffersTheSuspendedProfileTile(t *testing.T) {
	shape := namedShape("dashboards.SocialMediaDashboard",
		"ProfileURL", "ProfileRemovalStatus", "TotalProfilesSuspended",
		"TotalSubscribers", "TotalAutoClaims", "TotalManualClaims")
	out := socialVODKPIs("dashboards.SocialMediaDashboard", shape)

	expr, ok := out["profilesSuspended"]
	if !ok {
		t.Fatal("Social & UGC offers no suspended-profile tile")
	}
	if !strings.Contains(expr, "COUNT(DISTINCT") {
		t.Errorf("must COUNT accounts, not SUM the per-row flag — one profile spans "+
			"many rows here, so a sum reports it once per row:\n  %s", expr)
	}
	if strings.Contains(expr, "SUM(") {
		t.Errorf("SUM(TotalProfilesSuspended) is the over-count this replaces:\n  %s", expr)
	}
	for _, want := range []string{"TotalProfilesSuspended > 0", "ProfileRemovalStatus = 'Dead'", " OR "} {
		if !strings.Contains(expr, want) {
			t.Errorf("either signal must count the account; missing %q:\n  %s", want, expr)
		}
	}
	/* Counted over ProfileURL — the identity channelKPIs counts for this table
	   — so this figure can never exceed the Channels tile beside it. */
	if !strings.Contains(expr, "THEN ProfileURL END") {
		t.Errorf("counted over the wrong identity:\n  %s", expr)
	}

	// A table missing both signals offers nothing rather than a zero tile.
	bare := namedShape("dashboards.SocialMediaDashboard", "ProfileURL", "TotalSubscribers")
	if _, ok := socialVODKPIs("dashboards.SocialMediaDashboard", bare)["profilesSuspended"]; ok {
		t.Error("a table with neither suspension signal must offer no tile")
	}
}

/*
The portal has to ASK the service for the social figure.

This is the whole of why that tile never appeared even though reports_api has
declared the measure all along: apiMeasureFor consults this map, and a key that
is not in it is never requested. The failure leaves no trace — no error, no
zero, just no card.
*/
func TestTheSuspendedTilesAreRequestedFromTheService(t *testing.T) {
	for _, k := range []string{"channelsSuspended", "profilesSuspended"} {
		if len(apiMeasure[k]) == 0 {
			t.Errorf("%q has no service measure alias, so the bridge never asks for "+
				"it and the card is silently absent", k)
		}
	}
	/* And they stay distinct. Folding profilesSuspended in as an alias of
	   channelsSuspended would make a report that shows both draw one figure
	   twice under two names. */
	for _, m := range apiMeasure["channelsSuspended"] {
		if m == "profilesSuspended" {
			t.Error("profilesSuspended must not be an alias of channelsSuspended")
		}
	}
}

/*
Both tiles are labelled, described and carried onto the Summary band.

A metric with no label draws a card headed with its key; one missing from the
Summary band is computed per platform and then dropped when the sections are
merged, which is what happened to the social figure.
*/
func TestBothSuspendedTilesAreNamedAndSummarised(t *testing.T) {
	for _, k := range []string{"channelsSuspended", "profilesSuspended"} {
		if kpiTileLabels[k] == "" {
			t.Errorf("%q has no label", k)
		}
		if kpiTileDescriptions[k] == "" {
			t.Errorf("%q has no ⓘ note", k)
		}
		found := false
		for _, s := range summaryKPIOrder {
			if s == k {
				found = true
			}
		}
		if !found {
			t.Errorf("%q is missing from the Summary tile band, so a platform that "+
				"reports it has the figure dropped at the merge", k)
		}
	}
	/* The label no longer claims a case this tile cannot be in: it is offered
	   off a channel-status column and never lands on a website report, which
	   has suspendedWebsites of its own. */
	if strings.Contains(kpiTileLabels["channelsSuspended"], "Website") {
		t.Errorf("channelsSuspended is labelled %q — it never counts websites; "+
			"suspendedWebsites is that tile", kpiTileLabels["channelsSuspended"])
	}
}
