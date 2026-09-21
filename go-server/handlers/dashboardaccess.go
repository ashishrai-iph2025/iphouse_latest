package handlers

/*
Which report modules a person may open.

── What this narrows ─────────────────────────────────────────────────────────

The Reports page builds its sidebar from the enabled rows of report_platform —
"Open Web - VOD", "UGC & Social Media - Sports", and so on. This grant says
which of them one login account gets, chosen by an admin from the dashboard
module catalogue (dcp_module) rather than from the platform list directly.

Two catalogues for one idea is worth explaining. dcp_module is the list an admin
already maintains, on /admin/dashboard-modules, and since migration 006 each of
its rows carries a CATEGORY — VOD, Sports, War Room. That category is the whole
point: it turns a flat list of twenty modules into three short ones, so granting
access is "Sports, these four" rather than a hunt down a column of near-identical
names. report_platform has no such column and is not administered on that screen.

── How a module finds its report ─────────────────────────────────────────────

By NAME, normalised: a module called "Open Web" filed under "Sports" resolves to
the platform labelled "Open Web - Sports", because both sides reduce to
"openwebsports" once case, spaces and punctuation are dropped.

That is a join on a string, which is not what anyone would design from scratch,
and the alternative was worse: a foreign key would mean an admin maintaining the
correspondence by hand on a third screen, and getting it wrong there produces the
same silent mismatch with more steps. What makes it safe is that the join is
resolved WHERE IT IS SET — the picker on /admin/registrations shows each module's
resolved report, or says plainly that it matches none, so a name that does not
line up is visible to the person who can fix it at the moment they are choosing.
See DashboardAccess below, which returns that resolution with the module list.

An uncategorised module matches on its bare name, so a catalogue nobody has
categorised yet behaves exactly as it reads.

── Default ───────────────────────────────────────────────────────────────────

NO ROWS MEANS EVERY REPORT, matching report_access and for the same reason: this
table is empty on the day it ships and the other reading would revoke every
report from every login at once. "Explicitly none" is the sentinel module id 0,
which resolves to nothing.

Where a login is restricted BOTH ways — an allow-list in Report Configuration and
a module grant here — the two INTERSECT. Both were set deliberately by somebody,
and the narrower answer is the only one that honours both.
*/

import (
	"encoding/json"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"

	ipauth "github.com/ip-house/iphouse-api/auth"
	"github.com/ip-house/iphouse-api/db"
)

/*
normaliseReportName strips everything the two catalogues disagree about.

Same rule as normaliseClientName in reportclientmap.go, applied to a different
pair of strings for the same reason: one side is typed by an admin into
dcp_module and the other into report_platform, so "Open Web - VOD",
"Open Web – VOD" and "Open Web VOD" all have to compare equal. Called through
rather than copied, so the two can never drift into disagreeing about what a
difference is.
*/
func normaliseReportName(s string) string { return normaliseClientName(s) }

/*
dashboardModuleKey is what a module compares as: its name and its category run
together, so "Open Web" + "Sports" meets the platform labelled
"Open Web - Sports".

An uncategorised module keys on its name alone. That is not a fallback bolted on
— it is what an uncategorised module MEANS. It has not been told which cut of
the report it is, so the only honest thing it can match is a platform whose label
does not name a cut either.

Note there is deliberately no name-only key for a CATEGORISED module. Adding one
unconditionally would make "Open Web / VOD" and "Open Web / Sports" both match a
platform simply labelled "Open Web", so granting one would grant the other —
which is exactly the distinction the category exists to draw. loadDashModules
allows that fallback only where it cannot cause that collision; see the note on
`spare` there.
*/
func dashboardModuleKey(name, category string) string {
	if strings.TrimSpace(category) == "" {
		return normaliseReportName(name)
	}
	return normaliseReportName(name + " " + category)
}

