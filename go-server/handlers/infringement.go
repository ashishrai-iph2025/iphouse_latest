package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/ip-house/iphouse-api/markscan"
)

// POST /api/infringement
func Infringement(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	apiToken := ResolveAPIToken(claims)
	if apiToken == "" {
		Fail(w, 401, "API token missing. Please re-login."); return
	}

	var body struct {
		Platform  string `json:"platform"`
		StartDate string `json:"startDate"`
		EndDate   string `json:"endDate"`
		AssetName string `json:"assetName"`
		Page      int    `json:"page"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if body.Platform == "" {
		Fail(w, 422, "platform is required"); return
	}

	key := strings.ToLower(body.Platform)
	if !markscan.HasPlatform(key) {
		Fail(w, 422, "Unknown platform: "+body.Platform); return
	}

	opts := map[string]any{"pageNo": max(1, body.Page)}
	if body.StartDate != "" {
		opts["startDate"] = body.StartDate
	}
	if body.EndDate != "" {
		opts["endDate"] = body.EndDate
	}
	if body.AssetName != "" {
		opts["assetName"] = body.AssetName
	}

	httpStatus, raw, err := markscan.FetchInfringements(apiToken, key, opts)
	if err != nil {
		Fail(w, 502, err.Error()); return
	}
	if httpStatus == 401 || httpStatus == 403 {
		Fail(w, 401, "API token expired. Please re-login."); return
	}
	if httpStatus >= 400 {
		msg := fmt.Sprintf("Markscan API returned %d", httpStatus)
		switch v := raw.(type) {
		case string:
			if v != "" {
				msg = v
			}
		case map[string]any:
			for _, k := range []string{"message", "Message", "error", "Error", "title", "Title"} {
				if s, ok := v[k].(string); ok && s != "" {
					msg = s
					break
				}
			}
		}
		Fail(w, 502, msg); return
	}

	items, total := normalizeInfringementResponse(raw)
	OK(w, map[string]any{"success": true, "data": map[string]any{
		"items": items, "total": total, "page": body.Page,
	}})
}

func normalizeInfringementResponse(raw any) ([]any, int) {
	if arr, ok := raw.([]any); ok {
		return arr, len(arr)
	}
	if m, ok := raw.(map[string]any); ok {
		for _, k := range []string{"items", "rows", "data"} {
			if arr, ok := m[k].([]any); ok {
				total := len(arr)
				if t, ok := m["total"]; ok {
					if tv, ok := t.(float64); ok {
						total = int(tv)
					}
				}
				return arr, total
			}
		}
		for _, v := range m {
			if arr, ok := v.([]any); ok {
				return arr, len(arr)
			}
		}
	}
	return []any{}, 0
}
