package handlers

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

/*
The gate's page names must be the nav's page names.

They are a JOIN KEY into module_permission.pageName, shared with NAV_ITEMS in
lib/navItems.tsx, and nothing at compile time connects the two: a Go constant
that drifts from the TypeScript one is not an error, it is a module the API
refuses to everybody while the nav goes on offering it. The capitalisation is
already inconsistent across the set ("DownloadRequest" but "data-sharing"), which
is exactly the shape of thing a person retypes wrong.

Read from the real file rather than mirrored into a fixture, because a mirror is
one more copy to drift.
*/
func TestModulePageNamesMatchTheNav(t *testing.T) {
	src, err := os.ReadFile("../../lib/navItems.tsx")
	if err != nil {
		t.Skipf("nav source not readable from here: %v", err)
	}

	navPages := map[string]bool{}
	for _, m := range regexp.MustCompile(`pageName:\s*'([^']+)'`).FindAllStringSubmatch(string(src), -1) {
		navPages[m[1]] = true
	}
	if len(navPages) == 0 {
		t.Fatal("no pageName values found — the nav file's shape changed and this test is now blind")
	}

	for _, page := range []string{
		PageQC, PageUploadURL, PageSearchCases, PageIPTracking, PageDownload, PageDataSharing,
	} {
		if !navPages[page] {
			t.Errorf("pageName %q is gated on the server but is not a pageName in "+
				"lib/navItems.tsx — the API would refuse a module the nav still offers", page)
		}
	}
}

/*
Every client route that belongs to a module must go through the gate.

The hole this closes was not a wrong check, it was a MISSING one: the endpoints
were `auth(...)` and nothing else, so the only thing standing between a login and
another module's data was a React component deciding not to render. Adding the
next endpoint with a plain `auth(...)` puts it straight back, and nothing else
would notice.

Asserted against the route table's text because that is where the mistake is
made. The pairing is checked too, not just the presence of `mod(` — an endpoint
gated on the wrong module is a subtler version of the same bug.
*/
func TestClientModuleRoutesAreGated(t *testing.T) {
	src, err := os.ReadFile("../main.go")
	if err != nil {
		t.Fatalf("cannot read the route table: %v", err)
	}
	routes := string(src)

	for _, c := range []struct{ path, page string }{
		{"POST /api/infringement", "PageSearchCases"},
		{"POST /api/infringement/category", "PageSearchCases"},
		{"POST /api/search", "PageSearchCases"},
		{"POST /api/enforce", "PageSearchCases"},
		{"GET /api/download", "PageDownload"},
		{"POST /api/download", "PageDownload"},
		{"GET /api/download/{id}", "PageDownload"},
		{"GET /api/upload-url", "PageUploadURL"},
		{"POST /api/upload-url", "PageUploadURL"},
		{"POST /api/qc-urls", "PageQC"},
		{"POST /api/qc-enforce", "PageQC"},
		{"POST /api/pending-count", "PageQC"},
		{"POST /api/ip-tracking", "PageIPTracking"},
		{"GET /api/ip-tracking/client-details", "PageIPTracking"},
		{"POST /api/data-sharing/upload", "PageDataSharing"},
		{"GET /api/data-sharing/history", "PageDataSharing"},
	} {
		line := routeLine(routes, c.path)
		if line == "" {
			t.Errorf("route %q is no longer registered — if it moved, move its gate with it", c.path)
			continue
		}
		if !strings.Contains(line, "mod(handlers."+c.page+",") {
			t.Errorf("route %q is not gated on %s:\n  %s", c.path, c.page, strings.TrimSpace(line))
		}
	}
}

/*
And the three modules that gate themselves must keep doing so.

Reports, Dashboard and War Room are checked inside their handlers rather than by
the wrapper — they needed more than a yes/no. That is fine and deliberate, but it
means the route table shows `auth(...)` for them, which reads exactly like the
bug. This says so, so nobody "fixes" the inconsistency by deleting the handler
check or double-gates a route on the wrong module.
*/
func TestSelfGatedRoutesStillCheckTheirOwnGrant(t *testing.T) {
	for _, c := range []struct{ file, fn string }{
		{"warroom.go", "warRoomAllowed(claims)"},
		{"reportsrun.go", "mayOpenReports(claims)"},
		{"misc.go", "mayOpenDashboard(claims)"},
	} {
		src, err := os.ReadFile(c.file)
		if err != nil {
			t.Errorf("cannot read %s: %v", c.file, err)
			continue
		}
		if !strings.Contains(string(src), c.fn) {
			t.Errorf("%s no longer calls %s — that module's endpoints are now "+
				"open to any signed-in login", c.file, c.fn)
		}
	}
}

// routeLine returns the mux.Handle line registering `path`, or "".
func routeLine(src, path string) string {
	for _, line := range strings.Split(src, "\n") {
		if strings.Contains(line, "mux.Handle(\""+path+"\"") {
			return line
		}
	}
	return ""
}
