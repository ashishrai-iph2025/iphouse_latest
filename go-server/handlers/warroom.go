package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	ipauth "github.com/ip-house/iphouse-api/auth"
	"github.com/ip-house/iphouse-api/db"
	"github.com/ip-house/iphouse-api/markscan"
	"github.com/ip-house/iphouse-api/store"
)

// warStore is the War Room dataset store, injected from main at startup.
var warStore store.Store

// SetWarRoomStore wires the store built in main().
func SetWarRoomStore(s store.Store) { warStore = s }

// warFetchConcurrency bounds simultaneous MarkScan page requests in flight at
// once, shared across every platform and every page within a platform — this
// is what actually matters for throughput, since a single huge platform
// (hundreds of pages) used to be fetched one page at a time regardless of how
// many platforms ran concurrently.
const warFetchConcurrency = 10

// warRoomBody is the shared request shape for both the plain and streaming
// War Room endpoints.
type warRoomBody struct {
	AssetNames   []string `json:"assetNames"`
	AssetName    string   `json:"assetName"` // backward-compat single-asset field
	StartDate    string   `json:"startDate"`
	EndDate      string   `json:"endDate"`
	Platforms    []string `json:"platforms"`
	Mode         string   `json:"mode"`
	ClientUserID int64    `json:"clientUserId"`
}

// apiErr carries an HTTP status + message out of processWarRoom so both the
// plain and streaming handlers can report it the way that fits their protocol.
type apiErr struct {
	status int
	msg    string
}

func (e *apiErr) Error() string { return e.msg }

// warRoomAllowed reports whether this login may use the War Room: portal
// staff (admin/super admin) always can; clients need the "WAR ROOM" module
// granted on /admin/module-permissions.
func warRoomAllowed(claims *ipauth.Claims) bool {
	if claims == nil {
		return false
	}
	if isAdmin(claims) {
		return true
	}
	row, _ := db.QueryOne(`
		SELECT 1 AS ok
		FROM user_module_permission_test u
		JOIN module_permission m ON m.Id = u.moduleId
		WHERE u.loginId = ? AND u.allowed = 1 AND m.status = 0 AND UPPER(m.ModuleName) = 'WAR ROOM'
		LIMIT 1`, claims.LoginID)
	return row != nil
}

// resolveWarRoomToken picks the MarkScan token + store-key owner for a request:
// clients use their own token; an admin (role>=1) may act on behalf of a
// selected client by passing clientUserId.
func resolveWarRoomToken(claims *ipauth.Claims, body warRoomBody) (token string, ownerID int64, aerr *apiErr) {
	ownerID = claims.UserID
	if body.ClientUserID != 0 && isAdmin(claims) {
		ownerID = body.ClientUserID
		token = TokenForUser(body.ClientUserID)
		if token == "" {
			return "", 0, &apiErr{502, "No API token for the selected client — check its API credentials."}
		}
		return token, ownerID, nil
	}
	token = ResolveAPIToken(claims)
	if token == "" {
		return "", 0, &apiErr{401, "API token missing. Please re-login."}
	}
	return token, ownerID, nil
}

// WarRoom builds the cross-platform War Room report for an asset. It keeps an
// accumulated dataset in the store and pulls only changed rows (updatedSince) on
// refresh, so the dashboard reflects cumulative data while fetching deltas.
//
// POST /api/warroom
// body: { assetName?, startDate, endDate?, platforms?[], mode: "auto"|"full"|"incremental" }
func WarRoom(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	if !warRoomAllowed(claims) {
		Fail(w, 403, "War Room access is not enabled for your account")
		return
	}
	if warStore == nil {
		Fail(w, 500, "war room store not initialised")
		return
	}

	var body warRoomBody
	json.NewDecoder(r.Body).Decode(&body)
	if len(body.AssetNames) == 0 && body.AssetName != "" {
		body.AssetNames = []string{body.AssetName}
	}
	if len(body.AssetNames) == 0 {
		Fail(w, 422, "at least one asset is required")
		return
	}

	token, ownerID, aerr := resolveWarRoomToken(claims, body)
	if aerr != nil {
		Fail(w, aerr.status, aerr.msg)
		return
	}

	payload, aerr := processWarRoom(r.Context(), token, ownerID, body, nil)
	if aerr != nil {
		Fail(w, aerr.status, aerr.msg)
		return
	}
	OK(w, payload)
}

