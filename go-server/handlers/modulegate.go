package handlers

/*
Module authorization for the CLIENT endpoints, on the server.

WHY THIS EXISTS

Client pages were gated in one place only: ClientModuleGuard in src/App.tsx,
which asks /api/user/nav and refuses to render the page. That is a rendering
decision, not an access control — it runs in the browser, it can be skipped by
calling the endpoint directly, and it fails open on a network error by design.
So a login granted Calendar and Reports could still read Download Request's
history, Infringements Approval's queue and IP Tracking's details by asking
their endpoints for them.

The same hole was found and closed on the ADMIN side already — see the `cfg`
wrapper in main.go, whose comment says it plainly: "Previously these grants were
enforced only by hiding cards on /admin/configuration, so any role>=1 login could
call the endpoint directly." This is that fix, for the client routes.

Three modules already had a gate of their own and keep it: Reports
(mayOpenReports), Dashboard (mayOpenDashboard) and War Room (warRoomAllowed).
They are per-handler because each needed more than a yes/no — a client mapping, a
role rule — and rewriting them here would be churn against working code. What
they proved is the rule this file generalises, in mayOpenReports' own words:
"Hiding a nav item is not access control."

WHY IT KEYS ON THE NAV'S OWN ANSWER

A gate that re-derives "is this granted" from its own SQL drifts from the nav
that shows it, and the drift is invisible until someone is wrongly refused. The
seeded Dashboard module is the standing example: ModuleName "Dashboard" with
pageName "DashboardAccess", a spelling the nav does not use — anything matching
on it naively gets the wrong answer.

So this asks the same function the nav does. grantedPageNames runs UserNav's
query and UserNav's navEntries, and reads the pageNames off the result. The
guarantee that buys is exact and worth stating: IF THE NAV SHOWS IT, THE API
ALLOWS IT, AND IF THE NAV DOES NOT, THE API REFUSES. There is no third answer to
get wrong.

WHAT IT DELIBERATELY DOES NOT GATE

  - Utility endpoints every signed-in user needs whatever their modules:
    /api/auth/*, /api/user/*, /api/notifications*, /api/token, /api/keepalive,
    /api/geo/country, /api/profile/*, /api/master-data.
  - /api/master-data in particular: it is the shared asset/language/country
    lookup behind the filter rails of several modules, and gating it on any one
    of them would empty the dropdowns of the others.
  - Client Admin (/api/client-admin/*), whose grant is PER PERSON
    (dcp_user_login.is_client_admin) rather than per company — see
    CLIENT_ADMIN_NAV_ITEM in lib/navItems.tsx. It is checked inside its handlers.
*/

import (
	"log"
	"net/http"
	"strings"

	ipauth "github.com/ip-house/iphouse-api/auth"
	"github.com/ip-house/iphouse-api/db"
)

/*
The module identifiers the client routes gate on.

Named constants rather than literals at the call sites, because these strings
are a JOIN KEY into module_permission.pageName and they must match
lib/navItems.tsx exactly — including its capitalisation, which is not
consistent ("DownloadRequest" but "data-sharing") because it grew that way. A
typo here is not a compile error; it is a module nobody can reach.

Kept in nav order, so this list reads against NAV_ITEMS side by side.
*/
// Exported because main.go names them in the route table — the point of the
// wrapper is that the gate is readable there, beside the path it protects.
const (
	PageQC          = "PerformQC"         // Infringements Approval
	PageUploadURL   = "UploadURL"         // Submit URLs for Take-down
	PageSearchCases = "SearchCaseList"    // Search Case List
	PageIPTracking  = "IPTrackingDetails" // IP Tracking Details
	PageDownload    = "DownloadRequest"   // Download Request
	PageDataSharing = "data-sharing"      // Data Sharing
)

/*
grantedModuleRows is the one query behind both the nav and this gate.

Shared rather than copied, so "the API allows exactly what the nav shows" is a
property of the code rather than of two SQL strings staying in step. Ordered
because UserNav renders these in order; the gate reads them as a set and does
not care.
*/
func grantedModuleRows(loginID int64) ([]map[string]any, error) {
	return db.Query(`
		SELECT m.Id AS moduleId, m.ModuleName, m.pageName, m.nav_order AS navOrder
		  FROM user_module_permission_test u
		  JOIN module_permission m ON m.Id = u.moduleId
		 WHERE u.loginId = ? AND u.allowed = 1 AND m.status = 0
		 ORDER BY m.nav_order ASC, m.Id ASC`, loginID)
}

/*
grantedPageNames is the set of module pageNames this login may open.

Lower-cased on the way in so the lookup cannot fail on capitalisation alone —
the constants above have to match navItems.tsx, but a DB row differing only in
case should not lock someone out of a module they hold.

An error reading the grants returns nil and a false ok, and the CALLER decides
what that means. It is not silently an empty set: "we could not read your
permissions" and "you have none" are different facts, and conflating them turns
a database blip into every user losing every module at once.
*/
func grantedPageNames(claims *ipauth.Claims) (map[string]bool, bool) {
	if claims == nil {
		return nil, false
	}
	rows, err := grantedModuleRows(claims.LoginID)
	if err != nil {
		log.Printf("[module-gate] cannot read grants for loginId=%d: %v", claims.LoginID, err)
		return nil, false
	}

	// Exactly what UserNav does with the same rows — see the file comment.
	granted := make([]string, 0, len(rows))
	byName := make(map[string]map[string]any, len(rows))
	for _, row := range rows {
		name := strFromAny(row["ModuleName"])
		if name == "" {
			continue
		}
		granted = append(granted, name)
		byName[strings.ToLower(name)] = row
	}

	out := map[string]bool{}
	for _, e := range navEntries(granted, byName, nil) {
		if p := strFromAny(e["pageName"]); p != "" {
			out[strings.ToLower(p)] = true
		}
	}
	return out, true
}

/*
hasModuleGrant answers the gate's question for one page.

Staff pass. They administer these modules from /admin and reach the client
screens through "view as client" — and impersonation is NOT a loophole here:
Impersonate rewrites the session as the client, role 0 and the client's own
loginId (see handlers/impersonate.go), so an admin viewing a client is held to
that client's grants exactly like the client is. That is the behaviour to keep;
it is what makes "view as client" show the client's portal rather than a
privileged version of it.
*/
func hasModuleGrant(claims *ipauth.Claims, pageName string) bool {
	if isStaff(claims) {
		return true
	}
	pages, ok := grantedPageNames(claims)
	if !ok {
		return false // fail CLOSED — see grantedPageNames
	}
	return pages[strings.ToLower(pageName)]
}

/*
RequireModule wraps a client handler behind one module grant.

Mirrors admin.RequireConfigModule so both sides of the portal read alike, and
sits OUTSIDE the handler rather than inside it so the gate is visible in the
route table — where someone adding the next endpoint will see that its
neighbours have one.

The refusal names the module. It is a 403 to a signed-in user who asked for
something real, not a probe to be starved of information: telling them which
module to ask their administrator for is the difference between a page they can
get access to and a page that appears broken.
*/
func RequireModule(pageName string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims := ClaimsFrom(r)
		if claims == nil {
			Fail(w, 401, "Not authenticated")
			return
		}
		if !hasModuleGrant(claims, pageName) {
			log.Printf("[module-gate] refused loginId=%d user=%q %s %s — no %q grant",
				claims.LoginID, claims.LoginUsername, r.Method, r.URL.Path, pageName)
			Fail(w, 403, "Your account does not have access to this module ("+pageName+
				"). Ask your administrator to grant it.")
			return
		}
		next(w, r)
	}
}
