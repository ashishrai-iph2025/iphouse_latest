package admin

/*
THE SPORTS AND VOD SECTIONS OF THE CACHE & REDIS TAB.

	GET  /api/admin/report-cache/section?name=sports|vod
	     the section's platforms, what the cache holds for them (per client),
	     and its last cache-on-demand run
	POST /api/admin/report-cache/section/warm
	     {"name":"sports|vod","clientIds":[…],"months":["2026-07",…]}
	     or {"name":…,"clientIds":[…],"from":"2026-01-15","to":"2026-03-31"}
	     — at most a year, see handlers/sectionwarm.go

The report cache itself is shared by both sections (one key space, keyed by
platform); a section is the view of it restricted to its own platforms.
*/

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/ip-house/iphouse-api/handlers"
	"github.com/ip-house/iphouse-api/reportcache"
)

func sectionName(s string) (string, string, bool) {
	switch s {
	case "sports":
		return s, "Sports", true
	case "vod":
		return s, "VOD", true
	}
	return "", "", false
}

// GET /api/admin/report-cache/section?name=sports|vod
func ReportCacheSection(w http.ResponseWriter, r *http.Request) {
	name, label, known := sectionName(r.URL.Query().Get("name"))
	if !known {
		fail(w, 400, "name must be sports or vod")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	keys, labels := handlers.SectionPlatforms(name)
	inSection := map[string]bool{}
	platforms := make([]map[string]any, 0, len(keys))
	for _, k := range keys {
		inSection[k] = true
		platforms = append(platforms, map[string]any{"key": k, "label": labels[k]})
	}

	type agg struct {
		ClientID   string    `json:"clientId"`
		ClientName string    `json:"clientName"`
		Reports    int       `json:"reports"`
		Platforms  int       `json:"platforms"`
		Newest     time.Time `json:"newest"`
		Oldest     time.Time `json:"oldest"`
		Bytes      int       `json:"bytes"`
		plats      map[string]bool
	}
	byClient := map[string]*agg{}
	total, bytes := 0, 0
	var newest time.Time
	connected := reportcache.Get().Enabled()
	if connected {
		entries, _ := reportcache.Get().List(ctx, 0)
		names := clientNameMap(ctx)
		for _, e := range entries {
			if !inSection[e.Platform] {
				continue
			}
			total++
			bytes += e.Bytes
			if e.StoredAt.After(newest) {
				newest = e.StoredAt
			}
			k := strings.ToLower(e.ClientID)
			a := byClient[k]
			if a == nil {
				a = &agg{ClientID: e.ClientID, ClientName: names[k], plats: map[string]bool{}, Oldest: e.StoredAt}
				byClient[k] = a
			}
			a.Reports++
			a.Bytes += e.Bytes
			a.plats[e.Platform] = true
			if e.StoredAt.After(a.Newest) {
				a.Newest = e.StoredAt
			}
			if e.StoredAt.Before(a.Oldest) {
				a.Oldest = e.StoredAt
			}
		}
	}
	clients := make([]*agg, 0, len(byClient))
	for _, a := range byClient {
		a.Platforms = len(a.plats)
		if a.ClientName == "" {
			a.ClientName = a.ClientID
		}
		clients = append(clients, a)
	}
	sort.Slice(clients, func(i, j int) bool {
		return strings.ToLower(clients[i].ClientName) < strings.ToLower(clients[j].ClientName)
	})

	run := handlers.SectionRunStatus(name)
	if run != nil { // name the clients in the run
		names := clientNameMap(ctx)
		if cs, ok := run["clients"].([]handlers.SectionClientResult); ok {
			named := make([]map[string]any, 0, len(cs))
			for _, c := range cs {
				named = append(named, map[string]any{"clientId": c.ClientID, "clientName": names[strings.ToLower(c.ClientID)],
					"done": c.Done, "ready": c.Ready, "error": c.Error})
			}
			run["clients"] = named
		}
	}
	ok(w, map[string]any{
		"success": true, "name": name, "label": label, "connected": connected, "platforms": platforms,
		"totals":  map[string]any{"reports": total, "clients": len(clients), "bytes": bytes, "newest": newest},
		"clients": clients, "run": run,
	})
}

// POST /api/admin/report-cache/section/warm
func ReportCacheSectionWarm(w http.ResponseWriter, r *http.Request) {
	if !reportcache.Get().Enabled() {
		fail(w, 422, "The cache is not connected — save a working Redis address first")
		return
	}
	var in struct {
		Name      string   `json:"name"`
		ClientIDs []string `json:"clientIds"`
		Months    []string `json:"months"`
		From      string   `json:"from"`
		To        string   `json:"to"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		fail(w, 400, "Could not read the request")
		return
	}
	name, label, known := sectionName(in.Name)
	if !known {
		fail(w, 400, "name must be sports or vod")
		return
	}
	var clients []string
	for _, c := range in.ClientIDs {
		if c = strings.TrimSpace(c); c != "" {
			clients = append(clients, c)
		}
	}
	if len(clients) == 0 {
		fail(w, 422, "Pick at least one client")
		return
	}
	windows, err := handlers.SectionWindows(in.Months, in.From, in.To)
	if err != nil {
		fail(w, 422, err.Error())
		return
	}
	period := windows[0].Label
	if len(windows) > 1 {
		period = windows[0].Label + " → " + windows[len(windows)-1].Label
	}
	n, err := handlers.StartSectionWarm(name, clients, windows, period, adminName(r))
	if err != nil {
		fail(w, 409, err.Error())
		return
	}
	ok(w, map[string]any{"success": true, "started": true, "section": label, "reports": n, "windows": len(windows)})
}
