package handlers

import (
	"net/url"
	"strconv"
	"strings"
)

/*
Turning a page request into an upstream query.

── Where the paging happens, and why it moved ───────────────────────────────

At the DATABASE. /v1/masters/assets takes limit, offset, total and the declared
filters, so MySQL cuts the page and this service forwards fifty rows.

The first version of this paged in memory: fetch the client's whole register,
cache it, slice. It worked and it was the wrong shape. Measured, one decoded row
costs 1,414 bytes — three times its JSON — so the largest client on this platform
(47,000 assets, per the master's own note) is 63 MB of cache for one company, and
the four-entry bound made that 254 MB of resident memory serving a screen a
handful of people open. Paging at the source costs nothing per client and is
correct at any size.

── The filters go upstream too, and that is not optional ────────────────────

A filter applied to the fifty rows in hand is not a filter — it would report
three matches where the register holds forty. Search, genre and active are all
declared filters on the master, so the WHERE clause and the LIMIT see the same
predicate and `total` counts what the reader is actually filtering.
*/

const (
	assetPageSizeMin  = 10
	assetPageSizeMax  = 200
	assetPageSizeInit = 50
)

// assetFilter is what the page asked for, already parsed and bounded.
type assetFilter struct {
	q        string
	genre    string
	active   string // "1" | "0" | "" (all)
	page     int
	pageSize int
}

func parseAssetFilter(get func(string) string) assetFilter {
	f := assetFilter{
		q:        strings.TrimSpace(get("q")),
		genre:    strings.TrimSpace(get("genre")),
		active:   strings.TrimSpace(get("active")),
		page:     1,
		pageSize: assetPageSizeInit,
	}
	if strings.EqualFold(f.genre, "all") {
		f.genre = ""
	}
	if f.active != "1" && f.active != "0" {
		f.active = ""
	}
	if n, err := strconv.Atoi(strings.TrimSpace(get("page"))); err == nil && n > 0 {
		f.page = n
	}
	if n, err := strconv.Atoi(strings.TrimSpace(get("pageSize"))); err == nil && n > 0 {
		/* Clamped rather than rejected. A page size out of range is a caller
		   getting it wrong, not an attack, and an error for it would break the
		   table instead of showing a sensible number of rows. The upper bound is
		   what stops pageSize=100000 from undoing the whole point of this — it is
		   the only thing standing between a reader and the 47k-row register. */
		if n < assetPageSizeMin {
			n = assetPageSizeMin
		}
		if n > assetPageSizeMax {
			n = assetPageSizeMax
		}
		f.pageSize = n
	}
	return f
}

/*
assetUpstreamQuery builds the master request for one page.

Pure, and separated from the handler so the mapping can be tested: every one of
these parameters is a place where the page and the count can silently disagree.
Sending `q` without `total`, or `total` without the filters, produces a table
that lists five rows and says there are two thousand.
*/
func assetUpstreamQuery(clientID string, f assetFilter) url.Values {
	q := url.Values{}
	q.Set("ClientMasterId", clientID)
	q.Set("limit", strconv.Itoa(f.pageSize))
	q.Set("offset", strconv.Itoa((f.page-1)*f.pageSize))
	// The row count for the SAME predicate, which is what makes a pager possible.
	q.Set("total", "1")
	// The genre picker, in the same round trip. Its values come from a DISTINCT
	// over the whole client, not from the page — a dropdown built from fifty rows
	// offers only the option already chosen.
	q.Set("facets", "Genre")

	if f.q != "" {
		q.Set("q", f.q)
	}
	if f.genre != "" {
		q.Set("Genre", f.genre)
	}
	if f.active != "" {
		q.Set("Active", f.active)
	}
	return q
}

// truthyParam reads a query flag the way the reporting service reads its own —
// anything but empty, 0, off, false or no.
func truthyParam(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "", "0", "off", "false", "no":
		return false
	}
	return true
}

// assetIntFrom reads a JSON number off the decoded body. Every number in a
// map[string]any decoded by encoding/json is a float64 — never an int — so a
// plain type assertion to int silently yields zero, and a zero total draws a
// pager as one empty page.
func assetIntFrom(v any) int {
	switch t := v.(type) {
	case float64:
		return int(t)
	case int:
		return t
	case int64:
		return int(t)
	case string:
		n, _ := strconv.Atoi(t)
		return n
	}
	return 0
}

func assetStringsFrom(v any) []string {
	raw, _ := v.([]any)
	out := make([]string, 0, len(raw))
	for _, x := range raw {
		if s := strings.TrimSpace(anyToString(x)); s != "" {
			out = append(out, s)
		}
	}
	return out
}

/*
assetPageBody shapes the upstream answer into what the table reads.

`pages` is computed here rather than upstream because it depends on the page
size this service chose, not on anything the warehouse knows. The clamp matters:
narrowing a filter while on page 20 is ordinary, and reporting page 20 of 3
leaves the reader looking at an empty table that reads as "no results".
*/
func assetPageBody(upstream map[string]any, f assetFilter) map[string]any {
	rows, _ := upstream["rows"].([]any)
	if rows == nil {
		rows = []any{}
	}
	total := assetIntFrom(upstream["total"])

	pages := (total + f.pageSize - 1) / f.pageSize
	if pages == 0 {
		pages = 1
	}
	page := f.page
	if page > pages {
		page = pages
	}

	genres := []string{}
	if facets, ok := upstream["facets"].(map[string]any); ok {
		genres = assetStringsFrom(facets["Genre"])
	}

	return map[string]any{
		"rows":      rows,
		"page":      page,
		"pageSize":  f.pageSize,
		"pages":     pages,
		"total":     total,
		"genres":    genres,
		"hasActive": rowsCarryActive(rows),
	}
}

/*
rowsCarryActive reports whether the feed knows about Active at all.

Read off the ROWS rather than assumed, because an older reporting service does
not silently fail when sent Active=1 — it ignores the parameter it does not
recognise. The page would then tick "Active only", list retired titles anyway,
and give the reader no way to tell which of the two things they were looking at.
Seeing the column absent, the page hides the control instead.
*/
func rowsCarryActive(rows []any) bool {
	for _, raw := range rows {
		if row, ok := raw.(map[string]any); ok {
			if _, present := row["Active"]; present {
				return true
			}
		}
	}
	return false
}
