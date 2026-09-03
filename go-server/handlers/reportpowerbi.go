package handlers

/*
A report that is an embedded Power BI report rather than a warehouse query.

Some reports cannot be queried from the dashboards at all — ESA's P2P tracking
is the case this was built for: infohashes, captured IP addresses and ISP
breakdowns that live in Power BI and nowhere this service can reach with SQL. A
platform can therefore declare itself `powerbi` instead of `table`, and the
report page embeds it in place of the panels.

── WHERE THE REPORT ID COMES FROM ───────────────────────────────────────────

	Not from Report Configuration. A Power BI report is per CLIENT — ESA's P2P
	report is not another client's — and those assignments already exist, made on
	/admin/dashboards and stored as dcp_user_module_map(userId, moduleId, link).

	So the platform records which MODULE it is and the report id is resolved per
	reader out of that mapping. One place to assign a client's report, and it is
	the screen built for it; a report id typed into Report Configuration would
	either be shown to every client alike or need a second per-client table
	beside the one that already holds exactly this.

── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────

	It does not mint the embed token. The page asks /api/embed-token for that,
	the same call the client dashboard has always made, so there is one
	implementation of the Azure hand-off and one place it can be fixed.

	It does not widen who may embed what. That endpoint authorises on the JWT
	alone — its own comment records that per-report authorisation was tried and
	rolled back — so any signed-in login can already request a token for any
	report in the workspace. This resolves what a reader SHOULD see; it is not a
	gate, and nothing here should be read as one.
*/

import (
	"strings"

	"github.com/ip-house/iphouse-api/db"
)

/*
powerBIReport is what a Power BI platform answers with instead of panels.

`Link` is what the assignment holds, which may be a full Power BI URL rather
than a bare id — the page extracts the id from it the same way the client
dashboard does, so both accept whatever an operator pasted.
*/
type powerBIReport struct {
	ModuleID   int64  `json:"moduleId"`
	ModuleName string `json:"moduleName"`
	Link       string `json:"link"`
}

/*
powerBIReportFor resolves the report a client should see for a Power BI platform.

Returns ok=false with a REASON rather than an empty struct, because the two ways
this fails are different problems and the reader can act on neither if they are
reported the same:

	no module      the platform is set to Power BI and nobody has said which
	               dashboard it is. A configuration mistake, fixed in Report
	               Configuration.
	no assignment  the platform is wired up and THIS client has no report for
	               it. Fixed on /admin/dashboards, for that client.

An inactive assignment counts as no assignment. The mapping carries `active`
precisely so a report can be withdrawn without deleting the row, and reading a
withdrawn one would put back the report somebody switched off.
*/
func powerBIReportFor(p platformDef, clientID string) (powerBIReport, bool, string) {
	if p.PowerBIModuleID == 0 {
		return powerBIReport{}, false,
			"This report is set to Power BI but no dashboard has been chosen for it yet."
	}
	userID := powerBIUserIDForClient(clientID)
	if userID == 0 {
		return powerBIReport{}, false,
			"This client is not mapped to a portal account, so its dashboard " +
				"assignments cannot be read."
	}

	row, err := db.QueryOne(`
		SELECT m.moduleId, m.moduleName, COALESCE(mp.link, '') AS link
		FROM dcp_module m
		LEFT JOIN dcp_user_module_map mp
		       ON mp.moduleId = m.moduleId AND mp.userId = ? AND mp.active = 1
		WHERE m.moduleId = ? AND m.deleted = 0
		LIMIT 1`, userID, p.PowerBIModuleID)
	if err != nil || row == nil {
		return powerBIReport{}, false,
			"The dashboard this report points at no longer exists."
	}

	link := strings.TrimSpace(strFromAny(row["link"]))
	name := strFromAny(row["moduleName"])
	if link == "" {
		return powerBIReport{}, false,
			"No " + name + " dashboard has been assigned to this client yet."
	}
	return powerBIReport{
		ModuleID:   numOf(row["moduleId"]),
		ModuleName: name,
		Link:       link,
	}, true, ""
}

/*
powerBIUserIDForClient turns a warehouse client id into the dcp_user the
dashboard assignments are filed under.

TWO IDENTIFIERS FOR ONE COMPANY, and that is the whole reason this exists. A
report is scoped by the warehouse client id the slicer and the client mapping
deal in; dcp_user_module_map is keyed by dcp_user.userId. Neither is derivable
from the other, so the join has to go through the client record that carries
both — dcp_user.ClientID_MS3, which is exactly where the portal-to-warehouse
mapping is kept. See ClientIDColumn.

Resolved from the CLIENT rather than from the session, so it answers the same way
for a client reading their own report and for staff who picked that client from
the slicer. Taking claims.UserID instead would have been shorter and wrong for
the second: staff would have been shown whatever Power BI report happened to be
assigned to their own login.

0 when nothing matches, which the caller reports as unresolved rather than
falling back to anything. There is no safe fallback here — every wrong answer is
one company's report shown to another.
*/
func powerBIUserIDForClient(clientID string) int64 {
	clientID = strings.TrimSpace(clientID)
	if clientID == "" {
		return 0
	}
	row, err := db.QueryOne(
		"SELECT userId FROM dcp_user WHERE "+ClientIDColumn+" = ? AND deleted = 0 LIMIT 1",
		clientID)
	if err != nil || row == nil {
		return 0
	}
	return numOf(row["userId"])
}
