package handlers

import (
	"os"
	"strings"
	"testing"
)

/*
Every panel kind the server can emit is one the configuration page can draw.

── WHAT WENT WRONG ─────────────────────────────────────────────────────────

Report Configuration styles a panel by looking its kind up in a map keyed by a
union declared in the TypeScript. The server decides the kinds. Add one here and
not there, and the lookup returns undefined — and the page then reads `.tint`
off it and dies, so a screen for arranging panels stops opening because one
panel had no icon. The message a super admin got was "Cannot read properties of
undefined (reading 'tint')", which names neither the panel nor the kind.

Adding the monthly split card did exactly that.

── WHY THIS TEST IS IN GO AND READS TYPESCRIPT ─────────────────────────────

Because the dependency runs that way. The Go constants are the source of truth
and the page is the consumer, so the useful moment to fail is when someone adds
a kind here — and the only place that can be noticed is a test that knows about
both. The page now also falls back to a grey square rather than crashing, so the
consequence of missing this is cosmetic; this keeps it from even being that.

Read from source rather than executed, for the same reason
TestTheLayoutOffersTheClaimTilesOnYouTube reads reportlayout.go: the linkage has
to exist whatever the warehouse says.
*/
func TestEveryPanelKindIsStyledByTheConfigurationPage(t *testing.T) {
	src, err := os.ReadFile("../../app/admin/report-config/page.tsx")
	if err != nil {
		t.Fatalf("read the configuration page: %v", err)
	}
	page := string(src)

	/* The kinds, listed rather than reflected — Go has no way to enumerate
	   constants, so this is the one place they are written twice and the test
	   below is what keeps the copy honest. */
	kinds := []string{
		panelTile, panelHeading, panelTrend, panelTrendSplit,
		panelRate, panelDim, panelFilter, panelRealtime,
	}

	for _, k := range kinds {
		/* Present in the STYLE map specifically, not merely somewhere in the
		   file: the union type mentions every kind too, and a kind in the union
		   with no style entry is exactly the crash this exists for. The map's
		   entries are `  <kind>: {` at one indent. */
		if !strings.Contains(page, "\n  "+k+": {") {
			t.Errorf("panel kind %q has no KIND_STYLE entry in the configuration page — "+
				"the card falls back to a grey square, and before the fallback existed "+
				"it took the whole page down", k)
		}
		// And a name, or the row in the panel list is headed by nothing at all.
		if !strings.Contains(page, k+": '") {
			t.Errorf("panel kind %q has no KIND_LABEL entry", k)
		}
	}

	/* And the union itself, which is what the compiler checks the rest against.
	   A kind styled but absent from the union is a type error waiting for the
	   next person who assigns a panel list to it. */
	for _, k := range kinds {
		if !strings.Contains(page, "'"+k+"'") {
			t.Errorf("panel kind %q is not in the LayoutPanel kind union", k)
		}
	}
}

/*
── The configuration page asks /api/reports/* about the right PAGE ─────────

/api/reports/options answers for one report page at a time: a request naming no
scope is answered for the Sports one, and a VOD platform asked for under that
scope comes back 403 "You do not have access to this report".

Report Configuration spans both pages, so it cannot leave the scope out — and
it did, which is why the Page layout tab reported "Client list unavailable"
against Summary, Open Web, Social Media & UGC, YouTube, Telegram, Mobile Apps
and Search Engine while the Sports tabs beside them listed clients normally. The
picker had no way to say the question had been wrong rather than the data
missing.

It cannot infer the scope from the key, so the platform list publishes it.
*/
func TestThePlatformListPublishesWhichReportPageEachOneIsOn(t *testing.T) {
	src, err := os.ReadFile("reportplatforms.go")
	if err != nil {
		t.Fatalf("read reportplatforms.go: %v", err)
	}
	if !strings.Contains(string(src), `"reportScope"`) {
		t.Fatal("the platform list no longer publishes reportScope; the configuration " +
			"page cannot scope its /api/reports/options call and every VOD platform's " +
			"client picker goes empty")
	}

	page, err := os.ReadFile("../../app/admin/report-config/page.tsx")
	if err != nil {
		t.Fatalf("read the configuration page: %v", err)
	}
	p := string(page)
	if !strings.Contains(p, "reportScope") {
		t.Error("the configuration page does not read reportScope")
	}
	if !strings.Contains(p, "scope=") {
		t.Error("the configuration page does not send a scope to /api/reports/options")
	}
	/* The built-in Summary tab has no row in the platform list to carry a scope
	   — it is the VOD summary, and the Sports one is a platform of its own — so
	   the page has to name it. Without this, the tab the screen OPENS on is the
	   one that still fails. */
	if !strings.Contains(p, "key === 'summary'") {
		t.Error("the built-in summary tab has no scope of its own, so the tab the " +
			"page opens on still asks the wrong question")
	}
}
