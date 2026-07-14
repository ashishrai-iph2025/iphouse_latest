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

// GET /api/keepalive
func Keepalive(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	if claims == nil {
		Fail(w, 401, "Not authenticated"); return
	}
	expiryMs := time.Now().Add(time.Duration(config.C.SessionIdleSeconds) * time.Second).UnixMilli()
	OK(w, map[string]any{"alive": true, "expiryMs": expiryMs})
}

// GET /api/test-db — health probe. This endpoint is unauthenticated, so it must
// never echo the driver error (it names the DB host, user and schema). The
// detail goes to the server log; the caller gets a bare ok/not-ok.
func TestDB(w http.ResponseWriter, r *http.Request) {
	if err := db.Get().Ping(); err != nil {
		log.Printf("[test-db] ping failed: %v", err)
		Fail(w, 503, "Service unavailable"); return
	}
	OK(w, map[string]any{"success": true, "message": "DB OK"})
}

// POST /api/pending-count
func PendingCount(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	apiToken := ResolveAPIToken(claims)
	if apiToken == "" {
		Fail(w, 401, "API token missing"); return
	}

	var body struct {
		PlatformName string `json:"platformName"`
		AssetName    string `json:"assetName"`
		StartDate    string `json:"startDate"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if body.PlatformName == "" {
		Fail(w, 422, "platformName is required"); return
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
		Fail(w, 502, err.Error()); return
	}
	OK(w, map[string]any{"success": true, "data": data})
}

// GET/POST /api/notifications
func Notifications(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	if claims == nil {
		Fail(w, 401, "Not authenticated"); return
	}
	rows, err := db.Query("SELECT * FROM dcp_notifications WHERE userId = ? ORDER BY created_at DESC LIMIT 50", claims.UserID)
	if err != nil || rows == nil {
		OK(w, map[string]any{"success": true, "notifications": []any{}}); return
	}
	OK(w, map[string]any{"success": true, "notifications": rows})
}

// GET /api/token
func Token(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	if claims == nil {
		Fail(w, 401, "Not authenticated"); return
	}
	apiToken := ResolveAPIToken(claims)
	OK(w, map[string]any{"success": true, "token": apiToken})
}

// GET /api/user/nav
func UserNav(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	if claims == nil {
		Fail(w, 401, "Unauthorized"); return
	}

	allowed, _ := db.Query(`
		SELECT m.Id AS moduleId, m.ModuleName, m.pageName
		FROM user_module_permission_test u
		JOIN module_permission m ON m.Id = u.moduleId
		WHERE u.loginId = ? AND u.allowed = 1 AND m.status = 0`, claims.LoginID)

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

	// Dashboard is always granted regardless of permission table entries
	modules := []map[string]any{
		{"moduleId": 0, "moduleName": "Dashboard", "pageName": "dashboard"},
	}
	for _, row := range allowed {
		name := strFromAny(row["ModuleName"])
		if name == "Dashboard" {
			continue // already added above
		}
		modules = append(modules, map[string]any{
			"moduleId":   intFromAny(row["moduleId"]),
			"moduleName": name,
			"pageName":   strFromAny(row["pageName"]),
		})
	}
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
		Fail(w, 401, "Not authenticated"); return
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
		Fail(w, 401, "Not authenticated"); return
	}

	var body struct {
		Current string `json:"current"`
		NewPass string `json:"newPass"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if body.Current == "" || body.NewPass == "" {
		OK(w, map[string]any{"success": false, "error": "Both passwords are required"}); return
	}
	if len(body.NewPass) < 8 {
		OK(w, map[string]any{"success": false, "error": "New password must be at least 8 characters"}); return
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
			OK(w, map[string]any{"success": false, "error": "Current password is incorrect"}); return
		}
		hashed, err := ipauth.HashPassword(body.NewPass)
		if err != nil {
			Fail(w, 500, "Hash error"); return
		}
		if err := db.MustExec("UPDATE dcp_super_admin SET password_hash = ? WHERE id = ?", hashed, intFromAny(row["id"])); err != nil {
			Fail(w, 500, "Could not update your password. Please try again."); return
		}
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
		OK(w, map[string]any{"success": false, "error": "Account not found"}); return
	}
	hash, _ := row["login_password"].(string)
	if !ipauth.VerifyPassword(body.Current, hash) {
		OK(w, map[string]any{"success": false, "error": "Current password is incorrect"}); return
	}

	hashed, err := ipauth.HashPassword(body.NewPass)
	if err != nil {
		Fail(w, 500, "Hash error"); return
	}
	if err := db.MustExec("UPDATE dcp_user_login SET login_password = ? WHERE login_username = ? AND is_active = 1", hashed, claims.LoginUsername); err != nil {
		Fail(w, 500, "Could not update your password. Please try again."); return
	}
	OK(w, map[string]any{"success": true})
}

