package handlers

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

/*
The asset scope reaches the service as ONE comma-joined list.

Worth pinning because the failure it replaced was invisible. The endpoint used
to match the whole joined string as a single asset id, so a two-asset selection
returned a confident zero — no error, no warning, just a live card reporting
that nothing had ever been found. Nothing but comparing the two ways of asking
would have caught it, and nothing in the response distinguished it from a
genuinely quiet client.

It now sums server-side (21 assets in one call returned 6,508, exactly the
total of the same 21 asked individually). If that ever regresses, the joining
here is the seam it would regress at.
*/
func TestSplitParamsFlattensBothSpellings(t *testing.T) {
	// Repeated parameters and comma-separated lists both arrive; callers use
	// whichever suits them, and the War Room uses repeats because an asset name
	// may itself contain a comma.
	got := splitParams([]string{"A,B", " C ", "", "D,,E"})
	want := []string{"A", "B", "C", "D", "E"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("splitParams = %v, want %v", got, want)
	}
	if len(splitParams(nil)) != 0 {
		t.Error("no parameters should give no assets, which means every asset")
	}
}

/*
The same asset twice must not be counted twice.

A dedupe here rather than a hope about the caller: the War Room resolves NAMES
to ids, and one title recorded under two names would otherwise send the same id
twice — which the service would sum, inflating the very number the filter was
added to make precise.
*/
func TestDedupeKeepsFirstSpellingAndDropsRepeats(t *testing.T) {
	got := dedupe([]string{"A-1", "B-2", "a-1", "B-2", "C-3"})
	want := []string{"A-1", "B-2", "C-3"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("dedupe = %v, want %v", got, want)
	}
}

/*
Asset ids come off the request in both spellings, and an empty scope means every
asset rather than none.
*/
func TestRealtimeAssetIDsReadsIdsFromTheRequest(t *testing.T) {
	r := httptest.NewRequest("GET", "/api/realtime/war-room?assetId=A,B&assetId=C", nil)
	got, err := realtimeAssetIDs(r.Context(), r, "CLIENT-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if strings.Join(got, ",") != "A,B,C" {
		t.Errorf("got %v, want A,B,C", got)
	}

	// No asset parameters at all: the card is the client's whole total, and the
	// joined scope must be empty so no assetId is sent.
	bare := httptest.NewRequest("GET", "/api/realtime/war-room", nil)
	none, err := realtimeAssetIDs(bare.Context(), bare, "CLIENT-1")
	if err != nil || len(none) != 0 {
		t.Errorf("an unscoped request gave %v (err %v), want no assets", none, err)
	}
	if strings.Join(none, ",") != "" {
		t.Error("an empty scope must join to the empty string, or every request is filtered by nothing")
	}
}