// WarRoomStream is identical to WarRoom but streams live progress over
// Server-Sent Events as each platform's fetch starts/finishes, so the client
// can render a real per-platform loader instead of one opaque spinner. The
// stream ends with a "done" event carrying the same payload WarRoom returns
// (or an "error" event on failure).
//
// POST /api/warroom/stream
func WarRoomStream(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	if !warRoomAllowed(claims) {
		Fail(w, 403, "War Room access is not enabled for your account")
		return
	}
	if warStore == nil {
		Fail(w, 500, "war room store not initialised")
		return
	}

	var body warRoomBody
	json.NewDecoder(r.Body).Decode(&body)
	if len(body.AssetNames) == 0 && body.AssetName != "" {
		body.AssetNames = []string{body.AssetName}
	}
	if len(body.AssetNames) == 0 {
		Fail(w, 422, "at least one asset is required")
		return
	}

	token, ownerID, aerr := resolveWarRoomToken(claims, body)
	if aerr != nil {
		Fail(w, aerr.status, aerr.msg)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		Fail(w, 500, "streaming unsupported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(200)

	// Progress events fire from concurrent platform goroutines and the
	// heartbeat ticker below — serialise all writes to the response.
	var sendMu sync.Mutex
	send := func(event string, v any) {
		b, _ := json.Marshal(v)
		sendMu.Lock()
		defer sendMu.Unlock()
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, b)
		flusher.Flush()
	}

	// Heartbeat: page fetches can run for minutes with no platform-level
	// progress event in between, and a silent connection is what idle
	// timeouts (browser, proxies, OS) kill — surfacing in the UI as a bare
	// "network error". Ping every 15s so the stream is never idle.
	hbDone := make(chan struct{})
	defer close(hbDone)
	go func() {
		t := time.NewTicker(15 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-hbDone:
				return
			case <-r.Context().Done():
				return
			case <-t.C:
				send("ping", map[string]any{"t": time.Now().Unix()})
			}
		}
	}()

	onProgress := func(assetName, platform, phase string, count int, err error) {
		evt := map[string]any{"asset": assetName, "platform": platform, "phase": phase, "count": count}
		if err != nil {
			evt["error"] = err.Error()
		}
		send("platform", evt)
	}

	payload, aerr := processWarRoom(r.Context(), token, ownerID, body, onProgress)
	if aerr != nil {
		send("error", map[string]any{"message": aerr.msg})
		return
	}
	send("done", payload)
}

