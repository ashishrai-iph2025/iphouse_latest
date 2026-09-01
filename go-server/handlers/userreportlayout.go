package handlers

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
)

/*
GET/PUT/DELETE /api/user/report-layout — a client rearranging its own report.

The same three operations Report Configuration performs, with one difference
that is the whole point of the file: the client is taken from the SESSION and
the caller's own value is discarded. reportScope does that already for every
other report endpoint, and this is the same rule applied to the layout — without
it, a client granted the right to arrange its own report would be able to name
somebody else's and arrange theirs.

Implemented by forcing the scope onto the request and handing it to the existing
handler rather than by reimplementing it.

That is deliberate. The layout is not a stored list; it is the platform's
computed default with the stored rows overlaid, plus the filter pane derived
from whichever panels survived, plus the default span/viz/position of every
panel so a Reset can mean something. A second implementation of that would agree
with the first until the next time the registry changed. Here, an admin and a
client editing the same report are running the same code, and the only thing
that differs is who is allowed to say which client.
*/
func UserReportLayout(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	if claims == nil {
		Fail(w, 401, "Not authenticated")
		return
	}
	/* The module grant first: this reads and writes the shape of a report, so a
	   login whose company was never given Reports has no business here even
	   with the layout grant set. Same check the report data endpoints make. */
	if !mayOpenReports(claims) {
		Fail(w, 403, "This account does not have the Reports module")
		return
	}

	clientID, ok, why := reportScope(claims, "")
	if !ok {
		Fail(w, 403, why)
		return
	}
	/* An empty client is the ALL-CLIENTS default layout — the one every client
	   falls back to. reportScope returns it for staff, who pass their own
	   client explicitly and are not doing that here. Refused rather than
	   allowed to mean "the shared default", because editing the shared default
	   by accident is the one mistake this endpoint could make that would show
	   up on every other client's report. */
	if clientID == "" {
		Fail(w, 422, "This session is not scoped to a reporting client. "+
			"Arrange the shared default from Report Configuration instead.")
		return
	}

	platform := strings.TrimSpace(r.URL.Query().Get("platform"))

	switch r.Method {
	case http.MethodGet:
		/* Reading needs only Reports. The page already draws this layout, so
		   refusing to describe it to a reader who can see it would protect
		   nothing — and the editor needs it loaded before it can ask whether
		   the reader may change it. */
		scopeQuery(r, platform, clientID)
		ReportLayoutGet(w, r)

	case http.MethodPut:
		if !mayEditReportLayout(claims) {
			Fail(w, 403, "This account may not change the report layout")
			return
		}
		/* No `platform` argument, deliberately. A save carries its platform in
		   the BODY — the editor PUTs to a bare /api/user/report-layout with no
		   query string at all — so the value read off the URL above is empty
		   here, and passing it made scopeSaveBody ask adminHiddenPanels("")
		   about an unknown platform. That answered "nothing is hidden", both
		   halves of rule two below went unenforced, and every panel IP House
		   had switched off came back on the client's report the moment they
		   saved anything. scopeSaveBody reads it from the body it has already
		   decoded. */
		if !scopeSaveBody(w, r, clientID) {
			return
		}
		ReportLayoutSave(w, r)

	case http.MethodDelete:
		/*
			Refused, whatever the grant says.

			The grant is the right to ARRANGE a report — to move a panel, resize
			one, switch one off. Reset is not another arrangement, it is the
			deletion of every arrangement anyone at the company ever made, and it
			is not undoable: the rows are gone and there is nothing to restore
			them from. One reader, one click, and a layout somebody built over
			weeks is the shared default again — with no trace of who did it or
			what it looked like before.

			So it stays with the people who can see the shared default they would
			be reverting to: DELETE /api/admin/report-layout, from Report
			Configuration. That handler is unchanged and still drops one client's
			rows when it is given a clientId.

			Answered here rather than by dropping the route, so the caller is told
			why instead of getting a bare 405 — and 403 rather than 404 because
			the operation exists, this session simply may not perform it.
		*/
		Fail(w, 403, "A report layout can only be reset by IP House. "+
			"Ask your account manager to restore the default arrangement.")

	default:
		Fail(w, 405, "Method not allowed")
	}
}

// scopeQuery rewrites the request's query string so the delegated handler reads
// the session's client and nothing the caller sent.
func scopeQuery(r *http.Request, platform, clientID string) {
	q := url.Values{}
	q.Set("platform", platform)
	q.Set("clientId", clientID)
	r.URL.RawQuery = q.Encode()
}

/*
scopeSaveBody does the same for the JSON body of a save, and enforces the one
thing a client may not do.

The body is decoded to a generic map and re-encoded rather than parsed into the
handler's own struct: that struct is the save format, it will grow, and a copy
of it here would silently drop whatever field was added to it next. Everything
the caller sent survives except what the two rules below overrule.

The PLATFORM is read from that same decoded body rather than taken as an
argument. It used to be passed in from the caller's query string, which a save
does not have — the editor PUTs to a bare /api/user/report-layout and names its
platform in the JSON — so it arrived empty, adminHiddenPanels was asked about a
platform that does not exist, and rule two below silently did nothing at all.
There is only one place a save states its platform; this reads it from there.

── Rule one: the client is the session's ────────────────────────────────────

Same rule reportScope applies to every other report endpoint.

── Rule two: what IP House hid stays hidden ─────────────────────────────────

Two parts, and the second is the one that is easy to miss.

Clamping is obvious: a panel the shared default hides is forced hidden, so a
crafted request cannot turn on a panel the editor never offered.

Re-appending is not obvious, and without it hiding a panel from a client would
UN-hide it for them. layoutFor consults the shared default only while a client
has no rows of its own; the first client save therefore replaces the default
wholesale for that client. A body carrying only the panels the client can see
would leave the hidden ones with no row at all — and a panel with no row takes
the registry's default, which is visible. So every admin-hidden panel the body
omits is added back, hidden, before the save runs.

Their order is the tail of the list, which costs nothing: a hidden panel has no
position on the page.
*/
func scopeSaveBody(w http.ResponseWriter, r *http.Request, clientID string) bool {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	r.Body.Close()
	if err != nil {
		Fail(w, 400, "Could not read the request")
		return false
	}
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil || body == nil {
		Fail(w, 422, "A layout is required")
		return false
	}
	body["clientId"] = clientID

	platform, _ := body["platform"].(string)
	platform = strings.TrimSpace(platform)
	/* Refused here rather than left to ReportLayoutSave, which would reject it
	   a moment later anyway. The difference is that everything between the two
	   is the rule that keeps admin-hidden panels hidden, and running it against
	   an unnamed platform is how it came to be a no-op in the first place. */
	if platform == "" {
		Fail(w, 422, "A platform is required")
		return false
	}

	hidden := adminHiddenPanels(platform)
	if len(hidden) > 0 {
		list, _ := body["panels"].([]any)
		sent := map[string]bool{}
		for _, item := range list {
			p, ok := item.(map[string]any)
			if !ok {
				continue
			}
			key, _ := p["key"].(string)
			key = strings.TrimSpace(key)
			sent[key] = true
			if hidden[key] {
				p["hidden"] = true
			}
		}
		for key := range hidden {
			if !sent[key] {
				list = append(list, map[string]any{"key": key, "hidden": true})
			}
		}
		body["panels"] = list
	}

	next, err := json.Marshal(body)
	if err != nil {
		Fail(w, 500, "Could not prepare the request")
		return false
	}
	r.Body = io.NopCloser(bytes.NewReader(next))
	r.ContentLength = int64(len(next))
	return true
}
