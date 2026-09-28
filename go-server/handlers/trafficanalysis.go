package handlers

/*
TRAFFIC ANALYSIS — SIMILARWEB FIGURES FOR ONE CLIENT'S DOMAINS.

The admin page at /admin/traffic-analysis. Every figure comes from reports_api's
/v1/traffic/* endpoints (see reports_api internal/api/traffic.go), which join the
client's Open Web hostnames to mediascan.InternetTrafficSimilarWeb and its child
tables. This portal holds no warehouse connection of its own (REPORTS_DB_* is not
set in the container), so this is a pass-through: the service's answer is
returned as it came, and re-describing its shape here would be a second
definition to keep in step.

Only the parameters the endpoints document are forwarded, so the page cannot be
used to send arbitrary query strings to the service under the portal's key.
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

var trafficViews = map[string][]string{
	"overview": {"clientId", "month", "source", "from", "to", "refresh"},
	"domains":  {"clientId", "month", "source", "from", "to", "refresh", "sort", "q", "tracked", "limit", "offset"},
	"domain":   {"clientId", "domain", "source", "from", "to", "refresh"},
	"compare":  {"clientId", "domains", "source", "from", "to", "refresh"},
	// The cache's status (Redis, data version, prepared views) — no client.
	"cache": {},
}

// TrafficAnalysis serves GET /api/admin/traffic-analysis/{view}.
func TrafficAnalysis(w http.ResponseWriter, r *http.Request) {
	view := r.PathValue("view")
	allowed, ok := trafficViews[view]
	if !ok {
		Fail(w, 404, "Unknown traffic view")
		return
	}
	if !reportsapi.Configured() {
		Fail(w, 503, "The reports API is not configured — set it under Configuration → Report config")
		return
	}
	in := r.URL.Query()
	if view != "cache" && strings.TrimSpace(in.Get("clientId")) == "" {
		Fail(w, 422, "Pick a client")
		return
	}
	if view != "cache" {
		// Who opens which client — the "top clients" auto-cache ranks by it.
		reportcache.Get().NoteUse("traffic", in.Get("clientId"), strconv.FormatInt(ClaimsFrom(r).LoginID, 10))
	}
	q := url.Values{}
	for _, k := range allowed {
		if v := strings.TrimSpace(in.Get(k)); v != "" {
			q.Set(k, v)
		}
	}
	// The portfolio overview is ~20s cold on a large client; the service caches
	// it for ten minutes, so only the first open of a window pays that.
	ctx, cancel := context.WithTimeout(r.Context(), 120*time.Second)
	defer cancel()
	var body json.RawMessage
	if err := reportsapi.Get().GetJSON(ctx, "/v1/traffic/"+view, q, &body); err != nil {
		Fail(w, 502, reportsAPIError(err))
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(200)
	_, _ = w.Write(body)
}

// TrafficAnalysisClients serves GET /api/admin/traffic-analysis/clients — the
// client picker, from the same list the Reports page offers staff.
func TrafficAnalysisClients(w http.ResponseWriter, r *http.Request) {
	if !reportsapi.Configured() {
		Fail(w, 503, "The reports API is not configured")
		return
	}
	rows, err := reportsapi.Get().Clients(r.Context())
	if err != nil {
		Fail(w, 502, err.Error())
		return
	}
	OK(w, map[string]any{"success": true, "clients": rows})
}

/*
reportsAPIError is a reports_api failure as a person should read it. A refused
or failed connection means the service is not answering — most often for the
few seconds of a redeploy — and the raw text ("Get http://reports_api:8090/…:
dial tcp 172.19.0.2:8090: connect: connection refused") names internal
addresses and says nothing useful. The service's own messages ("One month per
search", "ClientId is required") are passed through unchanged. The pages retry
on the word "unreachable", so it stays in.
*/
func reportsAPIError(err error) string {
	msg := err.Error()
	if strings.Contains(msg, "reports API unreachable") || strings.Contains(msg, "connection refused") ||
		strings.Contains(msg, "no such host") || strings.Contains(msg, "i/o timeout") {
		return "The reports service is unreachable right now — it may be restarting. Try again in a moment."
	}
	return msg
}
