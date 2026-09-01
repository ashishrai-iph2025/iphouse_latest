package handlers

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strings"

	"github.com/ip-house/iphouse-api/markscan"
)

// searchAttempt is one shape of the same lookup: which platform to route it to,
// and — for Open Web, whose records come in host/linking pairs — which side of
// the pair the URL is.
type searchAttempt struct {
	platform string
	isSrcURL bool
}

/*
searchAttempts turns "here is a URL" into the calls /SearchandRetriveapi can
actually answer.

The screen asks for a URL and nothing else, but the endpoint routes on
`platform`, so the platform is derived from the host. Two follow-ups exist
because a derivation can be wrong in exactly two ways, and each costs one extra
call only when the one before it found nothing:

  - Open Web records are a PAIR (the page linking to the file, the host serving
    it) and `isSrcUrl` says which one is being asked for, so both are tried.
  - the blank platform is the last resort — it is what this handler sent before
    the derivation existed, so the derivation can only add matches, never take
    one away.

An explicit platform from the caller is taken as given and tried alone.
*/
func searchAttempts(platform string, isSrcURL bool, rawURL string) []searchAttempt {
	if platform != "" {
		return []searchAttempt{{platform, isSrcURL}}
	}
	resolved := markscan.PlatformForURL(rawURL)
	if resolved == "" {
		// On no named platform — that is what Open Web is.
		return []searchAttempt{{"internet", false}, {"internet", true}, {"", false}}
	}
	return []searchAttempt{{resolved, false}, {"", false}}
}

// envelopeKeys are the fields a bare status message is made of. A response
// carrying nothing else is upstream saying "no such URL" in a sentence, and
// passing it on as data draws a screen of empty rows instead of that answer.
var envelopeKeys = map[string]bool{
	"message": true, "error": true, "status": true, "statuscode": true,
	"title": true, "detail": true, "success": true, "errors": true, "type": true,
}

// searchRecord pulls the single record out of an upstream response, or nil when
// the response holds none. A 200 carrying null, {} or [] is how "no such URL"
// arrives — it is not an error, and it must not be shown as one.
func searchRecord(data any) any {
	switch v := data.(type) {
	case map[string]any:
		for key, val := range v {
			if envelopeKeys[strings.ToLower(key)] {
				continue
			}
			if val != nil && fmt.Sprint(val) != "" {
				return v
			}
		}
	case []any:
		for _, item := range v {
			if rec := searchRecord(item); rec != nil {
				return rec
			}
		}
	}
	return nil
}

// POST /api/search
func Search(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	apiToken := ResolveAPIToken(claims)
	if apiToken == "" {
		Fail(w, 401, "API token missing")
		return
	}

	var body struct {
		URL      string `json:"url"`
		Platform string `json:"platform"`
		IsSrcURL bool   `json:"isSrcUrl"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if body.URL == "" {
		Fail(w, 422, "URL is required")
		return
	}

	// Whether any attempt was answered at all. Every attempt rejected is an API
	// problem, and telling the user "no record" would send them looking for a
	// URL that was never actually searched for.
	answered := false
	for _, attempt := range searchAttempts(body.Platform, body.IsSrcURL, body.URL) {
		httpStatus, data, err := markscan.SearchByUrl(apiToken, body.URL, attempt.platform, attempt.isSrcURL)
		if err != nil {
			Fail(w, 502, err.Error())
			return
		}
		if httpStatus == 401 || httpStatus == 403 {
			Fail(w, 401, "API token expired. Please re-login.")
			return
		}
		if httpStatus >= 500 {
			// Upstream is failing, not answering "not found" — retrying the same
			// URL under another platform only multiplies the outage.
			log.Printf("[search] upstream %d url=%q platform=%q body=%s",
				httpStatus, body.URL, attempt.platform, snippet(data, 200))
			OK(w, map[string]any{"success": false, "error": fmt.Sprintf("Search API error (%d). Please try again.", httpStatus)})
			return
		}
		if httpStatus < 400 {
			answered = true
			if rec := searchRecord(data); rec != nil {
				// Field NAMES only (no values): the screen renders every field a
				// record carries, but one that came back empty is invisible there,
				// and "does this platform even return that column?" is the question
				// this log answers.
				log.Printf("[search] hit url=%q platform=%q fields=%v", body.URL, attempt.platform, recordFields(rec))
				/* `isSrcUrl` is echoed because the caller cannot otherwise know
				   which SIDE answered. An Open Web lookup with no platform tries
				   the linking side and then the host side (see searchAttempts),
				   so a hit is one or the other and the screen has no way to tell
				   which — it would have to guess before it could offer to switch
				   to the other one. Meaningless off Open Web, where there is no
				   pair, and the screen ignores it there. */
				OK(w, map[string]any{
					"success": true, "data": rec,
					"platform": attempt.platform, "isSrcUrl": attempt.isSrcURL,
				})
				return
			}
		}
		log.Printf("[search] no record url=%q platform=%q isSrcUrl=%v status=%d body=%s",
			body.URL, attempt.platform, attempt.isSrcURL, httpStatus, snippet(data, 200))
	}

	if !answered {
		OK(w, map[string]any{"success": false, "error": "Search API rejected the request. Please try again or contact support."})
		return
	}
	OK(w, map[string]any{"success": false, "error": "No record found for this URL."})
}

// recordFields lists a record's field names, sorted so two searches can be
// diffed against each other.
func recordFields(rec any) []string {
	m, ok := rec.(map[string]any)
	if !ok {
		return nil
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// snippet renders an upstream response for a log line, capped so a full page of
// rows can't flood the log.
func snippet(data any, max int) string {
	if data == nil {
		return "<empty>"
	}
	s := fmt.Sprint(data)
	if b, err := json.Marshal(data); err == nil {
		s = string(b)
	}
	if len(s) > max {
		s = s[:max] + "…"
	}
	return s
}
