package handlers

/*
The MONITORING SCOPE slicer — how far into the takedown workflow a report reads.

mediascan.ProcessStage is an ordered list and every asset sits at exactly one of
its six stages:

	1 Discovery        ┐
	2 Discovery QC     ├─ monitoring only
	3 Enforcement QC   ┘
	4 Enforcement      ┐
	5 DMCA Notice      ├─ the enforcement half
	6 Escalation       ┘

A client buying monitoring alone is served by the first three; a client buying
the full service is served by all six. So this slicer says which engagement a
reader is looking at, and it is the second slicer in this product that names
something other than a value in a column — see sourcetype.go, whose shape this
follows deliberately.

── THE TWO VALUES OVERLAP, AND THAT IS THE DESIGN ───────────────────────────

End-to-end CONTAINS monitoring-only rather than sitting beside it: it is all six
stages, which is every asset the client has. So end-to-end narrows NOTHING, and
the portal sends no parameter for it at all — see apiScope. That is not a
shortcut, it is what keeps the unnarrowed report byte-identical to the report
served before this slicer existed: an unsent filter cannot change a figure, a
cache key or a query plan.

It also means this is not a groupable dimension. There is no GROUP BY that puts
an asset in one bucket or the other, so it gets no breakdown panel and never
appears in DIMFilterParam — it is a ceiling, and a ceiling is a WHERE.

── WHY IT IS PER CLIENT ─────────────────────────────────────────────────────

Most clients buy one or the other, and for them the control is a dropdown with
one meaningful setting — noise in a rail that already holds six. It is switched
on per client on Report Configuration → Client mapping, beside the warehouse id
that decides which report the client sees at all, because both answer the same
question: what is this company's reporting set up to be.

Off is the default, so no existing client's rail changes shape until somebody
turns it on.

── WHERE THE NARROWING HAPPENS ──────────────────────────────────────────────

Not here. The portal cannot express it: the stage belongs to the TITLE, in
mediascan.Asset.ProcessStageId, and no fact table repeats it — the same reason
the sports-genre narrowing is a predicate in reports_api rather than a list of
asset ids on the wire. reports_api declares an ExprFilter on every dataset that
names an asset id column; this file's job is to offer the control, say what its
values are, and put the chosen one on the scope. See assetattrs.go over there.
*/

import (
	"log"
	"strings"
	"sync"

	"github.com/ip-house/iphouse-api/db"
)

// monitoringScopeParam is the query parameter, as the page addresses it and as
// reports_api declares it. One spelling, three services.
const monitoringScopeParam = "monitoringScope"

/*
The value that NARROWS. It is the only one ever sent.

Spelled the same as reports_api's monitoringOnlyScope, and it has to be: that
service's predicate compares the bound value against this literal, so a rename
on one side without the other reads as "not monitoring-only" and silently serves
the whole report. There is no shared package between the two, so the test beside
this file is what holds them together.
*/
const monitoringOnlyScope = "monitoring-only"

// The other value. Carried so the dropdown can offer it and the page can show
// which of the two is selected — never sent, for the reason in the file comment.
const endToEndScope = "end-to-end"

// The dropdown, in workflow order: monitoring is the first half of the process
// and end-to-end is the whole of it.
func monitoringScopeOptions() []map[string]any {
	return []map[string]any{
		{"id": monitoringOnlyScope, "name": "Monitoring Only"},
		{"id": endToEndScope, "name": "End to End"},
	}
}

/*
monitoringScopeValue reads the slicer off a request scope.

Empty for anything that is not the narrowing value — an absent parameter, the
end-to-end value, or a typo. Failing to the WHOLE report is the only safe
direction, the same rule specsForSourceType is written to: a mistyped query
string must not empty a report, because once it has, nothing on the page can
tell that from a genuinely quiet client.
*/
func monitoringScopeValue(q map[string]string) string {
	if strings.TrimSpace(q[monitoringScopeParam]) == monitoringOnlyScope {
		return monitoringOnlyScope
	}
	return ""
}

/* ── Which clients get the control ────────────────────────────────────────── */

// MonitoringScopeColumn is the per-client switch, on dcp_user beside the
// warehouse client id. One row, one client, one place to correct it — the same
// argument ClientIDColumn is stored under.
const MonitoringScopeColumn = "ReportMonitoringScope"

var monitoringScopeOnce sync.Once

func ensureMonitoringScopeSchema() {
	monitoringScopeOnce.Do(func() {
		if portalColumnExists("dcp_user", MonitoringScopeColumn) {
			return
		}
		if _, _, err := db.Exec("ALTER TABLE dcp_user ADD COLUMN " +
			MonitoringScopeColumn + " TINYINT(1) NOT NULL DEFAULT 0"); err != nil {
			log.Printf("[monitoring-scope] add dcp_user.%s: %v", MonitoringScopeColumn, err)
			return
		}
		log.Printf("[monitoring-scope] added dcp_user.%s", MonitoringScopeColumn)
	})
}

/*
monitoringScopeEnabled answers whether this WAREHOUSE client's reports offer the
slicer.

Keyed on ClientID_MS3 rather than on the portal user id, because that is what
every read path downstream has in hand: the sections list and the data endpoint
both work in warehouse ids by the time they get here, and resolving back to a
portal row at each call site would be the same join written four times.

Fails CLOSED — no column, no row, no id means no slicer. A control that appears
because a lookup failed is worse than one that does not appear: it offers a
reader a choice the report may not honour.
*/
func monitoringScopeEnabled(clientID string) bool {
	id := strings.TrimSpace(clientID)
	if id == "" {
		return false
	}
	ensureMonitoringScopeSchema()
	row, err := db.QueryOne("SELECT COUNT(*) AS c FROM dcp_user "+
		"WHERE "+ClientIDColumn+" = ? AND "+MonitoringScopeColumn+" = 1 AND deleted = 0", id)
	if err != nil {
		log.Printf("[monitoring-scope] cannot read the switch for client %s: %v", id, err)
		return false
	}
	return row != nil && numOf(row["c"]) > 0
}
