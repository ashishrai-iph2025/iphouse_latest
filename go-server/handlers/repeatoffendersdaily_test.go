package handlers

import "testing"

/*
Repeat offenders on a DAILY ROLLUP.

The timestamp path measures a comeback against a removal stamp. The VOD
aggregates carry an account URL and no stamp at all — not RemovalTime, not
RemovalDate, not RemovalDoneAt — so that path recorded no batches, scored every
account 0, and the card read "No channel or profile came back after a takedown
in this window" on every VOD report for every client, permanently. An empty
panel that cannot become non-empty is a standing claim that nobody reoffends.

The rollup's own grain answers the same question: the earliest day the account
had a removal is the takedown, and any later day it was identified on is a
comeback. Everything below is that arithmetic, which is where a wrong answer
would be both invisible and defamatory — this card names accounts.
*/

func dayRow(url, date string, identified, removed int64) map[string]any {
	return map[string]any{
		"ChannelURL": url, "URLUploadDate": date,
		"TotalCount": identified, "RemovedCount": removed,
	}
}

func daily(rows []map[string]any) []map[string]any {
	return computeRepeatOffendersDaily(rows, "ChannelURL", "URLUploadDate",
		"TotalCount", "RemovedCount", 10)
}

func rowFor(t *testing.T, out []map[string]any, url string) map[string]any {
	t.Helper()
	for _, r := range out {
		if r["label"] == url {
			return r
		}
	}
	return nil
}

/*
THE CYCLE: up, removed, up again.

One removal on the 1st and fresh activity on the 3rd is one comeback — the
behaviour the card exists to name.
*/
func TestADayOfActivityAfterARemovalIsARepeat(t *testing.T) {
	out := daily([]map[string]any{
		dayRow("yt.com/a", "2026-09-01", 10, 4),
		dayRow("yt.com/a", "2026-09-03", 7, 0),
	})
	r := rowFor(t, out, "yt.com/a")
	if r == nil {
		t.Fatal("the account is absent; it was removed from and posted again, which is " +
			"exactly a repeat offender")
	}
	if got := numOf(r["repeats"]); got != 1 {
		t.Errorf("repeats = %d, want 1", got)
	}
	if got := numOf(r["urls"]); got != 17 {
		t.Errorf("urls = %d, want 17 — the rollup's own counts, not the row count", got)
	}
	if got := numOf(r["removed"]); got != 4 {
		t.Errorf("removed = %d, want 4", got)
	}
}

/*
An account nothing was ever removed from is NOT a repeat offender.

It may be the client's largest problem, and the volume panel beside this one is
where it belongs. Including it here is the failure the timestamp path was
rewritten to remove: ranking by busyness rather than by defiance.
*/
func TestAnAccountNeverRemovedFromIsExcluded(t *testing.T) {
	out := daily([]map[string]any{
		dayRow("yt.com/busy", "2026-09-01", 900, 0),
		dayRow("yt.com/busy", "2026-09-02", 900, 0),
		dayRow("yt.com/busy", "2026-09-03", 900, 0),
	})
	if r := rowFor(t, out, "yt.com/busy"); r != nil {
		t.Errorf("a never-removed account scored %v repeats — it posted a lot, which is "+
			"a different question and a different panel", r["repeats"])
	}
}

/*
The removal day itself is not a comeback.

A day with a removal is nearly always a day with activity, so counting it would
hand every removed account a score of at least 1 and the panel would rank the
same accounts as the volume one.
*/
func TestTheRemovalDayIsNotItselfARepeat(t *testing.T) {
	out := daily([]map[string]any{dayRow("yt.com/once", "2026-09-01", 10, 10)})
	if r := rowFor(t, out, "yt.com/once"); r != nil {
		t.Errorf("removed on its only active day and scored %v — nothing came after it",
			r["repeats"])
	}
}

/*
Activity BEFORE the first removal is not a comeback either.

The account was not yet on notice. Counting earlier days would score an account
by how long it had been active before anyone acted.
*/
func TestActivityBeforeTheFirstRemovalDoesNotCount(t *testing.T) {
	out := daily([]map[string]any{
		dayRow("yt.com/b", "2026-09-01", 5, 0),
		dayRow("yt.com/b", "2026-09-02", 5, 0),
		dayRow("yt.com/b", "2026-09-05", 5, 3), // first removal
		dayRow("yt.com/b", "2026-09-06", 5, 0), // the one comeback
	})
	r := rowFor(t, out, "yt.com/b")
	if r == nil {
		t.Fatal("account missing")
	}
	if got := numOf(r["repeats"]); got != 1 {
		t.Errorf("repeats = %d, want 1 — only 09-06 follows the first removal; the two "+
			"days before it were before the account was ever on notice", got)
	}
}

