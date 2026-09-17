package handlers

/*
ONE SUBMISSION IS ONE SUBMISSION, however many platforms it spans.

The reader pastes a list of URLs and presses one button. Upstream takes one
platform per call, so that one action becomes several calls — and for as long as
the fan-out lived in the browser, everything ELSE about the submission was fanned
out with it: a confirmation email per platform, and the admin bell rung per
platform, for one press of one button.

The fix was to move the fan-out behind this handler, which makes the property
worth pinning a property of these helpers: the email and the bell are given ONE
label and ONE URL list, built from every group that actually landed.
*/

import (
	"strings"
	"testing"
)

/*
The email names every platform that landed, once each.

The templates take a single platform string and print it on a line labelled
"Platform" — so a batch has to arrive there as a list, and "Open Web, YouTube" is
a true answer to that question where a second email would have been two half
answers.

Deduplicated because two tokens can resolve to the same display name, and a
receipt reading "Other UGC, Other UGC" says the submission went somewhere twice.
*/
func TestUploadPlatformsLabelNamesEachPlatformOnce(t *testing.T) {
	got := uploadPlatformsLabel([]uploadGroup{
		{Platform: "internet", URLs: []string{"https://a.example/1"}},
		{Platform: "youtube", URLs: []string{"https://youtube.com/watch?v=1"}},
	})
	for _, want := range []string{platformDisplay("internet"), platformDisplay("youtube")} {
		if !strings.Contains(got, want) {
			t.Errorf("label %q does not name %q — the one email would not say where "+
				"half the submission went", got, want)
		}
	}
	if strings.Count(got, ",") != 1 {
		t.Errorf("label %q, want exactly two platforms joined by one comma", got)
	}

	// The same platform twice — which a caller can send, and which must not read
	// as two destinations.
	got = uploadPlatformsLabel([]uploadGroup{
		{Platform: "internet", URLs: []string{"https://a.example/1"}},
		{Platform: "internet", URLs: []string{"https://b.example/2"}},
	})
	if strings.Contains(got, ",") {
		t.Errorf("label %q repeats a platform", got)
	}

	// An empty batch has nothing to name and must not produce a stray comma.
	if got = uploadPlatformsLabel(nil); got != "" {
		t.Errorf("label for no groups = %q, want empty", got)
	}
}

/*
The email lists every URL in the submission, not one platform's share.

This is the other half of "one email": a single confirmation that names two
platforms but lists only one of their URLs is worse than the two emails it
replaced, because the reader has no way to tell the list is partial.
*/
func TestUploadAllURLsCoversEveryGroup(t *testing.T) {
	groups := []uploadGroup{
		{Platform: "internet", URLs: []string{"https://a.example/1", "https://b.example/2"}},
		{Platform: "youtube", URLs: []string{"https://youtube.com/watch?v=1"}},
	}
	if n := uploadURLCount(groups); n != 3 {
		t.Errorf("uploadURLCount = %d, want 3", n)
	}
	all := uploadAllURLs(groups)
	if len(all) != 3 {
		t.Fatalf("uploadAllURLs returned %d of 3: %v", len(all), all)
	}
	for _, g := range groups {
		for _, u := range g.URLs {
			var found bool
			for _, a := range all {
				if a == u {
					found = true
				}
			}
			if !found {
				t.Errorf("%s is missing from the email's URL list", u)
			}
		}
	}

	// The bell carries the keys rather than the labels, so a consumer filtering
	// notifications by platform has the value the rest of the API uses.
	keys := uploadPlatformKeys(groups)
	if len(keys) != 2 || keys[0] != "internet" || keys[1] != "youtube" {
		t.Errorf("uploadPlatformKeys = %v, want the platform keys in order", keys)
	}
}

/*
An empty group is not a platform the submission touched.

The page can produce one — a platform chip whose URLs were all edited away
between render and submit — and letting it through would name a platform in the
confirmation email that nothing was sent to. uploadPushGroups skips them before
the upstream call; these two helpers have to agree, or the count in the email
disagrees with the list under it.
*/
func TestEmptyGroupsCountForNothing(t *testing.T) {
	groups := []uploadGroup{
		{Platform: "internet", URLs: []string{"https://a.example/1"}},
		{Platform: "telegram", URLs: nil},
	}
	if n := uploadURLCount(groups); n != 1 {
		t.Errorf("uploadURLCount = %d, want 1 — an empty group adds no URLs", n)
	}
	if all := uploadAllURLs(groups); len(all) != 1 {
		t.Errorf("uploadAllURLs = %v, want just the one real URL", all)
	}
}

