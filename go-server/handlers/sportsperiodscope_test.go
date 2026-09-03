package handlers

/*
The season's END is a configured boundary, not a data one.

DAZN's period runs to 2026-12-31. Asked for it in September, the realtime card
captioned itself "1 Aug 2026 - 31 Dec 2026" — four months of which had not
happened. The COUNT was right, because there are no rows in the future, so
nothing failed and nothing looked wrong except the one line whose job is saying
what was counted.

It is not only cosmetic: fillSeries draws a bucket for every step between since
and until, so an unclamped end puts months of empty bars to the right of the
data on any request that asks for a series.
*/

import (
	"testing"
	"time"
)

func TestSportsPeriodScopeClampsTheEndToToday(t *testing.T) {
	today := istToday()
	yesterday := time.Now().UTC().Add(330*time.Minute).AddDate(0, 0, -1).Format(ymdLayout)

	cases := []struct {
		name     string
		p        sportsPeriodConfig
		wantFrom string
		wantTo   string
		wantOK   bool
	}{
		{
			name:     "a season running into the future ends today",
			p:        sportsPeriodConfig{Enabled: true, Start: "2026-08-01", End: "2099-12-31"},
			wantFrom: "2026-08-01", wantTo: today, wantOK: true,
		},
		{
			/* A season that has already finished keeps its own end. Clamping to
			   today there would silently widen a closed season every day that
			   passed. */
			name:     "a finished season keeps its end",
			p:        sportsPeriodConfig{Enabled: true, Start: "2025-01-01", End: "2025-06-30"},
			wantFrom: "2025-01-01", wantTo: "2025-06-30", wantOK: true,
		},
		{
			name:     "an end of exactly today is left alone",
			p:        sportsPeriodConfig{Enabled: true, Start: "2026-08-01", End: today},
			wantFrom: "2026-08-01", wantTo: today, wantOK: true,
		},
		{
			/* A season that has not begun would otherwise clamp to before its own
			   start, and the service refuses "since is not before until" — which
			   reads on the card as a broken endpoint rather than a season that has
			   not started. */
			name:     "a future season does not invert",
			p:        sportsPeriodConfig{Enabled: true, Start: "2099-01-01", End: "2099-12-31"},
			wantFrom: "2099-01-01", wantTo: "2099-01-01", wantOK: true,
		},
		{
			name:   "a period switched off governs nothing",
			p:      sportsPeriodConfig{Enabled: false, Start: "2026-08-01", End: "2026-12-31"},
			wantOK: false,
		},
		{
			// A half-filled row is not a window — see active().
			name:   "a half-filled period governs nothing",
			p:      sportsPeriodConfig{Enabled: true, Start: "2026-08-01"},
			wantOK: false,
		},
	}

	for _, c := range cases {
		from, to, ok := sportsPeriodScope(c.p)
		if ok != c.wantOK {
			t.Errorf("%s: ok = %v, want %v", c.name, ok, c.wantOK)
			continue
		}
		if !ok {
			continue
		}
		if from != c.wantFrom || to != c.wantTo {
			t.Errorf("%s: got %s..%s, want %s..%s", c.name, from, to, c.wantFrom, c.wantTo)
		}
		// Whatever it returns must be a window the service will accept.
		if from > to {
			t.Errorf("%s: inverted window %s..%s — the service refuses it and the "+
				"card shows an error", c.name, from, to)
		}
	}
	_ = yesterday
}

/*
istToday is the report's calendar day, not the server's.

A UTC day would move the boundary five and a half hours: for the five and a half
hours after IST midnight it names YESTERDAY, so the card would drop the current
day's rows from its window while the tiles beside it kept them.
*/
func TestISTTodayIsAheadOfOrEqualToUTC(t *testing.T) {
	utc := time.Now().UTC().Format(ymdLayout)
	ist := istToday()
	if ist < utc {
		t.Errorf("istToday() = %s is behind the UTC date %s — the offset is applied "+
			"the wrong way and the card would lose the current day", ist, utc)
	}
	if _, err := time.Parse(ymdLayout, ist); err != nil {
		t.Errorf("istToday() = %q is not an ISO date, so it cannot be compared "+
			"against the period bounds: %v", ist, err)
	}
}
