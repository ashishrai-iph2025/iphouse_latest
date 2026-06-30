package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/ip-house/iphouse-api/markscan"
)

// GET /api/download — list download requests
func DownloadList(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	apiToken := ResolveAPIToken(claims)
	if apiToken == "" {
		Fail(w, 401, "API token missing"); return
	}

	raw, err := markscan.GetDownloadStatus(apiToken)
	if err != nil {
		Fail(w, 500, err.Error()); return
	}

	var rows []any
	switch v := raw.(type) {
	case []any:
		rows = v
	case map[string]any:
		if d, ok := v["data"].([]any); ok {
			rows = d
		}
	}

	items := make([]map[string]any, 0, len(rows))
	for _, r := range rows {
		m, ok := r.(map[string]any)
		if !ok {
			continue
		}
		items = append(items, map[string]any{
			"id":        coalesce(m, "id", "Id", "requestId"),
			"platform":  coalesce(m, "platform", "Platform"),
			"assetName": coalesce(m, "assetName", "AssetName", "asset_name"),
			"startDate": coalesce(m, "startDate", "StartDate", "start_date"),
			"endDate":   coalesce(m, "endDate", "EndDate", "end_date"),
			"processed": coalesce(m, "processed", "Processed"),
		})
	}
	OK(w, map[string]any{"success": true, "items": items})
}

// POST /api/download — trigger download
func DownloadTrigger(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	apiToken := ResolveAPIToken(claims)
	if apiToken == "" {
		Fail(w, 401, "API token missing"); return
	}

	var body struct {
		Platform  string `json:"platform"`
		AssetName string `json:"assetName"`
		StartDate string `json:"startDate"`
		EndDate   string `json:"endDate"`
	}
	json.NewDecoder(r.Body).Decode(&body)

	if body.Platform == "" && body.AssetName == "" {
		Fail(w, 422, "Platform or Asset Name is required"); return
	}

	payload := map[string]any{}
	if body.Platform != "" {
		payload["platform"] = body.Platform
	}
	if body.AssetName != "" {
		payload["assetName"] = body.AssetName
	}
	if body.StartDate != "" {
		payload["startDate"] = body.StartDate
	}
	if body.EndDate != "" {
		payload["endDate"] = body.EndDate
	}

	status, err := markscan.TriggerDownload(apiToken, payload)
	if err != nil {
		Fail(w, 500, err.Error()); return
	}
	if status >= 400 {
		Fail(w, 502, "API error"); return
	}
	OK(w, map[string]any{"success": true, "message": "Download request submitted. Check history for status."})
}

// GET /api/download/{id} — get file URL
func DownloadByID(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	apiToken := ResolveAPIToken(claims)
	if apiToken == "" {
		Fail(w, 401, "API token missing"); return
	}

	id := r.PathValue("id")
	if id == "" {
		// fallback for non-1.22 path matching
		id = strings.TrimPrefix(r.URL.Path, "/api/download/")
	}
	if id == "" {
		Fail(w, 400, "id required"); return
	}

	url, err := markscan.GetDownloadUrl(apiToken, id)
	if err != nil || url == "" {
		Fail(w, 502, "Failed to get download URL"); return
	}
	OK(w, map[string]any{"success": true, "url": url})
}

func coalesce(m map[string]any, keys ...string) any {
	for _, k := range keys {
		if v, ok := m[k]; ok && v != nil {
			return v
		}
	}
	return nil
}
