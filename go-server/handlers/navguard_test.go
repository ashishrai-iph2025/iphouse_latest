package handlers

import (
	"os"
	"strings"
	"testing"
)

/*
An expired session must never be reported as a missing permission.

── The bug ──────────────────────────────────────────────────────────────────

/api/user/nav answers 401 {"success":false,"error":"Not authenticated"} whenever
the session is not accepted. ClientModuleGuard folded that into its grant
refusal, so a reader whose session had just expired was shown:

	Access Restricted
	You don't have permission to access the VOD Reports module.
	Please contact the IP House team to request access.

It reproduced by signing out and back in on the same page: the check fires while
the new session is still being established, the 401 lands, and the card is what
the reader sees.

Both halves of that are wrong and the second is worse than the first. The remedy
it prints sends someone to ask for access they already hold, and sends whoever
fields the request hunting a permissions bug that does not exist. AccessDenied's
own header already names this failure mode — "Two DIFFERENT failures used to
wear the same face" — which is what makes it worth pinning.

── Why a source test ────────────────────────────────────────────────────────

Reproducing it needs a browser, an expiring session and a re-login race. The
defect is one branch mapping an HTTP status to the wrong verdict, and that is
visible here.
*/
func TestExpiredSessionIsNotReportedAsAMissingPermission(t *testing.T) {
	src, err := os.ReadFile("../../src/App.tsx")
	if err != nil {
		t.Skipf("App.tsx not readable from here: %v", err)
	}
	body := string(src)

	i := strings.Index(body, "/api/user/nav")
	if i < 0 {
		t.Fatal("ClientModuleGuard no longer fetches /api/user/nav")
	}
	// The handling of that response: from the fetch to the end of its chain.
	seg := body[i:]
	if e := strings.Index(seg, "}, [pathname"); e > 0 {
		seg = seg[:e]
	}
	/* CODE ONLY. The first version of this asserted against the raw text and
	   passed happily when the branch was deleted, because the prose above it
	   still said "401" — a test that reads its own explanation and calls it
	   evidence. */
	seg = stripJSComments(seg)

	/*
		The status has to be looked at, in an executable branch. Reading only the
		JSON body cannot tell a 401 from a 200 carrying success:false, and those
		are different answers.
	*/
	if !strings.Contains(seg, "401") {
		t.Error("no branch on 401 in the nav handling — an expired session has no case " +
			"of its own and falls into whichever verdict is written below it, which " +
			"is the grant refusal")
	}
	if !strings.Contains(seg, "'auth'") {
		t.Error("the nav handling never settles on 'auth', so an expired session is " +
			"reported as something it is not")
	}

	/*
		And 'grant' must be reachable ONLY from the allow-list check — the one
		thing entitled to say "you do not have permission". Any other path
		settling on 'grant' reports a failure to get an answer as a refusal.
	*/
	/* EXACTLY ONE, and it must be the allow-list verdict itself. A second is a
	   path that failed to get an answer and reported a refusal; none means the
	   verdict has moved somewhere this test is no longer reading. */
	if n := strings.Count(seg, "reason: 'grant'"); n != 1 {
		t.Errorf("%d branches in the nav handling settle on 'grant', want exactly 1 — "+
			"the allowedPages check. Any other is a failure to get an answer being "+
			"reported as \"you do not have permission\"", n)
	}
	if !strings.Contains(seg,
		"settle({ allowed: allowedPages.includes(item.pageName), label: item.label, reason: 'grant' })") {
		t.Error("the single 'grant' verdict is not the allow-list check — either it " +
			"moved, or something else is now entitled to refuse the reader")
	}
}

/*
stripJSComments removes // and block comments so an assertion cannot be
satisfied by prose. Not a parser: it does not know about comment markers inside
string literals, which is fine for what it is used on here and would only ever
make an assertion stricter, never looser.
*/
func stripJSComments(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); {
		if i+1 < len(s) && s[i] == '/' && s[i+1] == '*' {
			if e := strings.Index(s[i+2:], "*/"); e >= 0 {
				i += 2 + e + 2
				continue
			}
			break
		}
		if i+1 < len(s) && s[i] == '/' && s[i+1] == '/' {
			if e := strings.IndexByte(s[i:], '\n'); e >= 0 {
				i += e
				continue
			}
			break
		}
		b.WriteByte(s[i])
		i++
	}
	return b.String()
}

/*
A 401 sends the reader to sign in, carrying the page they were on.

Drawing any card for an expired session is wrong — there is nothing to report,
because nothing was checked. Redirecting completes the thing the reader was
already doing, and carrying the path is what makes signing in return them here
instead of to the dashboard.
*/
func TestExpiredSessionRedirectsBackToTheSamePage(t *testing.T) {
	src, err := os.ReadFile("../../src/App.tsx")
	if err != nil {
		t.Skipf("App.tsx not readable: %v", err)
	}
	body := string(src)

	g := strings.Index(body, "function ClientModuleGuard")
	if g < 0 {
		t.Fatal("ClientModuleGuard is gone")
	}
	seg := body[g:]
	if e := strings.Index(seg, "\nfunction "); e > 0 {
		seg = seg[:e]
	}

	if !strings.Contains(seg, "reason === 'auth'") {
		t.Error("ClientModuleGuard does not act on the 'auth' answer, so an expired " +
			"session still renders a card instead of a sign-in redirect")
	}
	if !strings.Contains(seg, "loginRedirectTarget(pathname") {
		t.Error("the redirect does not carry the current path — signing in would land " +
			"the reader somewhere other than the page they were trying to open")
	}
	/* Before the card, or it never runs: the generic !state.allowed branch
	   below would draw AccessDenied first. */
	auth := strings.Index(seg, "reason === 'auth'")
	card := strings.Index(seg, "<AccessDenied")
	if auth > 0 && card > 0 && auth > card {
		t.Error("the 'auth' redirect is written AFTER the AccessDenied branch, so the " +
			"card wins and the redirect is dead code")
	}
}