// dashModule is one row of the catalogue with its resolution attached.
type dashModule struct {
	ID       int64
	Name     string
	Category string
	// The report platform this module resolves to. Empty when nothing matches,
	// which the picker reports rather than hides.
	PlatformKey   string
	PlatformLabel string
}

/*
loadDashModules reads the live catalogue and resolves each row against the
platform list.

Only undeleted modules. A deactivated module is not a report anybody should be
granted, and leaving one resolvable would mean access surviving the act that was
meant to retire it.
*/
func loadDashModules() []dashModule {
	rows, err := db.Query(
		"SELECT moduleId, moduleName, category FROM dcp_module WHERE deleted = 0 ORDER BY moduleName")
	if err != nil {
		log.Printf("[dashboard-access] could not read dcp_module: %v", err)
		return nil
	}

	// Platform labels, keyed by their normalised form. Disabled platforms are
	// skipped: they are not in anybody's sidebar, so resolving to one would
	// report a grant that cannot take effect.
	byLabel := map[string]platformDef{}
	for _, p := range loadPlatforms() {
		if !p.Enabled {
			continue
		}
		byLabel[normaliseReportName(p.Label)] = p
	}

	/*
		A CATEGORISED MODULE MAY TAKE A BARE-NAMED PLATFORM, BUT ONLY IF NOBODY
		ELSE WANTS IT.

		The platform registry names the Sports cuts and leaves the VOD ones
		plain: "Open Web - Sports" beside "Open Web". Keying strictly on name +
		category therefore resolved every Sports module and NO VOD module — the
		picker said "Matches no report — grants nothing" against all ten of
		them, and because an unresolved grant contributes no platform, saving
		one took every report away from the account. That is the failure this
		fallback exists to fix, and it is worth being careful about, because the
		careless version of it re-creates the collision the comment on
		dashboardModuleKey warns about.

		So the bare name is offered only when it is genuinely spare:

		  claimed  a platform already resolved by somebody's exact name +
		           category key, or owned outright by an uncategorised module of
		           that name. Taking it would be taking a report that another
		           row in this same catalogue already opens.
		  wants    how many DISTINCT categories are hoping for the same bare
		           name. Two means the registry does not draw the distinction
		           the catalogue does, and silently handing the platform to
		           whichever sorted first is worse than resolving neither: the
		           picker can say "matches no report" and be believed.
	*/
	claimed := map[string]bool{}
	wants := map[string]map[string]bool{}
	for _, r := range rows {
		name := strFromAny(r["moduleName"])
		cat := strings.TrimSpace(strFromAny(r["category"]))
		if cat == "" {
			// Its key IS the bare name, so it owns that platform outright.
			if p, hit := byLabel[normaliseReportName(name)]; hit {
				claimed[p.Key] = true
			}
			continue
		}
		if p, hit := byLabel[dashboardModuleKey(name, cat)]; hit {
			claimed[p.Key] = true
			continue
		}
		bare := normaliseReportName(name)
		if wants[bare] == nil {
			wants[bare] = map[string]bool{}
		}
		wants[bare][normaliseReportName(cat)] = true
	}

	out := make([]dashModule, 0, len(rows))
	for _, r := range rows {
		m := dashModule{
			ID:       numOf(r["moduleId"]),
			Name:     strFromAny(r["moduleName"]),
			Category: strFromAny(r["category"]),
		}
		if p, hit := byLabel[dashboardModuleKey(m.Name, m.Category)]; hit {
			m.PlatformKey, m.PlatformLabel = p.Key, p.Label
		} else if strings.TrimSpace(m.Category) != "" {
			bare := normaliseReportName(m.Name)
			if p, hit := byLabel[bare]; hit && !claimed[p.Key] && len(wants[bare]) == 1 {
				m.PlatformKey, m.PlatformLabel = p.Key, p.Label
			}
		}
		out = append(out, m)
	}
	return out
}

