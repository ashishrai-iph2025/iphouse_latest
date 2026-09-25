package handlers

import (
	"net/url"
	"testing"

	"github.com/ip-house/iphouse-api/reportsapi"
)

func TestOpenWebBatchScope(t *testing.T) {
	ds := reportsapi.Dataset{Key: "open-web", DateFromParam: "URLUploadDateFrom", DateToParam: "URLUploadDateTo"}
	base := func() url.Values {
		return url.Values{
			"ClientId":          {"C1"},
			"URLUploadDateFrom": {"2026-08-26"},
			"URLUploadDateTo":   {"2026-09-23"},
		}
	}

	// Client + window, plus the three narrowings the endpoint applies.
	sc := base()
	sc.Set("assetId", "A1")
	sc.Set("genre", "Movies")
	sc.Set("domain", "x.com")
	q, ok := openWebBatchScope(ds, sc)
	if !ok {
		t.Fatal("client, window, asset, genre and domain should all be honoured")
	}
	for k, want := range map[string]string{"clientId": "C1", "from": "2026-08-26", "to": "2026-09-23",
		"assetId": "A1", "genre": "Movies", "domain": "x.com"} {
		if got := q.Get(k); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}

	/* Any other narrowing must leave the figure OUT — the endpoint would ignore
	   it and return the unfiltered count under a filtered page. */
	for _, k := range []string{"language", "pageNoBucket", brandDomainsParam} {
		sc := base()
		sc.Set(k, "v")
		if _, ok := openWebBatchScope(ds, sc); ok {
			t.Errorf("a scope narrowed by %q was accepted; the batch count would ignore it", k)
		}
	}
}
