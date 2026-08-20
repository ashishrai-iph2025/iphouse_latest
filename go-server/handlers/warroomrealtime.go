package handlers

/*
The War Room's live counts, taken from MarkScan itself.

This is a SECOND source for the same card. The first — see realtime.go — reads
reports_api, which is the warehouse the reports are built from. Both are kept
deliberately:

	reports_api   what has landed in the warehouse. Complete, comparable with
	              every other figure on the reports screens, and behind whatever
	              lag the load has.
	MarkScan      what the enforcement platform is seeing right now, per asset,
	              through the same endpoints the War Room report pulls from.

The War Room reads MarkScan because that is what its report is made of. A card
above the report answering from a different system would invite exactly the
comparison it cannot survive: the two are not lagged copies of one number, they
are two systems counting at different moments.

What makes it affordable is that no rows are fetched. Every /Paged endpoint
returns totalRecords alongside the page, so a one-row request carries the whole
count — see markscan.CountPage. Building this from the report's own rows would
mean pulling every page of every platform on a timer.
*/

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/ip-house/iphouse-api/markscan"
)

// How many MarkScan calls the card may have in flight. A dozen platforms times
// however many assets are selected, held to something the enforcement API will
// not treat as a burst.
const warRealtimeConcurrency = 6

/*
GET /api/warroom/realtime?assetName=…&startDate=&endDate=

THE SAME NUMBERS AS THE PLATFORM STRIP, on a timer.

This used to count independently — one cheap totalRecords call per platform —
and the counts never quite agreed with the report sitting under them. Every
disagreement had a real cause and each was worth fixing: a comma-joined asset
list matching nothing, the UGC umbrella needing its seven sub-platforms asked
for separately, an end date whose final day MarkScan excludes. But they kept
arriving, because two implementations of "how many infringements are there"
will differ for as long as they are two implementations.

So it stopped being a second implementation. This runs processWarRoom — the
very function behind /api/warroom and the streaming report — and reads the
per-platform totals off the result it returns. The card and the strip cannot
disagree now: identical pull, identical store, identical date filter, identical
aggregation, one code path.

What differs is only WHEN. The strip is rebuilt when someone presses Refresh or
Generate; this runs every thirty seconds, so it shows the same figures a little
sooner. Incremental mode, so each run is a delta against the store rather than a
re-pull of the window.
*/
func WarRoomRealtime(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	if claims == nil {
		Fail(w, 401, "Not authenticated")
		return
	}

	assets := splitParams(r.URL.Query()["assetName"])
	if len(assets) == 0 {
		Fail(w, 422, "Pick at least one asset")
		return
	}

	body := warRoomBody{
		AssetNames: assets,
		StartDate:  strings.TrimSpace(r.URL.Query().Get("startDate")),
		EndDate:    strings.TrimSpace(r.URL.Query().Get("endDate")),
		/* Incremental, always. A full re-pull on a thirty-second timer would
		   fetch every page of every platform for the window, repeatedly — the
		   cost the report pays once when someone asks for it. The delta is what
		   makes this affordable, and it is also what the Refresh button does. */
		Mode: "incremental",
	}
	if adminID := strings.TrimSpace(r.URL.Query().Get("clientUserId")); adminID != "" {
		if n, err := parseIntSafe(adminID); err == nil && n > 0 {
			body.ClientUserID = int64(n)
		}
	}

	token, ownerID, aerr := resolveWarRoomToken(claims, body)
	if aerr != nil {
		Fail(w, aerr.status, aerr.msg)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()

	out, aerr := processWarRoom(ctx, token, ownerID, body, nil)
	if aerr != nil {
		Fail(w, aerr.status, aerr.msg)
		return
	}

	/* The per-platform strip, read off the report rather than recomputed.
	   `Totals.Identified` is the number the tab shows under IDENTIFICATION. */
	report, _ := out["data"].(markscan.WarRoomReport)
	platforms := make([]RealtimePlatform, 0, len(report.Platforms))
	for _, p := range report.Platforms {
		platforms = append(platforms, RealtimePlatform{
			Key:    p.Platform,
			Label:  p.Label,
			Family: "markscan",
			Count:  int64(p.Totals.Identified),
		})
	}
	sortRealtime(platforms)

	OK(w, map[string]any{
		"ok": true, "view": "war-room", "source": "markscan",
		// The strip's own total, so the headline and the rows it sits above are
		// the same arithmetic rather than two sums that ought to agree.
		"total":     report.Summary.Identified,
		"platforms": platforms,
		"assets":    len(assets),
		"startDate": body.StartDate, "endDate": body.EndDate,
		"asOf": time.Now().UTC().Format(time.RFC3339),
	})
}
