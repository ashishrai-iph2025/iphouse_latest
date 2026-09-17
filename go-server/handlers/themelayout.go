package handlers

/*
Whether a login's portal opens with the sidebar on, and the header shown.

Was localStorage only (`ip_customizer`, in lib/ThemeCustomizerContext.tsx) —
a preference of the BROWSER, not the account. A reader who turned the
sidebar on at their desk got the shipped default back on their laptop, and
an admin who wanted a client's portal to open a particular way had no place
to say so short of walking them through the customizer panel over a call.

This table has carried more than these two columns before — a curated set of
nav layouts and colours, then a full rebuild with 24 presets and nine
sections — both cut back down on the same finding: most of it either did
nothing in AdminShell (which has always had its own fixed layout) or was
choice this app never needed. What is left is genuinely a matter of
per-account preference with real, distinct code behind it in ClientShell.tsx
and SideNav.tsx.

Kept here as one row per ACCOUNT, not per browser, keyed the same way the
lockout and password-history tables already key across the two account
kinds that share this portal — see AcctLogin / AcctSuperAdmin in
authlockout.go. Staff and client logins both run the same customizer, and
both get the same persistence for it; only the admin-set-a-login's-default
endpoint below is client-only, because it lives on the client account
editor and there is no equivalent screen for editing a colleague's staff
account.

Two doors onto one row:

  - GET/PUT /api/user/theme-layout — a login reading and saving ITS OWN
    settings, called by the customizer panel itself whenever a reader
    changes something there.
  - GET/PUT/DELETE /api/admin/login-theme-layout — an admin reading and
    writing a CLIENT LOGIN's row directly, from the account editor drawer.
    This is not a separate "default" layer sitting under the login's own
    choice — it is the same row. An admin sets what a login starts on;
    if that login later opens the customizer and changes something, their
    own save overwrites it, exactly as Module Access and Layout Access
    already work in the same drawer. Reset (DELETE) removes the row
    outright, handing the login back to whatever the shipped client-side
    defaults are.
*/

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"sync"

	ipauth "github.com/ip-house/iphouse-api/auth"
	"github.com/ip-house/iphouse-api/db"
)

const themeLayoutTable = "user_theme_layout"

var themeLayoutSchemaOnce sync.Once

func ensureThemeLayoutSchema() {
	themeLayoutSchemaOnce.Do(func() {
		if _, _, err := db.Exec(`
			CREATE TABLE IF NOT EXISTS ` + themeLayoutTable + ` (
			  account_type    VARCHAR(20)  NOT NULL,
			  account_id      BIGINT       NOT NULL,
			  sidebar_enabled TINYINT(1)   NOT NULL DEFAULT 0,
			  header_visible  TINYINT(1)   NOT NULL DEFAULT 1,
			  updated_by      VARCHAR(191) NOT NULL DEFAULT '',
			  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
			  PRIMARY KEY (account_type, account_id)
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`); err != nil {
			log.Printf("[theme-layout] create %s: %v", themeLayoutTable, err)
			return
		}
		/* A portal whose table predates these two columns (it carried a much
		   larger set — accent/navbar/sidebar colours, nav layout, sidebar
		   size, direction, position, user info — across two earlier, richer
		   designs) gets them ADDed here; CREATE TABLE IF NOT EXISTS only
		   fires on a table that does not exist yet. The old columns are left
		   in place rather than dropped — this migration only ever adds — so
		   they sit unused rather than being touched by a DROP COLUMN against
		   a table this code does not own the data lifecycle of. */
		for _, col := range []struct{ name, ddl string }{
			{"sidebar_enabled", "TINYINT(1) NOT NULL DEFAULT 0"},
			{"header_visible", "TINYINT(1) NOT NULL DEFAULT 1"},
		} {
			if portalColumnExists(themeLayoutTable, col.name) {
				continue
			}
			if _, _, err := db.Exec("ALTER TABLE " + themeLayoutTable + " ADD COLUMN " + col.name + " " + col.ddl); err != nil {
				log.Printf("[theme-layout] add %s.%s: %v", themeLayoutTable, col.name, err)
			}
		}
	})
}

// themeLayout is the customizer state — the two fields CustomizerState in
// lib/ThemeCustomizerContext.tsx carries, in the same shape, so the frontend
// can round-trip it with no translation layer either side.
type themeLayout struct {
	SidebarEnabled bool `json:"sidebarEnabled"`
	HeaderVisible  bool `json:"headerVisible"`
}

// themeLayoutFor reads one account's row, or a zero-value/false when it has
// none — absent is a real state (this account has never been set, by itself
// or by an admin) and the caller decides what to fall back to rather than
// this function inventing shipped defaults it does not own.
func themeLayoutFor(acctType string, acctID int64) (themeLayout, bool) {
	ensureThemeLayoutSchema()
	row, err := db.QueryOne(`
		SELECT sidebar_enabled, header_visible
		  FROM `+themeLayoutTable+`
		 WHERE account_type = ? AND account_id = ? LIMIT 1`, acctType, acctID)
	if err != nil {
		log.Printf("[theme-layout] read %s/%d: %v", acctType, acctID, err)
		return themeLayout{}, false
	}
	if row == nil {
		return themeLayout{}, false
	}
	return themeLayout{
		SidebarEnabled: flagOn(row["sidebar_enabled"]),
		HeaderVisible:  flagOn(row["header_visible"]),
	}, true
}

