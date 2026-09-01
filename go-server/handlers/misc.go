package handlers

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	ipauth "github.com/ip-house/iphouse-api/auth"
	"github.com/ip-house/iphouse-api/config"
	"github.com/ip-house/iphouse-api/db"
	"github.com/ip-house/iphouse-api/markscan"
)

/*
GET /api/keepalive — the ONE place a session is extended.

It used to report an expiry it did not create: the body said "you have thirty
more minutes" and nothing re-issued the cookie, so the JWT still died thirty
minutes after LOGIN however often this was called. That is why the portal logged
people out mid-task — SESSION_IDLE_TIMEOUT_SECONDS names an idle window and
behaved as an absolute one. Now the token is re-signed here and `expiryMs` is the
expiry of the cookie that just went out with the response.

WHY REFRESHING HERE AND NOT IN THE JWT MIDDLEWARE.

Sliding the session on every authenticated request is the obvious version and it
is wrong on this portal: the reports page polls its realtime card every few
seconds, so a tab left open on an empty desk would renew itself forever and the
idle timeout would never fire for anyone. An idle timeout has to be driven by the
USER being there, so the browser calls this on real input events and nothing
else — see IdleTimeoutGuard.tsx.

Which means a caller polling this endpoint in a loop keeps its own session alive.
That is inherent to any keepalive and is bounded by the same thing that bounds
the cookie: whoever holds it was already authenticated.
*/
func Keepalive(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	if claims == nil {
		Fail(w, 401, "Not authenticated")
		return
	}

	/* Re-sign from the claims we already verified. SignToken replaces
	   RegisteredClaims wholesale with a fresh window, which is exactly the slide
	   — and it carries the identity across untouched, impersonation included, so
	   a renewed session is the same session and not a quietly widened one. */
	tok, err := ipauth.SignToken(*claims)
	if err != nil {
		/* The session in hand is still valid; only the extension failed. Report
		   the expiry it ALREADY has rather than a new one, so the browser counts
		   down to the truth instead of waiting on a renewal that never landed. */
		log.Printf("[keepalive] re-signing the session failed: %v", err)
		expiry := int64(0)
		if claims.ExpiresAt != nil {
			expiry = claims.ExpiresAt.Time.UnixMilli()
		}
		OK(w, map[string]any{"alive": true, "extended": false, "expiryMs": expiry})
		return
	}
	SetTokenCookie(w, tok)

	/* Computed the same way SignToken computes it, from the same config value.
	   Not read back off the token: parsing what we just signed to learn a number
	   we already had is a round trip that can only agree. */
	expiryMs := time.Now().Add(time.Duration(config.C.SessionIdleSeconds) * time.Second).UnixMilli()
	OK(w, map[string]any{
		"alive":    true,
		"extended": true,
		"expiryMs": expiryMs,
		/* The window itself, so the browser can size its own timers without a
		   second call to /api/user/idle-timeout on every renewal. */
		"idleSeconds": config.C.SessionIdleSeconds,
	})
}

// GET /api/test-db — health probe. This endpoint is unauthenticated, so it must
// never echo the driver error (it names the DB host, user and schema). The
// detail goes to the server log; the caller gets a bare ok/not-ok.
func TestDB(w http.ResponseWriter, r *http.Request) {
	if err := db.Get().Ping(); err != nil {
		log.Printf("[test-db] ping failed: %v", err)
		Fail(w, 503, "Service unavailable")
		return
	}
	OK(w, map[string]any{"success": true, "message": "DB OK"})
}

