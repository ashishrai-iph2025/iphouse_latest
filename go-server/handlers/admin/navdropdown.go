package admin

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/ip-house/iphouse-api/db"
)

// Admin-configurable dropdown sub-items for a nav module (parent keyed by its
// pageName). Each child links to an EXISTING client route — an arbitrary URL
// can't create a page, so the href is validated against this allow-list, which
// mirrors the client routes registered in src/App.tsx.
var allowedNavRoutes = map[string]bool{
	"/dashboard":        true,
	"/war-room":         true,
	"/infringement":     true,
	"/search":           true,
	"/pending-count":    true,
	"/qc-action":        true,
	"/upload-url":       true,
	"/download-request": true,
	"/ip-tracking":      true,
	"/data-sharing":     true,
	"/profile":          true,
	"/switch-account":   true,
}

// GET/POST/PUT/DELETE /api/admin/nav-dropdown
//
//	GET ?parentPageName=X → { items: [{id,label,href,sortOrder}] }
//	POST   {parentPageName,label,href}     → add a child
//	PUT    {id,label,href}                 → edit a child
//	DELETE {id}                            → remove a child
func NavDropdown(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		parent := strings.TrimSpace(r.URL.Query().Get("parentPageName"))
		if parent == "" {
			fail(w, 422, "parentPageName is required"); return
		}
		rows, _ := db.Query(
			"SELECT id, label, href, sort_order FROM nav_dropdown_items WHERE parent_page_name = ? ORDER BY sort_order ASC, id ASC",
			parent)
		if rows == nil {
			rows = []map[string]any{}
		}
		ok(w, map[string]any{"success": true, "items": rows, "routes": routeOptions()})

	case http.MethodPost:
		var body struct {
			ParentPageName string `json:"parentPageName"`
			Label          string `json:"label"`
			Href           string `json:"href"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		body.ParentPageName = strings.TrimSpace(body.ParentPageName)
		body.Label = strings.TrimSpace(body.Label)
		body.Href = strings.TrimSpace(body.Href)
		if body.ParentPageName == "" || body.Label == "" || body.Href == "" {
			fail(w, 422, "parentPageName, label and href are required"); return
		}
		if !allowedNavRoutes[body.Href] {
			fail(w, 422, "Link must be an existing page"); return
		}
		// Append after the current last child.
		next, _ := db.QueryOne("SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM nav_dropdown_items WHERE parent_page_name = ?", body.ParentPageName)
		order := int64(1)
		if next != nil {
			order = intVal(next["n"])
		}
		if err := db.MustExec("INSERT INTO nav_dropdown_items (parent_page_name, label, href, sort_order) VALUES (?, ?, ?, ?)",
			body.ParentPageName, body.Label, body.Href, order); err != nil {
			fail(w, 500, "Could not add dropdown item"); return
		}
		ok(w, map[string]any{"success": true})

	case http.MethodPut:
		var body struct {
			ID    int64  `json:"id"`
			Label string `json:"label"`
			Href  string `json:"href"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		body.Label = strings.TrimSpace(body.Label)
		body.Href = strings.TrimSpace(body.Href)
		if body.ID == 0 || body.Label == "" || body.Href == "" {
			fail(w, 422, "id, label and href are required"); return
		}
		if !allowedNavRoutes[body.Href] {
			fail(w, 422, "Link must be an existing page"); return
		}
		if err := db.MustExec("UPDATE nav_dropdown_items SET label = ?, href = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?",
			body.Label, body.Href, body.ID); err != nil {
			fail(w, 500, "Could not update dropdown item"); return
		}
		ok(w, map[string]any{"success": true})

	case http.MethodDelete:
		var body struct {
			ID int64 `json:"id"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if body.ID == 0 {
			fail(w, 422, "id required"); return
		}
		db.Exec("DELETE FROM nav_dropdown_items WHERE id = ?", body.ID)
		ok(w, map[string]any{"success": true})

	default:
		fail(w, 405, "Method not allowed")
	}
}

// POST /api/admin/nav-dropdown/reorder — body { orderedIds: [int] }.
func NavDropdownReorder(w http.ResponseWriter, r *http.Request) {
	var body struct {
		OrderedIds []int64 `json:"orderedIds"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if len(body.OrderedIds) == 0 {
		fail(w, 422, "orderedIds required"); return
	}
	for i, id := range body.OrderedIds {
		db.Exec("UPDATE nav_dropdown_items SET sort_order = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?", i+1, id)
	}
	ok(w, map[string]any{"success": true})
}

// routeOptions returns the selectable client routes (for the admin picker),
// with friendly labels — mirrors allowedNavRoutes.
func routeOptions() []map[string]string {
	return []map[string]string{
		{"label": "Dashboard", "href": "/dashboard"},
		{"label": "War Room", "href": "/war-room"},
		{"label": "Infringement Search", "href": "/infringement"},
		{"label": "Search by URL", "href": "/search"},
		{"label": "Approvals", "href": "/pending-count"},
		{"label": "QC Action", "href": "/qc-action"},
		{"label": "Submit Take-downs", "href": "/upload-url"},
		{"label": "Download Request", "href": "/download-request"},
		{"label": "IP Tracking", "href": "/ip-tracking"},
		{"label": "Data Sharing", "href": "/data-sharing"},
		{"label": "Profile", "href": "/profile"},
		{"label": "Switch Account", "href": "/switch-account"},
	}
}
