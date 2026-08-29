package admin

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/ip-house/iphouse-api/db"
)

/*
GET/POST /api/admin/layout-access — which logins may change the portal layout.

One flag per LOGIN ACCOUNT: whether the people signing in with it may rearrange
their Reports page — which KPI cards, charts and slicers appear, in what order,
at what width, and as which chart. It is the same thing Report Configuration
does, handed to a client for their own report.

Keyed on login_username, not loginId. A shared login is one dcp_user_login row
per company and loginId names one of them, so keying on it would give the same
person a different answer per company — and the Shared Logins list reports
MAX(loginId), which silently names whichever company was added last. The list
groups by login_username for exactly this reason, and so does this.

Note the two grains, which are different on purpose. The PERMISSION is per
login, because whether somebody is trusted to rearrange is a fact about them.
The RESULT is per client — report_panel_layout.client_id — because a report is
shared, and a layout stored per reader would stop it being one report. Nothing
about the arrangement is stored in this table; see handlers/userreportlayout.go.

Set from the Module access pane of the Edit Login Account drawer on
/admin/registrations, where it appears once the account holds Reports.

Default deny: no row means no.
*/
func LayoutAccessSettings(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		/* One row per person, matching the Shared Logins list — same GROUP BY,
		   so the two screens cannot disagree about what an account is. The
		   companies are carried only to identify the person on screen; nothing
		   here is keyed on them. */
		rows, _ := db.Query(`
			SELECT
				ul.login_username,
				MAX(ul.first_name)                                           AS first_name,
				MAX(ul.last_name)                                            AS last_name,
				GROUP_CONCAT(DISTINCT u.name ORDER BY u.name SEPARATOR ', ') AS master_names,
				MAX(ul.is_active)                                            AS is_active,
				COALESCE(MAX(s.layout_enabled), 0)                           AS layout_enabled
			FROM dcp_user_login ul
			LEFT JOIN dcp_user u ON u.userId = ul.userId AND u.deleted = 0
			LEFT JOIN login_layout_settings s ON s.login_username = ul.login_username
			WHERE ul.deleted = 0
			GROUP BY ul.login_username
			ORDER BY ul.login_username`)
		if rows == nil {
			rows = []map[string]any{}
		}
		ok(w, map[string]any{"success": true, "logins": rows})

	case http.MethodPost:
		var body struct {
			LoginUsername string `json:"loginUsername"`
			LayoutEnabled bool   `json:"layoutEnabled"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		username := strings.TrimSpace(body.LoginUsername)
		if username == "" {
			fail(w, 422, "loginUsername is required")
			return
		}
		v := 0
		if body.LayoutEnabled {
			v = 1
		}
		/* Only the flag is written. Revoking deliberately LEAVES the stored
		   layout in place: the account goes back to the standard layout while
		   it is revoked, and gets its own back if the grant returns, which is
		   the difference between taking away a permission and discarding
		   somebody's work. */
		if !execOK(w, "the layout setting",
			`INSERT INTO login_layout_settings (login_username, layout_enabled) VALUES (?, ?)
			 ON DUPLICATE KEY UPDATE layout_enabled = ?`, username, v, v) {
			return
		}
		ok(w, map[string]any{"success": true})

	default:
		fail(w, 405, "Method not allowed")
	}
}
