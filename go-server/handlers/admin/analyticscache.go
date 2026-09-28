package admin

/*
THE ANALYTICS CACHES, ON THE CACHE & REDIS TAB.

Traffic Analysis and Torrent Analysis are computed by reports_api and cached
there — in THIS portal's Redis (one Redis for the application), under the
`reports_api:` key prefix, beside the report cache this tab already manages.
reports_api owns those entries (it knows what each key means and which data
version it belongs to), so this is a pass-through to its admin routes:

	GET  /api/admin/report-cache/analytics                    both scopes' status + entries
	POST /api/admin/report-cache/analytics/{action}?scope=…   clear | prepare

Clearing one scope deletes only its own prefix — never this tab's report cache,
never the other scope.
*/

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/ip-house/iphouse-api/reportsapi"
)

// GET /api/admin/report-cache/analytics
func ReportCacheAnalytics(w http.ResponseWriter, r *http.Request) {
	if !reportsapi.Configured() {
		fail(w, 503, "The reports API is not configured")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	out := map[string]any{"success": true}
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, scope := range []string{"traffic", "torrent"} {
		wg.Add(1)
		go func(scope string) {
			defer wg.Done()
			var body json.RawMessage
			err := reportsapi.Get().GetJSON(ctx, "/v1/admin/analytics-cache", url.Values{"scope": {scope}}, &body)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				out[scope] = map[string]any{"error": err.Error()}
				return
			}
			out[scope] = body
		}(scope)
	}
	wg.Wait()
	ok(w, out)
}

// POST /api/admin/report-cache/analytics/{action}?scope=traffic|torrent
func ReportCacheAnalyticsAction(w http.ResponseWriter, r *http.Request) {
	action, scope := r.PathValue("action"), r.URL.Query().Get("scope")
	if (action != "clear" && action != "prepare") || (scope != "traffic" && scope != "torrent") {
		fail(w, 400, "action must be clear or prepare, scope traffic or torrent")
		return
	}
	if !reportsapi.Configured() {
		fail(w, 503, "The reports API is not configured")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	var body map[string]any
	// Cache on demand: the clients and the period ride along (at most a year —
	// reports_api enforces it and says so).
	q := url.Values{"scope": {scope}}
	for _, k := range []string{"clients", "months", "from", "to"} {
		if v := strings.TrimSpace(r.URL.Query().Get(k)); v != "" {
			q.Set(k, v)
		}
	}
	if err := reportsapi.Get().PostJSON(ctx, "/v1/admin/analytics-cache/"+action, q, &body); err != nil {
		fail(w, 502, err.Error())
		return
	}
	log.Printf("[analytics-cache] %s %s by %s", action, scope, adminName(r))
	body["success"] = true
	ok(w, body)
}
