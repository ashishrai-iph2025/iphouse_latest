package handlers

import (
	"net/http"
	"strings"

	ipauth "github.com/ip-house/iphouse-api/auth"
	"github.com/ip-house/iphouse-api/db"
)

/*
GET /api/user/layout-access — may this session rearrange its Reports page?

The grant governs the REPORT layout: which KPI cards, charts and slicers appear
on /reports, in what order and at what width. That arrangement already exists
and already has an editor — Report Configuration, writing report_panel_layout.
All this adds is permission for a client to do it for their own report instead
of asking IP House to.

Two different grains, deliberately:

  - The GRANT is per LOGIN (login_username), set from the Module access pane of
    the Edit Login Account drawer once the account holds Reports. Whether a
    person is trusted to rearrange is a fact about the person.
  - The RESULT is per CLIENT (report_panel_layout.client_id). A report is shared
    — everyone reading that client's report reads the same page — so a layout
    stored per reader would not be the same report any more.

Which is why nothing about the arrangement is stored here. This table answers
one question, and the answer is a boolean.

Staff are never gated: they administer this, and they have Report Configuration.
*/
func UserLayoutAccess(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	if claims == nil {
		Fail(w, 401, "Not authenticated")
		return
	}
	OK(w, map[string]any{
		"success":         true,
		"canChangeLayout": mayEditReportLayout(claims),
	})
}

/*
mayEditReportLayout reports whether this session may rearrange a report.

Answering false is not an error and must not read like one — the page simply
does not offer the control. A caller that cannot reach the database gets false
for the same reason: denying on failure is the safe direction for a grant, and
the write path re-checks anyway.
*/
func mayEditReportLayout(claims *ipauth.Claims) bool {
	if claims == nil {
		return false
	}
	/* Staff, but NOT a staff member who is impersonating: impersonation forces
	   Role to 0, so an admin viewing as a client is held to that client's own
	   grant. That is the honest reading of "view as" — the point is to see what
	   they see, and an admin who wants to rearrange the page has Report
	   Configuration, where the change is made deliberately rather than while
	   looking through somebody else's session. */
	if isStaff(claims) {
		return true
	}
	return loginLayoutGranted(claims.LoginUsername)
}

// loginLayoutGranted reads the per-login flag set from the Edit Login Account
// drawer. A missing row means denied, so an account created after this shipped
// needs no write to be in the right state.
func loginLayoutGranted(username string) bool {
	username = strings.TrimSpace(username)
	if username == "" {
		return false
	}
	row, _ := db.QueryOne(
		"SELECT layout_enabled FROM login_layout_settings WHERE login_username = ? LIMIT 1",
		username)
	return row != nil && intFromAny(row["layout_enabled"]) == 1
}
