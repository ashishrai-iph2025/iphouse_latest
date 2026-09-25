package handlers

import (
	"sort"
	"strconv"
	"strings"
)

/*
dimPageNo is "Page Number - Identification": the linking table's PageNoBucket —
which search-results page an infringing link was found on, as 1, 2, 3, 4 and 5+.
See its candidate in reportplatforms.go.
*/
const dimPageNo = "byPageNo"

/*
pageNoRows puts the merged page buckets in page order and drops the unfilled one.

PAGE ORDER, not volume: the panel is a sequence and reads left to right from the
first page. "5+" sorts as 5, after "4". A bucket that does not start with a
number sorts after all of them rather than being dropped, so an unexpected
spelling still shows up where someone can see it.

"(none)" is removed. It is every row with no bucket, which today is every row —
the ETL has not started filling the column — and one bar labelled "(none)" would
read as a finding. With it gone the panel says "No data" until the column is
populated, and then fills without a change here.
*/
func pageNoRows(rows []map[string]any) []map[string]any {
	out := make([]map[string]any, 0, len(rows))
	for _, r := range rows {
		label := strings.TrimSpace(strFromAny(r["label"]))
		if label == "" || label == noneLabel {
			continue
		}
		out = append(out, r)
	}
	sort.SliceStable(out, func(i, j int) bool {
		return pageNoOrder(strFromAny(out[i]["label"])) < pageNoOrder(strFromAny(out[j]["label"]))
	})
	return out
}

// pageNoOrder is a bucket's position: its leading number, or past the end.
func pageNoOrder(label string) int {
	s := strings.TrimSpace(label)
	end := 0
	for end < len(s) && s[end] >= '0' && s[end] <= '9' {
		end++
	}
	if n, err := strconv.Atoi(s[:end]); err == nil {
		return n
	}
	return 1 << 30
}