/*
── The removed half ──────────────────────────────────────────────────────────

The sports view answers with `removed` beside `count` and `totalRemoved` beside
`total`; the war-room view does not ask for either. THREE answers arrive looking
like zero and only one of them is one:

	removed: 8202   counted, and that many are down
	removed: 0      counted, and none are down — a finding, and the whole point
	                of a card that shows quiet platforms rather than hiding them
	removed: null   this platform could not be counted at all
	(absent)        this VIEW does not count removals

Which is why the field is a pointer here rather than an int64. The trap it is
pinned against is `omitempty`: on a plain int it eats the second row above, and
a client whose enforcement has not started yet becomes indistinguishable from
one nobody is enforcing for.
*/
func TestRealtimeReadingKeepsTheRemovedHalf(t *testing.T) {
	// The service's own answer, trimmed to the fields this side reads.
	const sports = `{
	  "view": "sports", "clientId": "70408704-E460-41EB-8304-022DFAFE704C",
	  "total": 13460, "totalRemoved": 8202,
	  "platforms": [
	    {"key":"open-web","label":"Open Web","family":"open-web","count":13271,
	     "removed":8202,"removedWhen":"d.InfringingRemovalStatus = 'Approved'",
	     "table":"mediascan._InternetURLsNEW","dateColumn":"URLUploadDate"},
	    {"key":"ugc-other","label":"UGC & other social media","family":"ugc","count":189,
	     "removed":0,"removedWhen":"t.RemovalStatus = 'Dead'",
	     "table":"mediascan.UGCAndOtherSocialMediaURLs","dateColumn":"DiscoveryDoneAt"},
	    {"key":"vk","label":"VK","family":"social","count":null,
	     "removed":null,"error":"not counted"}
	  ]}`

	var got realtimeResponse
	if err := json.Unmarshal([]byte(sports), &got); err != nil {
		t.Fatalf("the service's own shape no longer decodes: %v", err)
	}
	if got.TotalRemoved == nil || *got.TotalRemoved != 8202 {
		t.Fatalf("totalRemoved = %v, want 8202", got.TotalRemoved)
	}
	if got.Total != 13460 {
		t.Errorf("total = %d — the identified half must be untouched by any of this", got.Total)
	}

	openWeb, ugc, vk := got.Platforms[0], got.Platforms[1], got.Platforms[2]
	if openWeb.Removed == nil || *openWeb.Removed != 8202 {
		t.Errorf("open-web removed = %v, want 8202", openWeb.Removed)
	}
	if ugc.Removed == nil || *ugc.Removed != 0 {
		t.Errorf("ugc removed = %v — a counted zero is a finding and must survive as one", ugc.Removed)
	}
	// Not counted is not zero. The card draws nothing here rather than
	// reporting that a platform it could not read has had nothing taken down.
	if vk.Removed != nil {
		t.Errorf("vk removed = %v, want nothing — that platform did not answer", *vk.Removed)
	}

	// The war-room view sends neither field, and neither may be invented.
	var bare realtimeResponse
	if err := json.Unmarshal([]byte(`{"view":"war-room","total":11,"platforms":[{"key":"yt","count":11}]}`), &bare); err != nil {
		t.Fatalf("war-room shape: %v", err)
	}
	if bare.TotalRemoved != nil || bare.Platforms[0].Removed != nil {
		t.Error("the war-room reading acquired removals it never counted")
	}
}

/*
And the same three answers must survive being RE-encoded for the browser.

`omitempty` on a pointer drops only nil, which is exactly the distinction above
— but it is one field-type edit away from dropping the counted zero too, and
that edit would look like a tidy-up.
*/
func TestRealtimePayloadKeepsACountedZeroAndOmitsAnAbsentOne(t *testing.T) {
	zero, some := int64(0), int64(8202)
	ps := []RealtimePlatform{
		{Key: "open-web", Count: 13271, Removed: &some,
			RemovedWhen: "d.InfringingRemovalStatus = 'Approved'"},
		{Key: "ugc-other", Count: 189, Removed: &zero, RemovedWhen: "t.RemovalStatus = 'Dead'"},
		{Key: "vk", Count: 0},
	}
	scrubRealtimeSchema(ps)

	out, err := json.Marshal(ps)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	js := string(out)

	// Decoded back rather than pattern-matched: what matters is whether the KEY
	// is there and what it holds, not where it landed in the object.
	var back []map[string]any
	if err := json.Unmarshal(out, &back); err != nil {
		t.Fatalf("the payload does not decode: %v", err)
	}
	if v, ok := back[1]["removed"]; !ok || v != float64(0) {
		t.Errorf("the counted zero was dropped from the payload: %s", js)
	}
	if _, invented := back[2]["removed"]; invented {
		t.Errorf("a platform that reported no removals was given one: %s", js)
	}
	// The predicate that produced these figures must not travel with them.
	if strings.Contains(js, "RemovalStatus") || strings.Contains(js, "mediascan") {
		t.Errorf("the payload still carries warehouse schema: %s", js)
	}
	if !strings.Contains(js, "delisting") {
		t.Errorf("open-web lost the words that say what its removals are: %s", js)
	}
}

