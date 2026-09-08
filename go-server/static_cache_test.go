package main

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

/*
The entry document must be revalidated; the hashed assets may be cached for ever.

This is one rule with two halves, and it is worth a test because breaking it is
invisible until a deploy and then presents as a DIFFERENT bug every time.

index.html names the content-hashed bundles. Served without Cache-Control it
carries only Last-Modified, and a browser is then free to invent its own
freshness and reuse it without asking. A returning reader loads the previous
index.html, which names the previous chunks, and runs an old bundle against a
new server.

That is how the ghost "Realtime / No data." card reached the report: the server
had gained a panel kind the cached bundle had no case for, so it fell through a
catch-all and drew an empty breakdown. The report of it was "wrong on the first
visit, right after a refresh" — which is the signature of exactly this, since a
reload revalidates.

Read from source rather than by starting the server, because starting it needs a
database, a config and every dependency main() wires up, and this has to fail
next to the edit that caused it.
*/
func TestStaticFilesCarryTheRightCacheHeaders(t *testing.T) {
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("read main.go: %v", err)
	}
	body := string(src)

	// The static handler, isolated: everything from the FileServer to the end of
	// the closure it is used in.
	start := strings.Index(body, "staticFS := http.FileServer")
	if start < 0 {
		t.Fatal("no static file handler in main.go — this test is checking nothing")
	}
	tail := body[start:]
	if end := strings.Index(tail, "\n\taddr := "); end > 0 {
		tail = tail[:end]
	}

	if !strings.Contains(tail, "Cache-Control") {
		t.Fatal("the static handler sets no Cache-Control. index.html then carries " +
			"only Last-Modified, a browser reuses it on its own judgement, and a " +
			"returning reader runs the previous bundle against the current server.")
	}

	/*
		The SPA fallback is the entry document for every route on the site, so it
		is the one that must never be reused without asking. Checked by finding
		the fallback branch and requiring a revalidating directive BEFORE the
		ServeFile in it — set afterwards, the header would be written too late,
		because ServeFile has already flushed the response head.
	*/
	fb := strings.Index(tail, "SPA fallback")
	if fb < 0 {
		t.Fatal("could not find the SPA fallback branch")
	}
	serve := strings.Index(tail[fb:], "http.ServeFile")
	if serve < 0 {
		t.Fatal("the SPA fallback no longer serves a file")
	}
	before := tail[fb : fb+serve]
	if !strings.Contains(before, "Cache-Control") {
		t.Error("the SPA fallback does not set Cache-Control before ServeFile. " +
			"Set after it the header is dropped — ServeFile has already written " +
			"the response head — so index.html goes out uncacheable-by-accident " +
			"rather than must-revalidate.")
	}
	if !cacheDirectiveNear(tail, "no-cache") {
		t.Error("no no-cache directive anywhere in the static handler; the entry " +
			"document has to be revalidated on every visit or a deploy does not " +
			"reach anyone who has been here before")
	}

	/*
		And the other half. Without a long cache on /assets every reload re-fetches
		a megabyte of JavaScript that cannot have changed — the filename is its
		content hash. immutable is what tells the browser not even to ask.
	*/
	if !strings.Contains(tail, "/assets/") {
		t.Error("the handler does not distinguish /assets/ — the hashed bundles " +
			"are then revalidated on every reload, which is a round trip per file " +
			"for something whose name changes when it changes")
	}
	if !strings.Contains(tail, "immutable") {
		t.Error("the hashed assets are not marked immutable")
	}

	/*
		The long cache must apply ONLY to hashed names. index.html, the logos and
		the favicon keep their names across builds, so a year on one of those pins
		a stale copy with nothing to bust it.

		Checked by where the immutable header is SET, not by where its value is
		declared. The first version of this test looked for an /assets/ mention
		near the max-age literal, found the const block it is declared in, and
		failed on correct code.
	*/
	guard := strings.Index(tail, `strings.HasPrefix(r.URL.Path, "/assets/")`)
	if guard < 0 {
		t.Fatal("the immutable cache is not guarded by an /assets/ prefix check")
	}
	branch := tail[guard:] // the body of that if, up to its else
	if e := strings.Index(branch, "} else {"); e > 0 {
		branch = branch[:e]
	}
	if !strings.Contains(branch, "immutable") {
		t.Error("the /assets/ branch does not set the immutable cache — so either " +
			"the hashed bundles are revalidated on every reload, or the long cache " +
			"is applied outside /assets/ where no filename change can bust it")
	}

	// And exactly one long max-age exists: the value that branch uses. A second
	// is a name with a year-long cache and nothing to bust it.
	longCache := regexp.MustCompile(`max-age=\d{6,}`)
	if n := len(longCache.FindAllString(tail, -1)); n != 1 {
		t.Errorf("found %d long max-age values in the static handler, want exactly "+
			"one — the hashed assets", n)
	}
}

// cacheDirectiveNear reports whether the directive appears in a Cache-Control
// value rather than only in prose — a comment mentioning no-cache is not a
// header.
func cacheDirectiveNear(src, directive string) bool {
	for _, line := range strings.Split(src, "\n") {
		l := strings.TrimSpace(line)
		if strings.HasPrefix(l, "//") || strings.HasPrefix(l, "/*") || strings.HasPrefix(l, "*") {
			continue
		}
		if strings.Contains(l, directive) && (strings.Contains(l, "=") || strings.Contains(l, "\"")) {
			return true
		}
	}
	return false
}
