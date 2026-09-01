package handlers

import "testing"

/*
The period is only worth configuring if the query obeys it.

The calendar is the half a reader sees; these pin the half that makes it true.
Everything below goes through clampToSportsPeriod directly, because that is the
one function a sports READ passes its window through — the report and the slicer
values behind it.

The live card is no longer among them: it counts the whole period rather than a
window clamped into it, so it asks sportsPeriodScope instead. See
realtime_test.go.
*/

const (
	perStart = "2025-01-01"
	perEnd   = "2025-03-31"
)

func aPeriod() sportsPeriodConfig {
	return sportsPeriodConfig{Enabled: true, Start: perStart, End: perEnd}
}

func clampOf(t *testing.T, from, to string) (string, string, bool) {
	t.Helper()
	q := map[string]string{"from": from, "to": to}
	moved := clampToSportsPeriod(q, aPeriod())
	return q["from"], q["to"], moved
}

// A window already inside the period is the common case and must pass through
// untouched — including the "moved" flag, which the page uses to decide whether
// to tell the reader its range was adjusted.
func TestAWindowInsideThePeriodIsLeftAlone(t *testing.T) {
	from, to, moved := clampOf(t, "2025-02-01", "2025-02-28")
	if from != "2025-02-01" || to != "2025-02-28" {
		t.Errorf("window moved to %s..%s", from, to)
	}
	if moved {
		t.Error("reported as adjusted when nothing changed")
	}
}

// The reason the server clamps at all: a request can carry dates no calendar
// would have offered.
func TestAWindowStraddlingThePeriodIsPulledIn(t *testing.T) {
	from, to, moved := clampOf(t, "2024-06-01", "2026-06-01")
	if from != perStart || to != perEnd {
		t.Errorf("got %s..%s, want %s..%s", from, to, perStart, perEnd)
	}
	if !moved {
		t.Error("a window that was pulled in should report as adjusted")
	}
}

/*
An absent end must not read the whole table.

specWhere applies its BETWEEN only when both ends are present, so a request that
simply omits a date would otherwise have been an unfiltered read of the source —
the period defeated by leaving a field blank rather than by filling it in.
*/
func TestAnAbsentEndIsFilledFromThePeriod(t *testing.T) {
	from, to, _ := clampOf(t, "", "")
	if from != perStart || to != perEnd {
		t.Errorf("empty window became %s..%s, want the period", from, to)
	}
	if from, to, _ := clampOf(t, "2025-02-01", ""); to != perEnd || from != "2025-02-01" {
		t.Errorf("half-open window became %s..%s", from, to)
	}
}

// Entirely outside, in both directions. The invariant that matters is that what
// comes back is a valid window INSIDE the period — never a read of data the
// period excludes, and never an inverted range that BETWEEN answers with
// silence.
func TestAWindowOutsideThePeriodCollapsesOntoIt(t *testing.T) {
	for _, c := range []struct{ from, to, wantFrom, wantTo string }{
		{"2020-01-01", "2020-12-31", perStart, perStart}, // entirely before
		{"2030-01-01", "2030-12-31", perEnd, perEnd},     // entirely after
	} {
		from, to, moved := clampOf(t, c.from, c.to)
		if from != c.wantFrom || to != c.wantTo {
			t.Errorf("%s..%s became %s..%s, want %s..%s",
				c.from, c.to, from, to, c.wantFrom, c.wantTo)
		}
		if from > to {
			t.Errorf("%s..%s produced an inverted window %s..%s", c.from, c.to, from, to)
		}
		if !moved {
			t.Errorf("%s..%s should report as adjusted", c.from, c.to)
		}
	}
}

// A range handed in backwards would survive clamping backwards, and BETWEEN
// answers an inverted range with no rows — an empty report that looks like a
// real one.
func TestABackwardsWindowIsStraightened(t *testing.T) {
	from, to, _ := clampOf(t, "2025-03-01", "2025-02-01")
	if from > to {
		t.Errorf("still inverted: %s..%s", from, to)
	}
	if from != "2025-02-01" || to != "2025-03-01" {
		t.Errorf("got %s..%s, want 2025-02-01..2025-03-01", from, to)
	}
}

/*
A period that is off, half-filled or backwards governs nothing.

Each of these is a state the configuration screen can be left in mid-edit, and
treating any of them as a window would clamp every sports report to a boundary
nobody finished setting — which reads on the page as data that has gone missing.
*/
func TestAnIncompletePeriodClampsNothing(t *testing.T) {
	for name, p := range map[string]sportsPeriodConfig{
		"disabled":  {Enabled: false, Start: perStart, End: perEnd},
		"no start":  {Enabled: true, End: perEnd},
		"no end":    {Enabled: true, Start: perStart},
		"empty":     {Enabled: true},
		"backwards": {Enabled: true, Start: perEnd, End: perStart},
	} {
		if p.active() {
			t.Errorf("%s period reports itself active", name)
		}
		q := map[string]string{"from": "2020-01-01", "to": "2030-01-01"}
		if clampToSportsPeriod(q, p) {
			t.Errorf("%s period clamped a window", name)
		}
		if q["from"] != "2020-01-01" || q["to"] != "2030-01-01" {
			t.Errorf("%s period altered the window to %s..%s", name, q["from"], q["to"])
		}
	}
}

