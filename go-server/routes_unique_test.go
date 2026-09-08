package main

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

/*
No route may be registered twice.

This is not a style rule. http.ServeMux PANICS on a duplicate pattern, so a
second registration of the same method and path does not fail to build, does not
fail a request, and does not degrade anything — it stops the service from
starting at all. The failure arrives at deploy time as a container that will not
come up, with a message naming a route rather than the change that added it.

It happened: the asset register was first wired to /api/admin/asset-access,
which admin.AssetAccess already owned. The code compiled and the tests passed.
Nothing in Go would have said a word until boot.

Read from source rather than by building the mux, because building it needs a
database, a config and every dependency main() wires up — and this needs to fail
in a second, next to the edit that caused it.
*/
func TestEveryRouteIsRegisteredOnce(t *testing.T) {
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("read main.go: %v", err)
	}

	// mux.Handle("GET /api/thing", …) and mux.HandleFunc("POST /api/thing", …)
	re := regexp.MustCompile(`mux\.Handle(?:Func)?\(\s*"([A-Z]+ /[^"]*|/[^"]*)"`)
	matches := re.FindAllStringSubmatch(string(src), -1)
	if len(matches) < 50 {
		t.Fatalf("found only %d routes in main.go — the pattern this test scans "+
			"for has changed and it is no longer checking anything", len(matches))
	}

	seen := map[string]int{}
	for _, m := range matches {
		seen[m[1]]++
	}

	dupes := []string{}
	for pattern, n := range seen {
		if n > 1 {
			dupes = append(dupes, pattern)
		}
	}
	if len(dupes) > 0 {
		t.Errorf("registered more than once: %s\n\n"+
			"http.ServeMux panics on a duplicate pattern, so this does not "+
			"misbehave at runtime — the service will not start. Give the new "+
			"route its own path, or replace the handler on the existing one.",
			strings.Join(dupes, ", "))
	}
}
