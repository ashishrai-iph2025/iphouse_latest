package handlers

import (
	"encoding/json"
	"testing"
)

/*
Paging the asset register.

The filtering and counting now happen in SQL, which these tests cannot reach.
What they can reach is the MAPPING — what this service asks the master for, and
how it reads the answer back — and that is where the silent failures live. Every
one of the cases below produces a table that renders perfectly and lies.
*/

func getter(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

/*
EVERY ACTIVE FILTER MUST REACH THE UPSTREAM QUERY.

This is the one that matters. The page sends a filter, the server holds it, and
the row count comes back for a DIFFERENT predicate than the rows — so the table
lists five titles under "1,388 match this filter". Nothing errors and the numbers
look plausible, which is why it would survive a manual check.
*/
func TestEveryFilterReachesTheUpstreamQuery(t *testing.T) {
	f := parseAssetFilter(getter(map[string]string{
		"q": "world", "genre": "Sports", "active": "1", "page": "3", "pageSize": "25",
	}))
	q := assetUpstreamQuery("CLIENT-1", f)

	for param, want := range map[string]string{
		"ClientMasterId": "CLIENT-1",
		"q":              "world",
		"Genre":          "Sports",
		"Active":         "1",
		"limit":          "25",
		"offset":         "50", // page 3 of 25
	} {
		if got := q.Get(param); got != want {
			t.Errorf("%s = %q, want %q — a filter the page applied but the query "+
				"does not carry means the rows and the count answer different "+
				"questions", param, got, want)
		}
	}

	if q.Get("total") != "1" {
		t.Error("total was not requested. Without it the master returns no row " +
			"count, the pager reads a missing total as zero and draws itself as " +
			"one empty page.")
	}
	if q.Get("facets") == "" {
		t.Error("no facets requested — the genre picker would have to be built " +
			"from the fifty rows on screen, which offers only the genre already " +
			"selected and no way back")
	}
}

// "All genres" is the absence of a filter, not a genre called All.
func TestTheAllSentinelIsNotSentAsAGenre(t *testing.T) {
	q := assetUpstreamQuery("C", parseAssetFilter(getter(map[string]string{"genre": "all"})))
	if q.Get("Genre") != "" {
		t.Errorf("Genre = %q — the sentinel was forwarded as a real genre name, "+
			"which matches nothing and empties the register", q.Get("Genre"))
	}
	if v := assetUpstreamQuery("C", parseAssetFilter(getter(map[string]string{
		"active": "banana"}))).Get("Active"); v != "" {
		t.Errorf("Active = %q, want an unrecognised value to mean no filter", v)
	}
}

func TestOffsetIsZeroOnTheFirstPage(t *testing.T) {
	q := assetUpstreamQuery("C", parseAssetFilter(getter(map[string]string{"page": "1"})))
	if q.Get("offset") != "0" {
		t.Errorf("offset = %q on page 1, want 0", q.Get("offset"))
	}
}

/*
pageSize is clamped, not trusted.

It is the only thing standing between a reader and the 47,000-row register that
paging exists to avoid sending.
*/
func TestPageSizeIsClamped(t *testing.T) {
	if f := parseAssetFilter(getter(map[string]string{"pageSize": "100000"})); f.pageSize != assetPageSizeMax {
		t.Errorf("pageSize = %d, want it clamped to %d", f.pageSize, assetPageSizeMax)
	}
	if f := parseAssetFilter(getter(map[string]string{"pageSize": "1"})); f.pageSize != assetPageSizeMin {
		t.Errorf("pageSize = %d, want it raised to %d", f.pageSize, assetPageSizeMin)
	}
	if f := parseAssetFilter(getter(map[string]string{})); f.pageSize != assetPageSizeInit {
		t.Errorf("default pageSize = %d, want %d", f.pageSize, assetPageSizeInit)
	}
	// And the clamp has to reach the wire, not just the struct.
	q := assetUpstreamQuery("C", parseAssetFilter(getter(map[string]string{"pageSize": "100000"})))
	if q.Get("limit") != "200" {
		t.Errorf("limit = %q, want the clamped 200 — clamping the struct and "+
			"sending the raw value would defeat the whole thing", q.Get("limit"))
	}
}

// The upstream body decoded the way it actually arrives.
func upstreamBody(t *testing.T, raw string) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return m
}

/*
total arrives as a JSON NUMBER, which decodes to float64 — never int.

A plain assertion to int yields zero, and a zero total is not a visible error:
the pager reports one page, the Next button is disabled, and 1,338 titles are
unreachable behind a table that looks finished.
*/
func TestTotalIsReadFromAFloat(t *testing.T) {
	body := upstreamBody(t, `{"rows":[],"total":1388}`)
	if _, isFloat := body["total"].(float64); !isFloat {
		t.Fatalf("total decoded as %T — this test is not exercising the real shape", body["total"])
	}
	got := assetPageBody(body, assetFilter{page: 1, pageSize: 50})
	if got["total"] != 1388 {
		t.Errorf("total = %v, want 1388 — read as an int this silently becomes 0 "+
			"and the pager hides every page but the first", got["total"])
	}
	if got["pages"] != 28 {
		t.Errorf("pages = %v, want 28 (1388 at 50 per page)", got["pages"])
	}
}

/*
A page past the end clamps to the last one.

Narrowing a filter while on page 20 is ordinary. Reporting page 20 of 3 leaves
the reader looking at an empty table that reads as "your search found nothing".
*/
func TestPageBeyondTheEndClamps(t *testing.T) {
	got := assetPageBody(upstreamBody(t, `{"rows":[],"total":30}`),
		assetFilter{page: 99, pageSize: 10})
	if got["page"] != 3 {
		t.Errorf("page = %v, want it clamped to the last page 3", got["page"])
	}
}

func TestAnEmptyRegisterReportsOnePage(t *testing.T) {
	got := assetPageBody(upstreamBody(t, `{"rows":[],"total":0}`),
		assetFilter{page: 1, pageSize: 50})
	if got["pages"] != 1 {
		t.Errorf("pages = %v, want 1 rather than 0", got["pages"])
	}
}

/*
Whether the feed carries Active is read off the ROWS.

An older reporting service does not reject Active=1 — it ignores a parameter it
does not know. The page would tick "Active only", be served retired titles
anyway, and show no sign of the disagreement. Seeing the column absent, it hides
the control instead.
*/
func TestHasActiveIsDetectedFromTheRows(t *testing.T) {
	with := assetPageBody(upstreamBody(t,
		`{"rows":[{"Id":"1","Active":1}],"total":1}`), assetFilter{page: 1, pageSize: 50})
	if with["hasActive"] != true {
		t.Error("hasActive should be true when the rows carry the column")
	}

	without := assetPageBody(upstreamBody(t,
		`{"rows":[{"Id":"1","AssetName":"One"}],"total":1}`), assetFilter{page: 1, pageSize: 50})
	if without["hasActive"] != false {
		t.Error("hasActive should be false on a feed with no Active column, so the " +
			"page hides a control that would silently do nothing")
	}
}

// The genre picker comes from the facet, not from the page's rows.
func TestGenresComeFromTheFacet(t *testing.T) {
	got := assetPageBody(upstreamBody(t, `{
		"rows":[{"Id":"1","Genre":"Sports"}],
		"total":1,
		"facets":{"Genre":["Games","Movies","Sports"]}}`), assetFilter{page: 1, pageSize: 50})

	genres, _ := got["genres"].([]string)
	if len(genres) != 3 {
		t.Errorf("genres = %v, want all three from the facet — taken from the rows "+
			"instead, a filtered page offers only the genre already chosen", genres)
	}
}
