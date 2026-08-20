package admin

import (
	"strings"
	"testing"
)

/*
Which http:// addresses save silently and which save with a warning.

Plain http is allowed everywhere now, so this classifier is the only thing left
deciding whether anyone is TOLD that the API key is about to travel in clear
text. Getting it wrong in one direction cries wolf on a container-to-container
URL until the warning is ignored; in the other it says nothing while the key
crosses the internet. Both are worth a test.
*/
func TestIsPrivateHost(t *testing.T) {
	private := []string{
		// The case this change exists for: a sibling container on the Docker
		// network, addressed by its Compose service name.
		"http://reports_api:8090",
		"http://reports-api:8090",
		"http://reports_api",

		"http://localhost:8090",
		"http://localhost",
		"http://api.localhost:3000",
		"http://127.0.0.1:8090",
		"http://127.1.2.3",
		"http://[::1]:8090",

		"http://10.0.0.5:8090",
		"http://172.16.4.1",
		"http://172.31.255.254",
		"http://192.168.1.20:8090",
		"http://169.254.10.10",
		"http://100.64.0.1",  // CGNAT / Tailscale
		"http://100.127.0.1", // top of the CGNAT range

		"http://reports.internal:8090",
		"http://reports.local",
		"http://box.lan",
		"http://reports-api.default.svc",
		"http://reports-api.default.svc.cluster.local:8090",
	}
	for _, u := range private {
		if !isPrivateHost(u) {
			t.Errorf("%s: classified public, so saving it would raise a warning about "+
				"a request that never leaves private infrastructure", u)
		}
	}

	public := []string{
		"http://api-reports.ip-house.in",
		"http://api-reports.ip-house.in:8090",
		"http://8.8.8.8",
		"http://172.32.0.1",  // just outside 172.16/12
		"http://172.15.0.1",  // just below it
		"http://100.63.0.1",  // just below CGNAT
		"http://100.128.0.1", // just above CGNAT
		"http://example.com",
	}
	for _, u := range public {
		if isPrivateHost(u) {
			t.Errorf("%s: classified private, so the key would be sent there in clear "+
				"text with nothing said about it", u)
		}
	}
}

/*
What actually reaches the screen.

The three cases that matter: the URL this change exists to allow saves with
nothing said; https says nothing whatever the host; and a public http address
still gets told, because that is the one where the key really is on the wire.
*/
func TestHTTPWarning(t *testing.T) {
	silent := []string{
		"http://reports_api:8090", // the Docker sibling — the whole point
		"http://localhost:8090",
		"http://192.168.1.20:8090",
		"https://api-reports.ip-house.in",
		"https://anything.example.com",
		"", // nothing typed
	}
	for _, u := range silent {
		if w := httpWarning(u); w != "" {
			t.Errorf("httpWarning(%q) = %q, want no warning", u, w)
		}
	}

	w := httpWarning("http://api-reports.ip-house.in:8090")
	if w == "" {
		t.Fatal("a public http:// address must still warn — the key crosses the internet in clear text")
	}
	// The host is named, or the reader has to work out which address it means.
	if !strings.Contains(w, "api-reports.ip-house.in") {
		t.Errorf("warning does not name the host: %q", w)
	}
	// It says the save happened. Wording that reads like a refusal sends someone
	// looking for a Save button that already worked.
	if !strings.Contains(w, "Saved") {
		t.Errorf("warning should make clear the save succeeded: %q", w)
	}
}

// The warning text names the host, so it has to survive a URL with a port, a
// path, or a shape net/url will not parse.
func TestHostOf(t *testing.T) {
	cases := map[string]string{
		"http://reports_api:8090":            "reports_api",
		"https://api-reports.ip-house.in":    "api-reports.ip-house.in",
		"http://localhost:8090/v1":           "localhost",
		"http://[::1]:8090":                  "::1",
		"http://192.168.1.20":                "192.168.1.20",
		"http://host with space:8090":        "host with space",
		"https://api-reports.ip-house.in:80": "api-reports.ip-house.in",
	}
	for in, want := range cases {
		if got := hostOf(in); got != want {
			t.Errorf("hostOf(%q) = %q, want %q", in, got, want)
		}
	}
}
