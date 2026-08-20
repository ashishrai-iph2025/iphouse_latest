package admin

// The client-account screens must not list IP House's own accounts.
//
// Users, Registrations, Module Permissions and Client Admins all administer
// CLIENT logins. Staff are rows in dcp_user_login like anyone else, so without
// a filter they appear in tables whose every action is about a client's — which
// is how a colleague's account gets edited by mistake.
//
// Checked against the SOURCE, the way TestCacheSaveArgCount is, because the
// alternative needs a database and the thing worth protecting is structural: a
// fifth listing added later, or a WHERE rewritten without the filter, should
// fail here rather than on the screen.

import (
	"os"
	"strings"
	"testing"
)

/*
The filters have to READ as fragments of the clauses they are appended to.

`staffFilter` extends a WHERE, so it starts with AND; `staffFilterHaving` opens
its own clause after GROUP BY. Getting either prefix wrong produces SQL that
fails at query time — on a page, in front of somebody — rather than here.
*/
func TestStaffFilterFragmentsAreWellFormed(t *testing.T) {
	if !strings.HasPrefix(staffFilter, " AND ") {
		t.Errorf("staffFilter must extend a WHERE clause, got %q", staffFilter)
	}
	if !strings.HasPrefix(staffFilterHaving, " HAVING ") {
		t.Errorf("staffFilterHaving must open its own clause, got %q", staffFilterHaving)
	}
	// Both encode the same rule: effective role 0, where 1 is Admin and 2 is
	// Super Admin. If roleSelect's mapping ever changes, these must follow.
	for name, frag := range map[string]string{
		"staffFilter":       staffFilter,
		"staffFilterHaving": staffFilterHaving,
	} {
		for _, want := range []string{"SuperAdmin", "Admin", "= 0"} {
			if !strings.Contains(frag, want) {
				t.Errorf("%s does not mention %q — it no longer matches roleSelect", name, want)
			}
		}
	}
	if !strings.Contains(roleSelect, "SuperAdmin") || !strings.Contains(roleSelect, "Admin") {
		t.Error("roleSelect no longer maps the staff roles the filters assume")
	}
}

/*
Every client-account listing applies it.

Named by file and by the query each screen loads, so a failure says which page
started showing staff rather than only that something did.
*/
func TestClientAccountListingsHideStaff(t *testing.T) {
	for _, tc := range []struct{ page, file, marker string }{
		{"/admin/users", "users.go", "FROM dcp_user_login l INNER JOIN dcp_user u ON u.userId = l.userId"},
		{"/admin/client-admins", "clientadmins.go", "FROM dcp_user_login l"},
		{"/admin/module-permissions", "modules.go", "SELECT u.userId, l.loginId, u.name AS clientName"},
	} {
		src, err := os.ReadFile(tc.file)
		if err != nil {
			t.Fatalf("read %s: %v", tc.file, err)
		}
		body := string(src)
		if !strings.Contains(body, tc.marker) {
			t.Fatalf("%s: the listing query moved — this test is checking the wrong thing", tc.file)
		}
		if !strings.Contains(body, "staffFilter") {
			t.Errorf("%s (%s) does not apply staffFilter — that page lists staff accounts", tc.file, tc.page)
		}
	}

	// Registrations groups by login, so it takes the HAVING form. A WHERE there
	// would drop the staff ROWS while leaving the login itself, rebuilt from
	// whichever companies happened not to match — a subtly wrong row rather
	// than an absent one.
	src, err := os.ReadFile("settings.go")
	if err != nil {
		t.Fatalf("read settings.go: %v", err)
	}
	body := string(src)
	if !strings.Contains(body, "GROUP BY ul.login_username") {
		t.Fatal("settings.go: the shared-logins query moved — this test is checking the wrong thing")
	}
	if !strings.Contains(body, "staffFilterHaving") {
		t.Error("settings.go (/admin/registrations) does not apply staffFilterHaving — that page lists staff logins")
	}
}

/*
staffFilter reads sa.role, so any query using it must join dcp_super_admin.

Without the join the statement fails outright, which is the loud failure — but
it fails on a page rather than here, so the pairing is worth asserting.
*/
func TestStaffFilterAlwaysHasItsJoin(t *testing.T) {
	for _, file := range []string{"users.go", "clientadmins.go", "modules.go"} {
		src, err := os.ReadFile(file)
		if err != nil {
			t.Fatalf("read %s: %v", file, err)
		}
		body := string(src)
		if strings.Contains(body, "staffFilter") && !strings.Contains(body, "roleJoin") {
			t.Errorf("%s uses staffFilter without roleJoin — sa.role is not in scope", file)
		}
	}
}
