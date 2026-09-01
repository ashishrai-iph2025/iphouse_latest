package markscan

import "testing"

func TestPlatformForURLResolvesNamedPlatforms(t *testing.T) {
	cases := map[string]string{
		"https://www.facebook.com/groups/1406550424604001?multi_permalinks=1406550734603970/": "facebook",
		"https://m.facebook.com/watch/?v=123":                                                 "facebook",
		"https://mbasic.facebook.com/story.php?story_fbid=9":                                  "facebook",
		"https://fb.watch/abc123/":                                                            "facebook",
		"https://www.instagram.com/reel/Cxyz/":                                                "instagram",
		"https://youtu.be/dQw4w9WgXcQ":                                                        "youtube",
		"https://m.youtube.com/watch?v=dQw4w9WgXcQ":                                           "youtube",
		"https://x.com/someone/status/1":                                                      "twitter",
		"https://twitter.com/someone/status/1":                                                "twitter",
		"https://t.me/somechannel/42":                                                         "telegram",
		"https://vm.tiktok.com/ZS123/":                                                        "tiktok",
		"https://vkvideo.ru/video-1_2":                                                        "vk",
		"https://ok.ru/video/123":                                                             "ok",
		"https://www.dailymotion.com/video/x9abc":                                             "dailymotion",
		"https://b23.tv/abc":                                                                  "bilibili",
		"https://chomikuj.pl/some.file":                                                       "chomikuj",
		"https://apps.apple.com/us/app/thing/id123":                                           "i-tunes",
		"https://play.google.com/store/apps/details?id=com.thing":                             "play store",
		// Scheme-less input is what a paste out of a spreadsheet looks like.
		"www.facebook.com/groups/1": "facebook",
	}
	for raw, want := range cases {
		if got := PlatformForURL(raw); got != want {
			t.Errorf("PlatformForURL(%q) = %q, want %q", raw, got, want)
		}
	}
}

func TestPlatformForURLLeavesOpenWebUnresolved(t *testing.T) {
	// No named platform — the caller reads "" as Open Web. music.apple.com is
	// the case an "apple.com" suffix entry would wrongly claim as an app store.
	for _, raw := range []string{
		"https://some-pirate-site.ru/watch/match-live",
		"https://music.apple.com/us/album/x/1",
		"https://notfacebook.com/groups/1",
		"",
		"not a url",
	} {
		if got := PlatformForURL(raw); got != "" {
			t.Errorf("PlatformForURL(%q) = %q, want \"\"", raw, got)
		}
	}
}
