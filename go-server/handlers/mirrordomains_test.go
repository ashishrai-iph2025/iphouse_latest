package handlers

/*
The mirror COUNT and the mirror LIST are one fact, and they have to stay one.

The root-domain cards have always printed "12 mirror domains" beside a brand.
They now also hand over the twelve names, which turns a figure nobody could
check into one anybody can: a reader who opens the drawer and counts eleven rows
under a 12 has found a bug the old card could hide forever.

So these tests pin the two together at each place they could come apart — the
fold that produces them, and the merge that rebuilds every row from scratch.
*/

import (
	"sort"
	"strings"
	"testing"
)

func mirrorsOf(t *testing.T, row map[string]any) []string {
	t.Helper()
	got := stringListOf(row["mirrorDomains"])
	if got == nil {
		t.Fatalf("row %v carries no mirror list", row["label"])
	}
	return got
}

// The fold hands over the hostnames it counted, and exactly those.
func TestTheFoldCarriesTheHostnamesBehindTheCount(t *testing.T) {
	rows := []map[string]any{
		{"label": "livetv.sx", "urls": int64(100), "removed": int64(40)},
		{"label": "livetv901.me", "urls": int64(50), "removed": int64(10)},
		{"label": "cdn.livetv872.me", "urls": int64(25), "removed": int64(5)},
		{"label": "vipleague.io", "urls": int64(200), "removed": int64(90)},
	}
	out := foldDomainRows(rows, domainRootBrand)

	for _, r := range out {
		list := mirrorsOf(t, r)
		if int64(len(list)) != numOf(r["mirrors"]) {
			t.Errorf("%v: %d names under a count of %v — the card would print a "+
				"number the drawer below it contradicts",
				r["label"], len(list), r["mirrors"])
		}
	}

	byName := map[string][]string{}
	for _, r := range out {
		byName[strFromAny(r["label"])] = mirrorsOf(t, r)
	}
	want := []string{"livetv.sx", "livetv901.me", "cdn.livetv872.me"}
	got := append([]string{}, byName["livetv"]...)
	sort.Strings(got)
	sort.Strings(want)
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("livetv's mirrors are %v, want %v", got, want)
	}
	/* Volume order out of the fold — the busiest mirror first, the same ranking
	   the panel itself is in. Only the MERGE sorts alphabetically, because that
	   is the point at which volume order no longer exists. */
	if byName["livetv"][0] != "livetv.sx" {
		t.Errorf("the fold's list starts at %q, want the busiest mirror first",
			byName["livetv"][0])
	}
}

/*
The merge unions the lists rather than concatenating them.

A brand can reach the merge from more than one source. Two sources that both saw
one hostname saw one hostname, and a list with it twice would print a domain
twice under a count that had counted it twice.
*/
func TestTheMergeUnionsTheMirrorLists(t *testing.T) {
	sets := breakdownSets{}
	accumulateBreakdownSet(sets, "byDomainRootSource", "owledge", map[string]any{
		"mirrorDomains": []string{"s-c3.owledge.cc", "s-c4.owledge.cc"}})
	// The second source, arriving as []any — which is what a cached report holds
	// once it has been through JSON on its way into the summary merge.
	accumulateBreakdownSet(sets, "byDomainRootSource", "owledge", map[string]any{
		"mirrorDomains": []any{"s-c4.owledge.cc", "s-c8.owledge.cc"}})

	row := map[string]any{"label": "owledge", "mirrors": int64(4)}
	applyBreakdownSets(sets, "byDomainRootSource", "owledge", row)

	got := stringListOf(row["mirrorDomains"])
	if len(got) != 3 {
		t.Fatalf("merged to %d domains, want 3 — the shared hostname was counted twice: %v", len(got), got)
	}
	/* THE COUNT FOLLOWS THE LIST. It arrived as 4, because each side summed its
	   own hostname count and both had seen s-c4. A reader can now count the
	   drawer, so the number above it has to be the number of rows in it. */
	if numOf(row["mirrors"]) != 3 {
		t.Errorf("mirrors = %v over a list of %d — the count was left disagreeing "+
			"with the names under it", row["mirrors"], len(got))
	}
	// Alphabetical: volume order does not survive a union, and this is the order
	// somebody scanning for one domain wants.
	if got[0] != "s-c3.owledge.cc" || got[2] != "s-c8.owledge.cc" {
		t.Errorf("merged list is not sorted: %v", got)
	}
}

