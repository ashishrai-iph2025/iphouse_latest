package reportsapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// A POST that meets a 302 must reach the new address as a POST, key attached —
// the staging failure was it arriving as a GET and being answered 405.
func TestRedirectKeepsPost(t *testing.T) {
	var gotMethod, gotKey string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/old" {
			http.Redirect(w, r, "/new?"+r.URL.RawQuery, http.StatusFound)
			return
		}
		gotMethod, gotKey = r.Method, r.Header.Get("X-API-Key")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	hc := &http.Client{CheckRedirect: keepMethodOnRedirect}
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/old?scope=traffic", nil)
	req.Header.Set("X-API-Key", "k")
	resp, err := hc.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if gotMethod != http.MethodPost {
		t.Errorf("redirected POST arrived as %s", gotMethod)
	}
	if gotKey != "k" {
		t.Errorf("API key lost on redirect: %q", gotKey)
	}
}