// POST /api/ip-tracking
func IPTracking(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	if claims == nil {
		Fail(w, 401, "Not authenticated"); return
	}
	apiToken := ResolveAPIToken(claims)
	if apiToken == "" {
		Fail(w, 401, "API token missing"); return
	}
	var body struct {
		StartDate       string `json:"startDate"`
		EndDate         string `json:"endDate"`
		CopyrightOwner  string `json:"copyrightOwner"`
		PageNo          int    `json:"pageNo"`
		Asset           string `json:"asset"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		Fail(w, 422, "Invalid request body"); return
	}
	if body.CopyrightOwner == "" {
		Fail(w, 422, "copyrightOwner is required"); return
	}
	payload := map[string]any{
		"startDate":      body.StartDate,
		"endDate":        body.EndDate,
		"copyrightOwner": body.CopyrightOwner,
		"pageNo":         body.PageNo,
	}
	if body.Asset != "" {
		payload["asset"]      = body.Asset
		payload["assetName"]  = body.Asset
		payload["assetTitle"] = body.Asset
		payload["Asset"]      = body.Asset
		payload["AssetName"]  = body.Asset
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
		Fail(w, 502, "Upstream request failed. Please try again."); return
	}
	defer resp.Body.Close()
	rawBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		Fail(w, 502, "Markscan API error "+string(rawBody[:min(len(rawBody), 200)])); return
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
	if v == nil { return []any{} }
	return v
}

func min(a, b int) int {
	if a < b { return a }
	return b
}

// GET /api/ip-tracking/client-details
func IPTrackingClientDetails(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	if claims == nil {
		Fail(w, 401, "Not authenticated"); return
	}
	apiToken := ResolveAPIToken(claims)
	if apiToken == "" {
		Fail(w, 401, "API token missing"); return
	}
	base := config.C.MarkscanBase
	req, _ := http.NewRequest("GET", base+"/GetClientDetails", nil)
	req.Header.Set("Authorization", "Bearer "+apiToken)
	req.Header.Set("Accept", "application/json")
	tlsClient := &http.Client{Timeout: 20 * time.Second}
	resp, err := tlsClient.Do(req)
	if err != nil {
		Fail(w, 502, "Markscan request failed"); return
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
		Fail(w, 401, "Not authenticated"); return
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
		Fail(w, 401, "API token missing"); return
	}

	rawP, _ := markscan.GetAllPlatforms(apiToken)
	rawA, _ := markscan.GetAllAssets(apiToken)
	platforms := normalizeMasterList(rawP, "platformName", "platform_name", "name", "platform", "PlatformName", "Platform")
	assets    := normalizeMasterList(rawA, "assetName", "asset_name", "name", "AssetName", "Asset")
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
		Fail(w, 401, "SESSION_EXPIRED"); return
	}

	reportID := r.URL.Query().Get("reportId")
	if reportID == "" {
		Fail(w, 400, "Missing reportId"); return
	}

	row, err := db.QueryOne("SELECT client_id, client_secret, tenant_id, workspace_id FROM master_powerbi_credentials WHERE is_active = 1 ORDER BY id DESC LIMIT 1")
	if err != nil || row == nil {
		Fail(w, 500, "No Power BI API credentials found in database"); return
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
		Fail(w, 500, "Azure AD request failed"); return
	}
	accessToken, _ := tokenResp["access_token"].(string)
	if accessToken == "" {
		Fail(w, 500, "Azure AD authentication failed"); return
	}

	reportInfo, err := getWithBearer("https://api.powerbi.com/v1.0/myorg/groups/"+workspaceID+"/reports/"+reportID, accessToken)
	if err != nil {
		Fail(w, 500, "Report fetch failed"); return
	}
	embedURL, _ := reportInfo["embedUrl"].(string)
	if embedURL == "" {
		Fail(w, 500, "Invalid reportId or no API permission"); return
	}

	embedTokenResp, err := postJSONWithBearer(
		"https://api.powerbi.com/v1.0/myorg/groups/"+workspaceID+"/reports/"+reportID+"/GenerateToken",
		accessToken, map[string]string{"accessLevel": "View"},
	)
	if err != nil {
		Fail(w, 500, "Embed token generation failed"); return
	}
	embedTok, _ := embedTokenResp["token"].(string)
	if embedTok == "" {
		Fail(w, 500, "Embed token generation failed"); return
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