// Each later day counts once, however many rows or URLs it carried.
func TestEachComebackDayCountsOnce(t *testing.T) {
	out := daily([]map[string]any{
		dayRow("yt.com/c", "2026-09-01", 1, 1),
		dayRow("yt.com/c", "2026-09-02", 50, 0),
		dayRow("yt.com/c", "2026-09-02", 50, 0), // same day, second row
		dayRow("yt.com/c", "2026-09-04", 3, 0),
	})
	r := rowFor(t, out, "yt.com/c")
	if r == nil {
		t.Fatal("account missing")
	}
	if got := numOf(r["repeats"]); got != 2 {
		t.Errorf("repeats = %d, want 2 — 09-02 is one day however many rows it has, and "+
			"a busy afternoon is one piece of behaviour", got)
	}
}

/*
The identity is the URL, never the display name.

Two accounts calling themselves the same thing are two offenders, and merging
them would report one as twice as persistent as either.
*/
func TestAccountsAreKeyedOnTheURL(t *testing.T) {
	rows := []map[string]any{
		dayRow("yt.com/one", "2026-09-01", 5, 5),
		dayRow("yt.com/one", "2026-09-02", 5, 0),
		dayRow("yt.com/two", "2026-09-01", 5, 5),
		dayRow("yt.com/two", "2026-09-02", 5, 0),
	}
	for i := range rows {
		rows[i]["ChannelName"] = "Sports HD Live"
	}
	out := daily(rows)
	if len(out) != 2 {
		t.Fatalf("got %d rows, want 2 — two URLs sharing a display name are two accounts",
			len(out))
	}
	for _, r := range out {
		if got := numOf(r["repeats"]); got != 1 {
			t.Errorf("%v scored %d, want 1", r["label"], got)
		}
	}
}

/*
Without a per-day removal count there is nothing to measure from.

Returning an empty panel is the honest answer; inventing one from activity alone
would rank the busiest account under a title promising the opposite.
*/
func TestTheDailyPathNeedsItsColumns(t *testing.T) {
	rows := []map[string]any{
		dayRow("yt.com/a", "2026-09-01", 10, 4),
		dayRow("yt.com/a", "2026-09-03", 7, 0),
	}
	for _, c := range []struct{ name, url, date, ident, removed string }{
		{"no url column", "", "URLUploadDate", "TotalCount", "RemovedCount"},
		{"no date column", "ChannelURL", "", "TotalCount", "RemovedCount"},
		{"no removed column", "ChannelURL", "URLUploadDate", "TotalCount", ""},
	} {
		got := computeRepeatOffendersDaily(rows, c.url, c.date, c.ident, c.removed, 10)
		if len(got) != 0 {
			t.Errorf("%s: got %d rows, want none", c.name, len(got))
		}
	}
}

// Ranked by recurrence first — the whole point of the panel.
func TestTheMostPersistentAccountRanksFirst(t *testing.T) {
	out := daily([]map[string]any{
		// One comeback, enormous volume.
		dayRow("yt.com/loud", "2026-09-01", 4000, 10),
		dayRow("yt.com/loud", "2026-09-02", 4000, 0),
		// Three comebacks, small volume.
		dayRow("yt.com/persistent", "2026-09-01", 10, 2),
		dayRow("yt.com/persistent", "2026-09-02", 10, 0),
		dayRow("yt.com/persistent", "2026-09-03", 10, 0),
		dayRow("yt.com/persistent", "2026-09-04", 10, 0),
	})
	if len(out) < 2 {
		t.Fatalf("got %d rows, want 2", len(out))
	}
	if out[0]["label"] != "yt.com/persistent" {
		t.Errorf("first row is %v — the panel ranks by RECURRENCE, and a single huge "+
			"dump that was then dealt with is the solved problem, not the ongoing one",
			out[0]["label"])
	}
}

// The account's suspension is carried through, off whichever column names it.
func TestSuspendedAccountsAreLabelled(t *testing.T) {
	rows := []map[string]any{
		dayRow("yt.com/d", "2026-09-01", 5, 5),
		dayRow("yt.com/d", "2026-09-02", 5, 0),
	}
	rows[1]["ChannelStatus"] = "Dead"
	r := rowFor(t, daily(rows), "yt.com/d")
	if r == nil {
		t.Fatal("account missing")
	}
	if r["profileStatus"] != "Suspended" {
		t.Errorf("profileStatus = %v, want Suspended", r["profileStatus"])
	}
}