/*
── The sports card counts a SEASON, not the slicer's dates ──────────────────

The card used to be clamped INTO the report's date range, on the reasoning that
a live figure above dated tiles must cover the same days. It was decoupled when
the two disagreed anyway, and the reason written down — that the layers they read
can never be comparable — was wrong: one expression in the counts service was
de-duplicating Open Web URLs per day on a grain the warehouse table does not
have. That is fixed, and the layers reconcile exactly.

The window is still the client's configured period, now for the reason that
actually holds: following the slicer re-counts the raw tables on every move of
it, and a season is 14.5s against production. Up to TODAY, since a season is a
configured boundary and not a data one and DAZN's runs to December. These pin
that, because the symptom of losing it is not an error: it is a smaller number,
on the card a reader trusts most precisely because it says "live".

The fixture below is a FINISHED season, so nothing is clamped and the whole
period is returned. The clamp itself is
TestSportsPeriodScopeClampsTheEndToToday.
*/
func TestSportsPeriodScopeIsTheWholePeriod(t *testing.T) {
	from, to, ok := sportsPeriodScope(aPeriod())
	if !ok {
		t.Fatal("an enabled period gave no window")
	}
	if from != perStart || to != perEnd {
		t.Errorf("want the whole period %s..%s, got %s..%s — this fixture is a "+
			"finished season, so the clamp to today must not touch it",
			perStart, perEnd, from, to)
	}
}

// A period switched off is how a client is exempted, and the caller must then
// fall back to the request's own window rather than to a window of zeroes —
// which BETWEEN would answer with an empty card that looks like a quiet client.
func TestSportsPeriodScopeDeclinesWhenNothingIsConfigured(t *testing.T) {
	for _, p := range []sportsPeriodConfig{
		{}, // nothing saved at all
		{Enabled: false, Start: perStart, End: perEnd}, // switched off
		{Enabled: true, Start: "", End: perEnd},        // half a window
	} {
		if _, _, ok := sportsPeriodScope(p); ok {
			t.Errorf("%+v was treated as a usable period", p)
		}
	}
}

/*
Every other view still reads the window it was given.

The change above is the sports card's alone. War Room passes the range its own
report was generated for, and folding that into the period logic would scope one
report by another's season.
*/
func TestNonSportsViewKeepsTheRequestedWindow(t *testing.T) {
	r := httptest.NewRequest("GET", "/api/realtime/war-room?from=2025-06-01&to=2025-06-07", nil)
	sc := scopeFromRequest(r, "war-room", "any-client")

	if sc.since != "2025-06-01 00:00:00" {
		t.Errorf("start moved: %q", sc.since)
	}
	// Inclusive of the final day: this service's bound is, unlike MarkScan's.
	if sc.until != "2025-06-07 23:59:59" {
		t.Errorf("end moved or lost its day: %q", sc.until)
	}
	if sc.period {
		t.Error("a war-room count was labelled as period-scoped")
	}
}

/*
What goes ON THE WIRE is bare calendar days, whatever the caption shows.

This is a bug that shipped, and it was invisible: every platform's count was a
little wrong in an unremarkable direction, with no error anywhere. reports_api
reads a bare date as a day on the REPORT's calendar (IST) and a value carrying a
time as a literal UTC instant — so "2026-08-01 00:00:00" asked for a window
5h30m late at both ends, dropping the first morning and taking the one after the
last day. Against the reference query for DAZN over August 2026: Telegram 525
where the report said 509, Facebook 258 against 238, YouTube 461 against 471.
Small, in both directions, and unreadable as anything but noise.

The timestamps still have to exist — dayWords in RealtimeCard.tsx parses them to
write "1 Aug 2026" — so the two forms are pinned together here: the caption keeps
its timestamps and the request carries days.
*/
func TestTheAPIWindowIsBareCalendarDays(t *testing.T) {
	r := httptest.NewRequest("GET", "/api/realtime/war-room?from=2025-06-01&to=2025-06-07", nil)
	sc := scopeFromRequest(r, "war-room", "any-client")

	since, until := sc.apiWindow()
	if since != "2025-06-01" {
		t.Errorf("since went on the wire as %q — a value with a time on it is read "+
			"as UTC, not as a day on the report's calendar", since)
	}
	if until != "2025-06-07" {
		t.Errorf("until went on the wire as %q, want the bare day", until)
	}

	// And the display form is untouched, or the caption stops saying "1 Aug 2026".
	if sc.since != "2025-06-01 00:00:00" || sc.until != "2025-06-07 23:59:59" {
		t.Errorf("the caption's timestamps changed: %q → %q — dayWords parses these",
			sc.since, sc.until)
	}

	/* An absent `until` must stay absent. It is a real case — scopeFromRequest
	   leaves it empty when the caller names no end — and a blank turned into a
	   date would silently bound an unbounded count. */
	var open realtimeScope
	if s, u := open.apiWindow(); s != "" || u != "" {
		t.Errorf("an empty scope produced %q/%q", s, u)
	}
}