// A panel that never had a list does not grow one, and its summed count is left
// exactly as it was.
func TestAPanelWithoutMirrorsIsUntouchedByTheSetFold(t *testing.T) {
	sets := breakdownSets{}
	accumulateBreakdownSet(sets, "byDomain", "example.com", map[string]any{
		"urls": int64(10), "removed": int64(3)})

	row := map[string]any{"label": "example.com", "mirrors": int64(7)}
	applyBreakdownSets(sets, "byDomain", "example.com", row)

	if _, has := row["mirrorDomains"]; has {
		t.Errorf("a panel with no list gained one: %v", row["mirrorDomains"])
	}
	if numOf(row["mirrors"]) != 7 {
		t.Errorf("mirrors = %v, want the summed 7 left alone where there is no "+
			"list to derive it from", row["mirrors"])
	}
}

/*
Two panels' sets never bleed into each other.

They share a map, and the first cut of it keyed only by panel and label — so a
second set field would have unioned itself into the first one's members. There is
one set field today; this is what stops the second from being the bug.
*/
func TestSetsAreKeyedByFieldAsWellAsByRow(t *testing.T) {
	a := breakdownSetKey("byDomainRootAll", "livetv", "mirrorDomains")
	b := breakdownSetKey("byDomainRootSource", "livetv", "mirrorDomains")
	c := breakdownSetKey("byDomainRootAll", "livetv", "somethingElse")
	if a == b || a == c || b == c {
		t.Errorf("two different sets share a key: %q %q %q", a, b, c)
	}
	/* And a label that CONTAINS the separator cannot forge another row's key.
	   The separator is a NUL, which no hostname or brand can hold. */
	if strings.Contains(breakdownSetSep, " ") || breakdownSetSep == "" {
		t.Errorf("the set separator %q is not a character labels are free of", breakdownSetSep)
	}
}

/*
stringListOf reads both shapes a list arrives in — and nothing else as one.

[]string inside one process, []any after the row has been through JSON. A plain
string is NOT a one-item list: reading one that way would put a brand's own name
in its mirror drawer.
*/
func TestStringListOfReadsListsAndOnlyLists(t *testing.T) {
	if got := stringListOf([]string{"a.example", "b.example"}); len(got) != 2 {
		t.Errorf("[]string read as %v", got)
	}
	if got := stringListOf([]any{"a.example", "b.example"}); len(got) != 2 {
		t.Errorf("[]any read as %v — this is the shape a cached report holds", got)
	}
	for _, v := range []any{nil, "a.example", int64(3), map[string]any{}} {
		if got := stringListOf(v); got != nil {
			t.Errorf("%T read as a list of %d", v, len(got))
		}
	}
}

/*
── A LIST THAT CANNOT ACCOUNT FOR ITS COUNT IS SHOWN AS A LOWER BOUND ───────

The provider cards get their domain list from a walk over raw rows, and their
domain COUNT from either that same walk or from the service — whichever
answered. Where the service answered, the row carries the count and no list.

Merge such a row with one that does carry a list and the union is a fragment:
two names under a gauge reading twenty-nine. The count is the trustworthy half
there, so it is left alone rather than shrunk to match — but the two names are
still worth having, and the drawer now offers them rather than nothing. See
reconciledList, the single-table version of the same call.
*/
func TestAPartialUnionIsShownWithoutShrinkingTheCount(t *testing.T) {
	sets := breakdownSets{}
	// One source walked the rows and has the names.
	accumulateBreakdownSet(sets, "byHSPNotices", "Netulu Incorporated", map[string]any{
		"extra": int64(2), "extraDomains": []string{"a.example", "b.example"}})
	// The other took the service's count and has none.
	accumulateBreakdownSet(sets, "byHSPNotices", "Netulu Incorporated", map[string]any{
		"extra": int64(27)})

	row := map[string]any{"label": "Netulu Incorporated", "extra": int64(29)}
	applyBreakdownSets(sets, "byHSPNotices", "Netulu Incorporated", row)

	got := stringListOf(row["extraDomains"])
	if len(got) != 2 {
		t.Errorf("extraDomains = %v, want the two names carried through as a lower bound", got)
	}
	if numOf(row["extra"]) != 29 {
		t.Errorf("extra = %v, want the summed 29 left alone — a two-name fragment must "+
			"not shrink the count that is still trustworthy here", row["extra"])
	}
}

// And where every source brought its list, the count follows the union.
func TestAWholeListStillSetsItsCount(t *testing.T) {
	sets := breakdownSets{}
	accumulateBreakdownSet(sets, "byHSPNotices", "AlexHost SRL", map[string]any{
		"extra": int64(2), "extraDomains": []string{"a.example", "b.example"}})
	accumulateBreakdownSet(sets, "byHSPNotices", "AlexHost SRL", map[string]any{
		"extra": int64(2), "extraDomains": []string{"b.example", "c.example"}})

	row := map[string]any{"label": "AlexHost SRL", "extra": int64(4)}
	applyBreakdownSets(sets, "byHSPNotices", "AlexHost SRL", row)

	got := stringListOf(row["extraDomains"])
	if len(got) != 3 {
		t.Fatalf("merged to %d domains, want 3: %v", len(got), got)
	}
	if numOf(row["extra"]) != 3 {
		t.Errorf("extra = %v over a list of 3 — the shared domain was counted twice",
			row["extra"])
	}
}

