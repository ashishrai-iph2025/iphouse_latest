package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/ip-house/iphouse-api/markscan"
)

// POST /api/infringement
func Infringement(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	apiToken := ResolveAPIToken(claims)
	if apiToken == "" {
		Fail(w, 401, "API token missing. Please re-login.")
		return
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
		Fail(w, 422, "platform is required")
		return
	}

	key := strings.ToLower(body.Platform)
	if !markscan.HasPlatform(key) {
		Fail(w, 422, "Unknown platform: "+body.Platform)
		return
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
		Fail(w, 502, err.Error())
		return
	}
	if httpStatus == 401 || httpStatus == 403 {
		Fail(w, 401, "API token expired. Please re-login.")
		return
	}
	if httpStatus >= 400 {
		Fail(w, 502, markscanError(httpStatus, raw))
		return
	}

	items, total := normalizeInfringementResponse(raw)
	OK(w, map[string]any{"success": true, "data": map[string]any{
		"items": items, "total": total, "page": body.Page,
	}})
}

/*
POST /api/infringement/category — one search across several platforms.

The single-platform search above is unchanged and is still what a chosen
platform uses. This is the other case: a category with more than one platform
behind it and no choice made, where the honest answer is every platform in it.

The results are NOT merged. Each platform's endpoint returns its own shape —
YouTube has views and subscribers, Marketplace has a price and a seller, Open Web
has a host URL and a linking URL — and flattening those into one table means
choosing a lowest common denominator and dropping the rest. So each platform is
returned with its own rows and its own row count, and the page draws a table per
platform whose columns come from that platform's data.

A platform that fails is reported IN PLACE rather than failing the request: one
expired upstream endpoint should cost its own table, not the other nine.
*/
func InfringementByCategory(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	apiToken := ResolveAPIToken(claims)
	if apiToken == "" {
		Fail(w, 401, "API token missing. Please re-login.")
		return
	}

	var body struct {
		Platforms []string `json:"platforms"`
		StartDate string   `json:"startDate"`
		EndDate   string   `json:"endDate"`
		AssetName string   `json:"assetName"`
		Page      int      `json:"page"`
	}
	json.NewDecoder(r.Body).Decode(&body)

	// The category vocabulary lives in the browser (lib/platformCategories.ts),
	// which is where the picker groups master data — so the caller names the
	// platforms and this validates them, rather than the grouping being written
	// out twice and drifting.
	wanted := []string{}
	seen := map[string]bool{}
	for _, p := range body.Platforms {
		key := strings.ToLower(strings.TrimSpace(p))
		if key == "" || seen[key] || !markscan.HasPlatform(key) {
			continue
		}
		seen[key] = true
		wanted = append(wanted, key)
	}
	if len(wanted) == 0 {
		Fail(w, 422, "No searchable platform in this category")
		return
	}
	if len(wanted) > maxCategoryPlatforms {
		Fail(w, 422, fmt.Sprintf("Too many platforms in one search (%d, limit %d)", len(wanted), maxCategoryPlatforms))
		return
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

	type result struct {
		Platform string `json:"platform"`
		Items    []any  `json:"items"`
		Total    int    `json:"total"`
		Error    string `json:"error,omitempty"`
	}

	// Bounded fan-out: MarkScan is somebody else's API and a category can hold a
	// dozen platforms. Four at a time keeps a category search roughly as quick as
	// the slowest few without opening a dozen upstream connections at once.
	out := make([]result, len(wanted))
	var wg sync.WaitGroup
	gate := make(chan struct{}, categoryFanout)
	// One expired token fails every platform identically; recorded so the page can
	// say "sign in again" rather than repeating the same error ten times.
	var authFailed atomic.Bool

	for i, key := range wanted {
		wg.Add(1)
		go func(i int, key string) {
			defer wg.Done()
			gate <- struct{}{}
			defer func() { <-gate }()

			res := result{Platform: key, Items: []any{}}
			// `opts` is shared across the goroutines, which is safe because
			// FetchInfringements only reads it — it copies into a request body of
			// its own rather than writing back.
			status, raw, err := markscan.FetchInfringements(apiToken, key, opts)
			switch {
			case err != nil:
				res.Error = err.Error()
			case status == 401 || status == 403:
				authFailed.Store(true)
				res.Error = "API token expired. Please re-login."
			case status >= 400:
				res.Error = markscanError(status, raw)
			default:
				res.Items, res.Total = normalizeInfringementResponse(raw)
			}
			out[i] = res
		}(i, key)
	}
	wg.Wait()

	rows, failed := 0, 0
	for _, r := range out {
		rows += len(r.Items)
		if r.Error != "" {
			failed++
		}
	}
	// Every platform rejected the token — that is a session problem, not ten
	// platform problems, and the page should say so once.
	if authFailed.Load() && failed == len(out) {
		Fail(w, 401, "API token expired. Please re-login.")
		return
	}
	OK(w, map[string]any{"success": true, "data": map[string]any{
		"platforms": out, "page": max(1, body.Page), "rows": rows,
	}})
}

const (
	// A category is a handful of platforms; a request naming far more than the
	// catalogue holds is a mistake or an abuse, not a search.
	maxCategoryPlatforms = 30
	categoryFanout       = 4
)

// markscanError pulls the message out of an upstream error body, whatever key it
// chose to put it under.
func markscanError(status int, raw any) string {
	msg := fmt.Sprintf("Markscan API returned %d", status)
	switch v := raw.(type) {
	case string:
		if v != "" {
			return v
		}
	case map[string]any:
		for _, k := range []string{"message", "Message", "error", "Error", "title", "Title"} {
			if s, ok := v[k].(string); ok && s != "" {
				return s
			}
		}
	}
	return msg
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
