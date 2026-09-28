package handlers

/*
BUSINESS INTELLIGENCE — Traffic Analysis and Torrent Analysis for client logins.

The two analytics pages began as staff-only screens under /admin, where the
reader picks any client. Business Intelligence puts the same pages in the
client portal, as the dropdown of the "Business Intelligence" nav tab, with
the client pinned to the login's own — the same rule the Reports page follows
(reportScope: a client login reads its mapped warehouse client and ONLY that;
whatever clientId it sends is discarded).

WHO SEES WHAT

Three grantable modules, all in module_permission, all granted per login on the
existing permission screens:

	Business Intelligence  (pageName BusinessIntelligence) — the tab itself
	Traffic Analysis       (pageName bi-traffic-analysis)
	Torrent Analysis       (pageName bi-torrent-analysis)

	- A login granted one or both of the two pages sees exactly those, and the
	  tab appears for them even without the parent grant — granting a page is
	  granting the way to it.
	- A login granted the tab and neither page sees both: the parent grant on
	  its own is the whole of Business Intelligence.

The two page modules are not nav tabs of their own: no NAV_ITEM carries their
pageNames, so the nav draws them only inside the tab's dropdown, which UserNav
narrows to what the login holds (applyBIDropdown). The endpoints below check
the same answer (biGrants), so a page hidden from the nav is refused by the API.

WHAT A CLIENT CANNOT DO

The cache controls stay with staff: no ?refresh (it forces a warehouse
recompute), no cache status views, and the client list is the login's own
client only.
*/

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"

	ipauth "github.com/ip-house/iphouse-api/auth"
	"github.com/ip-house/iphouse-api/db"
	"github.com/ip-house/iphouse-api/reportsapi"
)

const (
	PageBI        = "BusinessIntelligence"
	PageBITraffic = "bi-traffic-analysis"
	PageBITorrent = "bi-torrent-analysis"

	biTrafficHref = "/business-intelligence/traffic-analysis"
	biTorrentHref = "/business-intelligence/torrent-analysis"
)

/*
EnsureBIModules registers the two page modules and the tab's dropdown at boot,
so an admin has something to grant rather than having to invent the spellings.
Each is added only when missing — renames and reorders made on /admin/modules
are never undone.
*/
func EnsureBIModules() {
	for _, m := range []struct{ name, page string }{
		{"Traffic Analysis", PageBITraffic},
		{"Torrent Analysis", PageBITorrent},
	} {
		if row, err := db.QueryOne("SELECT Id FROM module_permission WHERE pageName = ? LIMIT 1", m.page); err != nil || row != nil {
			continue
		}
		if _, _, err := db.Exec(
			"INSERT INTO module_permission (ModuleName, pageName, status, created, updated) VALUES (?, ?, 0, UTC_TIMESTAMP(), UTC_TIMESTAMP())",
			m.name, m.page); err != nil {
			log.Printf("[bi] seed module %s: %v", m.page, err)
			continue
		}
		log.Printf("[bi] added the %q module — grant it per login", m.name)
	}
	if row, err := db.QueryOne("SELECT COUNT(*) AS c FROM nav_dropdown_items WHERE parent_page_name = ?", PageBI); err == nil && row != nil && intFromAny(row["c"]) == 0 {
		if _, _, err := db.Exec(`INSERT INTO nav_dropdown_items (parent_page_name, label, href, sort_order) VALUES (?, 'Traffic Analysis', ?, 1), (?, 'Torrent Analysis', ?, 2)`,
			PageBI, biTrafficHref, PageBI, biTorrentHref); err != nil {
			log.Printf("[bi] seed dropdown: %v", err)
		}
	}
}

// biRule is the grant rule of the file comment, on the three facts it reads.
func biRule(hasBI, hasTraffic, hasTorrent bool) (traffic, torrent bool) {
	if hasTraffic || hasTorrent {
		return hasTraffic, hasTorrent
	}
	return hasBI, hasBI
}

// biGrants answers which of the two pages this login may open. Staff open both.
func biGrants(claims *ipauth.Claims) (traffic, torrent bool) {
	if claims == nil {
		return false, false
	}
	if isStaff(claims) {
		return true, true
	}
	rows, err := grantedModuleRows(claims.LoginID)
	if err != nil {
		log.Printf("[bi] cannot read grants for loginId=%d: %v", claims.LoginID, err)
		return false, false
	}
	var hasBI, hasT, hasR bool
	for _, r := range rows {
		switch p := strFromAny(r["pageName"]); {
		case strings.EqualFold(p, PageBI):
			hasBI = true
		case strings.EqualFold(p, PageBITraffic):
			hasT = true
		case strings.EqualFold(p, PageBITorrent):
			hasR = true
		}
	}
	return biRule(hasBI, hasT, hasR)
}

