package admin

// Power BI workspace *management* endpoints (mutating). These complement the
// read-only monitor in dashboards.go and proxy to the Power BI REST API using
// the active service-principal credentials:
//
//   POST /api/admin/powerbi-workspace/import         — upload a .pbix into the workspace
//   GET  /api/admin/powerbi-workspace/import-status  — poll an import's state
//   POST /api/admin/powerbi-workspace/schedule       — set a dataset's refresh schedule
//   POST /api/admin/powerbi-workspace/refresh        — trigger an on-demand refresh
//   POST /api/admin/powerbi-workspace/delete         — delete a report or dataset
//
// All are gated behind the "powerbi-workspace" config module (see main.go).

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/ip-house/iphouse-api/db"
)

// activePBI resolves the active Power BI credential, mints an Azure token and
// returns it together with the target workspace (group) id.
func activePBI() (token, workspaceID string, err error) {
	cred, _ := db.QueryOne("SELECT client_id, client_secret, tenant_id, workspace_id FROM master_powerbi_credentials WHERE is_active = 1 ORDER BY id DESC LIMIT 1")
	if cred == nil {
		return "", "", fmt.Errorf("no credentials")
	}
	tenantID := pbiDecrypt(cred["tenant_id"])
	clientID := pbiDecrypt(cred["client_id"])
	clientSecret := pbiDecrypt(cred["client_secret"])
	workspaceID = pbiDecrypt(cred["workspace_id"])
	if tenantID == "" || clientID == "" || clientSecret == "" || workspaceID == "" {
		return "", "", fmt.Errorf("incomplete credentials")
	}
	t, terr := pbiToken(tenantID, clientID, clientSecret)
	if terr != nil {
		return "", "", terr
	}
	return t, workspaceID, nil
}

// pbiDo performs a mutating Power BI REST call and returns the raw status/body.
func pbiDo(method, token, path, contentType string, body io.Reader) (int, []byte, error) {
	req, _ := http.NewRequest(method, "https://api.powerbi.com/v1.0/myorg/"+path, body)
	req.Header.Set("Authorization", "Bearer "+token)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b, nil
}

// pbiErrMessage pulls a human-readable message out of a Power BI error body.
func pbiErrMessage(status int, body []byte) string {
	var env struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(body, &env) == nil {
		if env.Error.Message != "" {
			return env.Error.Message
		}
		if env.Error.Code != "" {
			return env.Error.Code
		}
	}
	return fmt.Sprintf("Power BI returned HTTP %d", status)
}

// POST /api/admin/powerbi-workspace/import
// multipart/form-data: file=<.pbix>, name=<displayName>, nameConflict=<...>
func PowerBIImport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		fail(w, 405, "Method not allowed")
		return
	}
	// Cap the upload at 1 GB (Power BI's simple-import ceiling).
	r.Body = http.MaxBytesReader(w, r.Body, 1<<30)
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		fail(w, 400, "Could not read the uploaded file (max 1 GB).")
		return
	}
	file, hdr, err := r.FormFile("file")
	if err != nil {
		fail(w, 422, "No .pbix file was provided.")
		return
	}
	defer file.Close()

	if !strings.HasSuffix(strings.ToLower(hdr.Filename), ".pbix") {
		fail(w, 422, "The file must be a .pbix report.")
		return
	}
	name := strings.TrimSpace(r.FormValue("name"))
	if name == "" {
		name = strings.TrimSuffix(hdr.Filename, ".pbix")
	}
	conflict := r.FormValue("nameConflict")
	switch conflict {
	case "Abort", "Overwrite", "CreateOrOverwrite", "GenerateUniqueName":
	default:
		conflict = "CreateOrOverwrite" // "update if it exists, else create"
	}

	token, workspaceID, err := activePBI()
	if err != nil {
		log.Printf("[powerbi] import auth failed: %v", err)
		fail(w, 502, "PowerBI authentication failed. Check the configured credentials.")
		return
	}

	// Stream the uploaded file straight through as a fresh multipart body so we
	// never buffer the whole .pbix in memory.
	pr, pw := io.Pipe()
	mw := multipart.NewWriter(pw)
	go func() {
		part, e := mw.CreateFormFile("file", hdr.Filename)
		if e == nil {
			_, e = io.Copy(part, file)
		}
		if e == nil {
			e = mw.Close()
		}
		pw.CloseWithError(e)
	}()

	path := fmt.Sprintf("groups/%s/imports?datasetDisplayName=%s&nameConflict=%s",
		workspaceID, url.QueryEscape(name), conflict)
	status, body, err := pbiDo("POST", token, path, mw.FormDataContentType(), pr)
	if err != nil {
		log.Printf("[powerbi] import request failed: %v", err)
		fail(w, 502, "The upload to Power BI could not be completed.")
		return
	}
	if status < 200 || status >= 300 {
		fail(w, 502, "Import failed: "+pbiErrMessage(status, body))
		return
	}

	var imp map[string]any
	json.Unmarshal(body, &imp)
	importID := ""
	if s, ok := imp["id"].(string); ok {
		importID = s
	}
	ok(w, map[string]any{
		"success":     true,
		"importId":    importID,
		"importState": imp["importState"],
		"name":        name,
	})
}