// processWarRoom holds the actual fan-out + aggregation logic shared by the
// plain and streaming endpoints. onProgress (nilable) is invoked around each
// platform's fetch, tagged with the asset it belongs to.
func processWarRoom(ctx context.Context, token string, ownerID int64, body warRoomBody, onProgress func(asset, platform, phase string, count int, err error)) (map[string]any, *apiErr) {
	platforms := body.Platforms
	if len(platforms) == 0 {
		platforms = markscan.PlatformsForWarRoom()
	}

	// Process each selected asset. Every asset maintains its own store key so
	// per-asset incremental refresh works independently. Results are merged before
	// aggregation so the dashboard always shows the combined view.
	fetchStart := time.Now()
	totalPulled := 0
	anyFull := false

	for _, assetName := range body.AssetNames {
		// Client already gone (page reload, another Generate click, tab
		// close) — stop instead of continuing to burn MarkScan capacity and
		// Redis writes on a response nobody will receive.
		if ctx.Err() != nil {
			log.Printf("[warroom] aborting: client disconnected (%v)", ctx.Err())
			return nil, &apiErr{499, "client disconnected"}
		}

		key := fmt.Sprintf("u%d:%s", ownerID, store.Key(assetName))
		lastFetch, coverageStart, existing, hasData := warStore.Meta(ctx, key)

		// Full when forced, asset is new, there's nothing stored yet, or the
		// requested window starts BEFORE the stored dataset's coverage — an
		// incremental (updatedSince) pull can never backfill historical rows
		// the original pull's startDate excluded, so widening the date range
		// used to silently show the same counts no matter how far back the
		// user went.
		widened := body.StartDate != "" &&
			(coverageStart == "" || body.StartDate < coverageStart)
		assetFull := body.Mode == "full" || !hasData || existing == 0 || widened
		if widened && hasData {
			log.Printf("[warroom] asset=%q window widened (%s < %q) — forcing full re-pull", assetName, body.StartDate, coverageStart)
		}
		if assetFull {
			anyFull = true
			if body.StartDate == "" {
				return nil, &apiErr{422, "startDate is required — please pick a start date"}
			}
		}

		reqBody := map[string]any{"assetName": assetName}
		if assetFull {
			reqBody["startDate"] = body.StartDate
			if body.EndDate != "" {
				reqBody["endDate"] = body.EndDate
			}
		} else {
			reqBody["updatedSince"] = markscan.MarkScanTime(lastFetch)
		}

		var platProgress func(platform, phase string, count int, err error)
		if onProgress != nil {
			platProgress = func(platform, phase string, count int, err error) {
				onProgress(assetName, platform, phase, count, err)
			}
		}
		fetched, perPlatform := fanOutFetch(ctx, token, platforms, reqBody, platProgress)
		log.Printf("[warroom] asset=%q mode=%s pulled=%d perPlatform=%v", assetName, modeLabel(assetFull), countRows(fetched), perPlatform)

		if ctx.Err() != nil {
			log.Printf("[warroom] aborting after fetch: client disconnected (%v)", ctx.Err())
			return nil, &apiErr{499, "client disconnected"}
		}

		// No Reset even on full pulls: rows are ID-keyed, so upserting simply
		// updates existing rows and adds new ones. Resetting used to wipe the
		// whole set and re-insert only the platforms whose fetch succeeded —
		// one flaky platform (a MarkScan 500) made that platform vanish from
		// the dashboard until the next successful pull. Stale rows age out
		// via the store TTL instead.
		for plat, rows := range fetched {
			for _, row := range rows {
				row["platform"] = plat
				// MarkScan rows usually carry assetName; guarantee it so the
				// client can build the per-asset comparison chart.
				if s, _ := row["assetName"].(string); s == "" {
					row["assetName"] = assetName
				}
				markscan.NormalizeRow(plat, row)
			}
			if len(rows) > 0 {
				_ = warStore.Upsert(ctx, key, rows)
			}
		}
		// Record coverage: a full pull covers from its startDate; an
		// incremental keeps the coverage the stored dataset already had.
		newCoverage := coverageStart
		if assetFull {
			newCoverage = body.StartDate
		}
		_ = warStore.SetMeta(ctx, key, fetchStart, newCoverage)
		totalPulled += countRows(fetched)
	}

	// Merge stored rows from all selected asset keys, then scope to date window.
	var allRows []map[string]any
	for _, assetName := range body.AssetNames {
		key := fmt.Sprintf("u%d:%s", ownerID, store.Key(assetName))
		rows, _ := warStore.Rows(ctx, key)
		// Re-normalize on read: rows cached before a mapping was added (e.g.
		// Telegram's language1/quality) still carry their raw fields, so this
		// retroactively aligns them without waiting for a re-pull. Idempotent —
		// NormalizeRow only fills fields that are still empty.
		for _, r := range rows {
			markscan.NormalizeRow(strFromAny(r["platform"]), r)
		}
		allRows = append(allRows, rows...)
	}
	filtered := markscan.FilterRowsByDate(allRows, body.StartDate, body.EndDate)
	report := markscan.Aggregate(filtered)

	log.Printf("[warroom] assets=%v mode=%s totalPulled=%d stored=%d filtered=%d",
		body.AssetNames, modeLabel(anyFull), totalPulled, len(allRows), len(filtered))

	return map[string]any{
		"success": true,
		"data":    report,
		"rows":    markscan.TrimRows(filtered),
		"meta": map[string]any{
			"lastFetch":    fetchStart.UTC().Format(time.RFC3339),
			"rowCount":     len(allRows),
			"displayCount": len(filtered),
			"pulledNow":    totalPulled,
			"mode":         modeLabel(anyFull),
			"source":       warStore.Kind(),
			"perPlatform":  map[string]int{},
		},
	}, nil
}

