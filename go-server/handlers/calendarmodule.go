package handlers

import (
	"log"
	"sync"

	ipauth "github.com/ip-house/iphouse-api/auth"
	"github.com/ip-house/iphouse-api/db"
)

/*
The Calendar module — the grant behind the programme calendar on the landing page.

The calendar was gated on the REPORTS grant, which was true enough while it was
the only thing on that page: a login holding Reports saw the week's figures and
the fixture calendar above them, and there was nothing to separate. It is its own
panel now, drawn from its own endpoint with its own failure state, and a client
who should see the numbers but not the schedule had no way to be given one
without the other.

So it is its own module, and this file is the whole of what makes that identifier
real: the row an admin grants, the gate the endpoint checks, and the one-time
backfill that stops the split costing anybody the calendar they already had.

── The identifier is the PAGE, not the module's name ────────────────────────

`pageName` is the join key for everything — the nav (lib/navItems.tsx), the
module-access context in the browser, and the SQL gates here — and every other
module keys on the page the grant opens: UploadURL, SearchCaseList, war-room,
data-sharing. This one is no different. The module is called Calendar because
that is what a reader recognises on the page; what it GRANTS is /welcome, the
landing page the calendar sits at the top of, so "welcome" is the key.

That distinction is the whole of a bug that shipped: the constant here said
"Calendar" while the row an admin had created said "welcome", so a grant an admin
had ticked, saved and seen confirmed joined to nothing. Nothing failed loudly —
the panel is rendered behind `has(...)`, so a false answer draws no calendar and
no error either, and the account looked as though it had simply been given
nothing.

Seeding by pageName alone would not have found that row and would have inserted a
SECOND module also called Calendar, leaving an admin two identical rows of which
only one did anything. So the seed adopts the row that is already there — keyed
or not — and inserts only where there is nothing to adopt.
*/

// calendarPageName is the module identifier the grant, the landing page and the
// nav item all key on — the PAGE the grant opens, which is how every other
// module in this table is keyed. Seeded below so an admin has something to grant
// rather than having to invent the exact spelling — same reasoning as
// reportsPageName.
const calendarPageName = "welcome"

// The module NAME as it is displayed and as an admin is likely to have typed it.
// Only used to find a hand-made row to adopt; the identifier above is what
// anything reads afterwards.
const calendarModuleName = "Calendar"

/*
mayOpenCalendar gates the asset master when it is being read FOR THE CALENDAR.

Same shape and the same reasoning as mayOpenReports: hiding a panel in the
browser is not access control, so the endpoint behind it checks the grant itself.
It reads the same identifier the page and the nav do, so the three cannot answer
differently about one login.
*/
func mayOpenCalendar(claims *ipauth.Claims) bool {
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
		claims.LoginID, calendarPageName)
	return err == nil && row != nil && numOf(row["c"]) > 0
}

var calendarModuleOnce sync.Once

