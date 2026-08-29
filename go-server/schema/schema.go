// Package schema applies the portal's database changes, in order, once each.
//
// The versioned-migrations pattern, which is what the rest of the industry does
// and what this codebase did not: every change to the portal schema is a
// numbered entry below, applied at STARTUP, and recorded in a table so any
// database can be asked what it has.
//
// ── What this replaces, and why ──────────────────────────────────────────────
//
// The portal grew nineteen `ensure*Schema()` functions holding thirty-six
// CREATE TABLE and twenty ALTER … ADD COLUMN statements, each fired lazily by a
// sync.Once the first time its feature was used. That works, and it cost:
//
//   - nothing recorded what had run, so "does staging have this column yet" was
//     a question you answered by querying the database rather than reading the
//     repository,
//   - schema changes happened on a USER'S REQUEST, at some unpredictable moment
//     after deploy, rather than at deploy,
//   - and nothing checked the schema the code ASSUMED. That is the one that bit:
//     dcp_user_login.last_seen_at was read by the Active Sessions panel and
//     written by three login paths, and no ensure function ever created it. Four
//     code paths against a column that did not exist, every one of them
//     discarding its error, for months.
//
// The last point is why Verify() exists below and runs beside the migrations. A
// migration runner stops you shipping an absent column; an assertion tells you
// when one went absent anyway.
//
// ── House rules ─────────────────────────────────────────────────────────────
//
//   - APPEND ONLY. A migration that has run somewhere is history; editing its
//     SQL changes nothing on a database that already applied it and quietly
//     diverges the two. Fix a mistake with a new version.
//   - Numbers never repeat and never fill gaps. The number is the identity.
//   - Each statement stands alone. MySQL does not roll back DDL, so a migration
//     of four statements that fails on the third leaves two applied — the entry
//     is therefore NOT recorded, and every statement has to be safe to run twice
//     (IF NOT EXISTS, or a column check). That is a property of MySQL, not a
//     shortcut.
//   - The legacy ensure* functions are left alone deliberately. They are
//     idempotent and their tables exist; rewriting fifty-six live DDL statements
//     as migrations in one pass is a bigger risk than the inconsistency. New
//     schema goes here, and they can be retired one at a time — see MIGRATION.md.
package schema

import (
	"fmt"
	"log"
	"strings"

	"github.com/ip-house/iphouse-api/db"
)

/*
Step is a schema change expressed as GO rather than as SQL.

The portal's schema was built by nineteen functions that each fired lazily, the
first time their feature was touched, and recorded nothing. Rewriting all seventy
of their statements as frozen SQL would have duplicated every one away from the
comment that explains why it exists — and gained nothing on any database that
already has them, which is all of them.

So they are REGISTERED instead: named, numbered, ordered, run at startup, and
recorded in the same table the SQL migrations use. What that buys is everything
the lazy version lacked — schema work happens at deploy rather than on a user's
request, the order is declared rather than incidental, and any database can be
asked which steps it has had.

What it does not buy, and the honest limit of this: a Step's body can still
change, so it is not frozen history the way a numbered SQL statement is, and a
brand-new database still needs this Go code rather than the SQL alone. New schema
should therefore go in `migrations` above as SQL. These exist to bring what was
already written under the same roof — and each can be retired into real SQL when
someone is next working in that file. See MIGRATION.md.

Versions live in their own range (100+) so the two lists cannot collide as either
grows.
*/
type Step struct {
	Version int
	Name    string
	Run     func()
}

// Migration is one numbered change. Statements run in order.
type Migration struct {
	Version int
	Name    string
	// Each statement must be safe to run twice — see the note on DDL above.
	Statements []string
}

