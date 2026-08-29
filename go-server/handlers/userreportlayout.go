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
		if !scopeSaveBody(w, r, clientID, platform) {
			return
		}
		ReportLayoutSave(w, r)

	case http.MethodDelete:
		if !mayEditReportLayout(claims) {
			Fail(w, 403, "This account may not change the report layout")
			return
		}
		/* Deletes only this client's rows — see ReportLayoutReset, which keys
		   on (platform, client). What the reader gets back is whatever IP House
		   configured as the shared default, not a bare registry layout, which
		   is what "reset" should mean to them. */
		scopeQuery(r, platform, clientID)
		ReportLayoutReset(w, r)

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
func scopeSaveBody(w http.ResponseWriter, r *http.Request, clientID, platform string) bool {
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
