package markscan

import "strings"

/*
Resolving a platform from a URL alone.

Search & Retrieve asks MarkScan for one record by URL, and /SearchandRetriveapi
routes that lookup by the `platform` field it is given — the same platform
vocabulary as infringementEndpoints. The client screen deliberately asks for
nothing but a URL, so the platform has to be derived here, from the host, before
the call goes out. Sending "" leaves the endpoint with nothing to route on and
every search comes back empty.

Hosts that match nothing are NOT an error: the open web is where a URL belongs
when it is on no named platform, so the caller treats "" as "internet".
*/

// urlPlatformHosts maps a host (or any subdomain of it) to the platform key
// MarkScan knows it by — the keys of infringementEndpoints, not display labels.
// Mirrors ugcDomainPlatforms for the UGC platforms and extends it with the
// named ones; the two differ in what they return (wire key vs row label), which
// is why they are not the same map.
var urlPlatformHosts = map[string]string{
	// Named platforms, each with its own upstream endpoint.
	"facebook.com":         "facebook",
	"fb.com":               "facebook",
	"fb.watch":             "facebook",
	"fb.me":                "facebook",
	"instagram.com":        "instagram",
	"instagr.am":           "instagram",
	"youtube.com":          "youtube",
	"youtu.be":             "youtube",
	"youtube-nocookie.com": "youtube",
	"twitter.com":          "twitter",
	"x.com":                "twitter",
	"t.co":                 "twitter",
	"t.me":                 "telegram",
	"telegram.me":          "telegram",
	"telegram.org":         "telegram",

	// UGC platforms — one endpoint, selected by the platform value.
	"tiktok.com":       "tiktok",
	"vk.com":           "vk",
	"vkvideo.ru":       "vk",
	"ok.ru":            "ok",
	"odnoklassniki.ru": "ok",
	"sharechat.com":    "sharechat",
	"dailymotion.com":  "dailymotion",
	"dai.ly":           "dailymotion",
	"bilibili.com":     "bilibili",
	"bilibili.tv":      "bilibili",
	"b23.tv":           "bilibili",
	"chomikuj.pl":      "chomikuj",

	// App stores. Exact hosts: music.apple.com is not an app listing, and the
	// suffix match below would claim it from a bare "apple.com" entry.
	"apps.apple.com":   "i-tunes",
	"itunes.apple.com": "i-tunes",
	"play.google.com":  "play store",
}

// PlatformForURL returns the MarkScan platform key a URL belongs to, or "" when
// its host is on no named platform. Matches the host itself or any subdomain of
// it, so m.facebook.com, web.facebook.com and mbasic.facebook.com all resolve.
func PlatformForURL(rawURL string) string {
	host := hostOf(rawURL)
	if host == "" {
		return ""
	}
	// Longest suffix wins, so overlapping entries resolve the same way on every
	// run — ranging over the map alone would pick either match at random.
	best, bestLen := "", 0
	for suffix, platform := range urlPlatformHosts {
		if host != suffix && !strings.HasSuffix(host, "."+suffix) {
			continue
		}
		if len(suffix) > bestLen {
			best, bestLen = platform, len(suffix)
		}
	}
	return best
}
