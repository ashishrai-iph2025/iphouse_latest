package handlers

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"

	"github.com/ip-house/iphouse-api/markscan"
)

// POST /api/enforce
func Enforce(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	apiToken := ResolveAPIToken(claims)
	if apiToken == "" {
		Fail(w, 401, "API token missing"); return
	}

	var body struct {
		ActionType  string `json:"actionType"`
		Platform    string `json:"platform"`
		AssetName   string `json:"assetName"`
		URLIDs      []any  `json:"urlids"`
		Comment     string `json:"comment"`
		IsSourceURL bool   `json:"isSourceURL"`
	}
	json.NewDecoder(r.Body).Decode(&body)

	if body.ActionType == "" || body.Platform == "" || len(body.URLIDs) == 0 || body.Comment == "" {
		Fail(w, 422, "Missing required fields"); return
	}

	payload := map[string]any{
		"platform": body.Platform, "assetName": body.AssetName,
		"urlids": body.URLIDs, "comment": body.Comment, "isSourceURL": body.IsSourceURL,
	}

	var status int
	var data any
	var err error
	if body.ActionType == "approved" {
		status, data, err = markscan.SendToEnforcementQc(apiToken, payload)
	} else {
		status, data, err = markscan.MarkAsInvalid(apiToken, payload)
	}
	if err != nil {
		Fail(w, 500, err.Error()); return
	}
	if status >= 400 {
		Fail(w, 502, "API error"); return
	}
	OK(w, map[string]any{"success": true, "data": data})
}

// POST /api/qc-urls
func QCUrls(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	apiToken := ResolveAPIToken(claims)
	if apiToken == "" {
		Fail(w, 401, "API token missing"); return
	}

	var body struct {
		Platform  string `json:"platform"`
		StartDate string `json:"startDate"`
		AssetName string `json:"assetName"`
	}
	json.NewDecoder(r.Body).Decode(&body)

	if body.Platform == "" {
		Fail(w, 422, "platform is required"); return
	}

	isInternet := strings.Contains(strings.ToLower(body.Platform), "internet")

	var records []any
	if isInternet {
		// Internet: fetch source URLs and infringing URLs in parallel
		var sourceData, infrData []any
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			sourceData, _ = markscan.GetDiscoveryQcURLs(apiToken, body.Platform, body.StartDate, body.AssetName, true)
		}()
		go func() {
			defer wg.Done()
			infrData, _ = markscan.GetDiscoveryQcURLs(apiToken, body.Platform, body.StartDate, body.AssetName, false)
		}()
		wg.Wait()
		for _, item := range sourceData {
			if m, ok := item.(map[string]any); ok {
				m["isSourceURL"] = true
				records = append(records, m)
			}
		}
		for _, item := range infrData {
			if m, ok := item.(map[string]any); ok {
				m["isSourceURL"] = false
				records = append(records, m)
			}
		}
	} else {
		records, _ = markscan.GetDiscoveryQcURLs(apiToken, body.Platform, body.StartDate, body.AssetName, true)
	}

	if records == nil {
		records = []any{}
	}
	OK(w, map[string]any{"success": true, "data": records, "total": len(records)})
}

// POST /api/qc-enforce
func QCEnforce(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	apiToken := ResolveAPIToken(claims)
	if apiToken == "" {
		Fail(w, 401, "API token missing"); return
	}

	var body any
	json.NewDecoder(r.Body).Decode(&body)

	status, data, err := markscan.QCEnforce(apiToken, body)
	if err != nil {
		Fail(w, 500, err.Error()); return
	}
	if status >= 400 {
		Fail(w, 502, "API error"); return
	}
	OK(w, map[string]any{"success": true, "data": data})
}
