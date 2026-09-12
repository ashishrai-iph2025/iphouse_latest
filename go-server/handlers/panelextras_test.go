package handlers

/*
A panel that declares an extra figure must be able to PRODUCE it.

APIExtra names a measure for reports_api to answer. On a deployment with no
REPORTS_API_URL — the direct-SQL path — nothing reads it, and for a long time
nothing computed the figure either. The failure was invisible from every angle
a person looks from:

  · the label reached the page through the sections payload, so the column was
    titled correctly;
  · the chart shape drew the heading and an empty gauge, or once empty columns
    were dropped, drew nothing at all;
  · and no query failed, because no query was ever made.

Two provider cards shipped like that and their website count was never once
drawn. These tests pin both halves of the fix: that the declaration carries a
SQL expression too, and that the expression is pinned to the panel's own side.
*/

import (
	"strings"
	"testing"
)

// Every candidate declaring an extra must name one the SQL path can build.
func TestAnExtraMeasureIsAlsoComputableWithoutTheAPI(t *testing.T) {
	for _, c := range dimensionCandidates {
		if c.APIExtra == "" && c.APIExtra2 == "" {
			continue
		}
		/* The SQL side is resolved per table by inferSpec, so what is checked
		   here is that this file KNOWS how — an APIExtra it has no branch for is
		   a figure that silently never appears off the API path. */
		switch c.APIExtra {
		/* totalSubscribers is computable off the API path too, but not as a
		   measure expression: the panel that declares it is built from raw rows
		   on both paths — folded in computeTopProfiles, grouped in
		   topProfilesSQL — because a per-profile MAX cannot be a column
		   aggregate over posts. Listed here because the figure DOES appear on a
		   deployment without reports_api, which is all this test is defending. */
		case "", "totalDomains", "totalSubscribers":
		default:
			t.Errorf("%s declares APIExtra %q, which inferSpec has no SQL branch for — "+
				"the figure will be absent on every deployment without reports_api",
				c.Key, c.APIExtra)
		}
		switch c.APIExtra2 {
		case "", "notices":
		default:
			t.Errorf("%s declares APIExtra2 %q with no SQL branch", c.Key, c.APIExtra2)
		}
	}
}

/*
The domain column is pinned to the panel's SIDE, never preferred.

A host-side card counting InfringingDomain is the linking side's figure under
the host's heading, and nothing about the number says so — the same class of
error as the root-domain cards, which took a release to notice.
*/
func TestTheDomainCountIsPinnedToItsSide(t *testing.T) {
	host := domainColumnsForRole("host")
	link := domainColumnsForRole("linking")

	for _, c := range host {
		if strings.Contains(strings.ToLower(c), "infringing") {
			t.Errorf("the host side may count %q, which is the linking side's column", c)
		}
	}
	for _, c := range link {
		if strings.Contains(strings.ToLower(c), "source") {
			t.Errorf("the linking side may count %q, which is the host side's column", c)
		}
	}
	if len(host) == 0 || len(link) == 0 {
		t.Fatal("a side with no domain column can never draw its own count")
	}
	// And a table with no role keeps the old preference order, which is right
	// for a source that cannot tell the two apart.
	if got := domainColumnsForRole(""); len(got) < 2 {
		t.Errorf("an unroled table lost its fallback list: %v", got)
	}
}

/*
And the figures arrive as NUMBERS.

MySQL's text protocol hands a COUNT() back as []byte. Left to mapRows' default
branch it JSON-encodes as base64, the page reads NaN, and the gauge draws
nothing — which on this card is indistinguishable from the measure not existing.
*/
func TestTheExtraFiguresAreMappedAsNumbers(t *testing.T) {
	rows := []map[string]any{{
		"label": "Netulu Incorporated", "value": "Netulu Incorporated",
		"urls": []byte("2800"), "removed": []byte("2700"),
		"extra": []byte("188"), "extra2": []byte("96"),
	}}
	out := mapRows(rows, "label", "value", "urls", "removed", "extra", "extra2")
	if len(out) != 1 {
		t.Fatalf("want one row, got %d", len(out))
	}
	for _, k := range []string{"extra", "extra2"} {
		if _, isBytes := out[0][k].([]byte); isBytes {
			t.Errorf("%s came through as []byte — it will reach the page as base64", k)
		}
		if got := numOf(out[0][k]); got == 0 {
			t.Errorf("%s = 0 after mapping, want the counted value", k)
		}
	}
}

/*
The SQL expression and the API column must name the SAME column.

Two paths need the figure in two forms — an expression for the direct query, a
bare column for the row walk — and writing them separately is how they come to
count different things without either looking wrong.
*/
func TestTheTwoPathsCountTheSameColumn(t *testing.T) {
	for _, c := range []struct{ expr, want string }{
		{"COUNT(DISTINCT SourceDomain)", "SourceDomain"},
		{"COUNT(DISTINCT InfringingDomain)", "InfringingDomain"},
		{"COUNT(DISTINCT SourceDMCANoticeId)", "SourceDMCANoticeId"},
	} {
		if got := distinctColOf(c.expr); got != c.want {
			t.Errorf("distinctColOf(%q) = %q, want %q", c.expr, got, c.want)
		}
	}
	// Anything not of that shape yields nothing rather than a guess — a
	// hand-written expression must not be misread as a column name.
	for _, e := range []string{"", "SUM(TotalCount)", "COUNT(*)", "COUNT(DISTINCT a, b"} {
		if got := distinctColOf(e); got != "" {
			t.Errorf("distinctColOf(%q) = %q, want empty", e, got)
		}
	}
}
