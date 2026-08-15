package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"

	"github.com/ip-house/iphouse-api/markscan"
	"github.com/ip-house/iphouse-api/notify"
)

// POST /api/enforce
func Enforce(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	apiToken := ResolveAPIToken(claims)
	if apiToken == "" {
		Fail(w, 401, "API token missing")
		return
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
		Fail(w, 422, "Missing required fields")
		return
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
		Fail(w, 500, err.Error())
		return
	}
	if status >= 400 {
		Fail(w, 502, upstreamMsg("Markscan", status, data))
		return
	}

	OK(w, map[string]any{"success": true, "data": data})
}

// upstreamMsg renders a Markscan non-2xx response as something a reviewer can
// act on. The bare "API error" it replaces hid both the status and the reason,
// which made a wrong endpoint indistinguishable from a bad payload.
func upstreamMsg(endpoint string, status int, data any) string {
	detail := ""
	switch v := data.(type) {
	case nil:
	case string:
		detail = v
	default:
		if b, err := json.Marshal(v); err == nil {
			detail = string(b)
		}
	}
	detail = strings.TrimSpace(detail)
	if len(detail) > 500 {
		detail = detail[:500] + "…"
	}
	if detail == "" || detail == "null" {
		return fmt.Sprintf("%s returned HTTP %d", endpoint, status)
	}
	return fmt.Sprintf("%s returned HTTP %d: %s", endpoint, status, detail)
}

// POST /api/qc-urls
func QCUrls(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	apiToken := ResolveAPIToken(claims)
	if apiToken == "" {
		Fail(w, 401, "API token missing")
		return
	}

	var body struct {
		Platform  string `json:"platform"`
		StartDate string `json:"startDate"`
		AssetName string `json:"assetName"`
	}
	json.NewDecoder(r.Body).Decode(&body)

	if body.Platform == "" {
		Fail(w, 422, "platform is required")
		return
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
		Fail(w, 401, "API token missing")
		return
	}

	// Markscan has no /QcEnforce endpoint — an approval goes to
	// /SendtoEnforcementQc and a rejection to /MarkAsInvalid, both of which take
	// {platform, assetName, urlids, comment, isSourceURL}. Forwarding the page's
	// payload verbatim to a non-existent path was what surfaced as "API error".
	var body struct {
		ActionType  string `json:"actionType"`
		Platform    string `json:"platform"`
		AssetName   string `json:"assetName"`
		Comment     string `json:"comment"`
		URLIDs      []any  `json:"urlids"`
		IsSourceURL bool   `json:"isSourceURL"`
		// Internet mixes host and linking URLs in one table, and each carries its
		// own isSourceURL — such a selection is submitted as one group per flag.
		Groups []struct {
			URLIDs      []any `json:"urlids"`
			IsSourceURL bool  `json:"isSourceURL"`
		} `json:"groups"`
	}
	json.NewDecoder(r.Body).Decode(&body)

	type group struct {
		ids   []any
		isSrc bool
	}
	var groups []group
	for _, g := range body.Groups {
		if len(g.URLIDs) > 0 {
			groups = append(groups, group{ids: g.URLIDs, isSrc: g.IsSourceURL})
		}
	}
	if len(groups) == 0 && len(body.URLIDs) > 0 {
		groups = append(groups, group{ids: body.URLIDs, isSrc: body.IsSourceURL})
	}

	decision := strings.ToLower(strings.TrimSpace(body.ActionType))
	if decision != "approved" {
		decision = "rejected"
	}
	platform := body.Platform
	asset := body.AssetName

	if body.ActionType == "" || platform == "" || strings.TrimSpace(body.Comment) == "" || len(groups) == 0 {
		Fail(w, 422, "actionType, platform, comment and at least one URL id are required")
		return
	}

	count := 0
	results := make([]any, 0, len(groups))
	for _, g := range groups {
		payload := map[string]any{
			"platform":    platform,
			"assetName":   asset,
			"urlids":      g.ids,
			"comment":     body.Comment,
			"isSourceURL": g.isSrc,
		}

		var (
			status   int
			data     any
			err      error
			endpoint string
		)
		if decision == "approved" {
			endpoint = "SendtoEnforcementQc"
			status, data, err = markscan.SendToEnforcementQc(apiToken, payload)
		} else {
			endpoint = "MarkAsInvalid"
			status, data, err = markscan.MarkAsInvalid(apiToken, payload)
		}
		if err != nil {
			Fail(w, 500, err.Error())
			return
		}
		if status >= 400 {
			Fail(w, 502, upstreamMsg(endpoint, status, data))
			return
		}
		count += len(g.ids)
		results = append(results, data)
	}

	// Raise the approval decision to the admin bell. This is the handler the
	// Approval Review page posts to (/api/qc-enforce); /api/enforce above is a
	// separate, currently unused endpoint.
	pushNotify(claims, notify.Event{
		Type:  notify.TypeApprovalAction,
		Title: "URLs " + decision,
		Message: fmt.Sprintf("%d URL%s %s on %s%s",
			count, plural(count), decision, platformDisplay(platform), forAsset(asset)),
		Meta: map[string]any{
			"decision": decision, "platform": platform, "assetName": asset,
			"urlCount": count,
			// The reviewer's justification is the useful part for an admin
			// following up on a bulk rejection.
			"comment": body.Comment,
		},
	})

	OK(w, map[string]any{"success": true, "data": results, "processed": count})
}