/*
vodDashModules is the catalogue slice the VOD Reports picker offers — every
dcp_module row categorised "VOD", already resolved to its report_platform by
loadDashModules.

Filtered here rather than by adding a parameter to loadDashModules: every
existing caller wants the whole catalogue (the Reports picker's category
tabs let an admin browse all three), and this is the one caller that wants
exactly one slice of it, permanently. Category compared exactly, not
case-insensitively, matching how the value is written — see
DASHBOARD_CATEGORIES in lib/dashboardCategories.ts, which both ends of this
already have to agree on byte-for-byte or a module silently stops sorting
into its tab.
*/
func vodDashModules() []dashModule {
	all := loadDashModules()
	out := make([]dashModule, 0, len(all))
	for _, m := range all {
		if m.Category == "VOD" {
			out = append(out, m)
		}
	}
	return out
}

/*
sportsDashModules is the catalogue slice the Reports ("Live Events") picker
offers — every dcp_module row categorised Sports or War Room, already
resolved to its report_platform by loadDashModules. The complement of
vodDashModules above, and needed for the same reason: sportsOnlyPlatformKeys
is the hard backstop this grant is checked against when the Reports page
actually reads it, and a platform not claimed by Sports/War Room there falls
on vodOnlyPlatformKeys' side of that backstop instead. Before this existed,
the picker offered the WHOLE catalogue — VOD and uncategorised modules
included — so an admin could tick one, see it counted as granted, click
Apply, and have it grant nothing: resolved to a real platform, just not one
this page's backstop will ever draw. Category compared exactly, not
case-insensitively, matching vodDashModules and DASHBOARD_CATEGORIES.

A platform already granted through some OTHER route that falls outside this
narrower slice (an old VOD-categorised grant row, say) is not lost by this —
it becomes "unlisted" (see the GET handler below), shown and kept rather
than silently dropped, exactly as vodDashModules already relies on for the
symmetric case.
*/
func sportsDashModules() []dashModule {
	all := loadDashModules()
	out := make([]dashModule, 0, len(all))
	for _, m := range all {
		if m.Category == "Sports" || m.Category == "War Room" {
			out = append(out, m)
		}
	}
	return out
}

/*
sportsOnlyPlatformKeys is the hard backstop the Reports page (the plain
"Reports"/renamed-to-"Live Events" grant, NOT VOD) checks a platform against
before ever drawing it — every report_platform claimed by a Sports- or
War-Room-categorised module in the catalogue. The complement of
vodOnlyPlatformKeys below, and built the same way for the same reason: a
stale or hand-edited grant row naming a VOD platform must not be enough on
its own to draw VOD data on the page whose whole reason to exist is that it
shows Sports.

report_platform carries no category column of its own (see the note on
dashboardModuleKey above) — category is entirely what the dcp_module
catalogue says a platform is claimed as.
*/
func sportsOnlyPlatformKeys() map[string]bool {
	claimed := map[string]bool{}
	for _, m := range loadDashModules() {
		if m.PlatformKey == "" {
			continue
		}
		if strings.EqualFold(m.Category, "Sports") || strings.EqualFold(m.Category, "War Room") {
			claimed[m.PlatformKey] = true
		}
	}
	return claimed
}

/*
vodOnlyPlatformKeys is the hard backstop the VOD Reports page checks a
platform against before ever drawing it — every report_platform NOT claimed
by sportsOnlyPlatformKeys above. VOD is what a platform is when nothing in
the catalogue has claimed it as something narrower, the same "default"
reasoning vodDashModules uses for the picker. Built independently of whatever
the VOD grant (reportsAllowedForVOD) happens to hold, and checked IN ADDITION
to it: the grant says what a login is ALLOWED to see, this says what the page
CATEGORICALLY may ever show, and a stale or hand-edited grant row naming a
Sports platform must not be enough on its own to draw Sports data on a page
whose whole reason to exist is that it is not that.
*/
func vodOnlyPlatformKeys() map[string]bool {
	claimed := sportsOnlyPlatformKeys()
	out := map[string]bool{}
	for _, p := range loadPlatforms() {
		if !claimed[p.Key] {
			out[p.Key] = true
		}
	}
	return out
}

