package handlers

/*
Reports must not be gated on the Markscan token, because Reports never uses it.

── What went wrong ───────────────────────────────────────────────────────────

	`apiAccess` is one specific thing: whether the portal holds a Markscan bearer
	token for this login. ClientModuleGuard blocks every module that is not on
	lib/navItems.tsx's API_INDEPENDENT_PAGES when that token is missing, and
	Reports was not on it.

	So a client whose login holds no Markscan credentials was shown "Reporting
	service unavailable" for reports served entirely by reports_api and the
	warehouse. The named service was up the whole time.

	It bites hardest on an admin "view as client" session, which is where it was
	found. Impersonation swaps the session to the client's own userId, so the
	token is resolved from THAT client's stored credentials — an admin with a
	perfectly good token loses it the moment they step into a client portal, and
	the screen blames the reporting service and tells them to wait.

── Why this test reads two kinds of file ─────────────────────────────────────

	The exemption lives in TypeScript and the justification lives in Go, and
	neither language can see the other. There is no JS test runner in this
	project, so the check has to sit somewhere — and here it can assert BOTH
	halves of the invariant at once:

	  · Reports is exempt from the token gate, and
	  · Reports still deserves to be, because no report handler asks for a token.

	Either half failing on its own is a bug. If someone removes the exemption,
	the first fails. If Reports ever genuinely starts needing Markscan, the
	second fails and the exemption has to be reconsidered rather than silently
	becoming wrong.

	Reading source is a weak form of assertion and it is the strongest one
	available across this boundary — the same trade already made by
	TestCacheSaveArgCount and TestTheWarmPathClampsBeforeKeying.
*/

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const navItemsPath = "../../lib/navItems.tsx"

// The token resolvers. A handler calling either needs Markscan.
var markscanTokenCalls = []string{"ResolveAPIToken", "TokenForUser"}

func TestReportsIsExemptFromTheMarkscanGate(t *testing.T) {
	src, err := os.ReadFile(navItemsPath)
	if err != nil {
		t.Skipf("cannot read %s: %v", navItemsPath, err)
	}
	text := string(src)

	start := strings.Index(text, "API_INDEPENDENT_PAGES = [")
	if start < 0 {
		t.Fatal("could not find API_INDEPENDENT_PAGES — this test needs updating")
	}
	end := strings.Index(text[start:], "]")
	if end < 0 {
		t.Fatal("could not find the end of API_INDEPENDENT_PAGES")
	}
	list := text[start : start+end]

	/* 'Reports' is the pageName, and it is case-sensitive: isApiIndependentItem
	   does an exact includes() against item.pageName, which navItems.tsx spells
	   with a capital R. A lowercase entry would read as correct and gate the
	   page anyway. */
	if !strings.Contains(list, "'Reports'") && !strings.Contains(list, `"Reports"`) {
		t.Errorf("Reports is not in API_INDEPENDENT_PAGES.\n"+
			"It is served entirely by reports_api and the warehouse and needs no "+
			"Markscan token, so gating it on one shows a client "+
			"\"Reporting service unavailable\" for a service that is up — worst on an "+
			"admin view-as-client session, where the token comes from the CLIENT's "+
			"credentials.\nThe list currently reads: %s]", list[strings.Index(list, "["):])
	}
}

// The other half: the exemption is only correct while this stays true.
func TestNoReportHandlerNeedsTheMarkscanToken(t *testing.T) {
	files, err := filepath.Glob("report*.go")
	if err != nil {
		t.Fatalf("glob: %v", err)
	}
	if len(files) == 0 {
		t.Fatal("no report handler files found — this test needs updating")
	}

	checked := 0
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		b, err := os.ReadFile(f)
		if err != nil {
			t.Errorf("read %s: %v", f, err)
			continue
		}
		checked++
		for _, call := range markscanTokenCalls {
			if strings.Contains(string(b), call) {
				t.Errorf("%s calls %s.\n"+
					"Reports is exempt from the Markscan token gate on the grounds that "+
					"it never needs a token (see API_INDEPENDENT_PAGES in "+
					"lib/navItems.tsx). If that is no longer true, the exemption is now "+
					"wrong and a client with no Markscan credentials will reach this "+
					"page and be served empty data instead of being told why.", f, call)
			}
		}
	}
	t.Logf("checked %d report handler file(s)", checked)
}
