package handlers

/*
WAR ROOM LAYOUT — how the War Room's panels are arranged, per client.

The War Room page draws a fixed registry of panels (trend, TAT, breakdowns …,
see components/shared/warroom/panels.ts). This stores, per client, what the
registry's defaults are overridden with: order, hidden, size (span), title,
description, default chart type and default Top-N. The page keeps the
registry; this keeps only the overrides, as one JSON document per scope.

Scopes
	"<userId>"   one client's layout (the portal client, dcp_user.userId)
	"default"    the layout every client without its own falls back to

Who may change it — the same people who may shape a client's Sports report:
staff, a login granted report layout (Arrange), or the client's Client Admin.
Never while viewing as someone else. A client login only ever writes its own
scope; only staff write the default, and only staff reset a client's layout.

Readers change nothing here: a chart type or Top-N picked on a card lasts for
the visit and changes that card only.
*/

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"

	ipauth "github.com/ip-house/iphouse-api/auth"
	"github.com/ip-house/iphouse-api/db"
)

const warRoomLayoutTable = "war_room_layout"

var warRoomLayoutOnce sync.Once

func ensureWarRoomLayoutTable() {
	warRoomLayoutOnce.Do(func() {
		if _, _, err := db.Exec(`
			CREATE TABLE IF NOT EXISTS ` + warRoomLayoutTable + ` (
			  scope      VARCHAR(32)  NOT NULL,
			  layout     MEDIUMTEXT   NOT NULL,
			  updated_by VARCHAR(191) NOT NULL DEFAULT '',
			  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
			  PRIMARY KEY (scope)
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`); err != nil {
			log.Printf("[war-room-layout] create %s: %v", warRoomLayoutTable, err)
		}
	})
}

// One panel's overrides. Every field optional: absent means "the registry's".
type warRoomPanelConf struct {
	Key    string `json:"key"`
	Hidden bool   `json:"hidden,omitempty"`
	Span   string `json:"span,omitempty"`
	Title  string `json:"title,omitempty"`
	Desc   string `json:"desc,omitempty"`
	Viz    string `json:"viz,omitempty"`
	Limit  int    `json:"limit,omitempty"`
}

type warRoomLayout struct {
	Panels []warRoomPanelConf `json:"panels"`
}

func mayEditWarRoomLayout(claims *ipauth.Claims) bool {
	if claims == nil || claims.ImpersonatorLoginID != 0 {
		return false
	}
	return isStaff(claims) || mayEditReportLayout(claims) || claims.ClientAdmin
}

/*
warRoomScope is the scope a request reads or writes. A client login is always
its own client, whatever it sends. Staff name a client (clientId = userId) or,
with none, the shared default.
*/
func warRoomScope(claims *ipauth.Claims, requested string, wantDefault bool) string {
	if !isStaff(claims) {
		return strconv.FormatInt(claims.UserID, 10)
	}
	requested = strings.TrimSpace(requested)
	if wantDefault || requested == "" {
		return "default"
	}
	if _, err := strconv.ParseInt(requested, 10, 64); err != nil {
		return "default"
	}
	return requested
}

func readWarRoomLayout(scope string) (*warRoomLayout, bool) {
	row, err := db.QueryOne("SELECT layout FROM "+warRoomLayoutTable+" WHERE scope = ? LIMIT 1", scope)
	if err != nil || row == nil {
		return nil, false
	}
	var l warRoomLayout
	if json.Unmarshal([]byte(strFromAny(row["layout"])), &l) != nil {
		return nil, false
	}
	return &l, true
}

var warRoomSpans = map[string]bool{"": true, "full": true, "half": true, "third": true, "quarter": true, "twothirds": true}

