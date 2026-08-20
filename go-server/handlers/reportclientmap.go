package handlers

import (
	"encoding/json"
	"log"
	"net/http"
	"sort"
	"strings"
	"sync"

	ipauth "github.com/ip-house/iphouse-api/auth"
	"github.com/ip-house/iphouse-api/db"
)

/*
Portal client → warehouse client.

The reports read an analytics warehouse keyed on its own ClientId, and until now
that id came from the query string — which is exactly why the whole reports API
was staff-only: a client login could have asked for any company's numbers by
sending a different id.

Opening the reports to client logins therefore needs one thing first: a way to
know WHICH warehouse client a portal login belongs to, decided by staff and not
by the request. That is this table.

Matching on name was the alternative and is not good enough for a data boundary.
"IP House Demo - VOD" against "IP House Demo VOD" is a miss, which merely shows
an empty report; two clients whose names both begin "Star" is a HIT on the wrong
one, which shows a company another company's enforcement data. So the mapping is
explicit, and a name match is only ever offered as a SUGGESTION for a human to
confirm.
*/

/*
ClientIDColumn is where the analytics client id lives: a column ON THE CLIENT
RECORD, not a side table.

It was a separate mapping table first, which worked but put a client's most
important reporting attribute somewhere nobody editing that client would look.
It belongs with the name and the API credentials — one row, one client, one
place to correct it.
*/
const ClientIDColumn = "ClientID_MS3"

// The legacy side table, read once so an install that was configured before the
// column existed keeps its mappings.
const clientMapTable = "report_client_map"

var clientMapOnce sync.Once

func ensureClientMapSchema() {
	clientMapOnce.Do(func() {
		if !portalColumnExists("dcp_user", ClientIDColumn) {
			if _, _, err := db.Exec(
				"ALTER TABLE dcp_user ADD COLUMN " + ClientIDColumn + " VARCHAR(36) NULL"); err != nil {
				log.Printf("[report-map] add dcp_user.%s: %v", ClientIDColumn, err)
				return
			}
			log.Printf("[report-map] added dcp_user.%s", ClientIDColumn)
		}
		// One-way, and only into empty cells: the column is the truth once it
		// exists, so a value edited there is never overwritten by a stale row in
		// the old table.
		if portalTableExists(clientMapTable) {
			if _, n, err := db.Exec(`
				UPDATE dcp_user u
				  JOIN ` + clientMapTable + ` m ON m.portal_user_id = u.userId
				   SET u.` + ClientIDColumn + ` = m.warehouse_client
				 WHERE (u.` + ClientIDColumn + ` IS NULL OR u.` + ClientIDColumn + ` = '')
				   AND m.warehouse_client <> ''`); err == nil && n > 0 {
				log.Printf("[report-map] carried %d mapping(s) into dcp_user.%s", n, ClientIDColumn)
			}
		}
	})
}