/*
applyBIDropdown shapes the Business Intelligence tab in the nav payload: its
dropdown narrowed to the pages the login holds, and the tab added when only a
page (not the tab) was granted. The two page modules stay in the payload — no
nav item draws them, and they keep "the nav's answer" complete for anything
that reads grants off it.
*/
func applyBIDropdown(modules []map[string]any, dropByParent map[string][]map[string]any) []map[string]any {
	biAt := -1
	var hasT, hasR bool
	firstOrder := int64(-1)
	for i, m := range modules {
		p := strFromAny(m["pageName"])
		switch {
		case strings.EqualFold(p, PageBI):
			biAt = i
		case strings.EqualFold(p, PageBITraffic):
			hasT = true
		case strings.EqualFold(p, PageBITorrent):
			hasR = true
		default:
			continue
		}
		if o := intFromAny(m["navOrder"]); firstOrder < 0 || o < firstOrder {
			firstOrder = o
		}
	}
	if biAt < 0 && !hasT && !hasR {
		return modules
	}
	mayT, mayR := biRule(biAt >= 0, hasT, hasR)

	var src []map[string]any
	for k, v := range dropByParent {
		if strings.EqualFold(k, PageBI) {
			src = append(src, v...)
		}
	}
	drop := []map[string]any{}
	for _, it := range src {
		switch strFromAny(it["href"]) {
		case biTrafficHref:
			if !mayT {
				continue
			}
		case biTorrentHref:
			if !mayR {
				continue
			}
		}
		drop = append(drop, it)
	}

	if biAt >= 0 {
		modules[biAt]["pageName"] = PageBI // the spelling NAV_ITEMS keys on
		modules[biAt]["dropdown"] = drop
		return modules
	}
	return append(modules, map[string]any{
		"moduleId": 0, "moduleName": "Business Intelligence", "pageName": PageBI,
		"navOrder": firstOrder, "dropdown": drop,
	})
}

// biScope is the client a BI request reads, or a refusal already written.
func biScope(w http.ResponseWriter, r *http.Request, may bool) (string, bool) {
	claims := ClaimsFrom(r)
	if claims == nil {
		Fail(w, 401, "Not authenticated")
		return "", false
	}
	if !may {
		Fail(w, 403, "Your account does not have access to this page. Ask your administrator to grant it.")
		return "", false
	}
	id, ok, why := reportScope(claims, r.URL.Query().Get("clientId"))
	if !ok {
		Fail(w, 403, why)
		return "", false
	}
	return id, true
}

// pinClient rewrites the request's query to the scoped client, without the
// cache controls for a client login.
func pinClient(r *http.Request, clientID string) {
	q := r.URL.Query()
	if clientID != "" {
		q.Set("clientId", clientID)
	}
	if !isStaff(ClaimsFrom(r)) {
		q.Del("refresh")
	}
	r.URL.RawQuery = q.Encode()
}

// BITraffic serves GET /api/bi/traffic-analysis/{view}.
func BITraffic(w http.ResponseWriter, r *http.Request) {
	may, _ := biGrants(ClaimsFrom(r))
	clientID, ok := biScope(w, r, may)
	if !ok {
		return
	}
	switch view := r.PathValue("view"); view {
	case "cache":
		Fail(w, 404, "Unknown traffic view")
	case "clients":
		if isStaff(ClaimsFrom(r)) {
			TrafficAnalysisClients(w, r)
			return
		}
		OK(w, map[string]any{"success": true, "clients": []map[string]any{{"id": clientID, "name": biClientName(r.Context(), clientID)}}})
	default:
		pinClient(r, clientID)
		TrafficAnalysis(w, r)
	}
}

// BITorrent serves GET /api/bi/torrent-analysis/{path...}.
func BITorrent(w http.ResponseWriter, r *http.Request) {
	_, may := biGrants(ClaimsFrom(r))
	clientID, ok := biScope(w, r, may)
	if !ok {
		return
	}
	staff := isStaff(ClaimsFrom(r))
	switch view := strings.Trim(r.PathValue("path"), "/"); view {
	case "report/cache":
		Fail(w, 404, "Unknown torrent view")
	case "clients":
		if staff {
			TorrentAnalysis(w, r)
			return
		}
		// The service's list, narrowed to the login's own client.
		ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
		defer cancel()
		var body map[string]any
		if err := reportsapi.Get().GetJSON(ctx, "/v1/torrent/clients", nil, &body); err != nil {
			Fail(w, 502, reportsAPIError(err))
			return
		}
		mine := []any{}
		list, _ := body["clients"].([]any)
		for _, c := range list {
			if m, _ := c.(map[string]any); m != nil && strings.EqualFold(strFromAny(m["id"]), clientID) {
				mine = append(mine, m)
			}
		}
		body["clients"] = mine
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(body)
	default:
		pinClient(r, clientID)
		TorrentAnalysis(w, r)
	}
}

// biClientName is the warehouse's name for a client, or its id when the list
// cannot be read — the page only uses it as a label.
func biClientName(ctx context.Context, id string) string {
	if !reportsapi.Configured() {
		return id
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	rows, err := reportsapi.Get().Clients(ctx)
	if err != nil {
		return id
	}
	for _, c := range rows {
		if strings.EqualFold(strFromAny(c["id"]), id) {
			if n := strFromAny(c["name"]); n != "" {
				return n
			}
		}
	}
	return id
}