// fanOutFetch pulls every platform's pages concurrently (bounded). A single
// platform failing is logged and skipped — the report is still built from the rest.
// onProgress, if set, is called once per platform as it starts and once more as
// it finishes (err set on failure) — this drives the live per-platform loader.
func fanOutFetch(ctx context.Context, token string, platforms []string, base map[string]any, onProgress func(platform, phase string, count int, err error)) (map[string][]map[string]any, map[string]int) {
	var mu sync.Mutex
	out := map[string][]map[string]any{}
	counts := map[string]int{}

	// Shared across every platform's page fetches — bounds total concurrent
	// MarkScan HTTP calls without gating how many platforms can even start.
	// Every platform launches immediately; a slow, page-heavy platform (e.g.
	// Facebook at 225 pages) no longer occupies a "platform slot" and starves
	// out platforms later in the list from ever starting.
	sem := make(chan struct{}, warFetchConcurrency)
	var wg sync.WaitGroup
	for _, plat := range platforms {
		if ctx.Err() != nil {
			break
		}
		plat := plat
		// Each platform gets its own copy of the base body (FetchAllPages mutates pageNo).
		b := make(map[string]any, len(base))
		for k, v := range base {
			b[k] = v
		}
		wg.Add(1)
		if onProgress != nil {
			onProgress(plat, "start", 0, nil)
		}
		if plat == "ugc and other social media" {
			// MarkScan's UGC endpoint returns only the platform named in the
			// request body, so the umbrella key alone yields just the residual
			// "other" bucket. Fan out over every named UGC platform value too
			// and merge everything under the umbrella key.
			go func() {
				defer wg.Done()
				rows, err := fetchUGCSubPlatforms(ctx, token, b, sem)
				if err != nil {
					log.Printf("[warroom] platform %s fetch error: %v", plat, err)
				}
				mu.Lock()
				out[plat] = rows
				counts[plat] = len(rows)
				mu.Unlock()
				if onProgress != nil {
					onProgress(plat, "done", len(rows), err)
				}
			}()
			continue
		}
		go func() {
			defer wg.Done()
			rows, err := markscan.FetchAllPages(ctx, token, plat, b, sem)
			if err != nil {
				log.Printf("[warroom] platform %s fetch error: %v", plat, err)
			}
			mu.Lock()
			out[plat] = rows
			counts[plat] = len(rows)
			mu.Unlock()
			if onProgress != nil {
				onProgress(plat, "done", len(rows), err)
			}
		}()
	}
	wg.Wait()
	return out, counts
}

// fetchUGCSubPlatforms pulls every UGC platform value concurrently (bounded by
// the shared sem) and returns the merged rows: the 7 named platforms (tiktok,
// chomikuj, sharechat, vk, ok, bilibili, dailymotion) plus the residual
// "UGC And Other Social Media" bucket. Rows from a named fetch are tagged with
// that platform's label; residual rows are left untagged so NormalizeRow
// derives their subPlatform from the videoURL domain. One value failing is
// logged and surfaced but doesn't discard the others' rows.
func fetchUGCSubPlatforms(ctx context.Context, token string, base map[string]any, sem chan struct{}) ([]map[string]any, error) {
	type sub struct{ key, label string }
	subs := []sub{{"ugc and other social media", ""}} // residual bucket, tag via videoURL domain
	for _, s := range markscan.UGCSubPlatforms() {
		subs = append(subs, sub{s.Key, s.Label})
	}

	var mu sync.Mutex
	var wg sync.WaitGroup
	var merged []map[string]any
	var firstErr error
	for _, s := range subs {
		if ctx.Err() != nil {
			break
		}
		s := s
		b := make(map[string]any, len(base))
		for k, v := range base {
			b[k] = v
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			rows, err := markscan.FetchAllPages(ctx, token, s.key, b, sem)
			if s.label != "" {
				for _, row := range rows {
					row["subPlatform"] = s.label
				}
			}
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				log.Printf("[warroom] ugc sub-platform %s fetch error: %v", s.key, err)
				if firstErr == nil {
					firstErr = err
				}
			}
			merged = append(merged, rows...)
		}()
	}
	wg.Wait()
	return merged, firstErr
}

