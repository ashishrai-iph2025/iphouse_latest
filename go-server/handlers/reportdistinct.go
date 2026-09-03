package handlers

// How a DISTINCT count merges when several sources are added together.
//
// Every other KPI on a report is additive: two tables each finding 40 URLs found
// 80 between them. A distinct count of a dimension the sources SHARE is not —
// the same title is enforced on every platform at once, so two tables each
// reporting one asset are reporting the same asset, and adding them counts the
// tables rather than the assets.
//
// ── The bug this exists to remove ────────────────────────────────────────────
//
//	`totalAssets` is COUNT(DISTINCT AssetId) per table, and it was summed twice:
//	once across the tables inside a platform (reportplatforms.go) and again
//	across the platforms inside Summary (reportsummary.go).
//
//	With one asset selected, every table holding a row for it returns exactly 1,
//	so the tile counted TABLES. Measured on DAZN with a single asset picked:
//
//	  Open Web              2   — SportsURLRawData + SportsSourceURLRawData
//	  Social Media & UGC    1   — one table, and correct by coincidence
//	  Summary               3   — 2 + 1
//
//	The right answer in all three places is 1. "Titles in scope: 3" for one
//	selected title is not a number a reader can discount; it is a number they
//	act on, and it moves whenever a table happens to have rows.
//
//	It was inflated without a filter too — the whole catalogue multiplied by how
//	many tables carry it — but there the reader had no way to notice.
//
// ── Why not just count them properly ────────────────────────────────────────
//
//	Summary already tries: summaryDistinctAssets unions the ids. But it speaks
//	only direct SQL, and this install reads through reports_api, so every query
//	errors, the union reports itself inexact, and the summed figure stands. The
//	failure is silent — the per-table error is logged and swallowed, and "no
//	table answered" is indistinguishable from "no table has an asset column".
//
//	So this fixes the MERGE rather than adding a second scan. Two cases, and the
//	first is the one that matters:
//
//	  filtered    the reader named the assets. The answer is how many they
//	              named — exact, and free. No query can improve on it.
//	  unfiltered  the largest single source's distinct count, not the sum. The
//	              same catalogue is enforced everywhere, so the biggest table's
//	              count is the closest honest floor, and it can never be
//	              multiplied by how many tables exist.
//
//	The unfiltered case is an estimate and is deliberately one that can only
//	UNDER-report: a table holding a title no other table has is not counted
//	twice, it is not counted at all. Under-reporting a catalogue size is a
//	smaller wrong than multiplying it, and the exact union stays available to
//	direct-SQL installs on top.

import "strings"

/*
distinctKPIs are the KPIs that count distinct values of a dimension every source
shares, and so must be merged by MAX rather than by addition.

Deliberately just the one. Places — domains and channels — ARE summed, and
correctly: a domain and a channel are never the same row, and the two open-web
tables count different columns (InfringingDomain and SourceDomain), so their
totals genuinely add. Adding a metric here without that property being true of
it would replace an inflated number with a truncated one.
*/
var distinctKPIs = map[string]bool{"totalAssets": true}

// mergeKPI folds one source's figure into a running total, choosing addition or
// max by what the metric MEANS. The one place that decision is made, so the
// per-platform and per-summary merges cannot drift apart.
func mergeKPI(dst map[string]int64, key string, v int64) {
	if distinctKPIs[key] {
		if v > dst[key] {
			dst[key] = v
		}
		return
	}
	dst[key] += v
}

/*
selectedAssetCount is how many assets the reader named, or 0 for "all".

`assetId` arrives as a repeated parameter, a comma-separated list, or both —
flatQuery collapses repeats to the first value, so the comma form is what
reaches a report scope. Deduplicated case-insensitively because ids are GUIDs
and two spellings of one are one asset.
*/
func selectedAssetCount(q map[string]string) int64 {
	raw := strings.TrimSpace(q["assetId"])
	if raw == "" {
		return 0
	}
	seen := map[string]bool{}
	for _, part := range strings.Split(raw, ",") {
		if p := strings.TrimSpace(part); p != "" {
			seen[strings.ToLower(p)] = true
		}
	}
	return int64(len(seen))
}

/*
applyAssetScope overwrites a merged totalAssets with the reader's own selection
when there is one.

Only when the tile already exists: a platform with no asset column has no such
tile, and inventing one because a filter was set would put a figure on a report
that cannot measure it.
*/
func applyAssetScope(kpi map[string]int64, q map[string]string) {
	if _, has := kpi["totalAssets"]; !has {
		return
	}
	if n := selectedAssetCount(q); n > 0 {
		kpi["totalAssets"] = n
	}
}
