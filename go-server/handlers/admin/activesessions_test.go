package admin

/*
The active-sessions query must return the fields the table reads.

── The bug this exists to make impossible ────────────────────────────────────

	The panel showed four sessions and nothing in any column. The count was
	right, every cell was blank, and nothing anywhere failed: the query returned
	login_username / last_seen_at / name / role, and the table read full_name /
	username / client / last_activity / ip_address / action_count /
	force_logout_at. Only loginId was in both.

	That is invisible from either side. The Go compiles — the query is a string
	and the rows are map[string]any. The TypeScript compiles — the interface
	describes what the component wants, not what arrives. And the one number on
	the screen that DID work, the session count, comes from the array's length,
	so the panel looked healthy while telling the reader nothing.

	force_logout_at mattered most. The screen derives from it whether a row reads
	Active or Force-logged out, whether it offers Force Logout or Restore Access,
	and the Force-Logged Out tile. Absent, every row read Active with a Force
	Logout button, and that tile could only ever show 0 — a Super Admin could not
	see, or undo, a logout they had just forced.

── Why the test reads two files ──────────────────────────────────────────────

	The contract has one end in Go and one in TypeScript, and neither language
	can see the other. There is no JS test runner in this project, so the check
	sits here and asserts both ends agree: every field the ActiveSession
	interface declares is aliased by the SQL.

	Reading source is a weak assertion and it is the strongest one available
	across this boundary — the same trade already made by TestCacheSaveArgCount.
*/

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

const superAdminClientTS = "../../../components/admin/SuperAdminClient.tsx"

func TestActiveSessionsReturnsEveryFieldTheTableReads(t *testing.T) {
	ts, err := os.ReadFile(superAdminClientTS)
	if err != nil {
		t.Skipf("cannot read %s: %v", superAdminClientTS, err)
	}

	// The interface the component binds its columns to.
	block := string(ts)
	start := strings.Index(block, "interface ActiveSession {")
	if start < 0 {
		t.Fatal("could not find interface ActiveSession — this test needs updating")
	}
	end := strings.Index(block[start:], "}")
	if end < 0 {
		t.Fatal("could not find the end of interface ActiveSession")
	}
	fields := regexp.MustCompile(`(?m)^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:`).
		FindAllStringSubmatch(block[start:start+end], -1)
	if len(fields) == 0 {
		t.Fatal("parsed no fields out of interface ActiveSession")
	}

	// The query that feeds it.
	goSrc, err := os.ReadFile("superadmin.go")
	if err != nil {
		t.Fatalf("read superadmin.go: %v", err)
	}
	qStart := strings.Index(string(goSrc), "func ActiveSessions(")
	if qStart < 0 {
		t.Fatal("could not find func ActiveSessions")
	}
	body := string(goSrc)[qStart:]
	if next := strings.Index(body[len("func ActiveSessions("):], "\nfunc "); next >= 0 {
		body = body[:len("func ActiveSessions(")+next]
	}

	var missing []string
	for _, f := range fields {
		name := f[1]
		/* Either aliased explicitly (AS name) or selected as a bare column of
		   that name — l.force_logout_at needs no alias, because MySQL already
		   returns it under exactly that key. */
		if strings.Contains(body, "AS "+name) ||
			strings.Contains(body, "."+name+",") ||
			strings.Contains(body, "."+name+"\n") {
			continue
		}
		missing = append(missing, name)
	}

	if len(missing) > 0 {
		t.Errorf("the query does not return %v.\n"+
			"The Active Sessions table binds those columns, so each one renders "+
			"blank while the session COUNT still looks correct — the failure this "+
			"whole file is about. Alias them in the SELECT, or drop them from "+
			"interface ActiveSession if the data genuinely does not exist.",
			missing)
	}
	t.Logf("checked %d field(s) declared by interface ActiveSession", len(fields))
}

/*
The activity log is keyed by LOGIN id, not user id, whatever its column is
called: activity.Log is invoked with claims.LoginID throughout. Joining it on
l.userId instead would attribute one person's requests to another — and on this
database eleven login rows carry no userId at all, so those sessions would show
a count belonging to whoever happens to hold userId 0.
*/
func TestActivityLogIsJoinedOnLoginID(t *testing.T) {
	goSrc, err := os.ReadFile("superadmin.go")
	if err != nil {
		t.Fatalf("read superadmin.go: %v", err)
	}
	src := string(goSrc)
	qStart := strings.Index(src, "func ActiveSessions(")
	if qStart < 0 {
		t.Fatal("could not find func ActiveSessions")
	}
	body := src[qStart:]
	if next := strings.Index(body[20:], "\nfunc "); next >= 0 {
		body = body[:20+next]
	}

	if !strings.Contains(body, "user_activity_log") {
		t.Skip("the query no longer reads the activity log")
	}
	if strings.Contains(body, "a.user_id = l.userId") {
		t.Error("user_activity_log is joined on l.userId. Its user_id column holds a " +
			"LOGIN id — activity.Log is called with claims.LoginID — so this " +
			"attributes requests to the wrong person, and to userId 0 for every " +
			"login row that has no user.")
	}
	if !strings.Contains(body, "a.user_id = l.loginId") {
		t.Error("expected user_activity_log to be joined on l.loginId")
	}
}