/*
Every set field is paired with the count it has to agree with.

A set carried with no count field would never be reconciled against anything,
which is the state the mirror list was one review away from shipping in. The
pairing is the declaration, so adding a field without one fails here rather than
on a card.
*/
func TestEverySetFieldNamesItsCount(t *testing.T) {
	if len(breakdownSetFields) != len(breakdownSetKeys) {
		t.Errorf("%d fields are iterated but %d are declared — one of them is "+
			"either never folded or never reconciled",
			len(breakdownSetFields), len(breakdownSetKeys))
	}
	for _, f := range breakdownSetFields {
		if breakdownSetKeys[f] == "" {
			t.Errorf("set field %q names no count field, so nothing will ever check "+
				"the list against the number above it", f)
		}
	}
}

/*
The provider cards' count and list are the SAME set, by construction.

enforcementByGroup is built on enforcementSetsByGroup rather than counting
separately, so "29 linking domains" and the twenty-nine names cannot be computed
from different populations. This is the property that makes the drawer safe to
show at all.
*/
func TestTheProviderCountIsTheSizeOfItsList(t *testing.T) {
	rows := []map[string]any{
		{"HSPName": "Netulu Incorporated", "InfringingDomain": "a.example"},
		{"HSPName": "Netulu Incorporated", "InfringingDomain": "b.example"},
		{"HSPName": "Netulu Incorporated", "InfringingDomain": "a.example"},
		{"HSPName": "AlexHost SRL", "InfringingDomain": "c.example"},
		// No domain at all — counted by neither.
		{"HSPName": "AlexHost SRL", "InfringingDomain": ""},
	}
	sets := enforcementSetsByGroup(rows, "HSPName", "InfringingDomain")
	counted := enforcementByGroup(rows, "HSPName", "InfringingDomain", 0)

	if len(counted) != len(sets) {
		t.Fatalf("%d counted groups against %d listed ones", len(counted), len(sets))
	}
	for _, r := range counted {
		label := strFromAny(r["label"])
		if int64(len(sets[label])) != numOf(r["urls"]) {
			t.Errorf("%s: count %v over a list of %d — the two were computed apart",
				label, r["urls"], len(sets[label]))
		}
	}
	// Sorted, so the drawer reads the same way on every refresh.
	if got := sets["Netulu Incorporated"]; len(got) != 2 || got[0] != "a.example" {
		t.Errorf("Netulu's domains are %v, want the two distinct ones, sorted", got)
	}
}

/*
── THE GAUGE OPENS ON WHATEVER OF IT THE WALK CAN VOUCH FOR ─────────────────

The provider cards' domain COUNT comes from the service — an exact
COUNT(DISTINCT) over the window — and their domain LIST from this bridge's walk
over raw rows, which is capped at a hundred thousand.

Measured on the live warehouse on 12 September 2026: the breakdown endpoint DOES
return `domains` (Netulu Incorporated 17, BestDC Limited 54 for DAZN's
1–11 September window), and the same window holds 5,136 rows — so the walk is
complete and the two agree exactly. A window over the whole 836,669-row host
table would not be — the case this now hands over as a lower bound instead of
withholding.
*/
func TestAGaugeOpensOnWhateverTheWalkCanVouchFor(t *testing.T) {
	three := []string{"a.example", "b.example", "c.example"}

	// The live case: the walk saw everything the service counted.
	if got := reconciledList(three, 3); len(got) != 3 {
		t.Errorf("a complete list was withheld: %v", got)
	}
	/* The capped case: seventeen counted, three seen. Offered anyway, as a
	   lower bound — the caller is what compares len(list) against count and
	   says "at least 3 of 17" rather than claiming completeness. */
	if got := reconciledList(three, 17); len(got) != 3 {
		t.Errorf("a partial list was withheld rather than offered as a lower bound: %v", got)
	}
	/* A list LONGER than its count is a different failure — the walk saw MORE
	   distinct values than a correct exact count over the same rows could, so
	   the two disagree about the data rather than about how much of it each
	   saw. That is still dropped outright. */
	if got := reconciledList(three, 2); got != nil {
		t.Errorf("a three-name list was offered under a count of 2: %v", got)
	}
	// Nothing to show, either way round.
	for _, c := range []struct {
		list  []string
		count int64
	}{{nil, 0}, {nil, 5}, {three, 0}, {[]string{}, 0}} {
		if got := reconciledList(c.list, c.count); got != nil {
			t.Errorf("reconciledList(%d names, count %d) offered %v", len(c.list), c.count, got)
		}
	}
}