/*
── ONE GRANT, TWO WAYS OF LOOKING AT IT ──────────────────────────────────────

There used to be two allow-lists here — a platform list per loginId from Report
Configuration, and a module list per login_username from the account drawer —
intersected at read time. Both were real and the narrower won, which was
defensible and unusable: ticking Sports in one screen left the other showing
nothing ticked, and an admin could not tell from either screen what an account
would actually open.

So there is now one store, report_user_access, and the drawer is a second VIEW
of it rather than a second grant. Ticking a module there resolves the module to
its platform and writes that platform; opening the drawer resolves the stored
platforms back to modules. The User access tab writes the same rows directly.
Neither screen owns the answer and they cannot disagree.

login_dashboard_access is left in place and is no longer read or written. Its
grants were per person and this store is per company, so folding them in would
have had to invent an answer for accounts whose companies differ; and until the
resolution bug above was fixed, a categorised module resolved to no platform at
all, so almost nothing it holds was ever in effect.

── One grain, too ────────────────────────────────────────────────────────────

Per LOGIN ROW, which is per company, on both screens. A shared login holds one
client's platforms and not another's, and that is a distinction worth keeping:
an agency user reads Sports for one client and the VOD cuts for another.

The drawer used to speak for the PERSON here — reading the union across their
companies and writing every row alike. It sat directly beneath a checklist that
is explicitly per company, under that company's own picker, so the one thing it
looked like it did was the one thing it did not do. It now follows the same
picker as the modules above it: whichever company is selected is the company it
reads and writes.
*/

/*
writePlatformGrant stores one allow-list against one login row — one company. A
nil list clears the restriction, which is the absence of rows.

`table` selects which grant this writes: reportAccessTable for Reports,
reportAccessVODTable for VOD Reports — see reportAccessVODTable's own comment
for why they are two tables rather than one scoped by a column.

Deliberately the same shape of write as ReportAccessSave: delete the rows, then
insert the list in one statement, with the sentinel standing in for "restricted
to nothing" so it stays distinguishable from "never restricted".
*/
func writePlatformGrant(table string, id int64, keys []string, who string) error {
	valid := map[string]bool{}
	for _, p := range loadPlatforms() {
		valid[p.Key] = true
	}
	if _, _, err := db.Exec(
		"DELETE FROM "+table+" WHERE login_id = ?", id); err != nil {
		return err
	}
	if keys == nil {
		return nil
	}
	list := keys
	if len(list) == 0 {
		list = []string{reportAccessNone}
	}
	cols := make([]string, 0, len(list))
	args := make([]any, 0, len(list)*3)
	for _, k := range list {
		k = strings.TrimSpace(k)
		if k == "" || (k != reportAccessNone && !valid[k]) {
			continue
		}
		cols = append(cols, "(?, ?, ?)")
		args = append(args, id, k, who)
	}
	if len(cols) == 0 {
		return nil
	}
	_, _, err := db.Exec(
		"INSERT IGNORE INTO "+table+" (login_id, report_key, granted_by) VALUES "+
			strings.Join(cols, ", "), args...)
	return err
}