/*
EnsureCalendarModule makes the Calendar module real and keyed.

Re-asserted on every boot rather than recorded as done once, exactly like the
Reports module: it is data the portal needs present, and a database restored from
before the module existed should come up with it rather than with a landing page
whose calendar nobody can be granted.

Three cases, in order:

  - already keyed to this page — nothing to do, and this is the case on every
    boot after the first;
  - a row named Calendar carrying some OTHER key, or none — the row an admin
    added by hand. Re-keyed, because inserting alongside it would leave two rows
    called Calendar of which only one did anything, and an admin ticking the
    wrong one would be back where this started. Deleted rows are left alone:
    status != 0 is a row somebody took out of service, and quietly reviving it
    as the identifier the landing page now depends on is not a repair;
  - neither — insert it.

Re-keying rather than only filling a blank is the correction. The first version
adopted a row whose pageName was NULL or empty and nothing else, so the row that
actually existed — Calendar, keyed "welcome" — matched neither branch: not
already keyed, not an orphan. It fell through to the INSERT, which is how a
second Calendar module comes to exist on the next restart.

The GRANTS survive it either way. user_module_permission_test joins on moduleId,
so re-keying a row leaves every login that holds it holding it still; it is the
lookup that starts working, not the permission that changes.
*/
func EnsureCalendarModule() {
	calendarModuleOnce.Do(func() {
		row, err := db.QueryOne(
			"SELECT Id FROM module_permission WHERE pageName = ? LIMIT 1", calendarPageName)
		if err != nil || row != nil {
			return
		}

		// Any live row already called Calendar, whatever key it carries — a
		// wrong one included. Matching on the NAME is the point: that is what an
		// admin typed, and it is the only thing that identifies the row they
		// meant when its key is exactly what has gone wrong.
		stray, err := db.QueryOne(`
			SELECT Id, pageName FROM module_permission
			 WHERE UPPER(ModuleName) = UPPER(?) AND status = 0
			 ORDER BY Id LIMIT 1`, calendarModuleName)
		if err == nil && stray != nil {
			was := strFromAny(stray["pageName"])
			if _, _, err := db.Exec(
				"UPDATE module_permission SET pageName = ?, updated = UTC_TIMESTAMP() WHERE Id = ?",
				calendarPageName, stray["Id"]); err != nil {
				log.Printf("[calendar] key the existing module: %v", err)
				return
			}
			if was == "" {
				log.Printf("[calendar] the %q module had no page name — set to %q, which is what the grant joins on",
					calendarModuleName, calendarPageName)
			} else {
				log.Printf("[calendar] the %q module was keyed %q, which nothing joins on — set to %q; existing grants are unaffected",
					calendarModuleName, was, calendarPageName)
			}
			return
		}

		if _, _, err := db.Exec(
			"INSERT INTO module_permission (ModuleName, pageName, status, created, updated) VALUES (?, ?, 0, UTC_TIMESTAMP(), UTC_TIMESTAMP())",
			calendarModuleName, calendarPageName); err != nil {
			log.Printf("[calendar] seed module: %v", err)
			return
		}
		log.Printf("[calendar] added the %q module — grant it per login in Client Management", calendarPageName)
	})
}

/*
BackfillCalendarGrants gives the new module to everyone the old gate already let
in.

ONCE, EVER — which is why it is a numbered schema step and not part of the seed
above. Re-run on each boot it would undo an admin's decision: revoke Calendar
from a client in the morning and the next restart hands it straight back, with
nothing on screen to explain why. A step is recorded in schema_migrations the
first time it runs and skipped forever after, which is the difference between a
migration and a policy.

What it does is the whole of what makes this split safe to deploy. The calendar
was visible to every login holding Reports; separating the two without this would
take it away from all of them at once — a regression every customer sees and no
admin was warned about. Afterwards the two grants are genuinely independent, and
taking the calendar off a client is something somebody chose.

Only logins that hold Reports, and only where no Calendar row already exists:
`allowed` carries an explicit 0 as well as a 1, so a login somebody had already
been refused the calendar must not be granted it here by a NOT EXISTS that only
looked for grants.
*/
func BackfillCalendarGrants() {
	EnsureCalendarModule()

	row, err := db.QueryOne(
		"SELECT Id FROM module_permission WHERE pageName = ? LIMIT 1", calendarPageName)
	if err != nil || row == nil {
		log.Printf("[calendar] no module row to backfill against; grants unchanged")
		return
	}
	id := row["Id"]

	_, n, err := db.Exec(`
		INSERT INTO user_module_permission_test (loginId, moduleId, allowed)
		SELECT u.loginId, ?, 1
		  FROM user_module_permission_test u
		  JOIN module_permission m ON m.Id = u.moduleId
		 WHERE u.allowed = 1 AND m.status = 0 AND m.pageName = ?
		   AND NOT EXISTS (
		       SELECT 1 FROM user_module_permission_test x
		        WHERE x.loginId = u.loginId AND x.moduleId = ?)`,
		id, reportsPageName, id)
	if err != nil {
		log.Printf("[calendar] backfill from %q: %v", reportsPageName, err)
		return
	}
	log.Printf("[calendar] granted %q to %d login(s) that already held %q", calendarPageName, n, reportsPageName)
}
