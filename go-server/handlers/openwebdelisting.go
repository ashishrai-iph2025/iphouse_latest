package handlers

/*
THE DE-INDEXING FIGURES ON THE VOD OPEN WEB REPORT.

The De-Indexing tile counts distinct DelistingBatchId — one per submission to a
search engine, however many links rode on it. On the sports linking table every
row carries the id, so the bridge counts it off the rows. The VOD linking table
(InternetInfringingURLMainDashboardTable) has NO such column: reports_api's
open-web dataset lists DelistingBatchId only as a NULL placeholder so its row
shape matches the sports one, which is why the tile was an em dash and the two
batch panels were empty.

The ids live in the capture tables, mediascan.InternetGoogleDelisting and
InternetBingDelisting, and reports_api counts them at /v1/delisting/batches —
distinct over both engines, per engine and per upload day. See delisting.go in
that service. This file fetches that once per section and hands the tile and
the two panels their figures.

── ONLY WHEN THE SCOPE CAN BE HONOURED ──────────────────────────────────────

The endpoint can narrow by client, window, asset, domain and genre. A report
narrowed by anything else — a language, a page number, a pirate brand, a
client's hidden values — would get the UNNARROWED batch count under a filtered
page, a number that looks right and is not. So the figure is left out in that
case and the tile shows its dash; the panels say "No data".
*/

import (
	"context"
	"net/url"

	"github.com/ip-house/iphouse-api/reportsapi"
)

// openWebDelistingDataset is the reports_api dataset whose batch ids are not on
// its own rows.
const openWebDelistingDataset = "open-web"

type openWebBatches struct {
	Total    int64 `json:"total"`
	ByEngine []struct {
		Engine  string `json:"engine"`
		Batches int64  `json:"batches"`
		URLs    int64  `json:"urls"`
	} `json:"byEngine"`
	ByDay []struct {
		Date    string `json:"date"`
		Batches int64  `json:"batches"`
	} `json:"byDay"`
}

/*
openWebBatchScope is the endpoint's query for a section's scope, or ok=false
when the scope holds a narrowing the endpoint cannot apply.
*/
func openWebBatchScope(ds reportsapi.Dataset, scope url.Values) (url.Values, bool) {
	out := url.Values{}
	for key, vals := range scope {
		if len(vals) == 0 || vals[0] == "" {
			continue
		}
		v := vals[0]
		switch key {
		case "ClientId":
			out.Set("clientId", v)
		case ds.DateFromParam:
			out.Set("from", dateOnly(v))
		case ds.DateToParam:
			out.Set("to", dateOnly(v))
		case "assetId", "domain", "genre":
			out.Set(key, v)
		default:
			return nil, false
		}
	}
	if out.Get("clientId") == "" || out.Get("from") == "" || out.Get("to") == "" {
		return nil, false
	}
	return out, true
}

// fetchOpenWebBatches asks reports_api for the section's batches. nil when the
// dataset is not the VOD open-web one, the scope cannot be honoured, or the
// request failed — in each case the tile keeps its dash.
func fetchOpenWebBatches(ctx context.Context, c *reportsapi.Client, ds reportsapi.Dataset,
	scope url.Values, note func(error)) *openWebBatches {
	if ds.Key != openWebDelistingDataset {
		return nil
	}
	q, ok := openWebBatchScope(ds, scope)
	if !ok {
		return nil
	}
	var body openWebBatches
	if err := c.GetJSON(ctx, "/v1/delisting/batches", q, &body); err != nil {
		note(err)
		return nil
	}
	return &body
}

/*
engineRows is the "Engines - Batches" panel. No `value`: an engine NAME sent
back as the open-web dataset's searchEngine filter (an id) would select nothing
and empty the page, so the bars are not clickable.
*/
func (b *openWebBatches) engineRows() []map[string]any {
	out := make([]map[string]any, 0, len(b.ByEngine))
	for _, e := range b.ByEngine {
		out = append(out, map[string]any{
			"label": e.Engine, "urls": e.Batches, "removed": int64(0),
		})
	}
	return out
}

// dayRows is the "Day-wise De-Indexing" panel, in date order — the same shape
// enforcementDayPanel builds for the sports table.
func (b *openWebBatches) dayRows() []map[string]any {
	out := make([]map[string]any, 0, len(b.ByDay))
	for _, d := range b.ByDay {
		out = append(out, map[string]any{
			"label": d.Date, "value": d.Date, "urls": d.Batches, "removed": int64(0),
		})
	}
	return out
}