/*
THE PLATFORM ON THE WIRE IS THE PLATFORM THE READER'S URLS WERE ROUTED TO.

Pinned because rewriting it is a plausible-looking fix that makes things worse,
and this test is the record of that having been tried. A 400 on the UGC umbrella
reads as "PushInfringements does not accept this platform", and the apparent
remedy is to substitute a platform it does accept — one of the seven named UGC
keys, which share the same store upstream.

It is not what the API is saying. It validates each URL's DOMAIN against the
platform and answers "Domain is of different platform kwai.com". The umbrella
itself is accepted, verified against the live API:

	{"platform": "UGC And Other Social Media", "urls": ["https://www.snackvideo.com/…"]}
	→ 200 "Successfully added 1 infringements."

So substituting any other platform — even another UGC one — turns a submission
that would have worked into that exact error, for every URL whose domain is not
the site it was rewritten to.
*/
func TestThePlatformOnTheWireIsNotRewritten(t *testing.T) {
	for _, platform := range []string{
		// The one it is tempting to rewrite. It must go up exactly as it is.
		"UGC And Other Social Media",
		"UGC & Other Social Media",
		// The named UGC platforms travel under the umbrella in practice, but if
		// one is ever chosen it is still sent as itself, not translated.
		"tiktok", "vk", "ok", "sharechat", "dailymotion", "bilibili", "chomikuj",
		// The separately categorised platforms.
		"youtube", "facebook", "instagram", "twitter", "telegram", "internet",
	} {
		g := uploadGroup{Platform: platform, URLs: []string{"https://www.snackvideo.com/@x/video/1"}}
		_, payload, err := uploadPayloadFor(g, "Some Asset", "https://official.example/x", "", "a@example.com")
		if err != nil {
			t.Fatalf("%s: %v", platform, err)
		}
		body, ok := payload.(map[string]any)
		if !ok {
			t.Fatalf("%s: payload is %T", platform, payload)
		}
		if body["platform"] != platform {
			t.Errorf("platform %q went on the wire as %q — the API checks the URL's "+
				"domain against this value and answers 'Domain is of different "+
				"platform' when they disagree", platform, body["platform"])
		}
	}
}

/*
Open Web and third-party apps use the other endpoint, and nothing else does.

They carry a source URL per infringing URL; everything else posts a plain list.
Choosing the wrong one is a 400 with no obvious connection to the platform that
caused it, and the test is on the platform string, so it is worth a case each.
*/
func TestTheEndpointFollowsThePlatform(t *testing.T) {
	for _, c := range []struct{ platform, want string }{
		{"internet", "PushInfringementswithSource"},
		{"ThirdPartyApp", "PushInfringementswithSource"},
		{"UGC And Other Social Media", "PushInfringements"},
		{"youtube", "PushInfringements"},
		{"telegram", "PushInfringements"},
	} {
		got, _, err := uploadPayloadFor(
			uploadGroup{Platform: c.platform, URLs: []string{"https://x.example/1"}},
			"Some Asset", "https://official.example/x", "", "a@example.com")
		if err != nil {
			t.Fatalf("%s: %v", c.platform, err)
		}
		if got != c.want {
			t.Errorf("%s posts to %s, want %s", c.platform, got, c.want)
		}
	}

	// The source endpoint cannot be called without one, and failing here fails
	// only this group rather than the whole submission.
	if _, _, err := uploadPayloadFor(
		uploadGroup{Platform: "internet", URLs: []string{"https://x.example/1"}},
		"Some Asset", "", "", "a@example.com"); err == nil {
		t.Error("a source-platform group with no official URL was accepted")
	}
}

/*
A failed submission says WHY.

The reader gets this in a toast, and "API error 400" gives them nothing to act
on — not which field, not whether retrying would help. postRaw already decodes
the body; it was simply being discarded.

The known keys are tried first and the whole body is the fallback. That order
matters: a message field is a sentence written for a person, and reaching for it
before dumping JSON is the difference between "Invalid platform" and a brace.
Dumping the body is still better than nothing, because this API does not always
use one of those keys and the detail is then only in the shape.
*/
func TestUpstreamDetailReadsTheBody(t *testing.T) {
	for _, c := range []struct {
		name string
		in   any
		want string
	}{
		{"message key", map[string]any{"message": "Invalid platform"}, " — Invalid platform"},
		{"Error key", map[string]any{"Error": "asset not found"}, " — asset not found"},
		{"plain string body", "Bad Request: platform", " — Bad Request: platform"},
		// A body with no key this knows still carries its detail in the shape,
		// so it goes through verbatim rather than being thrown away.
		{"unknown shape", map[string]any{"urls": "too many"}, ` — {"urls":"too many"}`},
		// Nothing to say, and nothing said: an empty suffix leaves the caller's
		// "API error 400" reading as it did before.
		{"no body", nil, ""},
		{"empty string body", "", ""},
	} {
		if got := upstreamDetail(c.in); got != c.want {
			t.Errorf("%s: upstreamDetail(%v) = %q, want %q", c.name, c.in, got, c.want)
		}
	}

	// A long body is cut down: this ends in a notification, and a wall of JSON
	// there is less informative than a sentence, not more.
	long := map[string]any{"message": strings.Repeat("x", 500)}
	if got := upstreamDetail(long); len(got) > 210 {
		t.Errorf("a %d-character detail reached the toast; it must be truncated", len(got))
	}
}