// cleanWarRoomLayout trims what a save carries to what the page can use.
func cleanWarRoomLayout(in warRoomLayout) (warRoomLayout, bool) {
	out := warRoomLayout{Panels: []warRoomPanelConf{}}
	seen := map[string]bool{}
	for _, p := range in.Panels {
		p.Key = strings.TrimSpace(p.Key)
		if p.Key == "" || len(p.Key) > 64 || seen[p.Key] {
			continue
		}
		seen[p.Key] = true
		if !warRoomSpans[p.Span] {
			p.Span = ""
		}
		p.Title = strings.TrimSpace(p.Title)
		if len(p.Title) > 160 {
			p.Title = p.Title[:160]
		}
		p.Desc = strings.TrimSpace(p.Desc)
		if len(p.Desc) > 1000 {
			p.Desc = p.Desc[:1000]
		}
		if len(p.Viz) > 16 {
			p.Viz = ""
		}
		if p.Limit < 0 || p.Limit > 100 {
			p.Limit = 0
		}
		out.Panels = append(out.Panels, p)
	}
	return out, len(out.Panels) <= 100
}

// GET/PUT/DELETE /api/warroom/layout
//
//	GET    ?clientId=         → { layout, source: client|default|none, scope, canEdit, canEditDefault }
//	PUT    {clientId?, scope: "client"|"default", panels}
//	DELETE ?clientId=         → drop a client's layout (staff)
func WarRoomLayout(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	if !warRoomAllowed(claims) {
		Fail(w, 403, "War Room access is not enabled for your account")
		return
	}
	ensureWarRoomLayoutTable()

	switch r.Method {
	case http.MethodGet:
		scope := warRoomScope(claims, r.URL.Query().Get("clientId"), false)
		layout, source := (*warRoomLayout)(nil), "none"
		if l, ok := readWarRoomLayout(scope); ok {
			layout, source = l, "client"
			if scope == "default" {
				source = "default"
			}
		} else if l, ok := readWarRoomLayout("default"); ok {
			layout, source = l, "default"
		}
		OK(w, map[string]any{"success": true, "layout": layout, "source": source, "scope": scope,
			"canEdit": mayEditWarRoomLayout(claims), "canEditDefault": isStaff(claims) && claims.ImpersonatorLoginID == 0})

	case http.MethodPut:
		if !mayEditWarRoomLayout(claims) {
			Fail(w, 403, "Only an administrator or someone with report layout access can change the War Room layout")
			return
		}
		var body struct {
			ClientID string             `json:"clientId"`
			Scope    string             `json:"scope"`
			Panels   []warRoomPanelConf `json:"panels"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body); err != nil {
			Fail(w, 422, "A layout is required")
			return
		}
		wantDefault := body.Scope == "default"
		if wantDefault && !isStaff(claims) {
			Fail(w, 403, "Only IP House can change the default layout")
			return
		}
		scope := warRoomScope(claims, body.ClientID, wantDefault)
		clean, ok := cleanWarRoomLayout(warRoomLayout{Panels: body.Panels})
		if !ok {
			Fail(w, 422, "Too many panels")
			return
		}
		raw, _ := json.Marshal(clean)
		if _, _, err := db.Exec(`
			INSERT INTO `+warRoomLayoutTable+` (scope, layout, updated_by) VALUES (?, ?, ?)
			ON DUPLICATE KEY UPDATE layout = VALUES(layout), updated_by = VALUES(updated_by)`,
			scope, string(raw), claims.LoginUsername); err != nil {
			log.Printf("[war-room-layout] save %s: %v", scope, err)
			Fail(w, 500, "Could not save the layout")
			return
		}
		log.Printf("[war-room-layout] %s saved the %s layout (%d panels)", claims.LoginUsername, scope, len(clean.Panels))
		OK(w, map[string]any{"success": true, "scope": scope, "layout": clean})

	case http.MethodDelete:
		// Reset deletes an arrangement outright and cannot be undone — staff only,
		// the same rule the Sports report's layout follows.
		if !isStaff(claims) || claims.ImpersonatorLoginID != 0 {
			Fail(w, 403, "A layout can only be reset by IP House")
			return
		}
		scope := warRoomScope(claims, r.URL.Query().Get("clientId"), r.URL.Query().Get("scope") == "default")
		db.Exec("DELETE FROM "+warRoomLayoutTable+" WHERE scope = ?", scope)
		log.Printf("[war-room-layout] %s reset the %s layout", claims.LoginUsername, scope)
		OK(w, map[string]any{"success": true, "scope": scope})

	default:
		Fail(w, 405, "Method not allowed")
	}
}
