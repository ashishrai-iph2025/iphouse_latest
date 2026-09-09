package handlers

/*
The two combined root-domain cards must never be fed by each other's table.

Open Web reads two tables and they hold different populations: SportsURLRawData
has the pages that LINK to infringing content, SportsSourceURLRawData the ones
that HOST it. A link is de-indexed from search results; a host is taken down.

The cards were one card first, declared as

	{Key: "byDomainRootAll", Column: "InfringingDomain",
	 Alts: []string{"SourceDomain", "DomainURL", "Domain"}, ...}

and the Alts are the whole bug. inferSpec resolves a candidate against each
table's own shape, so the linking table answered on InfringingDomain and the
host table on SourceDomain — the SAME panel key, twice — and runPlatform then
summed the two by label. One card, holding a linking brand's URLs added to a
host brand's, an operator's hostnames counted on both sides, and a success rate
mixing de-indexing with takedown. Nothing about the number said so.

Two things keep it split, and both are tested here: the panels' grouping columns
must not overlap, and the de-indexing card must not exist on a table that cannot
measure de-indexing.
*/

import (
	"strings"
	"testing"
)

// candidate returns the registry entry for a panel key.
func candidate(t *testing.T, key string) (col string, alts []string, needs, label string) {
	t.Helper()
	for _, c := range dimensionCandidates {
		if c.Key == key {
			return c.Column, c.Alts, c.Needs, c.Label
		}
	}
	t.Fatalf("%s is not in dimensionCandidates — the panel cannot be built at all", key)
	return "", nil, "", ""
}

/*
The bug, stated as the thing that must not be true: the two cards must not share
a single spelling of their grouping column.

Any overlap at all is enough — the two tables are resolved independently, so one
shared spelling is one table answering for both panels.
*/
func TestTheTwoSidesShareNoGroupingColumn(t *testing.T) {
	linkCol, linkAlts, _, _ := candidate(t, dimDomainRootAll)
	hostCol, hostAlts, _, _ := candidate(t, dimDomainRootSource)

	link := map[string]bool{linkCol: true}
	for _, a := range linkAlts {
		link[a] = true
	}
	for _, c := range append([]string{hostCol}, hostAlts...) {
		if link[c] {
			t.Errorf("both cards accept %q, so one table can feed both and runPlatform "+
				"will sum a linking brand into a host one", c)
		}
	}
}

// And each is pinned to the column that only its own table has.
func TestEachSideIsPinnedToItsOwnColumn(t *testing.T) {
	for _, c := range []struct{ key, want string }{
		{dimDomainRootAll, "InfringingDomain"},
		{dimDomainRootSource, "SourceDomain"},
	} {
		col, alts, _, _ := candidate(t, c.key)
		if col != c.want {
			t.Errorf("%s groups by %q, want %q", c.key, col, c.want)
		}
		/* No alternates on either. A generic `Domain` spelling would let a table
		   that carries one answer for a panel whose entire point is which table
		   it came from — the same failure as the shared column above, arriving
		   through the back door. */
		if len(alts) != 0 {
			t.Errorf("%s accepts alternates %v; a side-pinned panel takes its own column only",
				c.key, alts)
		}
	}
}

/*
The de-indexing card must be gated on the column it measures.

Its second series is "Google approved the delisting", and the bridge swaps the
Google count into `removed` to draw it. On a table with no IsGoogleDelisted the
swap has nothing to read, and without this gate the card would render a plain
removal count under a heading that says Google — a wrong number wearing a right
one's clothes, which is worse than an absent card because nothing about it looks
wrong.
*/
func TestTheDeIndexingCardRequiresTheGoogleColumn(t *testing.T) {
	_, _, needs, label := candidate(t, dimDomainRootAll)
	if needs != "IsGoogleDelisted" {
		t.Errorf("%s requires %q, want IsGoogleDelisted — without the gate this card "+
			"draws plain removals under a de-indexing heading", dimDomainRootAll, needs)
	}
	// The heading and the gate have to agree: a card that says de-indexing and
	// one that requires the de-indexing column are the same decision written
	// twice, and the day they differ one of them is lying.
	if !strings.Contains(label, "De-Indexing") {
		t.Errorf("%s is titled %q, which no longer names the measure it is gated on",
			dimDomainRootAll, label)
	}
}

// The host card measures removal, so it must NOT be gated on Google's column —
// a host is not de-indexed, it is taken down.
func TestTheHostCardIsNotGatedOnGoogle(t *testing.T) {
	_, _, needs, label := candidate(t, dimDomainRootSource)
	if needs != "" {
		t.Errorf("%s requires %q; the host side measures removal and needs nothing extra",
			dimDomainRootSource, needs)
	}
	if !strings.Contains(label, "Removal") {
		t.Errorf("%s is titled %q, which does not name removal", dimDomainRootSource, label)
	}
}

// Both fold to brands, or the cards have no rows at all.
func TestBothSidesFoldToBrands(t *testing.T) {
	for _, key := range []string{dimDomainRootAll, dimDomainRootSource} {
		if _, derived := domainFoldFor(key); !derived {
			t.Errorf("%s is not folded to brands, so it would draw raw hostnames", key)
		}
	}
}

/*
The fold carries the Google count per brand.

Summed like the volumes rather than maxed: a brand's linking domains are
different hostnames, and the delistings approved against each of them are
different delistings.
*/
func TestTheFoldSumsTheGoogleCount(t *testing.T) {
	rows := []map[string]any{
		{"label": "livetv.sx", "urls": 100, "removed": 80, "googleDelisted": 61},
		{"label": "livetv901.me", "urls": 40, "removed": 30, "googleDelisted": 22},
		{"label": "other.example", "urls": 7, "removed": 1, "googleDelisted": 1},
	}
	out := foldDomainRows(rows, domainRootBrand)

	var livetv map[string]any
	for _, r := range out {
		if r["label"] == "livetv" {
			livetv = r
		}
	}
	if livetv == nil {
		t.Fatalf("the two livetv hostnames did not fold to one brand: %v", out)
	}
	if got := numOf(livetv["googleDelisted"]); got != 83 {
		t.Errorf("googleDelisted = %d, want 83 (61+22)", got)
	}
	if got := numOf(livetv["mirrors"]); got != 2 {
		t.Errorf("mirrors = %d, want 2 — the count of hostnames folded in", got)
	}
	if got := numOf(livetv["urls"]); got != 140 {
		t.Errorf("urls = %d, want 140", got)
	}
}