/*
reportsAllowedForClaims is the one question every report path asks: which
reports may THIS session see, or nil for all of them.

One lookup now. The session names its login row, and that row carries the list
both admin screens write.

`scope` selects WHICH grant — scopeVOD for the VOD Reports page, "" (or
anything else) for the original Reports page — the same constant and the same
meaning as the admin picker's dashAccessScope. The two are independent grants
on independent tables (see reportAccessVODTable) precisely so a login can hold
different modules on each; resolving the wrong one here is a data leak between
the two pages, not a cosmetic bug, which is why every caller of this function
must have a scope in hand rather than assuming "Reports".

Both answers are additionally bounded by a categorical backstop, INSIDE this
function rather than left to each caller to remember — vodOnlyPlatformKeys for
the VOD grant, sportsOnlyPlatformKeys for the plain Reports one (the grant a
"Live Events"-relabelled nav entry still resolves to; see mayOpenReport for
why the rename never touches the pageName this keys on). That backstop exists
so a stale or hand-edited grant row naming a platform from the OTHER category
cannot draw that category's data on a page whose whole reason to exist is
that it is the other one. Putting it here means every caller gets it for
free, including the "nil means unrestricted" case — an unrestricted Reports
grant must still mean "every Sports platform", never "every platform, VOD
included", and symmetrically for VOD.
*/
func reportsAllowedForClaims(claims *ipauth.Claims, scope string) map[string]bool {
	if claims == nil {
		return nil
	}
	if scope == scopeVOD {
		return intersectAllowed(reportsAllowedForVOD(claims.LoginID), vodOnlyPlatformKeys())
	}
	return intersectAllowed(reportsAllowedFor(claims.LoginID), sportsOnlyPlatformKeys())
}

/*
intersectAllowed bounds a grant by a backstop it may never exceed.

Pulled out of reportsAllowedForClaims as its own pure function because it is
the one line in this file that IS the safety property — everything else is
plumbing to get two maps to this point — and a property worth stating gets
its own name and its own test rather than living inline where a future edit
could reshape it without anyone noticing what rule they changed.

nil `allowed` (unrestricted) returns the backstop whole, never nil: an
unrestricted VOD grant must still mean "every VOD platform", not "every
platform" — nil propagating through here would silently widen it to Sports.
*/
func intersectAllowed(allowed, backstop map[string]bool) map[string]bool {
	if allowed == nil {
		return backstop
	}
	out := map[string]bool{}
	for k := range allowed {
		if backstop[k] {
			out[k] = true
		}
	}
	return out
}

/*
scopeVOD is the `scope`/`page` value that selects the VOD Reports grant
instead of the Reports one — the only recognised non-default value. Anything
else (including empty) is the original, unscoped behaviour, so an old client
that has never heard of `scope` keeps working exactly as before.
*/
const scopeVOD = "vod"

// dashAccessScope resolves a request's `scope` into the catalogue it should
// offer and the table it should read/write — the one branch point shared by
// both methods below, so GET and POST cannot disagree about what "vod" means.
func dashAccessScope(scope string) (mods []dashModule, allowedFor func(int64) map[string]bool, table string) {
	if scope == scopeVOD {
		return vodDashModules(), reportsAllowedForVOD, reportAccessVODTable
	}
	return sportsDashModules(), reportsAllowedFor, reportAccessTable
}

