package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/ip-house/iphouse-api/markscan"
)

// POST /api/search
func Search(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	apiToken := ResolveAPIToken(claims)
	if apiToken == "" {
		Fail(w, 401, "API token missing"); return
	}

	var body struct {
		URL      string `json:"url"`
		Platform string `json:"platform"`
		IsSrcURL bool   `json:"isSrcUrl"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if body.URL == "" {
		Fail(w, 422, "URL is required"); return
	}

	httpStatus, data, err := markscan.SearchByUrl(apiToken, body.URL, body.Platform, body.IsSrcURL)
	if err != nil {
		Fail(w, 502, err.Error()); return
	}
	if httpStatus == 401 || httpStatus == 403 {
		Fail(w, 401, "API token expired. Please re-login."); return
	}
	if httpStatus >= 400 || data == nil {
		OK(w, map[string]any{"success": false, "error": "No results found or API error"}); return
	}
	OK(w, map[string]any{"success": true, "data": data})
}
