package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/ip-house/iphouse-api/markscan"
	"github.com/ip-house/iphouse-api/notify"
)

// GET /api/download — list download requests
func DownloadList(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	apiToken := ResolveAPIToken(claims)
	if apiToken == "" {
		Fail(w, 401, "API token missing")
		return
	}

	raw, err := markscan.GetDownloadStatus(apiToken)
	if err != nil {
		Fail(w, 500, err.Error())
		return
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

	// MarkScan's list is company-wide — one API token serves every login — so it
	// is filtered to the caller's own requests unless they are a Client Admin or
	// IP House staff. See requestledger.go.
	seesAll := seesAllCompanyRequests(claims)
	var ledger downloadLedger
	if claims != nil {
		ledger = downloadLedgerFor(claims.UserID, claims.LoginID)
	}

	items := make([]map[string]any, 0, len(rows))
	hidden := 0
	for _, r := range rows {
		m, ok := r.(map[string]any)
		if !ok {
			continue
		}
		reqID := cleanNil(fmt.Sprint(coalesce(m, "id", "Id", "requestId")))
		platform := cleanNil(fmt.Sprint(coalesce(m, "platform", "Platform")))
		asset := cleanNil(fmt.Sprint(coalesce(m, "assetName", "AssetName", "asset_name")))

		if !seesAll && !ledger.isMine(reqID, platform, asset) {
			hidden++
			continue
		}

		item := map[string]any{
			"id":        coalesce(m, "id", "Id", "requestId"),
			"platform":  coalesce(m, "platform", "Platform"),
			"assetName": coalesce(m, "assetName", "AssetName", "asset_name"),
			"startDate": coalesce(m, "startDate", "StartDate", "start_date"),
			"endDate":   coalesce(m, "endDate", "EndDate", "end_date"),
			"processed": coalesce(m, "processed", "Processed"),
		}
		// Who asked for it — the point of the company-wide view.
		if req, ok := ledger.requester(reqID); ok {
			if label := req.label(); label != "" {
				item["requestedBy"] = label
				item["requestedByEmail"] = req.email
				item["isMine"] = claims != nil && req.loginID == claims.LoginID
			}
		}
		items = append(items, item)
	}

	OK(w, map[string]any{
		"success": true,
		"items":   items,
		"scope":   requestScope(claims),
		// How many rows the scope filter removed. Not shown in the UI today —
		// it's here so "my history looks short" can be answered without adding
		// server logging that would name other people's requests.
		"hiddenCount": hidden,
	})
}

// POST /api/download — trigger download
func DownloadTrigger(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	apiToken := ResolveAPIToken(claims)
	if apiToken == "" {
		Fail(w, 401, "API token missing")
		return
	}

	var body struct {
		Platform  string `json:"platform"`
		AssetName string `json:"assetName"`
		StartDate string `json:"startDate"`
		EndDate   string `json:"endDate"`
	}
	json.NewDecoder(r.Body).Decode(&body)

	if body.Platform == "" && body.AssetName == "" {
		Fail(w, 422, "Platform or Asset Name is required")
		return
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
		Fail(w, 500, err.Error())
		return
	}
	if status >= 400 {
		Fail(w, 502, "API error")
		return
	}

	// Raise it to the admin bell. Display name, not the wire name — the bell text
	// has to read the same as the page it links to ("Open Web", not "Internet").
	scope := platformDisplay(body.Platform)
	if scope == "" {
		scope = "all platforms"
	}
	period := ""
	if body.StartDate != "" || body.EndDate != "" {
		period = fmt.Sprintf(" · %s → %s",
			orDash(body.StartDate), orDash(body.EndDate))
	}
	pushNotify(claims, notify.Event{
		Type:    notify.TypeDownloadRequest,
		Title:   "Data download requested",
		Message: fmt.Sprintf("%s%s%s", scope, forAsset(body.AssetName), period),
		Meta: map[string]any{
			"platform": body.Platform, "assetName": body.AssetName,
			"startDate": body.StartDate, "endDate": body.EndDate,
		},
	})

	// Record who asked, so the background watcher can attribute the request
	// when MarkScan later reports it ready — that list carries no requester.
	if claims != nil {
		requester := strings.TrimSpace(claims.LoginFirstName + " " + claims.LoginLastName)
		if requester == "" {
			requester = claims.LoginUsername
		}
		recordDownloadClaim(claims.UserID, claims.LoginID, requester, claims.LoginUsername,
			body.Platform, body.AssetName, body.StartDate, body.EndDate)
		// Attribute it now rather than on the watcher's next tick — the page
		// reloads its history straight after this response.
		reconcileDownloadsSoon(claims.UserID)
	}

	OK(w, map[string]any{"success": true, "message": "Download request submitted. Check history for status."})
}

// GET /api/download/{id} — get file URL
func DownloadByID(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	apiToken := ResolveAPIToken(claims)
	if apiToken == "" {
		Fail(w, 401, "API token missing")
		return
	}

	id := r.PathValue("id")
	if id == "" {
		// fallback for non-1.22 path matching
		id = strings.TrimPrefix(r.URL.Path, "/api/download/")
	}
	if id == "" {
		Fail(w, 400, "id required")
		return
	}

	url, err := markscan.GetDownloadUrl(apiToken, id)
	if err != nil || url == "" {
		Fail(w, 502, "Failed to get download URL")
		return
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