// POST /api/pending-count
func PendingCount(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	apiToken := ResolveAPIToken(claims)
	if apiToken == "" {
		Fail(w, 401, "API token missing")
		return
	}

	var body struct {
		PlatformName string `json:"platformName"`
		AssetName    string `json:"assetName"`
		StartDate    string `json:"startDate"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if body.PlatformName == "" {
		Fail(w, 422, "platformName is required")
		return
	}

	payload := map[string]any{"platformName": body.PlatformName}
	if body.AssetName != "" {
		payload["assetName"] = body.AssetName
	}
	if body.StartDate != "" {
		payload["startDate"] = body.StartDate
	}

	data, err := markscan.PendingCount(apiToken, payload)
	if err != nil {
		Fail(w, 502, err.Error())
		return
	}
	OK(w, map[string]any{"success": true, "data": data})
}

// GET/POST /api/notifications
func Notifications(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	if claims == nil {
		Fail(w, 401, "Not authenticated")
		return
	}
	rows, err := db.Query("SELECT * FROM dcp_notifications WHERE userId = ? ORDER BY created_at DESC LIMIT 50", claims.UserID)
	if err != nil || rows == nil {
		OK(w, map[string]any{"success": true, "notifications": []any{}})
		return
	}
	OK(w, map[string]any{"success": true, "notifications": rows})
}

// GET /api/token
func Token(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	if claims == nil {
		Fail(w, 401, "Not authenticated")
		return
	}
	apiToken := ResolveAPIToken(claims)
	OK(w, map[string]any{"success": true, "token": apiToken})
}

// GET /api/user/nav
func UserNav(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	if claims == nil {
		Fail(w, 401, "Unauthorized")
		return
	}

	allowed, _ := db.Query(`
		SELECT m.Id AS moduleId, m.ModuleName, m.pageName, m.nav_order AS navOrder
		FROM user_module_permission_test u
		JOIN module_permission m ON m.Id = u.moduleId
		WHERE u.loginId = ? AND u.allowed = 1 AND m.status = 0
		ORDER BY m.nav_order ASC, m.Id ASC`, claims.LoginID)

	// Diagnostic: how many module grants exist for this login (vs total rows).
	allRows, _ := db.Query(`SELECT moduleId, allowed FROM user_module_permission_test WHERE loginId = ?`, claims.LoginID)
	log.Printf("[user-nav] loginId=%d userId=%d user=%q → allowedModules=%d (total perm rows=%d)",
		claims.LoginID, claims.UserID, claims.LoginUsername, len(allowed), len(allRows))

	row, _ := db.QueryOne(`
		SELECT COUNT(*) AS cnt
		FROM dcp_user_login l
		JOIN dcp_user u ON u.userId = l.userId
		WHERE l.login_username = ? AND l.is_active = 1 AND u.deleted = 0`, claims.LoginUsername)

	accountCount := int64(1)
	if row != nil {
		accountCount = intFromAny(row["cnt"])
	}

	// Admin-configured dropdown children per parent module (keyed by pageName).
	dropByParent := map[string][]map[string]any{}
	dropRows, _ := db.Query("SELECT parent_page_name, label, href FROM nav_dropdown_items ORDER BY sort_order ASC, id ASC")
	for _, dr := range dropRows {
		p := strFromAny(dr["parent_page_name"])
		dropByParent[p] = append(dropByParent[p], map[string]any{
			"label": strFromAny(dr["label"]), "href": strFromAny(dr["href"]),
		})
	}

	/* Dashboard and Reports are one entitlement with two faces — see
	   effectiveNavModules for the rule and why it lives there. */
	granted := make([]string, 0, len(allowed))
	byName := make(map[string]map[string]any, len(allowed))
	for _, row := range allowed {
		name := strFromAny(row["ModuleName"])
		if name == "" {
			continue
		}
		granted = append(granted, name)
		byName[strings.ToLower(name)] = row
	}

	modules := navEntries(granted, byName, dropByParent)

	// Live API-token availability. The session's apiAccess claim is frozen at
	// select-login time, so a transient Markscan failure there would lock the
	// sidebar to Dashboard-only for the whole session. ResolveAPIToken serves
	// the cache or lazily re-authenticates, so this heals once Markscan recovers.
	apiAccess := ResolveAPIToken(claims) != ""

	OK(w, map[string]any{"success": true, "allowedModules": modules, "accountCount": accountCount, "apiAccess": apiAccess})
}

// GET /api/user/idle-timeout
func UserIdleTimeout(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	if claims == nil {
		Fail(w, 401, "Not authenticated")
		return
	}
	row, _ := db.QueryOne("SELECT idle_minutes, is_active FROM user_idle_settings WHERE user_id = ? LIMIT 1", claims.UserID)
	defaultMinutes := config.C.SessionIdleSeconds / 60
	if defaultMinutes < 1 {
		defaultMinutes = 30
	}
	minutes := defaultMinutes
	active := false
	if row != nil && intFromAny(row["is_active"]) == 1 {
		if mins := intFromAny(row["idle_minutes"]); mins > 0 {
			minutes = int(mins)
			active = true
		}
	}
	OK(w, map[string]any{"success": true, "minutes": minutes, "active": active})
}

// POST /api/profile/change-password
func ChangePassword(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	if claims == nil {
		Fail(w, 401, "Not authenticated")
		return
	}

	var body struct {
		Current string `json:"current"`
		NewPass string `json:"newPass"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if body.Current == "" || body.NewPass == "" {
		OK(w, map[string]any{"success": false, "error": "Both passwords are required"})
		return
	}
	/* Complexity is checked here, before either branch below, because it does
	   not depend on which table the account lives in. Reuse is checked INSIDE
	   each branch instead — the history is keyed by the identity that branch
	   authenticates on, and there is no single key that means the same thing
	   for a Super Admin and for a client login. */
	if err := ValidatePassword(body.NewPass); err != nil {
		OK(w, map[string]any{"success": false, "error": err.Error()})
		return
	}

	// Portal staff (Admin / Super Admin) authenticate against dcp_super_admin,
	// so their password must be changed there — never in dcp_user_login, where
	// claims.LoginID may collide with an unrelated client login row.
	// NOTE: claims.LoginType == 2 cannot identify staff — client rows in
	// dcp_user_login also use login_type = 2 (it means "password login" there).
	// Mirror the login flow instead: a dcp_super_admin row for this email takes
	// precedence; otherwise fall through to the regular dcp_user_login path.
	if row, _ := db.QueryOne("SELECT id, password_hash FROM dcp_super_admin WHERE email = ? AND is_active = 1 LIMIT 1", claims.LoginUsername); row != nil {
		hash, _ := row["password_hash"].(string)
		if !ipauth.VerifyPassword(body.Current, hash) {
			OK(w, map[string]any{"success": false, "error": "Current password is incorrect"})
			return
		}
		if PasswordReused(AcctSuperAdmin, claims.LoginUsername, body.NewPass) {
			OK(w, map[string]any{"success": false, "error": reusedPasswordMessage()})
			return
		}
		hashed, err := ipauth.HashPassword(body.NewPass)
		if err != nil {
			Fail(w, 500, "Hash error")
			return
		}
		if err := db.MustExec("UPDATE dcp_super_admin SET password_hash = ? WHERE id = ?", hashed, intFromAny(row["id"])); err != nil {
			Fail(w, 500, "Could not update your password. Please try again.")
			return
		}
		// Recorded only after the write succeeded: a history entry for a
		// password that was never stored would refuse a password the account
		// does not actually have.
		RecordPasswordHistory(AcctSuperAdmin, claims.LoginUsername, hashed)
		// A new password starts a new expiry period — and clears any warning
		// already sent about the old one.
		StampPasswordChanged(AcctSuperAdmin, intFromAny(row["id"]))
		OK(w, map[string]any{"success": true})
		return
	}

	// Regular users: login authenticates by USERNAME (LIMIT 1 across all of the
	// email's accounts), not by the selected loginId — so verify against that
	// same row and write the new hash to EVERY active row sharing the username,
	// otherwise the change lands on a row the login query never reads.
	row, _ := db.QueryOne(`
		SELECT l.loginId, l.login_password
		FROM dcp_user_login l
		INNER JOIN dcp_user u ON u.userId = l.userId
		WHERE l.login_username = ? AND l.is_active = 1 AND u.deleted = 0 LIMIT 1`, claims.LoginUsername)
	if row == nil {
		OK(w, map[string]any{"success": false, "error": "Account not found"})
		return
	}
	hash, _ := row["login_password"].(string)
	if !ipauth.VerifyPassword(body.Current, hash) {
		OK(w, map[string]any{"success": false, "error": "Current password is incorrect"})
		return
	}

	if PasswordReused(AcctLogin, claims.LoginUsername, body.NewPass) {
		OK(w, map[string]any{"success": false, "error": reusedPasswordMessage()})
		return
	}
	hashed, err := ipauth.HashPassword(body.NewPass)
	if err != nil {
		Fail(w, 500, "Hash error")
		return
	}
	if err := db.MustExec("UPDATE dcp_user_login SET login_password = ? WHERE login_username = ? AND is_active = 1", hashed, claims.LoginUsername); err != nil {
		Fail(w, 500, "Could not update your password. Please try again.")
		return
	}
	// Keyed by username, matching the UPDATE above: the new hash went to every
	// active row sharing it, so the history has to cover them all too.
	RecordPasswordHistory(AcctLogin, claims.LoginUsername, hashed)
	// Every row that took the new hash takes the new clock — stamping one would
	// leave the others warning about a password that has just been changed.
	StampPasswordChangedForUsername(claims.LoginUsername)
	OK(w, map[string]any{"success": true})
}

// POST /api/ip-tracking
func IPTracking(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	if claims == nil {
		Fail(w, 401, "Not authenticated")
		return
	}
	apiToken := ResolveAPIToken(claims)
	if apiToken == "" {
		Fail(w, 401, "API token missing")
		return
	}
	var body struct {
		StartDate      string `json:"startDate"`
		EndDate        string `json:"endDate"`
		CopyrightOwner string `json:"copyrightOwner"`
		PageNo         int    `json:"pageNo"`
		Asset          string `json:"asset"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		Fail(w, 422, "Invalid request body")
		return
	}
	if body.CopyrightOwner == "" {
		Fail(w, 422, "copyrightOwner is required")
		return
	}
	payload := map[string]any{
		"startDate":      body.StartDate,
		"endDate":        body.EndDate,
		"copyrightOwner": body.CopyrightOwner,
		"pageNo":         body.PageNo,
	}
	if body.Asset != "" {
		payload["asset"] = body.Asset
		payload["assetName"] = body.Asset
		payload["assetTitle"] = body.Asset
		payload["Asset"] = body.Asset
		payload["AssetName"] = body.Asset
		payload["AssetTitle"] = body.Asset
	}
	b, _ := json.Marshal(payload)
	base := config.C.MarkscanBase
	req, _ := http.NewRequest("POST", base+"/GetTorrent/IPDetails", strings.NewReader(string(b)))
	req.Header.Set("Authorization", "Bearer "+apiToken)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	tlsClient := &http.Client{Timeout: 60 * time.Second}
	resp, err := tlsClient.Do(req)
	if err != nil {
		log.Printf("[ip-tracking] markscan request failed: %v", err)
		Fail(w, 502, "Upstream request failed. Please try again.")
		return
	}
	defer resp.Body.Close()
	rawBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		Fail(w, 502, "Markscan API error "+string(rawBody[:min(len(rawBody), 200)]))
		return
	}
	var data map[string]any
	json.Unmarshal(rawBody, &data)
	OK(w, map[string]any{
		"success":      true,
		"data":         nilToSlice(data["data"]),
		"totalRecords": data["totalRecords"],
		"totalPages":   data["totalPages"],
		"pageSize":     data["pageSize"],
		"pageNo":       data["pageNo"],
	})
}

func nilToSlice(v any) any {
	if v == nil {
		return []any{}
	}
	return v
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// GET /api/ip-tracking/client-details
func IPTrackingClientDetails(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	if claims == nil {
		Fail(w, 401, "Not authenticated")
		return
	}
	apiToken := ResolveAPIToken(claims)
	if apiToken == "" {
		Fail(w, 401, "API token missing")
		return
	}
	base := config.C.MarkscanBase
	req, _ := http.NewRequest("GET", base+"/GetClientDetails", nil)
	req.Header.Set("Authorization", "Bearer "+apiToken)
	req.Header.Set("Accept", "application/json")
	tlsClient := &http.Client{Timeout: 20 * time.Second}
	resp, err := tlsClient.Do(req)
	if err != nil {
		Fail(w, 502, "Markscan request failed")
		return
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var data any
	json.Unmarshal(raw, &data)

	// Response may be an object with copyrightOwners/assets, or an array directly
	var dataMap map[string]any
	switch v := data.(type) {
	case map[string]any:
		dataMap = v
	case []any:
		// Array means it returned assets directly — treat as assets list
		dataMap = map[string]any{"assets": v}
	}

	owners := []string{}
	assets := []string{}
	if arr, ok := dataMap["copyrightOwners"].([]any); ok {
		for _, v := range arr {
			if s, ok := v.(string); ok && s != "" {
				owners = append(owners, s)
			}
		}
	}
	if arr, ok := dataMap["assets"].([]any); ok {
		for _, v := range arr {
			if s, ok := v.(string); ok && s != "" {
				assets = append(assets, s)
			}
		}
	}
	OK(w, map[string]any{"success": true, "copyrightOwners": owners, "assets": assets})
}

// GET /api/user/dashboard-data
func UserDashboardData(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	if claims == nil {
		Fail(w, 401, "Not authenticated")
		return
	}
	/* Now that Dashboard is a grant rather than a floor, the endpoint has to
	   check it. Withholding the module while still serving its PowerBI links to
	   anyone who asks for them would make the permission cosmetic — hiding a
	   nav item is not access control. */
	if !mayOpenDashboard(claims) {
		Fail(w, 403, "The Dashboard module is not enabled for this account")
		return
	}
	logo, _ := db.QueryOne("SELECT userLogo, companyLogo FROM dcp_user WHERE userId = ? AND deleted = 0", claims.UserID)
	modules, _ := db.Query(`
		SELECT md.moduleId, md.moduleName, md.moduleIcon, mp.link, mp.noLinkMsg, mp.active, mp.default
		FROM dcp_user_module_map mp
		INNER JOIN dcp_module md ON md.moduleId = mp.moduleId
		WHERE mp.userId = ? AND md.deleted = 0
		ORDER BY md.moduleId ASC`, claims.UserID)
	if modules == nil {
		modules = []map[string]any{}
	}
	OK(w, map[string]any{"success": true, "logo": logo, "modules": modules})
}

// POST /api/master-data
func MasterData(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	apiToken := ResolveAPIToken(claims)
	if apiToken == "" {
		Fail(w, 401, "API token missing")
		return
	}

	rawP, _ := markscan.GetAllPlatforms(apiToken)
	rawA, _ := markscan.GetAllAssets(apiToken)
	platforms := normalizeMasterList(rawP, "platformName", "platform_name", "name", "platform", "PlatformName", "Platform")
	assets := normalizeMasterList(rawA, "assetName", "asset_name", "name", "AssetName", "Asset")
	log.Printf("[master-data] raw assets from MarkScan: %d items → normalised: %d items; raw[0]=%v", len(rawA), len(assets), first(rawA))
	OK(w, map[string]any{"success": true, "platforms": platforms, "assets": assets})
}

func first(s []any) any {
	if len(s) > 0 {
		return s[0]
	}
	return nil
}

// normalizeMasterList converts a raw list of strings or objects into
// []map[string]any{outKey: value}, matching the old Next.js normalization.
func normalizeMasterList(raw []any, outKey string, fieldKeys ...string) []map[string]any {
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		var val string
		switch v := item.(type) {
		case string:
			val = v
		case map[string]any:
			for _, k := range fieldKeys {
				if s, ok := v[k].(string); ok && s != "" {
					val = s
					break
				}
			}
		}
		if val != "" {
			out = append(out, map[string]any{outKey: val})
		}
	}
	return out
}

// GET /api/embed-token
func EmbedToken(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	if claims == nil {
		Fail(w, 401, "SESSION_EXPIRED")
		return
	}

	reportID := r.URL.Query().Get("reportId")
	if reportID == "" {
		Fail(w, 400, "Missing reportId")
		return
	}

	// ROLLED BACK: Per-report embed authorisation was too restrictive
	// One report can be accessed by multiple users/clients
	// Current auth: User is authenticated via JWT (sufficient for now)
	// Future: Implement client-based access control instead of per-report

	row, err := db.QueryOne("SELECT client_id, client_secret, tenant_id, workspace_id FROM master_powerbi_credentials WHERE is_active = 1 ORDER BY id DESC LIMIT 1")
	if err != nil || row == nil {
		Fail(w, 500, "No Power BI API credentials found in database")
		return
	}

	clientID := safeDecryptField(row["client_id"])
	clientSecret := safeDecryptField(row["client_secret"])
	tenantID := safeDecryptField(row["tenant_id"])
	workspaceID := safeDecryptField(row["workspace_id"])

	azureURL := "https://login.microsoftonline.com/" + tenantID + "/oauth2/v2.0/token"
	formData := "grant_type=client_credentials&client_id=" + clientID +
		"&client_secret=" + clientSecret + "&scope=https://analysis.windows.net/powerbi/api/.default"

	tokenResp, err := postFormHTTP(azureURL, formData)
	if err != nil {
		Fail(w, 500, "Azure AD request failed")
		return
	}
	accessToken, _ := tokenResp["access_token"].(string)
	if accessToken == "" {
		Fail(w, 500, "Azure AD authentication failed")
		return
	}

	reportInfo, err := getWithBearer("https://api.powerbi.com/v1.0/myorg/groups/"+workspaceID+"/reports/"+reportID, accessToken)
	if err != nil {
		Fail(w, 500, "Report fetch failed")
		return
	}
	embedURL, _ := reportInfo["embedUrl"].(string)
	if embedURL == "" {
		Fail(w, 500, "Invalid reportId or no API permission")
		return
	}

	embedTokenResp, err := postJSONWithBearer(
		"https://api.powerbi.com/v1.0/myorg/groups/"+workspaceID+"/reports/"+reportID+"/GenerateToken",
		accessToken, map[string]string{"accessLevel": "View"},
	)
	if err != nil {
		Fail(w, 500, "Embed token generation failed")
		return
	}
	embedTok, _ := embedTokenResp["token"].(string)
	if embedTok == "" {
		Fail(w, 500, "Embed token generation failed")
		return
	}

	go db.Exec(`INSERT INTO user_dashboard_access (login_id, user_id, report_id, dashboard_name, workspace_id) VALUES (?, ?, ?, ?, ?)`,
		claims.LoginID, claims.UserID, reportID, strFromAny(reportInfo["name"]), workspaceID)

	OK(w, map[string]any{
		"embedUrl":   embedURL,
		"reportId":   reportID,
		"embedToken": embedTok,
		"expiry":     embedTokenResp["expiration"],
	})
}

func safeDecryptField(v any) string {
	s, ok := v.(string)
	if !ok {
		return ""
	}
	dec := ipauth.DecryptMain(s)
	if dec == "" {
		return s
	}
	return dec
}

func postFormHTTP(url, body string) (map[string]any, error) {
	resp, err := http.Post(url, "application/x-www-form-urlencoded", strings.NewReader(body))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var result map[string]any
	json.NewDecoder(resp.Body).Decode(&result)
	return result, nil
}

func getWithBearer(url, token string) (map[string]any, error) {
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var result map[string]any
	json.NewDecoder(resp.Body).Decode(&result)
	return result, nil
}

func postJSONWithBearer(url, token string, payload any) (map[string]any, error) {
	b, _ := json.Marshal(payload)
	req, _ := http.NewRequest("POST", url, strings.NewReader(string(b)))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var result map[string]any
	json.NewDecoder(resp.Body).Decode(&result)
	return result, nil
}

/*
── Dashboard and Reports are one entitlement with two faces ──────────────────

	They present the same client's figures, so a login never gets both:

	  Reports granted        Reports. Dashboard is dropped even where it was
	                         also ticked — two nav items for the same numbers
	                         are two places to disagree and a choice that means
	                         nothing to the person making it.
	  Reports not granted    Dashboard, IF it was granted. Otherwise neither.

	Dashboard is a permission like any other. It was briefly a floor — synthesised
	for every login that had not been given Reports — which meant the nav showed a
	module nobody had granted and an admin could not take it away. A permission
	that cannot be withheld is not a permission, and "nothing granted" is a
	legitimate state: it says the account is not set up yet, which is worth seeing
	rather than papering over.

	So the rule now only ever REMOVES. Nothing is invented here.

	Decided HERE, on the read, rather than when the permissions are saved. This
	endpoint is what the nav and every client-side gate consult, so the rule
	holds for grants written before it existed and for anything inserted
	straight into the table — neither of which a save-time check would reach.

	Everything else passes through in the order it was granted.
*/
const (
	// The module_permission ModuleName the exclusivity rule is written in, and
	// the one the admin pickers compare against (lib/moduleExclusivity.ts).
	dashboardModuleName = "Dashboard"

	/* The identifier the nav keys on — NAV_ITEMS in lib/navItems.tsx.

	   Deliberately not read from module_permission.pageName: the seeded row
	   carries "DashboardAccess", and a nav item is matched by pageName, so
	   letting the row supply it hides the tab. Pinned here so the two ends
	   cannot drift again. */
	dashboardPageName = "dashboard"
)

func effectiveNavModules(granted []string) []string {
	hasReports := false
	for _, n := range granted {
		if strings.EqualFold(n, reportsPageName) {
			hasReports = true
			break
		}
	}

	out := make([]string, 0, len(granted))
	for _, n := range granted {
		// The one subtraction: Reports supersedes Dashboard where both are
		// ticked. Where Reports is absent, Dashboard stands or falls on its
		// own grant like everything else in the list.
		if hasReports && strings.EqualFold(n, dashboardModuleName) {
			continue
		}
		out = append(out, n)
	}
	return out
}

/*
navEntries turns the resolved module NAMES into the nav payload.

Split out of UserNav so it can be tested. The exclusivity rule had a test and
this did not, which is precisely where the Dashboard tab went missing: the rule
was choosing correctly and the assembly was mislabelling the answer.

`byName` is the granted rows keyed by lower-cased ModuleName; `dropByParent` is
the admin-configured dropdown children keyed by pageName.
*/
/*
mayOpenDashboard reports whether this login may read the dashboard's contents.

Keyed on ModuleName rather than pageName, matching effectiveNavModules and the
admin pickers — the seeded row's pageName is "DashboardAccess", which is exactly
the mismatch that hid the tab, and repeating it here would hand a 403 to every
login that legitimately has the grant.

Staff pass: they administer these dashboards and reach them from /admin.
*/
func mayOpenDashboard(claims *ipauth.Claims) bool {
	if claims == nil {
		return false
	}
	if isStaff(claims) {
		return true
	}
	row, _ := db.QueryOne(`
		SELECT 1 AS ok
		  FROM user_module_permission_test u
		  JOIN module_permission m ON m.Id = u.moduleId
		 WHERE u.loginId = ? AND u.allowed = 1 AND m.status = 0
		   AND UPPER(m.ModuleName) = ?
		 LIMIT 1`, claims.LoginID, strings.ToUpper(dashboardModuleName))
	return row != nil
}

func navEntries(
	granted []string,
	byName map[string]map[string]any,
	dropByParent map[string][]map[string]any,
) []map[string]any {
	modules := []map[string]any{}
	for _, name := range effectiveNavModules(granted) {
		/* Dashboard is emitted with the pageName the NAV keys on, never with
		   whatever the module_permission row happens to carry.

		   The seeded Dashboard module is ModuleName "Dashboard" with pageName
		   "DashboardAccess" — a spelling that predates the nav keying on
		   pageName and appears nowhere in the code. Passing the row's value
		   through sent the tab out identified as something no NAV_ITEM matches,
		   so the client dropped it and a login granted Dashboard saw no
		   Dashboard.

		   Matched by NAME because that is what the grant, the exclusivity rule
		   and the admin pickers are all written in. Only the identifier is
		   overridden; the row still supplies the label and the order, so
		   renaming or reordering on /admin/modules moves this tab like any
		   other. */
		if strings.EqualFold(name, dashboardModuleName) {
			row, ok := byName[strings.ToLower(name)]
			if !ok {
				continue // not granted — and there is no fallback any more
			}
			modules = append(modules, map[string]any{
				"moduleId":   intFromAny(row["moduleId"]),
				"moduleName": name,
				"pageName":   dashboardPageName,
				"navOrder":   intFromAny(row["navOrder"]),
				"dropdown":   dropByParent[dashboardPageName],
			})
			continue
		}

		row, ok := byName[strings.ToLower(name)]
		if !ok {
			continue // granted but no row to describe it — nothing to render
		}
		pageName := strFromAny(row["pageName"])
		modules = append(modules, map[string]any{
			"moduleId":   intFromAny(row["moduleId"]),
			"moduleName": name,
			"pageName":   pageName,
			"navOrder":   intFromAny(row["navOrder"]),
			"dropdown":   dropByParent[pageName],
		})
	}
	return modules
}
