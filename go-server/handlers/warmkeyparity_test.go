package handlers

/*
A warmed sports report and the same report a reader opens must land on ONE cache
key.

The two paths reach cachedPlatformReport from different directions:

	read   /reports/data clamps the requested window into the configured sports
	       period and only then builds the key — see reports.go.
	warm   the background pass hands in a window straight from its own list.

The warm path did not clamp. So a pass covering "the last 90 days" against a
platform whose period starts inside that range wrote an entry keyed by ninety raw
days, while every reader of that report was keyed by the clamped window. The keys
could not meet.

That is worse than a plain miss, and it is why this has a test rather than a
comment. The pass still spent the warehouse time — eighteen aggregates per
report, per client, per pass — and produced entries nothing could ever read. The
warmer reported success, the admin table filled with rows, the hit rate stayed at
zero, and every reader still paid full price. Nothing in that picture points at
the cause.

These go through reportcache.Key directly. It is the pure function both paths
end up in, so the invariant can be pinned without a warehouse, a Redis or a
platform registry.
*/

import (
	"os"
	"strings"
	"testing"

	"github.com/ip-house/iphouse-api/reportcache"
)

const parityClient = "11111111-2222-3333-4444-555555555555"

// keyFor is the key a scope produces, clamped or not, as the caller chooses.
func keyFor(t *testing.T, from, to string, clamp bool) string {
	t.Helper()
	q := map[string]string{"clientId": parityClient, "from": from, "to": to}
	if clamp {
		clampToSportsPeriod(q, aPeriod())
	}
	k, ok := reportcache.Key("sports", parityClient, "shape-abc", q)
	if !ok {
		t.Fatal("this scope should be cacheable")
	}
	return k
}

/*
The bug, stated as the thing that must not be true: a window that STICKS OUT of
the period keys differently depending on whether it was clamped first.

perStart is 2025-01-01, so a window opening in 2024 is outside it.
*/
func TestAnUnclampedWindowKeysDifferently(t *testing.T) {
	const from, to = "2024-11-01", "2025-02-15"

	raw := keyFor(t, from, to, false)
	clamped := keyFor(t, from, to, true)

	if raw == clamped {
		t.Fatal("the clamp did not change the key, so this window does not " +
			"exercise the mismatch — pick one that falls outside the period")
	}
	// Both paths clamping is what makes them agree. This is the fix.
	if keyFor(t, from, to, true) != clamped {
		t.Fatal("clamping is not deterministic")
	}
}

/*
And the fix, stated as the invariant: once BOTH paths clamp, the key is the same
whichever direction it was reached from.

The warm path is modelled as the pass does it — a raw window from the window
list — and the read path as the endpoint does it, having already clamped. If
warmOne ever stops clamping, these diverge again.
*/
func TestWarmAndReadAgreeOnceBothClamp(t *testing.T) {
	cases := []struct{ name, from, to string }{
		{"opens before the period", "2024-11-01", "2025-02-15"},
		{"ends after the period", "2025-03-01", "2025-06-30"},
		{"straddles the whole period", "2024-06-01", "2025-12-31"},
		{"entirely before the period", "2024-01-01", "2024-06-30"},
		{"already inside", "2025-02-01", "2025-02-28"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			// The pass: a raw window, clamped by warmOne before keying.
			warm := keyFor(t, c.from, c.to, true)
			// The reader: the endpoint clamped it, so the scope arrives clamped
			// and clamping again is a no-op.
			cl := map[string]string{"from": c.from, "to": c.to}
			clampToSportsPeriod(cl, aPeriod())
			read := keyFor(t, cl["from"], cl["to"], true)

			if warm != read {
				t.Errorf("warm and read disagree:\n  warm %s\n  read %s\n"+
					"a warmed report would be unreadable and the pass would burn "+
					"warehouse time for nothing", warm, read)
			}
		})
	}
}