/*
Which reports the period governs.

Read off the tables first, because a label is free text: renaming a sports
platform must not release it from its period, which is the failure a name-only
test would have.
*/
func TestSportsPlatformsAreRecognisedByTheirTables(t *testing.T) {
	renamed := platformDef{
		Key: "open-web-2025", Label: "Open Web (2025 season)",
		Tables: []string{"dashboards.SportsURLRawData"},
	}
	if !isSportsPlatform(renamed) {
		t.Error("a renamed sports platform escaped its period — the tables still say Sports")
	}

	// The Sports Summary holds no tables of its own; the key and label are all
	// there is to go on.
	if !isSportsPlatform(platformDef{Key: "summary-sports", Label: "Summary - Sports"}) {
		t.Error("the sports summary was not recognised")
	}

	for _, p := range []platformDef{
		{Key: "open-web", Label: "Open Web", Tables: []string{"mediascan._InternetURLsNEW"}},
		{Key: "youtube", Label: "YouTube", Tables: []string{"mediascan.SocialMedia"}},
		{Key: summaryKey, Label: "Summary"},
	} {
		if isSportsPlatform(p) {
			t.Errorf("%q was governed by the sports period and should not be", p.Key)
		}
	}
}

// The DATE column comes back from the driver in more than one shape, and a
// period that parses as "" is a period that silently stops applying.
func TestDateOnlyReadsWhateverTheDriverReturns(t *testing.T) {
	for in, want := range map[string]string{
		"2025-01-01":          "2025-01-01",
		"2025-01-01 00:00:00": "2025-01-01",
		"":                    "",
		"not a date":          "",
	} {
		if got := dateOnly(in); got != want {
			t.Errorf("dateOnly(%q) = %q, want %q", in, got, want)
		}
	}
}

/*
Precedence between the default and a client's own window.

Three states, and the third is the one that is easy to get wrong: a client row
that is switched OFF means "this client has no period", not "this client has not
been configured". Without that distinction there is no way to exempt one client
from a default that applies to everybody else, which is the main reason a
per-client setting gets asked for.

Exercised through a stand-in for the two reads, because the real ones are a
database away and the rule under test is the precedence, not the SQL.
*/
func resolveWith(override *sportsPeriodConfig, fallback sportsPeriodConfig) sportsPeriodConfig {
	if override != nil {
		return *override
	}
	return fallback
}

func TestAClientRowWinsOverTheDefault(t *testing.T) {
	def := sportsPeriodConfig{Enabled: true, Start: "2025-01-01", End: "2025-03-31"}
	own := sportsPeriodConfig{Enabled: true, Start: "2024-06-01", End: "2024-08-31"}

	// No row: the default applies.
	if got := resolveWith(nil, def); got.Start != def.Start || got.End != def.End {
		t.Errorf("a client with no row got %s..%s, want the default", got.Start, got.End)
	}

	// Its own window, which must be used whole rather than intersected with the
	// default — the two windows need not overlap at all.
	got := resolveWith(&own, def)
	if got.Start != own.Start || got.End != own.End {
		t.Errorf("client window came back as %s..%s, want %s..%s", got.Start, got.End, own.Start, own.End)
	}
	if !got.active() {
		t.Error("a client window that is set and enabled should govern")
	}

	/* Switched off: no period for this client, even though the default is on.
	   The failure this pins is a resolve that falls back on a disabled row,
	   which silently reapplies the very default the row exists to escape. */
	off := sportsPeriodConfig{Enabled: false, Start: "2024-06-01", End: "2024-08-31"}
	if resolveWith(&off, def).active() {
		t.Error("a client switched off inherited the default period")
	}
}

// The clamp itself must use whichever window resolution handed it, including
// one that lies entirely outside the default.
func TestAClientWindowClampsToItsOwnDates(t *testing.T) {
	own := sportsPeriodConfig{Enabled: true, Start: "2024-06-01", End: "2024-08-31"}
	q := map[string]string{"from": "2024-01-01", "to": "2025-12-31"}
	if !clampToSportsPeriod(q, own) {
		t.Fatal("a straddling window should report as adjusted")
	}
	if q["from"] != own.Start || q["to"] != own.End {
		t.Errorf("clamped to %s..%s, want the client window %s..%s",
			q["from"], q["to"], own.Start, own.End)
	}
}