/*
migrations is the ordered history. APPEND ONLY.

001 is the schema the Active Sessions panel had always assumed and never had.
Both columns are nullable with no default, so adding them cannot fail on
existing rows and cannot change any behaviour until something writes them.
*/
var migrations = []Migration{
	{
		Version: 1,
		Name:    "dcp_user_login: last_seen_at, force_logout_at",
		Statements: []string{
			`ALTER TABLE dcp_user_login ADD COLUMN last_seen_at DATETIME NULL DEFAULT NULL`,
			`ALTER TABLE dcp_user_login ADD COLUMN force_logout_at DATETIME NULL DEFAULT NULL`,
		},
	},
	/*
		002 splits two meanings that had been sharing one column.

		is_active = 0 was doing three jobs: "this account may not sign in" (what
		auth.go actually reads it for), "this company assignment was removed
		during an edit", and "this login was deleted from Registrations". The
		third is why Registrations could not offer an active/inactive switch —
		marking somebody inactive was byte-for-byte the same write as deleting
		them, and the list filters on is_active, so they vanished.

		deleted now carries "this row is not a live assignment", set by both the
		delete action and the assignment-removal path. is_active goes back to
		meaning only "may sign in".

		The invariant every other query depends on: deleted = 1 IMPLIES
		is_active = 0. Nothing in auth needs to learn about this column as long
		as that holds — a deleted row is already excluded by the is_active = 1
		test those queries have always made. Every write below preserves it.

		The backfill reproduces exactly what Registrations shows today: it
		filtered is_active = 1, so every is_active = 0 row was already invisible
		there. Marking those deleted keeps the list byte-identical after deploy
		and changes nothing on /admin/users, which does not read this column.
	*/
	{
		Version: 2,
		Name:    "dcp_user_login: deleted (split delete from deactivate)",
		Statements: []string{
			`ALTER TABLE dcp_user_login ADD COLUMN deleted TINYINT NOT NULL DEFAULT 0`,
			`UPDATE dcp_user_login SET deleted = 1 WHERE is_active = 0`,
		},
	},
	/*
		003 gives the server an opinion about the Theme Customizer's layout
		controls, which it had never had.

		Nav layout, sidebar size and layout width lived only in localStorage
		under `ip_customizer`: every client could change all three, the choice
		never left the browser, and no admin could see or set it. This table is
		the grant behind them — per client COMPANY, the same grain as the War
		Room and idle-timeout settings, because "which layout this client's
		people get" is a property of the client rather than of one person's
		browser. Colour, theme preset and dark mode stay ungated; they are
		personal comfort, and nothing structural moves when they change.

		Default deny, expressed as a DEFAULT of 0 and NO backfill: an absent row
		and a 0 row have to mean the same thing, so a client company created
		long after this ships is denied without anyone writing a row for it.
	*/
	{
		Version: 3,
		Name:    "client_layout_settings: per-client layout-change grant",
		Statements: []string{
			`CREATE TABLE IF NOT EXISTS client_layout_settings (
				user_id        INT NOT NULL PRIMARY KEY,
				layout_enabled TINYINT(1) NOT NULL DEFAULT 0,
				updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
		},
	},
	/*
		004 moves the layout grant from the client company to the LOGIN, and
		gives it somewhere to keep the layout itself.

		003 held this per company, which was the wrong grain twice over. The
		grant is a decision about a person — it is administered from the Edit
		Login Account drawer on /admin/registrations, beside the rest of what
		that account may do — and the layout it governs is not a company-wide
		fact either.

		The key is login_username rather than loginId, and that is the whole
		point of it. A shared login is one dcp_user_login ROW PER COMPANY; a
		loginId names one of those rows, so keying on it would give the same
		person a different layout per company and would silently follow
		whichever row MAX(loginId) happened to name. login_username is what the
		Shared Logins list itself groups by, and it is the identity the people
		sharing an account actually share — so a layout stored against it is
		seen by everyone signing in with it, on any of its companies, which is
		the behaviour asked for.

		The three layout columns are NULL when nothing has been chosen, and null
		means "use the product default". That keeps "never set" distinct from
		"deliberately set to the default", which matters the day a default
		changes: the first should follow it and the second should not.

		003's table is dropped rather than migrated. It never shipped, nothing
		reads it, and it is keyed on something this feature no longer has an
		opinion about. 003 itself stays as written because a recorded step is
		history — see the APPEND ONLY note above.
	*/
	{
		Version: 4,
		Name:    "login_layout_settings: per-login layout grant and stored layout",
		Statements: []string{
			`CREATE TABLE IF NOT EXISTS login_layout_settings (
				login_username VARCHAR(191) NOT NULL PRIMARY KEY,
				layout_enabled TINYINT(1) NOT NULL DEFAULT 0,
				nav_layout     VARCHAR(32) NULL DEFAULT NULL,
				sidebar_size   VARCHAR(32) NULL DEFAULT NULL,
				layout_width   VARCHAR(32) NULL DEFAULT NULL,
				updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
			`DROP TABLE IF EXISTS client_layout_settings`,
		},
	},
	/*
		005 drops the three layout columns 004 added.

		They were the wrong layout. 004 stored navLayout, sidebarSize and
		layoutWidth — the Theme Customizer's chrome, which is the nav rail and
		the page width. What this grant is actually for is the REPORT layout:
		the arrangement of KPI cards, charts and slicers on /reports, which
		already has a home in report_panel_layout and an editor in Report
		Configuration.

		So this table keeps only the grant — who may rearrange — and the
		arrangement itself stays in report_panel_layout, keyed per platform and
		client as it already was. The two are separate on purpose: the
		permission is per PERSON (a login may or may not be trusted to
		rearrange) and the result is per CLIENT (everyone reading that client's
		report sees the same page). Storing the layout here would have made it
		per-person, and one report per reader is not what a shared report is.
	*/
	{
		Version: 5,
		Name:    "login_layout_settings: drop the nav-chrome columns",
		Statements: []string{
			`ALTER TABLE login_layout_settings DROP COLUMN nav_layout`,
			`ALTER TABLE login_layout_settings DROP COLUMN sidebar_size`,
			`ALTER TABLE login_layout_settings DROP COLUMN layout_width`,
		},
	},
	/*
		006 gives a dashboard module a CATEGORY, and a person a subset of the
		modules carrying it.

		── The column ───────────────────────────────────────────────────────────

		dcp_module is the report catalogue an admin maintains on
		/admin/dashboard-modules, and until now its rows were a flat list. The
		reports themselves are not flat: half of them are one subject cut two
		ways — the open web read for a VOD client and the open web read for a
		sports one are different reports over different fixtures — and the cut
		lived only inside the name, as the tail of "Open Web - VOD". Something
		you have to parse out of a label is something nothing can filter on.

		Empty string, not NULL, and no backfill. '' means "not categorised", one
		spelling of it rather than two, so every query can compare with = and no
		caller has to remember which of NULL or '' this install happens to use.
		Every existing row starts there, which is honest: nobody has said what
		category they are.

		VARCHAR rather than an ENUM or a lookup table. The vocabulary is three
		words that the picker and the admin table both need to agree on, and it
		lives in lib/dashboardCategories.ts where both of them read it; an ENUM
		would put a schema migration in the way of adding a fourth, and a lookup
		table would add a join and a second screen to maintain for a list that
		fits on one line.

		── The table ────────────────────────────────────────────────────────────

		login_dashboard_access is which of those modules a person may open.

		Keyed on login_username for the reason spelled out in 004: a shared login
		is one dcp_user_login ROW PER COMPANY, so a loginId names one of them and
		a grant stored against it would give the same person a different report
		list depending on which company they had signed into. The Shared Logins
		list groups by login_username, the layout grant beside this one is keyed
		on it, and so is this.

		NO ROWS MEANS EVERY MODULE. That is the same convention report_access
		already uses and it is chosen for the same reason: this table is empty on
		the day it ships, and the alternative reading would take every report
		away from every existing login at once. "Explicitly none" is still
		sayable — it is the sentinel row module_id = 0, which matches no module.
	*/
	{
		Version: 6,
		Name:    "dcp_module.category + login_dashboard_access",
		Statements: []string{
			`ALTER TABLE dcp_module ADD COLUMN category VARCHAR(32) NOT NULL DEFAULT ''`,
			`CREATE TABLE IF NOT EXISTS login_dashboard_access (
				login_username VARCHAR(191) NOT NULL,
				module_id      INT          NOT NULL,
				granted_by     VARCHAR(191) NOT NULL DEFAULT '',
				created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
				PRIMARY KEY (login_username, module_id)
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
		},
	},
}

/*
expected is the schema the CODE assumes — asserted, not created.

Everything here is either created by a migration above or by one of the legacy
ensure* functions, and the point is to notice when it is missing regardless of
which was supposed to have done it. A column read by four code paths and created
by none is the failure this list exists to make loud.

Deliberately short: it is the columns whose absence is SILENT, because every
access to them is fire-and-forget or discards its error. A column whose absence
breaks a page loudly does not need to be here.
*/
var expected = []struct{ Table, Column string }{
	{"dcp_user_login", "last_seen_at"},
	{"dcp_user_login", "force_logout_at"},
	{"dcp_user_login", "password_changed_at"},
	{"dcp_user_login", "is_client_admin"},
	/* Its absence is silent in the worst way: the Registrations list query
	   errors, db.Query logs and hands back nil, and the page renders an empty
	   table that looks like a portal with no accounts in it. */
	{"dcp_user_login", "deleted"},
	/* Silent in the same way: the dashboard-modules list would drop the column
	   from its SELECT nowhere — it would fail the whole query, and db.Query
	   logs and hands back nil, so the catalogue renders as a portal with no
	   report modules in it. */
	{"dcp_module", "category"},
}

const migrationsTable = "schema_migrations"

/*
Run applies whatever this database has not had, then asserts what the code needs.

Called once from main, after db.Init and before the server listens: schema
changes then happen at DEPLOY, in one predictable moment, with a line in the log
saying what happened — rather than on whichever user's request first touched the
feature.

Errors are returned, not logged and shrugged off. A portal whose schema did not
apply is one whose features fail one at a time later, which is strictly harder to
diagnose than refusing to start.
*/
func Run() error {
	if _, _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS ` + migrationsTable + ` (
		  version     INT          NOT NULL PRIMARY KEY,
		  name        VARCHAR(191) NOT NULL,
		  applied_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`); err != nil {
		return fmt.Errorf("schema: cannot create %s: %w", migrationsTable, err)
	}

	done, err := applied()
	if err != nil {
		return err
	}

	ran := 0
	for _, m := range migrations {
		if done[m.Version] {
			continue
		}
		for i, stmt := range m.Statements {
			if _, _, err := db.Exec(stmt); err != nil {
				/* Already-applied DDL is not a failure. MySQL has no
				   transactional DDL and no ADD COLUMN IF NOT EXISTS, so a
				   migration interrupted halfway leaves some statements done —
				   and re-running it has to be able to step over those. The
				   errors below are exactly "this change is already here". */
				if alreadyApplied(err) {
					/* Said out loud. db.Exec logs its own "EXEC FAILED" line
					   before handing the error back, so stepping over silently
					   leaves two alarming lines in the boot log with nothing
					   explaining them — which is how somebody comes to restart a
					   healthy portal. */
					log.Printf("[schema] %03d statement %d was already applied — stepping over it",
						m.Version, i+1)
					continue
				}
				return fmt.Errorf("schema: migration %03d (%s) statement %d: %w",
					m.Version, m.Name, i+1, err)
			}
		}
		if _, _, err := db.Exec(
			"INSERT INTO "+migrationsTable+" (version, name) VALUES (?, ?)", m.Version, m.Name); err != nil {
			return fmt.Errorf("schema: migration %03d applied but not recorded: %w", m.Version, err)
		}
		log.Printf("[schema] applied %03d %s", m.Version, m.Name)
		ran++
	}

	if ran == 0 {
		log.Printf("[schema] up to date at %03d", highestVersion())
	}
	Verify()
	return nil
}

/*
RunSteps applies the registered schema functions that this database has not had.

Ordered, recorded, and each one only ever run once here. A step that has already
been recorded is skipped — its DDL is idempotent and its own lazy call site is
still in place, so on a database that has had it the function is a no-op wherever
it is called from.

Errors are not returned. Every one of these functions predates this runner and
handles — or logs, or ignores — its own failures internally; wrapping them in a
"the portal will not start" contract they were never written for would turn a
long-tolerated warning into an outage. They are recorded as done, which is the
claim this can honestly make about them. The SQL migrations above are the ones
that stop the process.
*/
func RunSteps(steps []Step) {
	done, err := applied()
	if err != nil {
		log.Printf("[schema] cannot read applied steps, running all of them: %v", err)
		done = map[int]bool{}
	}
	ran := 0
	for _, st := range steps {
		if done[st.Version] || st.Run == nil {
			continue
		}
		st.Run()
		if _, _, err := db.Exec(
			"INSERT INTO "+migrationsTable+" (version, name) VALUES (?, ?)", st.Version, st.Name); err != nil {
			log.Printf("[schema] step %03d ran but was not recorded: %v", st.Version, err)
			continue
		}
		log.Printf("[schema] step %03d %s", st.Version, st.Name)
		ran++
	}
	if ran > 0 {
		log.Printf("[schema] %d schema step(s) applied", ran)
	}
}

/*
Verify logs anything the code expects and the database does not have.

A warning rather than a refusal: this list is about columns whose absence is
SILENT, and a portal that will not start is a worse outcome than one that says
loudly which feature is about to misbehave. The log line is the thing that was
missing for months.
*/
func Verify() {
	for _, e := range expected {
		row, err := db.QueryOne(`
			SELECT COUNT(*) AS c FROM information_schema.COLUMNS
			 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
			e.Table, e.Column)
		if err != nil {
			log.Printf("[schema] cannot check %s.%s: %v", e.Table, e.Column, err)
			continue
		}
		if row == nil || asInt(row["c"]) == 0 {
			log.Printf("[schema] MISSING %s.%s — the code reads this column and the "+
				"database does not have it; whatever reads it will fail silently",
				e.Table, e.Column)
		}
	}
}

func applied() (map[int]bool, error) {
	rows, err := db.Query("SELECT version FROM " + migrationsTable)
	if err != nil {
		return nil, fmt.Errorf("schema: cannot read %s: %w", migrationsTable, err)
	}
	out := make(map[int]bool, len(rows))
	for _, r := range rows {
		out[int(asInt(r["version"]))] = true
	}
	return out, nil
}

func highestVersion() int {
	high := 0
	for _, m := range migrations {
		if m.Version > high {
			high = m.Version
		}
	}
	return high
}

/*
alreadyApplied recognises the errors that mean "this change is already here".

	1060  duplicate column
	1061  duplicate key
	1050  table exists
	1091  cannot drop; does not exist

Matched on the message rather than a driver error type, because db.Exec hands
back a wrapped error and the codes are stable across MySQL versions in a way the
wrapping is not.
*/
func alreadyApplied(err error) bool {
	if err == nil {
		return true
	}
	msg := err.Error()
	for _, code := range []string{"1060", "1061", "1050", "1091"} {
		if strings.Contains(msg, "Error "+code) {
			return true
		}
	}
	return false
}

func asInt(v any) int64 {
	switch n := v.(type) {
	case int64:
		return n
	case int:
		return int64(n)
	case float64:
		return int64(n)
	case []byte:
		var out int64
		fmt.Sscanf(string(n), "%d", &out)
		return out
	case string:
		var out int64
		fmt.Sscanf(n, "%d", &out)
		return out
	}
	return 0
}