/*
The clamp has to be idempotent for the above to hold, because it now runs on both
paths and a reader's scope passes through it twice — once in the endpoint, once
inside warmOne when the same scope is rebuilt. A clamp that moved a window on the
second application would give the rebuild a different key from the entry it was
called to replace.
*/
func TestClampIsIdempotent(t *testing.T) {
	for _, c := range [][2]string{
		{"2024-11-01", "2025-02-15"},
		{"2025-03-01", "2025-06-30"},
		{"2024-01-01", "2024-06-30"},
		{"2025-02-01", "2025-02-28"},
		// Handed in backwards, which the clamp also straightens.
		{"2025-03-01", "2025-01-15"},
	} {
		q := map[string]string{"from": c[0], "to": c[1]}
		clampToSportsPeriod(q, aPeriod())
		once := q["from"] + ".." + q["to"]

		if clampToSportsPeriod(q, aPeriod()) {
			t.Errorf("%s..%s: the second clamp reported a move — applying it twice "+
				"is not a no-op, so warm and read would key differently", c[0], c[1])
		}
		if twice := q["from"] + ".." + q["to"]; twice != once {
			t.Errorf("%s..%s: clamped to %s then to %s", c[0], c[1], once, twice)
		}
	}
}

/*
The tests above pin the INVARIANT; this one pins the CALL.

They model the warm path rather than entering it — warmOne needs a platform
registry, a warehouse and a Redis — so deleting the clamp from warmOne would
leave every one of them green. That is the same shape of gap as the save
statement's argument count: correct by inspection, wrong at run time, and
invisible to a test suite that never reaches the line.

So the source is read, the way TestCacheSaveArgCount reads it. A grep for a call
is a weak assertion and it is the strongest one available here; the alternative is
no guard at all on the line whose absence caused this.

Both functions, because they have to agree with each other as well as with the
reader: warmOne decides the KEY the entry is stored under, probeFreshness decides
whether it gets rebuilt. Clamping one and not the other means asking about a
window the report does not cover.
*/
func TestTheWarmPathClampsBeforeKeying(t *testing.T) {
	src, err := os.ReadFile("reportcachebridge.go")
	if err != nil {
		t.Fatalf("read reportcachebridge.go: %v", err)
	}

	for _, fn := range []string{"func warmOne(", "func probeFreshness("} {
		start := strings.Index(string(src), fn)
		if start < 0 {
			t.Fatalf("could not find %s — this test needs updating", fn)
		}
		// To the next top-level func, which is where this one ends.
		body := string(src)[start:]
		if next := strings.Index(body[len(fn):], "\nfunc "); next >= 0 {
			body = body[:len(fn)+next]
		}
		if !strings.Contains(body, "clampToSportsPeriod(") {
			t.Errorf("%s does not call clampToSportsPeriod.\n"+
				"A sports report is clamped to its configured period before the live "+
				"endpoint keys it, so this path must clamp too — otherwise it writes "+
				"entries under a window no reader can ask for, and burns warehouse "+
				"time producing them. See TestWarmAndReadAgreeOnceBothClamp.", fn)
		}
	}
}

/*
An unfiltered report must be a SCOPE, not a drill-down — scopes are what the pass
maintains and what gets the full retention window.

The reader's request carries `type`, and the warmer's does not. If `type` ever
stopped being excluded from the key's extras, every reader's report would become
a drill-down: keyed apart from the warm entry, indexed nowhere, and expiring in
minutes. The hit rate would go to zero and the cache would look full.
*/
func TestAnUnfilteredReportIsAScopeOnBothPaths(t *testing.T) {
	// As the endpoint builds it, from the query string.
	read := map[string]string{
		"type": "sports", "clientId": parityClient,
		"from": "2025-02-01", "to": "2025-02-28",
	}
	rk, drill, ok := reportcache.KeyKind("sports", parityClient, "shape-abc", read)
	if !ok {
		t.Fatal("an unfiltered report should be cacheable")
	}
	if drill {
		t.Fatal("an unfiltered report was keyed as a drill-down — it would get the " +
			"short life and never be indexed")
	}

	// As the pass builds it: no `type`.
	warm := map[string]string{
		"clientId": parityClient, "from": "2025-02-01", "to": "2025-02-28",
	}
	wk, _, _ := reportcache.KeyKind("sports", parityClient, "shape-abc", warm)
	if rk != wk {
		t.Errorf("`type` leaked into the key:\n  read %s\n  warm %s\n"+
			"the pass omits it, so every warmed report would be unreadable", rk, wk)
	}
}
