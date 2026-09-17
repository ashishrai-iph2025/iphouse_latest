package handlers

/*
Platform detection decides where a take-down notice is SENT, so every way it can
pick the wrong one is worth pinning.

None of them announces itself. A URL routed to the wrong platform submits
successfully, appears in the history, and is confirmed by email — it simply
arrives in a queue that is not the one handling that site. The three failures
below are the ones this code can produce on its own: a hostname read into the
wrong row, a site matched on a fragment of its name, and the column names of
another service changing underneath it.
*/

import "testing"

/*
A site is matched on a LABEL of its hostname, never on a substring.

"ok" appears inside kooapp.com and tokyvideo.com, and "vk" inside any hostname
that happens to contain those two letters. Matching the string would file all of
them under ok.ru and vk.com respectively — a wrong queue, reported as success.
*/
func TestUGCHostTokenMatchesWholeLabels(t *testing.T) {
	for _, c := range []struct{ host, want string }{
		// The seven with a MarkScan key of their own.
		{"tiktok.com", "tiktok"},
		{"vk.com", "vk"},
		{"m.vk.ru", "vk"},
		{"vkvideo.ru", "vk"},
		{"ok.ru", "ok"},
		{"dailymotion.com", "dailymotion"},
		{"bilibili.com", "bilibili"},
		{"sharechat.com", "sharechat"},
		{"chomikuj.pl", "chomikuj"},

		/* The substring traps. Every one of these is a real row in the table and
		   none of them is the platform its letters suggest. */
		{"kooapp.com", ugcUmbrellaToken},
		{"tokyvideo.com", ugcUmbrellaToken},
		{"bigo.tv", ugcUmbrellaToken},
		{"veoh.com", ugcUmbrellaToken},

		// Everything else is the umbrella, which is a real destination rather
		// than a fallback: /UGCPlatform/Paged serves all 185 of them.
		{"reddit.com", ugcUmbrellaToken},
		{"", ugcUmbrellaToken},
	} {
		if got := ugcHostTokenFor(c.host); got != c.want {
			t.Errorf("ugcHostTokenFor(%q) = %q, want %q", c.host, got, c.want)
		}
	}
}

/*
The rows are read under BOTH spellings the master has used.

reports_api publishes the hostname as UGCDomain and the label as UGCDomainName.
An older build of it published the same two columns as Domain and Name, and the
portal and that service are deployed separately — so there is a window in which
the portal is asking a service that answers with the old names.

Without the fallback that window is an empty platform list, and an empty list
does not look broken: detection silently reverts to the built-in host set and
every unrecognised site goes in as Open Web, exactly as it did before any of this
existed. Nothing on screen says so.
*/
func TestUGCRowsReadBothColumnSpellings(t *testing.T) {
	// The current spelling.
	rows := ugcRowsFrom([]map[string]any{
		{"UGCDomainID": "FF265427", "UGCDomainName": "BIGO LIVE", "UGCDomain": "bigo.tv",
			"PlatformType": "UGC", "ReportingMethod": "Email", "Active": 1},
	})
	if len(rows) != 1 || rows[0].Domain != "bigo.tv" || rows[0].Site != "BIGO LIVE" {
		t.Fatalf("current spelling read as %+v", rows)
	}
	if rows[0].PlatformType != "UGC" {
		t.Errorf("PlatformType = %q, want UGC", rows[0].PlatformType)
	}

	// The spelling an older reports_api answers with.
	rows = ugcRowsFrom([]map[string]any{
		{"Id": "FF265427", "Name": "BIGO LIVE", "Domain": "bigo.tv", "PlatformType": "UGC"},
	})
	if len(rows) != 1 || rows[0].Domain != "bigo.tv" || rows[0].Site != "BIGO LIVE" {
		t.Fatalf("legacy spelling read as %+v — the portal would see no sites at all "+
			"against a service that has not been redeployed yet", rows)
	}
}

/*
The hostnames arrive dirtier than the column name suggests, and are cleaned.

Measured on the live table: one row holds "https://vkvideo.ru/" with a scheme and
a trailing slash, several hold mixed case ("Bilibili.tv", "SnapChat.com"), and one
label carries a leading space. A URL's host never looks like any of that, so an
uncleaned row is a row that can never match anything — it is not an error, it is
a site that silently stops being detected.

A row with no usable hostname is DROPPED. Kept, its empty domain would match the
empty host of an unparseable URL and route it somewhere arbitrary.
*/
func TestUGCRowsNormaliseWhatTheTableActuallyHolds(t *testing.T) {
	rows := ugcRowsFrom([]map[string]any{
		{"UGCDomain": "https://vkvideo.ru/", "UGCDomainName": "VK Video", "PlatformType": "Social Media"},
		{"UGCDomain": "Bilibili.tv", "UGCDomainName": "Bilibili.tv", "PlatformType": "Social Media"},
		{"UGCDomain": "  SnapChat.com  ", "UGCDomainName": " SnapChat ", "PlatformType": "Social Media"},
		{"UGCDomain": "", "UGCDomainName": "nameless", "PlatformType": "UGC"},
	})

	got := map[string]UGCDomain{}
	for _, r := range rows {
		got[r.Domain] = r
	}
	for _, want := range []string{"vkvideo.ru", "bilibili.tv", "snapchat.com"} {
		if _, ok := got[want]; !ok {
			t.Errorf("%s is not in the index; it holds %v", want, keysOfUGC(got))
		}
	}
	if len(rows) != 3 {
		t.Errorf("got %d rows, want 3 — the row with no hostname must be dropped, "+
			"or it matches every URL that would not parse", len(rows))
	}
	if s := got["snapchat.com"].Site; s != "SnapChat" {
		t.Errorf("site name is %q, want it trimmed to SnapChat", s)
	}
	// The scheme-carrying row still has to reach the right platform token.
	if tok := got["vkvideo.ru"].Token; tok != "vk" {
		t.Errorf("vkvideo.ru token = %q, want vk", tok)
	}
}

/*
A domain listed twice yields ONE entry.

Five domains carry two rows each — the same site entered once under a display
name and once under its own hostname, so bsky.app arrives as both "BlueSky" and
"bsky.app". They agree about the platform, so which one wins does not change
routing; what matters is that the index does not end up with the second silently
shadowing the first on every fetch, which would make the site label flicker
between two values for no reason a reader could see.
*/
func TestUGCRowsDropDuplicateDomains(t *testing.T) {
	rows := ugcRowsFrom([]map[string]any{
		{"UGCDomain": "bsky.app", "UGCDomainName": "BlueSky", "PlatformType": "UGC"},
		{"UGCDomain": "bsky.app", "UGCDomainName": "bsky.app", "PlatformType": "UGC"},
	})
	if len(rows) != 1 {
		t.Fatalf("got %d rows for one domain, want 1: %+v", len(rows), rows)
	}
	if rows[0].Site != "BlueSky" {
		t.Errorf("site = %q; the first row seen should stand", rows[0].Site)
	}
}

// keysOfUGC names what an index actually holds, for a failure message that says
// which domain is missing rather than only that one is.
func keysOfUGC(m map[string]UGCDomain) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