func portalTableExists(table string) bool {
	row, err := db.QueryOne(`
		SELECT COUNT(*) AS c FROM information_schema.TABLES
		 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, table)
	return err == nil && row != nil && numOf(row["c"]) > 0
}

/*
validClientID accepts a canonical 36-character UUID, or nothing.

Checked because the consequence of a wrong value here is not an error message —
it is one company reading another's enforcement data. A typo that still parses
as a UUID is beyond what validation can catch (which is why the mapping screen
offers a picker of real warehouse clients rather than a text box), but a
truncated paste or a stray quote is exactly what this stops.
*/
func validClientID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, c := range s {
		switch i {
		case 8, 13, 18, 23:
			if c != '-' {
				return false
			}
		default:
			isHex := (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
			if !isHex {
				return false
			}
		}
	}
	return true
}

// NormaliseClientID trims the wrapping a copy-paste tends to bring with it.
func NormaliseClientID(s string) string {
	return strings.Trim(strings.TrimSpace(s), "{}\"'")
}

// warehouseClientFor returns the analytics ClientId a portal client is mapped
// to. No value means no mapping, which means no report — never a fallback to
// "whatever was asked for".
func warehouseClientFor(portalUserID int64) (string, bool) {
	id, _ := warehouseClientDiag(portalUserID)
	return id, id != ""
}

/*
warehouseClientDiag is warehouseClientFor with the REASON.

"Not linked" was one message for three different faults — the column missing
because the API was not restarted, the client genuinely having no id set, and
the login pointing at a userId that has no client row. They need different
fixes, and telling someone to check a setting that is already correct wastes
more time than the original bug.

The detail goes to the log and to staff. A client sees only that the report is
not set up: the shape of our schema is not theirs to debug.
*/
func warehouseClientDiag(portalUserID int64) (string, string) {
	ensureClientMapSchema()
	row, err := db.QueryOne(
		"SELECT "+ClientIDColumn+" AS cid FROM dcp_user WHERE userId = ? LIMIT 1", portalUserID)
	if err != nil {
		why := "could not read dcp_user." + ClientIDColumn + ": " + err.Error() +
			" — if the column is missing, the API has not been restarted since it was added"
		log.Printf("[report-map] userId=%d: %s", portalUserID, why)
		return "", why
	}
	if row == nil {
		why := "no dcp_user row for this login's userId"
		log.Printf("[report-map] userId=%d: %s", portalUserID, why)
		return "", why
	}
	id := strings.TrimSpace(strFromAny(row["cid"]))
	if id == "" {
		why := ClientIDColumn + " is empty for this client — set it on the client, " +
			"or under Report Configuration → Client mapping"
		log.Printf("[report-map] userId=%d: %s", portalUserID, why)
		return "", why
	}
	return id, ""
}

// isStaff — role >= 1. Staff choose a client on the report; everyone else has
// theirs chosen for them.
func isStaff(claims *ipauth.Claims) bool {
	return claims != nil && claims.Role != nil && *claims.Role >= 1
}

/*
reportScope decides which warehouse client a request may read.

	staff        → whatever they asked for, as before
	client login → their mapped id, and ONLY that

`ok` is false when a client login has no mapping, which is a configuration gap
rather than an error the reader can fix — the page says so instead of showing an
empty report they would read as "no infringements".
*/
func reportScope(claims *ipauth.Claims, requested string) (clientID string, ok bool, why string) {
	if isStaff(claims) {
		return strings.TrimSpace(requested), true, ""
	}
	if claims == nil {
		return "", false, "Not signed in"
	}
	id, mapped := warehouseClientFor(claims.UserID)
	if !mapped {
		return "", false, "This account is not linked to a reporting client yet. " +
			"Ask IP House to complete the setup."
	}
	// The requested value is DISCARDED, not compared: there is no legitimate
	// reason for a client login to name a client, so treating a mismatch as an
	// error would only tell an attacker they had guessed wrong.
	return id, true, ""
}

/*
mayOpenReports gates the client-facing report on the same module grant that puts
it in the nav (module_permission.pageName = 'Reports'). Hiding a nav item is not
access control — without this, the endpoint would answer a login whose company
was never given the module.
*/
func mayOpenReports(claims *ipauth.Claims) bool {
	if isStaff(claims) {
		return true
	}
	if claims == nil {
		return false
	}
	row, err := db.QueryOne(`
		SELECT COUNT(*) AS c
		  FROM user_module_permission_test u
		  JOIN module_permission m ON m.Id = u.moduleId
		 WHERE u.loginId = ? AND u.allowed = 1 AND m.status = 0 AND m.pageName = ?`,
		claims.LoginID, reportsPageName)
	return err == nil && row != nil && numOf(row["c"]) > 0
}

// reportsPageName is the module identifier the nav and the grant both key on.
// Seeded by ensureReportsModule so an admin has something to grant rather than
// having to invent the exact spelling.
const reportsPageName = "Reports"

var reportsModuleOnce sync.Once

func ensureReportsModule() {
	reportsModuleOnce.Do(func() {
		row, err := db.QueryOne(
			"SELECT Id FROM module_permission WHERE pageName = ? LIMIT 1", reportsPageName)
		if err != nil || row != nil {
			return
		}
		if _, _, err := db.Exec(
			"INSERT INTO module_permission (ModuleName, pageName, status, created, updated) VALUES (?, ?, 0, UTC_TIMESTAMP(), UTC_TIMESTAMP())",
			"Reports", reportsPageName); err != nil {
			log.Printf("[report-map] seed module: %v", err)
			return
		}
		log.Printf("[report-map] added the %q module — grant it per login in Client Management", reportsPageName)
	})
}

// EnsureReportsAccess creates the mapping table and registers the Reports
// module at boot, so an admin can grant it and map a client without having to
// open the report first to bring the tables into existence.
func EnsureReportsAccess() {
	ensureClientMapSchema()
	ensureReportsModule()
}

/*
── GET /api/admin/report-client-map ─────────────────────────────────────────

	Every portal client, what it is mapped to, and — where it is not — the
	warehouse client whose name matches, offered for a human to confirm.
*/
func ReportClientMapList(w http.ResponseWriter, r *http.Request) {
	ensureClientMapSchema()

	/* Client companies only — no IP House rows.

	   This excluded role 1 and stopped there, so Super Admin (role 2) came
	   through and "Admin" sat in a picker whose every other entry is a customer.
	   Both are staff, and neither is a company anyone maps to a warehouse
	   client.

	   COALESCE rather than `!= 1 AND != 2`: role is nullable, and in SQL a NULL
	   fails an inequality rather than passing it, so the null rows — ordinary
	   clients — would have been dropped instead. */
	clients, err := db.Query(`
		SELECT userId, name, ` + ClientIDColumn + ` AS cid FROM dcp_user
		 WHERE COALESCE(role, 0) = 0 AND deleted = 0
		 ORDER BY name`)
	if err != nil {
		Fail(w, 500, "Could not list clients")
		return
	}

	/* The warehouse's own client list, so the picker offers real ids rather than
	   free text.

	   Read through WarehouseClientDirectory — ACTIVE companies only, so nobody
	   maps a portal client onto one the warehouse has retired. It answers from
	   EITHER backend —
	   reports_api's directory when the portal reads through it, the platforms'
	   own client columns when it holds warehouse credentials. It used to be
	   gated on `db.ReportsConfigured()` alone, which since the reports moved
	   behind reports_api is never true: the picker was permanently empty and the
	   tab reported "Warehouse client list unavailable" on an install where the
	   list was one HTTP call away. */
	wh := []map[string]any{}
	for id, name := range WarehouseClientDirectory(r.Context()) {
		wh = append(wh, map[string]any{"id": id, "name": name})
	}
	sort.Slice(wh, func(i, j int) bool {
		return strings.ToLower(strFromAny(wh[i]["name"])) < strings.ToLower(strFromAny(wh[j]["name"]))
	})

	// Name-match suggestions. Loose on purpose — punctuation and casing differ
	// between the two systems — and never applied automatically.
	byNorm := map[string]string{}
	for _, c := range wh {
		byNorm[normaliseClientName(strFromAny(c["name"]))] = strFromAny(c["id"])
	}

	// The warehouse's own name for an id, so a mapped client reads as a name
	// rather than as the UUID stored against it.
	nameByID := map[string]string{}
	for _, c := range wh {
		nameByID[strFromAny(c["id"])] = strFromAny(c["name"])
	}

	out := make([]map[string]any, 0, len(clients))
	for _, c := range clients {
		uid := numOf(c["userId"])
		name := strFromAny(c["name"])
		cid := strings.TrimSpace(strFromAny(c["cid"]))
		row := map[string]any{"userId": uid, "name": name}
		if cid != "" {
			row["warehouseClient"] = cid
			row["warehouseName"] = nameByID[cid]
			// A stored id the warehouse does not know is worth saying out loud:
			// it reports as linked and returns nothing.
			if _, known := nameByID[cid]; !known && len(wh) > 0 {
				row["unknownId"] = true
			}
		} else if guess, hit := byNorm[normaliseClientName(name)]; hit {
			row["suggestion"] = guess
		}
		out = append(out, row)
	}

	OK(w, map[string]any{
		"success": true, "clients": out, "warehouseClients": wh,
		"configured": db.ReportsConfigured(),
	})
}

// normaliseClientName strips everything the two systems disagree about, so
// "IP House Demo - VOD" and "IP House Demo VOD" compare equal.
func normaliseClientName(s string) string {
	var b strings.Builder
	for _, c := range strings.ToLower(s) {
		if (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') {
			b.WriteRune(c)
		}
	}
	return b.String()
}

/*
── PUT /api/admin/report-client-map ─────────────────────────────────────────

	Body: { userId, warehouseClient, warehouseName }. An empty warehouseClient
	removes the mapping, which takes the report away from that client rather than
	leaving it pointed somewhere stale.
*/
func ReportClientMapSave(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	ensureClientMapSchema()

	var body struct {
		UserID          int64  `json:"userId"`
		WarehouseClient string `json:"warehouseClient"`
		WarehouseName   string `json:"warehouseName"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if body.UserID <= 0 {
		Fail(w, 422, "A client is required")
		return
	}

	id := NormaliseClientID(body.WarehouseClient)
	if id != "" && !validClientID(id) {
		Fail(w, 422, "A reporting client id is a 36-character UUID")
		return
	}
	// NULL rather than '' when cleared, so "never set" and "deliberately blank"
	// are not two different empty values to test for later.
	var stored any
	if id != "" {
		stored = id
	}
	if _, _, err := db.Exec(
		"UPDATE dcp_user SET "+ClientIDColumn+" = ?, updated_at = UTC_TIMESTAMP() WHERE userId = ?",
		stored, body.UserID); err != nil {
		log.Printf("[report-map] save %d: %v", body.UserID, err)
		Fail(w, 500, "Could not save this mapping")
		return
	}
	if claims != nil {
		log.Printf("[report-map] %s set %s for client %d to %q",
			claims.LoginUsername, ClientIDColumn, body.UserID, id)
	}
	OK(w, map[string]any{"success": true, "userId": body.UserID, "cleared": id == ""})
}

/*
── GET /api/reports/scope ───────────────────────────────────────────────────

	What the CALLER may see: whether the report is open to them at all, and which
	client it will be run for. The client page asks this before anything else, so
	an unmapped account gets a sentence explaining why rather than an empty
	report.
*/
func ReportsScope(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	ensureReportsModule()

	if !mayOpenReports(claims) {
		OK(w, map[string]any{
			"success": true, "allowed": false,
			"reason": "The Reports module is not enabled for this account.",
		})
		return
	}
	if isStaff(claims) {
		OK(w, map[string]any{"success": true, "allowed": true, "staff": true})
		return
	}
	id, ok, why := reportScope(claims, "")
	out := map[string]any{
		"success": true, "allowed": ok, "staff": false,
		"clientId": id, "clientName": claims.ClientName, "reason": why,
	}
	if !ok {
		/* Impersonation is the case that makes this worth returning at all: a
		   staff member looking at a client's report AS that client sees the
		   client's message, and has no other way to find out which of the three
		   faults it is without reading the server log. */
		if claims.ImpersonatorLoginID != 0 {
			_, diag := warehouseClientDiag(claims.UserID)
			out["diagnostic"] = diag
			out["portalUserId"] = claims.UserID
		}
	}
	OK(w, out)
}
