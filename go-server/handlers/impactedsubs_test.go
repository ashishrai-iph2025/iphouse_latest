package handlers

import (
	"testing"

	"github.com/ip-house/iphouse-api/reportsapi"
)

/*
Impacted Subscribers is a SUBSET of Total Subscribers.

It read 16.3M against a total of 5.5M on a DAZN Telegram report — a part larger
than the whole. The cause was a hole rather than a wrong sum: Telegram's and
YouTube's VOD tables carry ChannelStatus and not RemovalChannelStatus, so
hasChannelColumns was false, the block that replaces BOTH tiles never ran, and
Impacted was left holding the service's SUM(Subscribers). Total had been rescued
separately by wantTotalSubscribers; Impacted had no twin.

Every case below is arithmetic on rows, which is where the defect lived and
where no warehouse is needed to catch it.
*/

// One account, three posts, one follower count. The reading moves between
// crawls, which is why the rule is MAX and not "the first one seen".
func rowsOneChannelThreePosts(status string) []map[string]any {
	return []map[string]any{
		{"ChannelURL": "t.me/a", "ChannelStatus": status, "Subscribers": 1000},
		{"ChannelURL": "t.me/a", "ChannelStatus": status, "Subscribers": 1200},
		{"ChannelURL": "t.me/a", "ChannelStatus": status, "Subscribers": 1100},
	}
}

/*
THE BUG ITSELF: one account's followers counted once per post.

SUM over these rows is 3,300 for an account that has 1,200 followers. Multiply
that across a client's whole window and you get 16.3M out of 5.5M.
*/
func TestImpactedSubscribersCountsEachAccountOnce(t *testing.T) {
	got := maxPerAccountImpacted(rowsOneChannelThreePosts("Dead"), "ChannelURL", "ChannelStatus")
	if got != 1200 {
		t.Errorf("got %d, want 1200 — the account's own highest reading. 3300 means "+
			"the follower count was summed once per post, which is the defect this "+
			"replaced", got)
	}
}

/*
Only the accounts that were actually taken down.

Impacted is "the reach enforcement removed". Counting live accounts in it makes
it equal to Total, and the two tiles stop being different questions.
*/
func TestImpactedCountsOnlyAccountsThatCameDown(t *testing.T) {
	rows := []map[string]any{
		{"ChannelURL": "t.me/dead", "ChannelStatus": "Dead", "Subscribers": 500},
		{"ChannelURL": "t.me/live", "ChannelStatus": "Active", "Subscribers": 9000},
	}
	got := maxPerAccountImpacted(rows, "ChannelURL", "ChannelStatus")
	if got != 500 {
		t.Errorf("got %d, want 500 — only the suspended account's audience counts; "+
			"9500 means a live channel was counted as removed reach", got)
	}
}

/*
THE INVARIANT, on the same rows: impacted <= total, always.

This is the property the tiles are read against, and the one that was visibly
broken on screen.
*/
func TestImpactedNeverExceedsTotal(t *testing.T) {
	for _, c := range []struct {
		name string
		rows []map[string]any
	}{
		{"all suspended", rowsOneChannelThreePosts("Dead")},
		{"none suspended", rowsOneChannelThreePosts("Active")},
		{"mixed", []map[string]any{
			{"ChannelURL": "t.me/a", "ChannelStatus": "Dead", "Subscribers": 300},
			{"ChannelURL": "t.me/a", "ChannelStatus": "Dead", "Subscribers": 450},
			{"ChannelURL": "t.me/b", "ChannelStatus": "Active", "Subscribers": 800},
			{"ChannelURL": "t.me/b", "ChannelStatus": "Active", "Subscribers": 100},
		}},
	} {
		total := maxPerAccountTotal(c.rows, "ChannelURL")
		imp := maxPerAccountImpacted(c.rows, "ChannelURL", "ChannelStatus")
		if imp > total {
			t.Errorf("%s: impacted %d exceeds total %d — a subset larger than its set",
				c.name, imp, total)
		}
	}
}

/*
Both spellings of "taken down", because the warehouse uses both.

'Dead' is what the raw tables write; the VOD YouTube table's own suspended-channel
measure in reports_api keys on LIKE '%Suspend%'. Matching one spelling yields a
flat zero on the tables that use the other — a tile reading 0 that nobody can
tell apart from "nothing was removed this window".
*/
func TestBothSpellingsOfTakenDownAreRecognised(t *testing.T) {
	for _, v := range []string{"Dead", "dead", " Dead ", "Suspended", "suspended", "Channel Suspended"} {
		if !accountTakenDown(v) {
			t.Errorf("accountTakenDown(%q) = false; the warehouse writes both 'Dead' "+
				"and a Suspend* spelling for the same fact", v)
		}
	}
	for _, v := range []string{"", "Active", "Live", "   "} {
		if accountTakenDown(v) {
			t.Errorf("accountTakenDown(%q) = true — a live account would be counted "+
				"as removed reach", v)
		}
	}
}

/*
The ACCOUNT's status column, resolved in priority order.

The dedicated columns are the precise ones: RemovalStatus on the row is about
the POST, and a post can come down while its account stays up. ChannelStatus is
the fallback because it is all these VOD aggregates carry.
*/
func TestAccountStatusColumnResolution(t *testing.T) {
	ds := func(cols ...string) reportsapi.Dataset {
		return reportsapi.Dataset{Columns: cols}
	}
	for _, c := range []struct {
		name string
		in   reportsapi.Dataset
		want string
	}{
		{"raw table", ds("ChannelURL", "RemovalChannelStatus", "ChannelStatus"), colRemovalChannelStatus},
		{"profile table", ds("ProfileURL", "RemovalProfileStatus"), colProfileStatus},
		{"VOD aggregate", ds("ChannelURL", "ChannelStatus"), colChannelStatus},
		{"nothing usable", ds("ChannelURL", "Subscribers"), ""},
	} {
		if got := accountStatusCol(c.in); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

/*
No status column means no tile, not a zero.

maxPerAccountImpacted returns 0 when it has nothing to filter on, and 0 is a
lie of a different kind — it reads as "nothing was taken down". The caller
deletes the tile in that case; this pins the helper's half of the contract.
*/
func TestNoStatusColumnYieldsNothingToShow(t *testing.T) {
	if got := maxPerAccountImpacted(rowsOneChannelThreePosts("Dead"), "ChannelURL", ""); got != 0 {
		t.Errorf("got %d, want 0 when there is no status column to read", got)
	}
	if got := maxPerAccountImpacted(rowsOneChannelThreePosts("Dead"), "", "ChannelStatus"); got != 0 {
		t.Errorf("got %d, want 0 when there is no account column to key on", got)
	}
}
