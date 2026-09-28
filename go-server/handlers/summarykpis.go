package handlers

import "sync"

/*
A CONFIGURED summary's headline tiles, added up from the sections it summarises.

The VOD Summary is a configured platform reading one table,
dashboards.Unified_BI_Dashboard, and that table does not carry every figure the
sections beside it show. Views Saved is a stored column the per-platform
reports do not trust (they recompute it — see viewsSavedFloor and the
Views_Saved_Compute3 parameters), and there is no channel-status measure at all,
so the Summary read 0 for Total Views Saved and Channels Suspended while Social
Media, YouTube and Telegram each showed a real figure.

The rule a reader applies is the right one: a tile on the Summary is the same
tile on each section, added up. So after the Summary has computed its own
figures, every tile the sections also report is replaced by the sum of theirs.

── WHAT IS NOT REPLACED ───────────────────────────────────────────────────

  identified, removed, pending, removalPct — the summary's own, from the one
      table that holds every platform; the removal rate is derived from the
      pair, and Open Web's removal carries the live-swap rules of its own
      section (see openWebLiveRemoved), which a plain sum would bypass.
  distinctKPIs (totalAssets) — a title is enforced on every platform at once,
      so adding each section's distinct count counts it once per platform.

Everything else — views saved, suspended channels, channels, subscribers,
likes, notices, de-indexing — is additive across platforms: a channel on
YouTube and a channel on Telegram are different channels.

── WHICH SECTIONS ─────────────────────────────────────────────────────────

The other enabled platforms of the same KIND — VOD for the VOD Summary — that
read tables of their own. Asked through cachedPlatformReport, the same cache the
sections' own pages use, so opening the Summary after a section (or the reverse)
costs nothing the second time.

Only for a summary that is NOT a sports one. The Sports Summary reads the sports
tables themselves, so its per-table figures already add up exactly this way.
*/

// summaryOwnKPIs are the tiles a summary keeps from its own table.
var summaryOwnKPIs = map[string]bool{
	"identified": true, "removed": true, "pending": true, "removalPct": true,
	"from": true, "to": true,
}

// summarySiblings is the sections a configured summary adds up.
func summarySiblings(p platformDef) []platformDef {
	sports := isSportsPlatform(p)
	out := []platformDef{}
	for _, x := range loadPlatforms() {
		if !x.Enabled || x.Key == p.Key || x.Key == summaryKey || isSummaryPlatform(x) {
			continue
		}
		if x.SourceKind != "" && x.SourceKind != sourceKindTable {
			continue // an embed has no figures to add
		}
		if isSportsPlatform(x) != sports {
			continue
		}
		out = append(out, x)
	}
	return out
}

/*
summaryKPIsFromSections adds up the sections' tiles, for the current window and
the comparison one. A key appears in a result only where at least one section
reported it — a figure no section has is left to the summary's own.
*/
func summaryKPIsFromSections(p platformDef, q map[string]string, bg bool) (now, prev map[string]int64) {
	sibs := summarySiblings(p)
	parts := make([]map[string]any, len(sibs))
	var wg sync.WaitGroup
	gate := make(chan struct{}, summaryConcurrency)
	for i, s := range sibs {
		wg.Add(1)
		go func(i int, s platformDef) {
			defer wg.Done()
			gate <- struct{}{}
			defer func() { <-gate }()
			parts[i] = cachedPlatformReport(s, q, bg, false)
		}(i, s)
	}
	wg.Wait()

	now, prev = map[string]int64{}, map[string]int64{}
	add := func(dst map[string]int64, m map[string]any) {
		for k, v := range m {
			if summaryOwnKPIs[k] || distinctKPIs[k] {
				continue
			}
			dst[k] += numOf(v)
		}
	}
	for _, part := range parts {
		if part == nil {
			continue
		}
		if ok, _ := part["ok"].(bool); !ok {
			continue
		}
		if k, ok := part["kpi"].(map[string]any); ok {
			add(now, k)
		}
		if k, ok := part["kpiPrev"].(map[string]any); ok {
			add(prev, k)
		}
	}
	return now, prev
}

// applySummaryKPIsFromSections overwrites the summary's tiles with the sums.
func applySummaryKPIsFromSections(p platformDef, q map[string]string, bg bool,
	kpiOut, kpiPrevOut map[string]any) {
	if !isSummaryPlatform(p) || isSportsPlatform(p) {
		return
	}
	now, prev := summaryKPIsFromSections(p, q, bg)
	for k, v := range now {
		kpiOut[k] = v
	}
	if kpiPrevOut != nil {
		for k, v := range prev {
			kpiPrevOut[k] = v
		}
	}
}
