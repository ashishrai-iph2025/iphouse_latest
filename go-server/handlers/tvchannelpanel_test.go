package handlers

/*
The two channel panels, and the one word they both wanted.

"Channel" means two different things across the sports tables, and for a long
time one panel drew both:

	SportsURLRawData, SportsSourceURLRawData   ChannelName is the BROADCASTER —
	                                           ESPN, DAZN, Paramount+. Neither
	                                           table carries an account column.
	Agg_Daily_Telegram_Sports_Raw              ChannelName is the pirate's own
	                                           Telegram channel; TVChannelName
	                                           is the broadcaster.
	Agg_Daily_Youtube_MasterNew, social        ChannelName is the account.

So a summary merging them ranked Paramount+ and DAZN alongside the Telegram
channels restreaming them, under one heading, as though they were the same kind
of thing. These tests pin the split: the account panel needs an account column,
and the broadcaster panel resolves its column by rule rather than by preference.
*/

import "testing"

// The shape of a table, for the resolver.
func hasCols(cols ...string) func(string) bool {
	set := map[string]bool{}
	for _, c := range cols {
		set[c] = true
	}
	return func(c string) bool { return set[c] }
}

/*
Which column each kind of table gives the broadcaster panel.

The open-web case is the one that cannot be expressed as a column preference:
ChannelName is right there, and is right — but only because the table carries no
account column. A plain "prefer TVChannelName, else ChannelName" list would take
ChannelName on Telegram too, which is the pirate.
*/
func TestTheBroadcasterColumnPerTable(t *testing.T) {
	for _, c := range []struct {
		table string
		has   func(string) bool
		want  string
	}{
		{"dashboards.SportsURLRawData", hasCols("ChannelName", "InfringingDomain"), colChannelName},
		{"dashboards.SportsSourceURLRawData", hasCols("ChannelName", "SourceDomain"), colChannelName},
		{"dashboards.Agg_Daily_Telegram_Sports_Raw",
			hasCols("ChannelName", "ChannelURL", "TVChannelName"), colTVChannelName},
		{"dashboards.Agg_Daily_Youtube_MasterNew", hasCols("ChannelName", "ChannelURL"), ""},
		{"dashboards.SocialMedia_Sports_Raw", hasCols("Platform", "ProfileURL"), ""},
	} {
		if got := tvChannelColumn(c.table, c.has); got != c.want {
			t.Errorf("%s resolved %q, want %q", c.table, got, c.want)
		}
	}
}

/*
THE CHANGE THAT IS COMING: TVChannelName arrives on the account tables.

It is not there yet. The resolver already prefers it, so the day it appears the
broadcaster panel starts drawing on those reports with no code change — which is
the whole reason the column is chosen by rule rather than listed per table.
*/
func TestTheBroadcasterPanelPicksUpTVChannelNameWhenItArrives(t *testing.T) {
	const tbl = "dashboards.Agg_Daily_Youtube_MasterNew"
	before := tvChannelColumn(tbl, hasCols("ChannelName", "ChannelURL"))
	if before != "" {
		t.Fatalf("today a YouTube-shaped table resolves %q, want nothing", before)
	}
	after := tvChannelColumn(tbl, hasCols("ChannelName", "ChannelURL", "TVChannelName"))
	if after != colTVChannelName {
		t.Errorf("with the column added it resolves %q, want TVChannelName — the panel "+
			"would stay empty on every account table", after)
	}
}

/*
The ACCOUNT panel requires an account column.

Without this it drew broadcasters on the two open-web tables, which is where the
mixing came from. Pinned on the candidate, because the gate is one field and its
absence is invisible in the output — the panel simply has more rows than it
should, all of them plausible.
*/
func TestTheChannelPanelNeedsAnAccountColumn(t *testing.T) {
	found := false
	for _, c := range dimensionCandidates {
		if c.Key != "byChannel" {
			continue
		}
		found = true
		if c.Needs != colChannelURL {
			t.Errorf("byChannel requires %q, want ChannelURL — without it the panel "+
				"ranks broadcasters as though they were pirate accounts", c.Needs)
		}
	}
	if !found {
		t.Fatal("byChannel is not in dimensionCandidates")
	}
}

/*
A pirate ChannelName can no longer reach this panel by accident.

The rule this replaced said "no ChannelURL, therefore a station" — which is true
of the two open-web tables and a guess about every other table in the warehouse.
Any table recording accounts by name alone satisfied it exactly, and its pirate
channels would have been drawn beside ESPN and DAZN looking entirely plausible.
*/
func TestAnAccountNameCannotReachTheBroadcasterPanel(t *testing.T) {
	for _, table := range []string{
		"dashboards.SomeOtherAccountTable",
		"dashboards.Agg_Daily_Telegram_Sports_Raw", // names, URL, and no TVChannelName
	} {
		if got := tvChannelColumn(table, hasCols("ChannelName")); got != "" {
			t.Errorf("%s offered %q as a broadcaster column — the panel would rank "+
				"pirate accounts as stations", table, got)
		}
	}
	// The two that ARE broadcasters still resolve, schema-qualified or not.
	for _, table := range []string{
		"dashboards.SportsURLRawData", "SportsURLRawData", "DASHBOARDS.SPORTSURLRAWDATA",
	} {
		if got := tvChannelColumn(table, hasCols("ChannelName")); got != colChannelName {
			t.Errorf("%s resolved %q, want ChannelName", table, got)
		}
	}
}

// And the broadcaster panel is declared, so the resolution above has somewhere
// to land.
func TestTheBroadcasterPanelIsDeclared(t *testing.T) {
	for _, c := range dimensionCandidates {
		if c.Key == dimTVChannel {
			if c.Label == "" {
				t.Error("the source-of-piracy panel has no label")
			}
			return
		}
	}
	t.Fatalf("%s is not in dimensionCandidates", dimTVChannel)
}
