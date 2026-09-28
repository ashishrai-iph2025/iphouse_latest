package handlers

/*
TORRENT ANALYSIS — WHO IS SHARING A CLIENT'S TORRENTS, FROM WHERE, ON WHAT.

The admin page at /admin/torrent-analysis. A pass-through to reports_api's
/v1/torrent/* (see reports_api internal/api/torrent.go and torrentreport.go),
the same arrangement as trafficanalysis.go: the portal has no warehouse
connection of its own, so the service's answer is returned as it came.

Two families behind it:
  report/*   the whole-period report, from the nightly snapshot of
             dashboards.Dashboard_TorrentIP_MonthlyAgg (live via the table's
             indexes when an asset / country slicer is set)
  the rest   raw peer sightings in mediascan.IPDetailsNew, ≤ 7 days per request

Only the documented paths and parameters are forwarded, so the page cannot be
used to send arbitrary requests to the service under the portal's key.
*/

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/ip-house/iphouse-api/reportcache"
	"github.com/ip-house/iphouse-api/reportsapi"
)

var torrentScopeParams = []string{"clientId", "from", "to", "month", "refresh"}

var torrentViews = map[string][]string{
	"clients":          nil,
	"report/summary":   {"assetId", "memberId", "childTitle", "infohash", "quality", "releaseGroup", "fileSize", "torrentName", "country", "continent", "isp", "userType"},
	"report/breakdown": {"by", "sort", "limit", "assetId", "memberId", "childTitle", "infohash", "quality", "releaseGroup", "fileSize", "torrentName", "country", "continent", "isp", "userType"},
	"report/geo":       nil,
	"report/options":   nil,
	"report/run":       {"assetId", "childTitle", "country", "continent", "isp", "poll"},
	"report/cache":     nil,
	"report/coverage":  {"assetId", "childTitle", "country", "continent", "isp"},
	"report/combined":  {"assetId", "childTitle", "country", "continent", "isp"},
	"summary":          {"assetId", "infohash", "country", "continent", "region", "city", "isp", "organization", "torrentClient", "mobile", "proxy", "hosting", "qualityOfPrintId", "languageId", "torrentName"},
	"inventory":        nil,
	"timeseries":       {"assetId", "infohash", "country", "isp", "torrentClient"},
	"breakdown":        {"by", "limit", "assetId", "infohash", "country", "continent", "region", "isp", "organization", "torrentClient", "mobile", "proxy", "hosting"},
	"torrents":         {"sort", "q", "withPeers", "limit", "offset", "assetId", "infohash"},
	"peers":            {"cursor", "limit", "ip", "assetId", "infohash", "country", "isp", "torrentClient"},
}

// TorrentAnalysis serves GET /api/admin/torrent-analysis/{path...}.
func TorrentAnalysis(w http.ResponseWriter, r *http.Request) {
	view := strings.Trim(r.PathValue("path"), "/")
	extra, ok := torrentViews[view]
	if !ok {
		Fail(w, 404, "Unknown torrent view")
		return
	}
	if !reportsapi.Configured() {
		Fail(w, 503, "The reports API is not configured — set it under Configuration → Report config")
		return
	}
	in := r.URL.Query()
	if view != "clients" && view != "report/geo" && view != "report/cache" && strings.TrimSpace(in.Get("clientId")) == "" {
		Fail(w, 422, "Pick a client")
		return
	}
	if c := in.Get("clientId"); c != "" {
		// Who opens which client — the "top clients" auto-cache ranks by it.
		reportcache.Get().NoteUse("torrent", c, strconv.FormatInt(ClaimsFrom(r).LoginID, 10))
	}
	q := url.Values{}
	for _, k := range append(append([]string{}, torrentScopeParams...), extra...) {
		if v := strings.TrimSpace(in.Get(k)); v != "" {
			q.Set(k, v)
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), 120*time.Second)
	defer cancel()
	var body json.RawMessage
	if err := reportsapi.Get().GetJSON(ctx, "/v1/torrent/"+view, q, &body); err != nil {
		Fail(w, 502, reportsAPIError(err))
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(200)
	_, _ = w.Write(body)
}