/*
── GET/POST /api/admin/dashboard-access ──────────────────────────────────────

GET  ?loginId=…&scope=vod  → the catalogue, plus what this account currently holds.
POST { loginId, modules: [ids] | null, scope: "vod" }

`scope` selects which page's grant this reads or writes — omitted or anything
but "vod" means the Reports page, exactly as before scope existed. See
scopeVOD and reportAccessVODTable.

`modules: null` clears the restriction and restores every report, which is the
state every account starts in. An empty list is a different and equally real
answer — "no reports" — and is stored as the sentinel row.
*/
func DashboardAccess(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		loginID := int64(0)
		if v, err := strconv.ParseInt(strings.TrimSpace(r.URL.Query().Get("loginId")), 10, 64); err == nil {
			loginID = v
		}
		if loginID == 0 {
			Fail(w, 422, "loginId is required")
			return
		}

		mods, allowedFor, _ := dashAccessScope(r.URL.Query().Get("scope"))
		out := make([]map[string]any, 0, len(mods))
		for _, m := range mods {
			out = append(out, map[string]any{
				"moduleId": m.ID, "moduleName": m.Name, "category": m.Category,
				/* Carried so the picker can show what each module will actually
				   open, and say so when the answer is nothing. A grant whose
				   modules match no report takes every report away, and that has
				   to be visible while it is being made rather than discovered
				   by the person it was made for. */
				"reportKey": m.PlatformKey, "reportLabel": m.PlatformLabel,
			})
		}

		/* The stored grant, resolved back into the modules that express it —
		   which is what makes this picker agree with the User access tab
		   instead of being a second opinion about the same account. */
		grant := allowedFor(loginID)
		restricted := grant != nil

		var allowed []int64
		if restricted {
			allowed = make([]int64, 0, len(mods))
			for _, m := range mods {
				if m.PlatformKey != "" && grant[m.PlatformKey] {
					allowed = append(allowed, m.ID)
				}
			}
		}

		/* Platforms this picker CANNOT express, because no module in the
		   catalogue resolves to them.

		   They matter because Apply rewrites the whole list: without carrying
		   them, opening the drawer on an account granted Search Engine and
		   pressing Apply would revoke Search Engine, having never shown it.
		   The POST puts them back and the screen names them. */
		expressible := map[string]bool{}
		for _, m := range mods {
			if m.PlatformKey != "" {
				expressible[m.PlatformKey] = true
			}
		}
		unlisted := []string{}
		if restricted {
			for _, p := range loadPlatforms() {
				if p.Enabled && grant[p.Key] && !expressible[p.Key] {
					unlisted = append(unlisted, p.Label)
				}
			}
			sort.Strings(unlisted)
		}

		OK(w, map[string]any{
			"success": true, "modules": out,
			"allowed":    allowed,
			"restricted": restricted,
			"unlisted":   unlisted,
		})

	case http.MethodPost:
		claims := ClaimsFrom(r)
		var body struct {
			LoginID int64    `json:"loginId"`
			Modules *[]int64 `json:"modules"`
			Scope   string   `json:"scope"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if body.LoginID == 0 {
			Fail(w, 422, "loginId is required")
			return
		}

		mods, allowedFor, table := dashAccessScope(body.Scope)

		who := ""
		if claims != nil {
			who = claims.LoginUsername
		}

		if body.Modules == nil {
			// Unrestricted: the ABSENCE of rows is the state, for this company.
			if err := writePlatformGrant(table, body.LoginID, nil, who); err != nil {
				Fail(w, 500, "Could not update report access")
				return
			}
			OK(w, map[string]any{"success": true, "restricted": false})
			return
		}

		/* Modules in, PLATFORMS out — the store speaks platforms, and so does
		   the User access tab writing the same rows. A module that resolves to
		   nothing contributes nothing rather than being stored as itself: it
		   would grant no report, and it would outlive the catalogue row it was
		   named for. */
		byID := map[int64]dashModule{}
		for _, m := range mods {
			byID[m.ID] = m
		}
		wanted := map[string]bool{}
		for _, id := range *body.Modules {
			if m, ok := byID[id]; ok && m.PlatformKey != "" {
				wanted[m.PlatformKey] = true
			}
		}

		/* Platforms no module can express, carried over rather than dropped.

		   Apply rewrites the whole list, and this picker can only speak for the
		   platforms some module resolves to. Without this, opening the drawer
		   on an account granted a platform the catalogue has no module for and
		   pressing Apply would revoke it — a control silently destroying what it
		   never showed. The GET names these so the screen can say they are
		   being kept. */
		expressible := map[string]bool{}
		for _, m := range mods {
			if m.PlatformKey != "" {
				expressible[m.PlatformKey] = true
			}
		}
		for k := range allowedFor(body.LoginID) {
			if k != reportAccessNone && !expressible[k] {
				wanted[k] = true
			}
		}

		keys := make([]string, 0, len(wanted))
		for k := range wanted {
			keys = append(keys, k)
		}
		sort.Strings(keys)

		if err := writePlatformGrant(table, body.LoginID, keys, who); err != nil {
			Fail(w, 500, "Could not save report access")
			return
		}
		OK(w, map[string]any{"success": true, "restricted": true})

	default:
		Fail(w, 405, "Method not allowed")
	}
}
