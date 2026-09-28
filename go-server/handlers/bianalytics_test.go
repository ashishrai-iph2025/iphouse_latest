package handlers

import "testing"

func TestBIRule(t *testing.T) {
	cases := []struct {
		bi, tr, to, wantT, wantR bool
	}{
		{false, false, false, false, false}, // nothing granted
		{true, false, false, true, true},    // the tab alone is the whole of BI
		{true, false, true, false, true},    // torrent assigned → only torrent
		{false, true, false, true, false},   // a page without the tab still opens
		{true, true, true, true, true},
	}
	for _, c := range cases {
		gT, gR := biRule(c.bi, c.tr, c.to)
		if gT != c.wantT || gR != c.wantR {
			t.Errorf("biRule(%v,%v,%v) = %v,%v; want %v,%v", c.bi, c.tr, c.to, gT, gR, c.wantT, c.wantR)
		}
	}
}

func TestApplyBIDropdown(t *testing.T) {
	drop := map[string][]map[string]any{PageBI: {
		{"label": "Traffic Analysis", "href": biTrafficHref},
		{"label": "Torrent Analysis", "href": biTorrentHref},
	}}
	hrefs := func(ms []map[string]any) []string {
		for _, m := range ms {
			if m["pageName"] == PageBI {
				out := []string{}
				for _, d := range m["dropdown"].([]map[string]any) {
					out = append(out, d["href"].(string))
				}
				return out
			}
		}
		return nil
	}

	// Tab + torrent only → the dropdown holds torrent alone.
	got := hrefs(applyBIDropdown([]map[string]any{
		{"pageName": "businessintelligence", "navOrder": 5},
		{"pageName": PageBITorrent, "navOrder": 6},
	}, drop))
	if len(got) != 1 || got[0] != biTorrentHref {
		t.Fatalf("tab+torrent: got %v", got)
	}

	// Tab alone → both.
	if got := hrefs(applyBIDropdown([]map[string]any{{"pageName": PageBI}}, drop)); len(got) != 2 {
		t.Fatalf("tab alone: got %v", got)
	}

	// Traffic alone, no tab → the tab is added, holding traffic.
	got = hrefs(applyBIDropdown([]map[string]any{{"pageName": PageBITraffic, "navOrder": 3}}, drop))
	if len(got) != 1 || got[0] != biTrafficHref {
		t.Fatalf("traffic alone: got %v", got)
	}

	// Nothing BI → untouched.
	if hrefs(applyBIDropdown([]map[string]any{{"pageName": "Reports"}}, drop)) != nil {
		t.Fatal("non-BI login gained a BI tab")
	}
}
