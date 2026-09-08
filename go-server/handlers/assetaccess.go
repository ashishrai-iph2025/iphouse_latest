package handlers

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"sync"

	ipauth "github.com/ip-house/iphouse-api/auth"
	"github.com/ip-house/iphouse-api/db"
)

/*
Who may see their company's asset register.

── The grain, and why it differs from the layout permission ─────────────────

Keyed on login_id, which names one PERSON AT ONE COMPANY — dcp_user_login holds
a row per company for a shared login, so loginId already carries the company.

That is the opposite of the choice login_layout_settings makes, and deliberately.
Whether somebody is trusted to rearrange a report is a fact about the person, so
that table keys on login_username and answers the same for them everywhere. Asset
access is a fact about a person AND a company: the register lists that client's
titles, so granting it for one company must not grant it for another the same
username also signs into. Keying on login_username here would leak one client's
title list to a session opened against a different client.

── Default deny ─────────────────────────────────────────────────────────────

No row means no access, and that is the only safe default for a table of a
client's protected titles. It also means the feature is invisible until somebody
is deliberately given it, so switching this on for one account cannot surprise
everyone else.
*/

const assetAccessTable = "asset_user_access"

var assetAccessOnce sync.Once

func ensureAssetAccessSchema() {
	assetAccessOnce.Do(func() {
		if _, _, err := db.Exec(`
			CREATE TABLE IF NOT EXISTS ` + assetAccessTable + ` (
			  login_id   INT UNSIGNED NOT NULL PRIMARY KEY,
			  granted_by VARCHAR(191) NOT NULL DEFAULT '',
			  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`); err != nil {
			log.Printf("[asset-access] create %s: %v", assetAccessTable, err)
		}
	})
}

// EnsureAssetAccessSchema creates the table at boot so the first read does not
// race the first write — same reason notify.EnsureSchema is called there.
func EnsureAssetAccessSchema() { ensureAssetAccessSchema() }

/*
mayViewAssets answers the one question every asset path asks.

Staff are not exempted here even though they can reach far more through the
admin screens. This endpoint answers as a CLIENT — it returns the register for
the client the session is scoped to — so an admin browsing it is using the client
feature and should have been given it like anyone else. Admins who want the raw
list have /admin and the reports API.
*/
func mayViewAssets(claims *ipauth.Claims) bool {
	if claims == nil || claims.LoginID == 0 {
		return false
	}
	ensureAssetAccessSchema()
	row, err := db.QueryOne(
		"SELECT login_id FROM "+assetAccessTable+" WHERE login_id = ? LIMIT 1", claims.LoginID)
	return err == nil && row != nil
}

/*
── GET/POST /api/admin/asset-access ─────────────────────────────────────────

GET  → every client login account, with the grant it currently holds.
POST → { loginIds: [...], enabled: bool }

The POST takes a LIST rather than one id because the screen it serves offers
"enable for these six people" as one action. Sending six requests would make a
half-applied batch a normal outcome — six chances to fail, and no way for the
operator to tell which took.
*/
func AssetAccessAdmin(w http.ResponseWriter, r *http.Request) {
	ensureAssetAccessSchema()

	switch r.Method {
	case http.MethodGet:
		/* Grouped on the client, because the screen picks a client first. Staff
		   accounts are left out for the same reason the other client-account
		   screens leave them out — they are colleagues, not customers, and they
		   read this register through admin instead. */
		rows, _ := db.Query(`
			SELECT u.userId, u.name AS clientName, u.email AS clientEmail,
			       l.loginId,
			       TRIM(CONCAT(IFNULL(l.first_name,''),' ',IFNULL(l.last_name,''))) AS personName,
			       l.login_username AS username,
			       CASE WHEN a.login_id IS NULL THEN 0 ELSE 1 END AS enabled,
			       a.granted_by
			FROM dcp_user_login l
			INNER JOIN dcp_user u ON u.userId = l.userId AND u.deleted = 0
			LEFT JOIN ` + assetAccessTable + ` a ON a.login_id = l.loginId
			LEFT JOIN dcp_super_admin sa
			  ON CONVERT(sa.email USING utf8mb4) COLLATE utf8mb4_general_ci
			   = CONVERT(l.login_username USING utf8mb4) COLLATE utf8mb4_general_ci
			  AND sa.is_active = 1
			WHERE l.deleted = 0 AND l.is_active = 1
			  AND sa.email IS NULL
			  AND (u.role IS NULL OR u.role != 1)
			ORDER BY u.name, l.login_username`)
		if rows == nil {
			rows = []map[string]any{}
		}
		OK(w, map[string]any{"success": true, "users": rows})

	case http.MethodPost:
		var body struct {
			LoginIDs []int64 `json:"loginIds"`
			Enabled  bool    `json:"enabled"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			Fail(w, 400, "Could not read the request")
			return
		}
		if len(body.LoginIDs) == 0 {
			Fail(w, 422, "Choose at least one account")
			return
		}
		/* Capped so one malformed request cannot build a statement with tens of
		   thousands of placeholders. The screen sends one client's logins at a
		   time and the largest client here has nowhere near this many. */
		if len(body.LoginIDs) > 2000 {
			Fail(w, 422, "Too many accounts in one request")
			return
		}

		claims := ClaimsFrom(r)
		who := ""
		if claims != nil {
			who = claims.LoginUsername
		}

		marks := make([]string, 0, len(body.LoginIDs))
		args := make([]any, 0, len(body.LoginIDs)*3)
		del := make([]any, 0, len(body.LoginIDs))
		for _, id := range body.LoginIDs {
			if id <= 0 {
				continue
			}
			marks = append(marks, "(?, ?)")
			args = append(args, id, who)
			del = append(del, id)
		}
		if len(del) == 0 {
			Fail(w, 422, "Choose at least one account")
			return
		}

		if body.Enabled {
			/* INSERT IGNORE, so re-enabling an account that already has access is
			   a no-op rather than an error — the screen sends the whole selection,
			   not the difference, and some of it is usually already granted. */
			if _, _, err := db.Exec(
				"INSERT IGNORE INTO "+assetAccessTable+" (login_id, granted_by) VALUES "+
					strings.Join(marks, ", "), args...); err != nil {
				log.Printf("[asset-access] grant: %v", err)
				Fail(w, 500, "The change could not be saved")
				return
			}
		} else {
			ph := strings.TrimSuffix(strings.Repeat("?,", len(del)), ",")
			if _, _, err := db.Exec(
				"DELETE FROM "+assetAccessTable+" WHERE login_id IN ("+ph+")", del...); err != nil {
				log.Printf("[asset-access] revoke: %v", err)
				Fail(w, 500, "The change could not be saved")
				return
			}
		}
		OK(w, map[string]any{"success": true, "changed": len(del)})

	default:
		Fail(w, 405, "Method not allowed")
	}
}