// A caller naming no window at all gets a BOUNDED one. All-time is what made
// the service answer 504, so the absence of dates must never reintroduce it.
func TestAMissingWindowFallsBackToABoundedOne(t *testing.T) {
	r := httptest.NewRequest("GET", "/api/realtime/war-room", nil)
	sc := scopeFromRequest(r, "war-room", "any-client")
	if sc.since == "" {
		t.Fatal("no lower bound at all — this is the all-time query that times out")
	}
	if sc.period {
		t.Error("a fallback window was labelled as period-scoped")
	}
}

/*
The card's own window beats the configured season.

The sports card used to wait for a narrowing filter before it appeared, because
unfiltered it counted the whole season. It is on screen from the moment a sports
report loads now, and this is what pays for that: it asks for the last day, and
`lastHours` has to win over the period or the control on the card would be the
one slicer in the product that does nothing.
*/
func TestARollingWindowBeatsTheConfiguredSeason(t *testing.T) {
	r := httptest.NewRequest("GET", "/api/realtime/sports?lastHours=24", nil)
	sc := scopeFromRequest(r, "sports", "any-client")

	if sc.hours != 24 {
		t.Fatalf("the window was not carried through: %d hours", sc.hours)
	}
	if sc.period {
		t.Error("a window the card asked for was labelled as the configured season")
	}
	if got := scopeName(sc); got != "rolling" {
		t.Errorf("scope name %q — the card writes \"in the last 24 hours\" off this", got)
	}

	/* And it is ONE REPORT DAY — today, whole — not the trailing twenty-four
	   hours. Parsed rather than eyeballed, because the two print almost alike and
	   only one of them selects the rows the report's 1D preset selects. */
	since, err := time.Parse(realtimeStampLayout, sc.since)
	if err != nil {
		t.Fatalf("since is not a timestamp: %q (%v)", sc.since, err)
	}
	until, err := time.Parse(realtimeStampLayout, sc.until)
	if err != nil {
		t.Fatalf("until is not a timestamp: %q (%v)", sc.until, err)
	}
	if since.Format(ymdLayout) != until.Format(ymdLayout) {
		t.Errorf("lastHours=24 spans %s..%s — that is two calendar days, and the "+
			"report's 1D preset is one", sc.since, sc.until)
	}
	if since.Format("15:04:05") != "00:00:00" || until.Format("15:04:05") != "23:59:59" {
		t.Errorf("the window is %s..%s, want a whole report day", sc.since, sc.until)
	}
}

/*
A rolling window is the report's own N-day range, to the row.

THE BUG THIS EXISTS FOR. The card's window was a pair of instants — "the last 168
hours" — while the report's 7D preset is seven IST calendar days. Read together
on 9 September 2026 they differed by twelve Twitter posts: the card reached into
2 September and stopped short of the last hours of the 9th. Nothing on screen
explained it, and a reader who cannot explain a small difference stops trusting
the large numbers next to it.

So `lastHours` is a number of report DAYS now, and this pins the mapping the team
reconciled against: at 02:00 IST on 9 September, 168 hours is 3 – 9 September —
the exact range in the slicer beside it.
*/
func TestARollingWindowIsTheReportsOwnDayRange(t *testing.T) {
	// 2026-09-08 20:32 UTC is 2026-09-09 02:02 IST — after IST midnight, which is
	// where a UTC-dated window would name the wrong day.
	now := time.Date(2026, 9, 8, 20, 32, 0, 0, time.UTC)

	for _, c := range []struct {
		hours    int
		from, to string
	}{
		{24, "2026-09-09", "2026-09-09"},
		{48, "2026-09-08", "2026-09-09"},
		{168, "2026-09-03", "2026-09-09"},
		// Rounded UP: anything part-way into a day is that whole day.
		{25, "2026-09-08", "2026-09-09"},
		{1, "2026-09-09", "2026-09-09"},
	} {
		since, until := rollingScope(c.hours, now).apiWindow()
		if since != c.from || until != c.to {
			t.Errorf("lastHours=%d asked for %s..%s, want %s..%s",
				c.hours, since, until, c.from, c.to)
		}
	}
}