// GET /api/admin/powerbi-workspace/import-status?id=<importId>
func PowerBIImportStatus(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if id == "" {
		fail(w, 422, "id is required")
		return
	}
	token, workspaceID, err := activePBI()
	if err != nil {
		fail(w, 502, "PowerBI authentication failed.")
		return
	}
	data, err := pbiGet(token, "groups/"+workspaceID+"/imports/"+url.PathEscape(id))
	if err != nil || data == nil {
		fail(w, 502, "Could not read the import status.")
		return
	}
	ok(w, map[string]any{
		"success":     true,
		"importState": data["importState"],
		"reports":     data["reports"],
		"datasets":    data["datasets"],
		"error":       data["error"],
	})
}

// POST /api/admin/powerbi-workspace/schedule
// { datasetId, enabled?, days?[], times?[], localTimeZoneId?, notifyOption? }
func PowerBISchedule(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		fail(w, 405, "Method not allowed")
		return
	}
	var body struct {
		DatasetID       string   `json:"datasetId"`
		Enabled         *bool    `json:"enabled"`
		Days            []string `json:"days"`
		Times           []string `json:"times"`
		LocalTimeZoneID string   `json:"localTimeZoneId"`
		NotifyOption    string   `json:"notifyOption"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if strings.TrimSpace(body.DatasetID) == "" {
		fail(w, 422, "datasetId is required")
		return
	}
	// When enabling, Power BI requires at least one day and one time.
	if body.Enabled != nil && *body.Enabled {
		if len(body.Days) == 0 || len(body.Times) == 0 {
			fail(w, 422, "Select at least one day and one time to enable the schedule.")
			return
		}
	}

	value := map[string]any{}
	if body.Enabled != nil {
		value["enabled"] = *body.Enabled
	}
	if body.Days != nil {
		value["days"] = body.Days
	}
	if body.Times != nil {
		value["times"] = body.Times
	}
	if body.LocalTimeZoneID != "" {
		value["localTimeZoneId"] = body.LocalTimeZoneID
	}
	if body.NotifyOption != "" {
		value["notifyOption"] = body.NotifyOption
	}
	if len(value) == 0 {
		fail(w, 422, "No schedule changes were provided.")
		return
	}

	token, workspaceID, err := activePBI()
	if err != nil {
		fail(w, 502, "PowerBI authentication failed.")
		return
	}
	payload, _ := json.Marshal(map[string]any{"value": value})
	status, respBody, err := pbiDo("PATCH", token,
		"groups/"+workspaceID+"/datasets/"+url.PathEscape(body.DatasetID)+"/refreshSchedule",
		"application/json", bytes.NewReader(payload))
	if err != nil {
		fail(w, 502, "Could not reach Power BI to update the schedule.")
		return
	}
	if status < 200 || status >= 300 {
		fail(w, 502, "Schedule update failed: "+pbiErrMessage(status, respBody))
		return
	}
	ok(w, map[string]any{"success": true})
}

// POST /api/admin/powerbi-workspace/refresh  { datasetId }
func PowerBIRefreshNow(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		fail(w, 405, "Method not allowed")
		return
	}
	var body struct {
		DatasetID string `json:"datasetId"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if strings.TrimSpace(body.DatasetID) == "" {
		fail(w, 422, "datasetId is required")
		return
	}
	token, workspaceID, err := activePBI()
	if err != nil {
		fail(w, 502, "PowerBI authentication failed.")
		return
	}
	payload, _ := json.Marshal(map[string]any{"notifyOption": "NoNotification"})
	status, respBody, err := pbiDo("POST", token,
		"groups/"+workspaceID+"/datasets/"+url.PathEscape(body.DatasetID)+"/refreshes",
		"application/json", bytes.NewReader(payload))
	if err != nil {
		fail(w, 502, "Could not reach Power BI to start the refresh.")
		return
	}
	if status < 200 || status >= 300 {
		fail(w, 502, "Refresh failed: "+pbiErrMessage(status, respBody))
		return
	}
	ok(w, map[string]any{"success": true})
}

// POST /api/admin/powerbi-workspace/delete  { type: "report"|"dataset", id }
func PowerBIDeleteItem(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		fail(w, 405, "Method not allowed")
		return
	}
	var body struct {
		Type string `json:"type"`
		ID   string `json:"id"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if strings.TrimSpace(body.ID) == "" {
		fail(w, 422, "id is required")
		return
	}
	var path string
	switch body.Type {
	case "report":
		path = "reports/"
	case "dataset":
		path = "datasets/"
	default:
		fail(w, 422, "type must be 'report' or 'dataset'")
		return
	}
	token, workspaceID, err := activePBI()
	if err != nil {
		fail(w, 502, "PowerBI authentication failed.")
		return
	}
	status, respBody, err := pbiDo("DELETE", token,
		"groups/"+workspaceID+"/"+path+url.PathEscape(body.ID), "", nil)
	if err != nil {
		fail(w, 502, "Could not reach Power BI to delete the item.")
		return
	}
	if status < 200 || status >= 300 {
		fail(w, 502, "Delete failed: "+pbiErrMessage(status, respBody))
		return
	}
	ok(w, map[string]any{"success": true})
}