func saveThemeLayout(acctType string, acctID int64, t themeLayout, who string) error {
	ensureThemeLayoutSchema()
	_, _, err := db.Exec(`
		INSERT INTO `+themeLayoutTable+`
		  (account_type, account_id, sidebar_enabled, header_visible, updated_by)
		VALUES (?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
		  sidebar_enabled=VALUES(sidebar_enabled), header_visible=VALUES(header_visible),
		  updated_by=VALUES(updated_by)`,
		acctType, acctID, t.SidebarEnabled, t.HeaderVisible, who)
	return err
}

// acctFor resolves a login's OWN identity in the (account_type, account_id)
// space these rows are keyed in — see the file header on why LoginID is
// already the right id for both kinds of account.
func acctFor(claims *ipauth.Claims) (string, int64) {
	if isStaff(claims) {
		return AcctSuperAdmin, claims.LoginID
	}
	return AcctLogin, claims.LoginID
}

/*
── GET /api/user/theme-layout ────────────────────────────────────────────

	A login reading its own settings — called once, on the customizer
	provider's first mount, the same moment it used to read localStorage.
*/
func UserThemeLayoutGet(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	if claims == nil {
		Fail(w, 401, "Not authenticated")
		return
	}
	acctType, acctID := acctFor(claims)
	t, found := themeLayoutFor(acctType, acctID)
	OK(w, map[string]any{"success": true, "found": found, "layout": t})
}

/*
── PUT /api/user/theme-layout ────────────────────────────────────────────

	A login saving its own settings — called every time the customizer panel
	changes one, the same moment it used to write localStorage. The body is
	the WHOLE state, not a patch: the panel already holds the full object
	(it has to, to render itself), and a partial write here would leave
	stale values in fields this save was not about.
*/
func UserThemeLayoutSave(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	if claims == nil {
		Fail(w, 401, "Not authenticated")
		return
	}
	var t themeLayout
	if err := json.NewDecoder(r.Body).Decode(&t); err != nil {
		Fail(w, 422, "A layout is required")
		return
	}
	acctType, acctID := acctFor(claims)
	if err := saveThemeLayout(acctType, acctID, t, claims.LoginUsername); err != nil {
		log.Printf("[theme-layout] save %s/%d: %v", acctType, acctID, err)
		Fail(w, 500, "Could not save your layout")
		return
	}
	OK(w, map[string]any{"success": true})
}

/*
── GET /api/admin/login-theme-layout?loginId= ────────────────────────────

	What a CLIENT login's portal opens on — the account editor's own read,
	same shape as the self-service one, plus whether this is the login's
	own saved choice or nothing has ever been set for it (found=false, in
	which case the drawer shows the shipped defaults as a preview rather
	than claiming they are this login's setting).
*/
func LoginThemeLayoutGet(w http.ResponseWriter, r *http.Request) {
	loginID, ok := parseLoginID(w, r)
	if !ok {
		return
	}
	t, found := themeLayoutFor(AcctLogin, loginID)
	OK(w, map[string]any{"success": true, "found": found, "layout": t})
}

/*
── PUT /api/admin/login-theme-layout ──────────────────────────────────────

	Set what a client login's portal opens on. Body: { loginId, layout }.
	Writes the SAME row the login's own save would — see the file header on
	why this is not a separate default layer.
*/
func LoginThemeLayoutSave(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	var body struct {
		LoginID int64       `json:"loginId"`
		Layout  themeLayout `json:"layout"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		Fail(w, 422, "A layout is required")
		return
	}
	if body.LoginID <= 0 {
		Fail(w, 422, "A login is required")
		return
	}
	who := ""
	if claims != nil {
		who = claims.LoginUsername
	}
	if err := saveThemeLayout(AcctLogin, body.LoginID, body.Layout, who); err != nil {
		log.Printf("[theme-layout] admin save login=%d: %v", body.LoginID, err)
		Fail(w, 500, "Could not save this login's layout")
		return
	}
	OK(w, map[string]any{"success": true})
}

/*
── DELETE /api/admin/login-theme-layout?loginId= ─────────────────────────

	Clears a client login's row outright, handing it back to the shipped
	client-side defaults — the same "no row at all" state a login that has
	never touched the customizer, and that an admin has never set anything
	for, is already in.
*/
func LoginThemeLayoutReset(w http.ResponseWriter, r *http.Request) {
	loginID, ok := parseLoginID(w, r)
	if !ok {
		return
	}
	ensureThemeLayoutSchema()
	if _, _, err := db.Exec(
		"DELETE FROM "+themeLayoutTable+" WHERE account_type = ? AND account_id = ?",
		AcctLogin, loginID); err != nil {
		Fail(w, 500, "Could not reset this login's layout")
		return
	}
	OK(w, map[string]any{"success": true})
}

// parseLoginID reads ?loginId= off the request, failing the response itself
// on anything unusable so every caller above can just check `ok`.
func parseLoginID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	raw := strings.TrimSpace(r.URL.Query().Get("loginId"))
	id := numOf(raw)
	if raw == "" || id <= 0 {
		Fail(w, 422, "A login is required")
		return 0, false
	}
	return id, true
}
