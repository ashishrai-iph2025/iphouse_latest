package admin

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	ipauth "github.com/ip-house/iphouse-api/auth"
	"github.com/ip-house/iphouse-api/db"
)

// maskSecret returns "••••••••" for non-empty secrets so plaintext never reaches the browser.
func maskSecret(s string) string {
	if s == "" {
		return ""
	}
	return "••••••••"
}

// pbiDecrypt mirrors the old project's safeDecrypt: decrypt with the main
// ENCRYPTION_KEY, falling back to the raw value if it isn't encrypted.
func pbiDecrypt(v any) string {
	s := strVal(v)
	if s == "" {
		return ""
	}
	if dec := ipauth.DecryptMain(s); dec != "" {
		return dec
	}
	return s
}

// GET/POST/PUT/DELETE /api/admin/dashboards
func Dashboards(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		uid := r.URL.Query().Get("userId")
		mid := r.URL.Query().Get("moduleId")

		// Single record lookup for edit page
		if uid != "" && mid != "" {
			row, _ := db.QueryOne(`
				SELECT u.userId, u.name, u.email, m.moduleId, m.moduleName, mp.link, mp.active, mp.`+"`default`"+`
				FROM dcp_user_module_map mp
				JOIN dcp_user u ON u.userId = mp.userId
				JOIN dcp_module m ON m.moduleId = mp.moduleId
				WHERE mp.userId = ? AND mp.moduleId = ?`, uid, mid)
			if row == nil {
				fail(w, 404, "Not found"); return
			}
			ok(w, map[string]any{"success": true, "dashboard": row}); return
		}

		// Modules dropdown (for add form)
		if r.URL.Query().Get("modules") == "1" {
			mods, _ := db.Query("SELECT moduleId, moduleName FROM dcp_module WHERE deleted = 0 ORDER BY moduleName")
			if mods == nil { mods = []map[string]any{} }
			ok(w, map[string]any{"success": true, "modules": mods}); return
		}

		// Full list
		dashboards, _ := db.Query(`
			SELECT u.userId, u.name, u.email, m.moduleId, m.moduleName, mp.link, mp.active, mp.`+"`default`"+`
			FROM dcp_user u
			JOIN dcp_user_module_map mp ON u.userId = mp.userId
			JOIN dcp_module m ON m.moduleId = mp.moduleId
			WHERE mp.link IS NOT NULL AND u.deleted = 0
			ORDER BY u.name ASC, m.moduleName ASC`)
		if dashboards == nil { dashboards = []map[string]any{} }

		totalClients, _ := db.QueryOne("SELECT COUNT(*) AS c FROM dcp_user WHERE deleted = 0 AND (role IS NULL OR role != 1)")
		totalDashboards, _ := db.QueryOne("SELECT COUNT(*) AS c FROM dcp_user_module_map WHERE link IS NOT NULL")
		totalModules, _ := db.QueryOne("SELECT COUNT(*) AS c FROM dcp_module WHERE deleted = 0")

		tc := int64(0); if totalClients != nil { tc = intVal(totalClients["c"]) }
		td := int64(0); if totalDashboards != nil { td = intVal(totalDashboards["c"]) }
		tm := int64(0); if totalModules != nil { tm = intVal(totalModules["c"]) }

		ok(w, map[string]any{
			"success":         true,
			"dashboards":      dashboards,
			"totalClients":    tc,
			"totalDashboards": td,
			"totalModules":    tm,
		})

	case http.MethodPost:
		var body struct {
			UserID    int64  `json:"userId"`
			ModuleID  int64  `json:"moduleId"`
			Link      string `json:"link"`
			Active    int    `json:"active"`
			IsDefault int    `json:"isDefault"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if body.UserID == 0 || body.ModuleID == 0 || body.Link == "" {
			fail(w, 422, "userId, moduleId and link are required"); return
		}
		existing, _ := db.QueryOne("SELECT userId FROM dcp_user_module_map WHERE userId = ? AND moduleId = ?", body.UserID, body.ModuleID)
		if existing != nil {
			db.Exec("UPDATE dcp_user_module_map SET link=?, active=?, `default`=? WHERE userId=? AND moduleId=?",
				body.Link, body.Active, body.IsDefault, body.UserID, body.ModuleID)
		} else {
			db.Exec("INSERT INTO dcp_user_module_map (userId, moduleId, link, active, `default`) VALUES (?,?,?,?,?)",
				body.UserID, body.ModuleID, body.Link, body.Active, body.IsDefault)
		}
		ok(w, map[string]any{"success": true})

	case http.MethodPut:
		var body struct {
			UserID    int64  `json:"userId"`
			ModuleID  int64  `json:"moduleId"`
			Link      string `json:"link"`
			Active    int    `json:"active"`
			IsDefault int    `json:"isDefault"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if body.UserID == 0 || body.ModuleID == 0 {
			fail(w, 422, "userId and moduleId required"); return
		}
		if body.Link != "" {
			db.Exec("UPDATE dcp_user_module_map SET link=?, active=?, `default`=? WHERE userId=? AND moduleId=?",
				body.Link, body.Active, body.IsDefault, body.UserID, body.ModuleID)
		} else {
			db.Exec("UPDATE dcp_user_module_map SET active=? WHERE userId=? AND moduleId=?",
				body.Active, body.UserID, body.ModuleID)
		}
		ok(w, map[string]any{"success": true})

	case http.MethodDelete:
		var body struct {
			UserID   int64 `json:"userId"`
			ModuleID int64 `json:"moduleId"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		db.Exec("DELETE FROM dcp_user_module_map WHERE userId=? AND moduleId=?", body.UserID, body.ModuleID)
		ok(w, map[string]any{"success": true})

	default:
		fail(w, 405, "Method not allowed")
	}
}

// GET/POST/PUT/DELETE /api/admin/powerbi-creds
func PowerBICreds(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		rows, _ := db.Query("SELECT id, client_id, client_secret, tenant_id, workspace_id, is_active FROM master_powerbi_credentials ORDER BY id ASC")
		if rows == nil { rows = []map[string]any{} }
		creds := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			creds = append(creds, map[string]any{
				"id":           row["id"],
				"clientId":     maskSecret(pbiDecrypt(row["client_id"])),
				"clientSecret": maskSecret(pbiDecrypt(row["client_secret"])),
				"tenantId":     maskSecret(pbiDecrypt(row["tenant_id"])),
				"workspaceId":  maskSecret(pbiDecrypt(row["workspace_id"])),
				"is_active":    row["is_active"],
			})
		}
		ok(w, map[string]any{"success": true, "creds": creds})
	case http.MethodPost:
		var body struct {
			ClientID     string `json:"clientId"`
			ClientSecret string `json:"clientSecret"`
			TenantID     string `json:"tenantId"`
			WorkspaceID  string `json:"workspaceId"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		db.Exec("INSERT INTO master_powerbi_credentials (client_id, client_secret, tenant_id, workspace_id, is_active) VALUES (?, ?, ?, ?, 1)",
			ipauth.EncryptMain(body.ClientID), ipauth.EncryptMain(body.ClientSecret), ipauth.EncryptMain(body.TenantID), ipauth.EncryptMain(body.WorkspaceID))
		ok(w, map[string]any{"success": true})
	case http.MethodPut:
		var body struct {
			ID           int64  `json:"id"`
			ClientID     string `json:"clientId"`
			ClientSecret string `json:"clientSecret"`
			TenantID     string `json:"tenantId"`
			WorkspaceID  string `json:"workspaceId"`
			IsActive     int    `json:"isActive"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if body.ClientSecret != "" {
			db.Exec("UPDATE master_powerbi_credentials SET client_id=?, client_secret=?, tenant_id=?, workspace_id=?, is_active=? WHERE id=?",
				ipauth.EncryptMain(body.ClientID), ipauth.EncryptMain(body.ClientSecret), ipauth.EncryptMain(body.TenantID), ipauth.EncryptMain(body.WorkspaceID), body.IsActive, body.ID)
		} else {
			db.Exec("UPDATE master_powerbi_credentials SET client_id=?, tenant_id=?, workspace_id=?, is_active=? WHERE id=?",
				ipauth.EncryptMain(body.ClientID), ipauth.EncryptMain(body.TenantID), ipauth.EncryptMain(body.WorkspaceID), body.IsActive, body.ID)
		}
		ok(w, map[string]any{"success": true})
	case http.MethodDelete:
		var body struct { ID int64 `json:"id"` }
		json.NewDecoder(r.Body).Decode(&body)
		db.Exec("DELETE FROM master_powerbi_credentials WHERE id = ?", body.ID)
		ok(w, map[string]any{"success": true})
	default:
		fail(w, 405, "Method not allowed")
	}
}

// GET /api/admin/powerbi-creds/reveal?id=<id>
// Returns decrypted credentials for a single row (admin-only, logged action).
func PowerBICredsReveal(w http.ResponseWriter, r *http.Request) {
	idStr := r.URL.Query().Get("id")
	if idStr == "" {
		fail(w, 422, "id required"); return
	}
	row, err := db.QueryOne("SELECT id, client_id, client_secret, tenant_id, workspace_id, is_active FROM master_powerbi_credentials WHERE id = ?", idStr)
	if err != nil || row == nil {
		fail(w, 404, "Not found"); return
	}
	logReveal(r, "powerbi", idStr)
	ok(w, map[string]any{
		"success":      true,
		"id":           row["id"],
		"clientId":     pbiDecrypt(row["client_id"]),
		"clientSecret": pbiDecrypt(row["client_secret"]),
		"tenantId":     pbiDecrypt(row["tenant_id"]),
		"workspaceId":  pbiDecrypt(row["workspace_id"]),
		"is_active":    row["is_active"],
	})
}

// pbiToken fetches an Azure OAuth2 access token for PowerBI.
func pbiToken(tenantId, clientId, clientSecret string) (string, error) {
	form := url.Values{}
	form.Set("grant_type", "client_credentials")
	form.Set("client_id", clientId)
	form.Set("client_secret", clientSecret)
	form.Set("scope", "https://analysis.windows.net/powerbi/api/.default")
	resp, err := http.PostForm("https://login.microsoftonline.com/"+tenantId+"/oauth2/v2.0/token", form)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var data map[string]any
	json.NewDecoder(resp.Body).Decode(&data)
	if t, ok := data["access_token"].(string); ok && t != "" {
		return t, nil
	}
	errDesc := ""
	if e, ok := data["error_description"].(string); ok {
		errDesc = e
	}
	return "", fmt.Errorf("token error: %s", errDesc)
}

// pbiGet calls a PowerBI API endpoint and decodes the JSON response.
func pbiGet(token, path string) (map[string]any, error) {
	req, _ := http.NewRequest("GET", "https://api.powerbi.com/v1.0/myorg/"+path, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var data map[string]any
	json.NewDecoder(resp.Body).Decode(&data)
	return data, nil
}

// GET/POST /api/admin/powerbi-workspace
func PowerBIWorkspace(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		fail(w, 405, "Method not allowed")
		return
	}

	cred, _ := db.QueryOne("SELECT client_id, client_secret, tenant_id, workspace_id FROM master_powerbi_credentials WHERE is_active = 1 ORDER BY id DESC LIMIT 1")
	if cred == nil {
		fail(w, 400, "No PowerBI credentials configured"); return
	}
	tenantId := pbiDecrypt(cred["tenant_id"])
	clientId := pbiDecrypt(cred["client_id"])
	clientSecret := pbiDecrypt(cred["client_secret"])
	workspaceId := pbiDecrypt(cred["workspace_id"])

	if tenantId == "" || clientId == "" || clientSecret == "" || workspaceId == "" {
		fail(w, 400, "PowerBI credentials are incomplete or could not be decrypted"); return
	}

	token, err := pbiToken(tenantId, clientId, clientSecret)
	if err != nil {
		fail(w, 502, "Azure auth failed: "+err.Error()); return
	}

	// Fetch workspace, reports and datasets concurrently.
	var wsData, reportsData, datasetsData map[string]any
	var topWg sync.WaitGroup
	topWg.Add(3)
	go func() { defer topWg.Done(); wsData, _ = pbiGet(token, "groups/"+workspaceId) }()
	go func() { defer topWg.Done(); reportsData, _ = pbiGet(token, "groups/"+workspaceId+"/reports") }()
	go func() { defer topWg.Done(); datasetsData, _ = pbiGet(token, "groups/"+workspaceId+"/datasets") }()
	topWg.Wait()

	workspaceName := workspaceId
	workspaceType := ""
	if wsData != nil {
		if n, ok := wsData["name"].(string); ok { workspaceName = n }
		if t, ok := wsData["type"].(string); ok { workspaceType = t }
	}

	// Build reports list
	reports := []map[string]any{}
	if reportsData != nil {
		if vals, ok := reportsData["value"].([]any); ok {
			for _, v := range vals {
				if m, ok := v.(map[string]any); ok {
					reports = append(reports, map[string]any{
						"id":         m["id"],
						"name":       m["name"],
						"reportType": m["reportType"],
						"webUrl":     m["webUrl"],
						"embedUrl":   m["embedUrl"],
						"datasetId":  m["datasetId"],
					})
				}
			}
		}
	}

	// Build datasets list with refresh info — fetched concurrently.
	datasets := []map[string]any{}
	if datasetsData != nil {
		if vals, ok := datasetsData["value"].([]any); ok {
			datasets = make([]map[string]any, len(vals))
			sem := make(chan struct{}, 6) // limit concurrent Azure calls
			var dsWg sync.WaitGroup

			for i, v := range vals {
				m, ok := v.(map[string]any)
				if !ok { continue }
				dsId := ""
				if s, ok := m["id"].(string); ok { dsId = s }
				isRefreshable := false
				if b, ok := m["isRefreshable"].(bool); ok { isRefreshable = b }

				ds := map[string]any{
					"id":                         dsId,
					"name":                       m["name"],
					"configuredBy":               m["configuredBy"],
					"isRefreshable":              isRefreshable,
					"isOnPremGatewayRequired":    m["isOnPremGatewayRequired"],
					"targetStorageMode":          m["targetStorageMode"],
					"createdDate":                m["createdDate"],
					"contentProviderType":        m["contentProviderType"],
					"refreshes":                  []any{},
					"refreshSchedule":            nil,
					"directQueryRefreshSchedule": nil,
				}
				datasets[i] = ds

				if !isRefreshable || dsId == "" {
					continue
				}

				dsWg.Add(1)
				go func(ds map[string]any, dsId string) {
					defer dsWg.Done()
					sem <- struct{}{}
					defer func() { <-sem }()

					// The three per-dataset calls run concurrently; each writes to its
					// own local var to avoid concurrent map writes, merged after Wait().
					var refreshes []any
					var refreshSchedule, dqSchedule any
					var inner sync.WaitGroup
					inner.Add(3)
					go func() {
						defer inner.Done()
						if rd, _ := pbiGet(token, "groups/"+workspaceId+"/datasets/"+dsId+"/refreshes?$top=20"); rd != nil {
							if vals2, ok := rd["value"].([]any); ok { refreshes = vals2 }
						}
					}()
					go func() {
						defer inner.Done()
						if rs, _ := pbiGet(token, "groups/"+workspaceId+"/datasets/"+dsId+"/refreshSchedule"); rs != nil {
							refreshSchedule = rs
						}
					}()
					go func() {
						defer inner.Done()
						if dqs, _ := pbiGet(token, "groups/"+workspaceId+"/datasets/"+dsId+"/directQueryRefreshSchedule"); dqs != nil {
							dqSchedule = dqs
						}
					}()
					inner.Wait()

					if refreshes != nil { ds["refreshes"] = refreshes }
					ds["refreshSchedule"] = refreshSchedule
					ds["directQueryRefreshSchedule"] = dqSchedule
				}(ds, dsId)
			}
			dsWg.Wait()

			// Drop any nil slots from entries that failed the type assertion.
			compact := datasets[:0]
			for _, d := range datasets {
				if d != nil { compact = append(compact, d) }
			}
			datasets = compact
		}
	}

	ok(w, map[string]any{
		"workspaceId":   workspaceId,
		"workspaceName": workspaceName,
		"workspaceType": workspaceType,
		"reports":       reports,
		"datasets":      datasets,
	})
}

// GET /api/admin/powerbi-workspace/activity
func PowerBIWorkspaceActivity(w http.ResponseWriter, r *http.Request) {
	cred, _ := db.QueryOne("SELECT client_id, client_secret, tenant_id FROM master_powerbi_credentials WHERE is_active = 1 ORDER BY id DESC LIMIT 1")
	if cred == nil {
		fail(w, 400, "No PowerBI credentials configured"); return
	}
	token, err := pbiToken(pbiDecrypt(cred["tenant_id"]), pbiDecrypt(cred["client_id"]), pbiDecrypt(cred["client_secret"]))
	if err != nil {
		fail(w, 502, "Azure auth failed: "+err.Error()); return
	}

	daysStr := r.URL.Query().Get("days")
	days := 1
	if daysStr != "" {
		fmt.Sscanf(daysStr, "%d", &days)
	}
	if days < 1 { days = 1 }
	if days > 30 { days = 30 }

	now := time.Now().UTC()
	startDT := now.AddDate(0, 0, -days+1).Format("2006-01-02") + "T00:00:00"
	endDT := now.Format("2006-01-02") + "T23:59:59"

	path := "admin/activityevents?startDateTime='" + url.QueryEscape(startDT) + "'&endDateTime='" + url.QueryEscape(endDT) + "'"
	req, _ := http.NewRequest("GET", "https://api.powerbi.com/v1.0/myorg/"+path, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		ok(w, map[string]any{"events": []any{}, "days": days, "fetchedCount": 0, "error": err.Error()}); return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	var actData map[string]any
	json.Unmarshal(body, &actData)

	events := []any{}
	permErr := false
	var guidance []string
	var errMsg string
	if actData != nil {
		if vals, ok2 := actData["activityEventEntities"].([]any); ok2 { events = vals }
		if e, ok2 := actData["error"].(map[string]any); ok2 {
			if c, ok2 := e["code"].(string); ok2 && strings.Contains(c, "Unauthorized") {
				permErr = true
				errMsg = "Insufficient permissions for Activity Log API. Service principal needs Power BI admin rights."
				guidance = []string{
					"Go to Power BI Admin Portal → Tenant Settings.",
					"Enable 'Allow service principals to use Power BI admin read-only APIs'.",
					"Add the service principal's security group to the setting.",
				}
			}
		}
	}

	ok(w, map[string]any{
		"events":          events,
		"days":            days,
		"fetchedCount":    len(events),
		"permissionError": permErr,
		"error":           errMsg,
		"guidance":        guidance,
	})
}
