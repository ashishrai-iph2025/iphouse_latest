package admin

// Module grants are keyed by loginId, and a shared login has one row per
// company. Everything below protects that one fact from being flattened.
//
// The account editor on /admin/registrations now sets these grants too, which
// means the id it writes against has to be the RIGHT row — the company the
// admin chose, not whichever row the grouped list happened to report. The
// checks are split between the arithmetic (testable outright) and the SQL that
// carries the pairs (read from source, the way TestCacheSaveArgCount is,
// because the alternative needs a database and the thing worth protecting is
// structural).

import (
	"strings"
	"testing"
)

/*
The bind markers must match the argument count exactly.

database/sql only compares them when the statement runs, so an off-by-one here
passes the compiler, vet and every test that does not reach a database, then
fails as "expected 3 arguments, got 4" on somebody's screen.
*/
func TestInPlaceholdersMatchesTheArgumentCount(t *testing.T) {
	for _, tc := range []struct {
		n    int
		want string
	}{
		{0, ""}, {1, "?"}, {2, "?,?"}, {5, "?,?,?,?,?"},
	} {
		if got := inPlaceholders(tc.n); got != tc.want {
			t.Errorf("inPlaceholders(%d) = %q, want %q", tc.n, got, tc.want)
		}
	}
	// A negative count is nonsense rather than an error, and must not produce a
	// clause with a stray comma in it.
	if got := inPlaceholders(-1); got != "" {
		t.Errorf("inPlaceholders(-1) = %q, want empty", got)
	}
	for n := 1; n <= 12; n++ {
		if c := strings.Count(inPlaceholders(n), "?"); c != n {
			t.Errorf("inPlaceholders(%d) holds %d markers", n, c)
		}
	}
}

/*
The lookup must bind the ids, never paste them.

It is the only query in this file assembled from a variable-length list, which
makes it the one place a `fmt.Sprintf` of the raw query string would look
natural — and the raw string is caller-supplied.
*/
func TestLoginIDsLookupBindsItsIDs(t *testing.T) {
	src := readSource(t, "modules.go")

	start := strings.Index(src, "FROM user_module_permission_test\"+")
	if start < 0 {
		t.Fatal("could not find the multi-login grant lookup")
	}
	stmt := src[start : start+240]
	if !strings.Contains(stmt, "inPlaceholders(len(ids))") {
		t.Errorf("the IN clause is no longer built from bind markers:\n%s", stmt)
	}
	if !strings.Contains(stmt, "ids...") {
		t.Errorf("the ids are no longer passed as arguments:\n%s", stmt)
	}
	// `raw` is the untouched query-string value. It is parsed into ints and
	// must never reach the statement.
	if strings.Contains(stmt, "raw") {
		t.Errorf("the raw query parameter reached the SQL:\n%s", stmt)
	}
}

/*
The registrations list must carry the company↔login PAIRS.

Its `loginId` column is MAX() over a person's rows — one arbitrary company —
and its `allUserIds` names companies without saying which row belongs to each.
Neither can key a grant. `assignments` is what the account editor's access
panel targets, so if it is dropped from this query the panel silently loses
every company and the drawer reads as "no company assigned yet".
*/
func TestSharedLoginsCarriesCompanyLoginPairs(t *testing.T) {
	src := readSource(t, "settings.go")

	if !strings.Contains(src, "AS assignments") {
		t.Fatal("the shared-logins query no longer selects assignments — " +
			"the account editor's module access panel has nothing to target")
	}
	// Inside a GROUP_CONCAT, because the query groups by login_username: a bare
	// CONCAT would return one arbitrary row's pair and look entirely plausible.
	i := strings.Index(src, "AS assignments")
	line := src[max0(i-160):i]
	if !strings.Contains(line, "GROUP_CONCAT") {
		t.Errorf("assignments is not aggregated over the group:\n%s", line)
	}
	if !strings.Contains(line, "ul.loginId") || !strings.Contains(line, "ul.userId") {
		t.Errorf("assignments no longer pairs a company with its login row:\n%s", line)
	}
	/* A login row with no company yet — the placeholder a registration approval
	   leaves behind — must still appear. CONCAT returns NULL for a NULL userId
	   and GROUP_CONCAT drops NULLs, so without the IFNULL that login vanishes
	   from the panel entirely rather than being told it has no company. */
	if !strings.Contains(line, "IFNULL(ul.userId") {
		t.Errorf("a login with no company assigned would be dropped from the pairs:\n%s", line)
	}
}

func max0(n int) int {
	if n < 0 {
		return 0
	}
	return n
}