func countRows(m map[string][]map[string]any) int {
	n := 0
	for _, v := range m {
		n += len(v)
	}
	return n
}

func modeLabel(full bool) string {
	if full {
		return "full"
	}
	return "incremental"
}

func isAdmin(claims *ipauth.Claims) bool {
	return claims != nil && claims.Role != nil && *claims.Role >= 1
}

// WarRoomClientToken is the admin "generate token" step: given a client's user
// id it authenticates against MarkScan with that client's stored credentials
// (caching the token) and returns the client's asset list, so the admin can then
// pick an asset and generate the report on that client's behalf.
//
// POST /api/warroom/client-token   (admin only)
// body: { clientUserId }
func WarRoomClientToken(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ClientUserID int64 `json:"clientUserId"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if body.ClientUserID == 0 {
		Fail(w, 422, "clientUserId is required")
		return
	}

	token := TokenForUser(body.ClientUserID)
	if token == "" {
		Fail(w, 502, "Could not generate an API token for this client — check its API credentials.")
		return
	}

	rawAssets, err := markscan.GetAllWarRoomAssets(token)
	if err != nil {
		Fail(w, 502, "Token generated, but fetching assets failed: "+err.Error())
		return
	}
	log.Printf("[warroom client-token] clientUserId=%d rawAssets=%d item[0]=%v", body.ClientUserID, len(rawAssets), firstAny(rawAssets))
	OK(w, map[string]any{"success": true, "tokenReady": true, "assets": assetOptions(rawAssets)})
}

// GET /api/warroom/assets — client mode: the War Room asset dropdown lists
// only assets flagged for the War Room (MarkScan GetAllWarRoomAssets),
// reduced to unique asset names.
func WarRoomAssets(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	if claims == nil {
		Fail(w, 401, "Not authenticated"); return
	}
	token := ResolveAPIToken(claims)
	if token == "" {
		Fail(w, 401, "API token missing"); return
	}
	raw, err := markscan.GetAllWarRoomAssets(token)
	if err != nil {
		Fail(w, 502, "Fetching War Room assets failed: "+err.Error()); return
	}
	log.Printf("[warroom assets] loginId=%d rawAssets=%d item[0]=%v", claims.LoginID, len(raw), firstAny(raw))
	OK(w, map[string]any{
		"success":           true,
		"assets":            assetOptions(raw),
		"comparisonEnabled": warRoomComparisonEnabled(claims.UserID),
	})
}

// warRoomComparisonEnabled reports whether the Asset Comparison tab is enabled
// for a client — managed per client on /admin/war-room-assets (default off).
// A missing table (page never opened) or missing row both mean "off".
func warRoomComparisonEnabled(userID int64) bool {
	row, _ := db.QueryOne("SELECT comparison_enabled FROM war_room_client_settings WHERE user_id = ? LIMIT 1", userID)
	return row != nil && intFromAny(row["comparison_enabled"]) == 1
}

// assetOptions reduces a loosely-typed MarkScan asset list to unique
// {key,label,warRoomEndDate} options — the name plus the war-room end date,
// which the frontend uses to auto-select the most recent asset.
func assetOptions(raw []any) []map[string]string {
	assets := make([]map[string]string, 0, len(raw))
	seen := map[string]bool{}
	for _, a := range raw {
		name := assetNameOf(a)
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		end := ""
		if m, ok := a.(map[string]any); ok {
			for _, k := range []string{"warRoomEndDate", "WarRoomEndDate", "war_room_end_date"} {
				if s, ok := m[k].(string); ok && s != "" {
					end = s
					break
				}
			}
		}
		assets = append(assets, map[string]string{"key": name, "label": name, "warRoomEndDate": end})
	}
	return assets
}

func firstAny(s []any) any {
	if len(s) > 0 {
		return s[0]
	}
	return nil
}

// assetNameOf extracts an asset display name from the loosely-typed MarkScan
// asset list (string or object with assetName/name).
func assetNameOf(a any) string {
	switch v := a.(type) {
	case string:
		return v
	case map[string]any:
		for _, k := range []string{"assetName", "AssetName", "asset_name", "name", "Name"} {
			if s, ok := v[k].(string); ok && s != "" {
				return s
			}
		}
	}
	return ""
}