/*
The window holds still for a whole report day, and steps at IST midnight.

It used to be quantised to the memo's TTL, because the memo is keyed on the
window and a boundary carrying seconds filed every poll under a key of its own.
Calendar days make that free: every poll between two IST midnights builds the
identical scope, so the single-flight always hits.

What keeps the card LIVE is therefore not the key moving — it is the memo's own
time check on the entry (see cachedRealtimeCount), which expires every TTL and
re-counts against a day that is still filling up.
*/
func TestARollingWindowStepsAtISTMidnightAndNotBefore(t *testing.T) {
	// 18:29 UTC is 23:59 IST — the last minute of the report's 7th.
	lastMinute := time.Date(2026, 9, 7, 18, 29, 0, 0, time.UTC)

	a := rollingScope(24, lastMinute.Add(-8*time.Hour))
	b := rollingScope(24, lastMinute)
	if a != b {
		t.Errorf("the window moved inside one report day:\n  %+v\n  %+v", a, b)
	}
	if got, _ := b.apiWindow(); got != "2026-09-07" {
		t.Errorf("the last minute of the IST 7th asked for %q", got)
	}

	// One minute later is IST midnight, and the window must have stepped.
	c := rollingScope(24, lastMinute.Add(time.Minute))
	if c == a {
		t.Error("the window did not step at IST midnight — a live card would show " +
			"yesterday all day")
	}
	if got, _ := c.apiWindow(); got != "2026-09-08" {
		t.Errorf("the first minute of the IST 8th asked for %q", got)
	}
}

/*
A week and no further.

The ceiling is what keeps the card cheap enough to show unfiltered: a week of
one client's captures measured at 1.4s against production where the season was
14.5s. Clamped rather than refused, because an out-of-range value is a stale tab
or a hand-typed URL and the nearest window it could have meant beats an error on
a card whose job is to keep showing numbers.
*/
func TestTheRollingWindowIsClampedToAWeek(t *testing.T) {
	for _, c := range []struct{ asked, want int }{
		{24, 24},
		{24 * 7, 24 * 7},
		{24 * 30, 24 * 7}, // a month: back to the season-sized cost this avoids
		{0, 0},            // not asked for at all — every other caller's window stands
		{-5, 0},
	} {
		r := httptest.NewRequest("GET", fmt.Sprintf("/api/realtime/sports?lastHours=%d", c.asked), nil)
		if got := rollingHoursFromRequest(r); got != c.want {
			t.Errorf("lastHours=%d gave %d, want %d", c.asked, got, c.want)
		}
	}

	// Absent, and the season logic is untouched — this must not have become the
	// window every sports card gets.
	r := httptest.NewRequest("GET", "/api/realtime/sports", nil)
	if got := rollingHoursFromRequest(r); got != 0 {
		t.Errorf("a request naming no window got %d hours", got)
	}
}

/*
The dimension filters are part of the memo key.

dims.key() was written for that key and never reached it, so two readers on the
same client, assets and window but different franchises collided and whichever
asked first decided what both were shown. The loser saw a plausible number for a
league they had not picked, which is the worst shape of wrong a cache can be.

It matters more now than it did: the card is on screen unfiltered from the
moment a sports report loads, so the UNFILTERED reading is always the one in the
memo first, and every filter a reader then picks would have been served it.
*/
func TestTheMemoKeyDistinguishesDimensionFilters(t *testing.T) {
	if k := (realtimeDims{}).key(); k != "" {
		t.Errorf("an unfiltered count keys as %q — it must key exactly as it did "+
			"before dimensions existed", k)
	}
	a := realtimeDims{Franchise: "Serie A"}
	b := realtimeDims{Franchise: "LaLiga"}
	if a.key() == b.key() {
		t.Fatalf("two franchises share the key %q", a.key())
	}
	if (realtimeDims{MatchDay: "Matchday 4"}).key() == (realtimeDims{}).key() {
		t.Error("a match day keys the same as no filter at all")
	}
}
