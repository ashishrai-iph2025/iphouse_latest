package markscan

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/ip-house/iphouse-api/config"
)

var httpClient = &http.Client{
	Timeout: 90 * time.Second,
}

// ── In-memory API token cache ─────────────────────────────────────────────────

type tokenEntry struct {
	token   string
	expires time.Time
}

var (
	tokenCache  = map[int64]tokenEntry{}
	tokenCacheMu sync.Mutex
)

func GetCachedToken(userID int64) string {
	tokenCacheMu.Lock()
	defer tokenCacheMu.Unlock()
	if e, ok := tokenCache[userID]; ok && time.Now().Before(e.expires) {
		return e.token
	}
	return ""
}

func SetCachedToken(userID int64, token string) {
	tokenCacheMu.Lock()
	defer tokenCacheMu.Unlock()
	tokenCache[userID] = tokenEntry{token: token, expires: time.Now().Add(25 * time.Minute)}
}

// ── Login ─────────────────────────────────────────────────────────────────────

// Login authenticates against the Markscan API. The API occasionally rejects a
// valid login transiently (observed intermittent 400s with credentials that
// succeed moments later) — and a missing token locks the whole session to
// Dashboard-only — so failed attempts are retried before giving up.
func Login(apiUsername, apiPassword string) (string, error) {
	var lastErr error
	for attempt := 1; attempt <= 3; attempt++ {
		token, err := loginOnce(apiUsername, apiPassword)
		if err == nil {
			return token, nil
		}
		lastErr = err
		if attempt < 3 {
			time.Sleep(time.Duration(attempt) * 500 * time.Millisecond)
		}
	}
	return "", lastErr
}

func loginOnce(apiUsername, apiPassword string) (string, error) {
	base := config.C.MarkscanBase
	body, _ := json.Marshal(map[string]string{"userName": apiUsername, "password": apiPassword})
	req, _ := http.NewRequest("POST", base+"/Login", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		snippet := string(raw)
		if len(snippet) > 200 {
			snippet = snippet[:200]
		}
		return "", fmt.Errorf("markscan login %d: %s", resp.StatusCode, snippet)
	}
	// Response is a JSON string e.g. "eyJ..."
	var token string
	if err := json.Unmarshal(raw, &token); err != nil {
		token = string(bytes.Trim(raw, `" `))
	}
	if len(token) < 20 {
		return "", fmt.Errorf("invalid token response")
	}
	return token, nil
}

// ── Infringement endpoints ────────────────────────────────────────────────────

var infringementEndpoints = map[string]string{}
var ugcPlatformMap = map[string]string{
	"tiktok":                   "tiktok",
	"chomikuj":                 "chomikuj",
	"vk":                       "vk",
	"ok":                       "ok",
	"sharechat":                "sharechat",
	"dailymotion":              "dailymotion",
	"bilibili":                 "bilibili",
	"ugc and other social media": "UGC And Other Social Media",
}

func init() {
	base := config.C.MarkscanBase
	if base == "" {
		base = "https://api.markscan.co.in"
	}
	infringementEndpoints = map[string]string{
		"facebook":                 base + "/Facebook/Paged",
		"internet":                 base + "/Internet/Paged",
		"youtube":                  base + "/YouTube/Paged",
		"instagram":                base + "/Instagram/Paged",
		"twitter":                  base + "/Twitter/Paged",
		"telegram":                 base + "/Telegram/Paged",
		"tiktok":                   base + "/UGCPlatform/Paged",
		"chomikuj":                 base + "/UGCPlatform/Paged",
		"vk":                       base + "/UGCPlatform/Paged",
		"ok":                       base + "/UGCPlatform/Paged",
		"sharechat":                base + "/UGCPlatform/Paged",
		"dailymotion":              base + "/UGCPlatform/Paged",
		"bilibili":                 base + "/UGCPlatform/Paged",
		"ugc and other social media": base + "/UGCPlatform/Paged",
		"meta ads":                 base + "/MetaAds/Paged",
		"marketplace":              base + "/Marketplace/Paged",
		"i-tunes":                  base + "/GetInfringements/ItunesApiUrls",
		"play store":               base + "/GetInfringements/GooglePlaystoreAPIurls",
		"third party app":          base + "/GetInfringements/ThirdPartyAppAPIurls",
		"third party mobile app":   base + "/GetInfringements/ThirdPartyMobileAppAPIurls",
		"torrent":                  base + "/GetInfringements/Internet/Test",
	}
}

func HasPlatform(platform string) bool {
	_, ok := infringementEndpoints[platform]
	return ok
}

// FetchInfringements calls the Markscan infringement API.
// Returns (httpStatus, data, error).
func FetchInfringements(token, platform string, opts map[string]any) (int, any, error) {
	url, ok := infringementEndpoints[platform]
	if !ok {
		return 0, nil, fmt.Errorf("unknown platform: %s", platform)
	}
	body := map[string]any{}
	if ugc, ok2 := ugcPlatformMap[platform]; ok2 {
		body["platform"] = ugc
	}
	for k, v := range opts {
		body[k] = v
	}
	return postRaw(token, url, body)
}

// SearchByUrl calls SearchandRetriveapi.
func SearchByUrl(token, rawURL, platform string, isSrcUrl bool) (int, any, error) {
	base := config.C.MarkscanBase
	return postRaw(token, base+"/SearchandRetriveapi", map[string]any{
		"url": rawURL, "platform": platform, "isSrcUrl": isSrcUrl,
	})
}

// SendToEnforcementQc calls SendtoEnforcementQc.
func SendToEnforcementQc(token string, payload any) (int, any, error) {
	base := config.C.MarkscanBase
	return postRaw(token, base+"/SendtoEnforcementQc", payload)
}

// MarkAsInvalid calls MarkAsInvalid endpoint.
func MarkAsInvalid(token string, payload any) (int, any, error) {
	base := config.C.MarkscanBase
	return postRaw(token, base+"/MarkAsInvalid", payload)
}

// GetDownloadStatus calls GetDownloadStatus.
func GetDownloadStatus(token string) (any, error) {
	base := config.C.MarkscanBase
	req, _ := http.NewRequest("GET", base+"/GetDownloadStatus", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var data any
	json.NewDecoder(resp.Body).Decode(&data)
	return data, nil
}

// TriggerDownload triggers a download request.
func TriggerDownload(token string, payload any) (int, error) {
	base := config.C.MarkscanBase
	endpoint := base + "/TriggerDownload"
	if p, ok := payload.(map[string]any); ok {
		if _, hasPlatform := p["platform"]; !hasPlatform {
			endpoint = base + "/TriggerDownload/AllPlatforms"
		}
	}
	status, _, err := postRaw(token, endpoint, payload)
	return status, err
}

// GetDownloadUrl fetches the actual download URL for a request ID.
func GetDownloadUrl(token, downloadID string) (string, error) {
	base := config.C.MarkscanBase
	req, _ := http.NewRequest("POST", base+"/DownloadDataExtraction/"+downloadID, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	s := string(bytes.Trim(raw, `" `))
	return s, nil
}

// GetAllPlatforms returns the list of platforms from Markscan.
func GetAllPlatforms(token string) ([]any, error) {
	base := config.C.MarkscanBase
	req, _ := http.NewRequest("GET", base+"/GetAllPlatforms", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var data any
	json.NewDecoder(resp.Body).Decode(&data)
	return extractArray(data), nil
}

// GetAllAssets returns the list of assets from Markscan.
func GetAllAssets(token string) ([]any, error) {
	base := config.C.MarkscanBase
	req, _ := http.NewRequest("GET", base+"/GetAllAssets", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var data any
	json.Unmarshal(raw, &data)
	return extractArray(data), nil
}

// GetAllWarRoomAssets returns only the assets flagged for the War Room.
func GetAllWarRoomAssets(token string) ([]any, error) {
	base := config.C.MarkscanBase
	req, _ := http.NewRequest("GET", base+"/GetAllWarRoomAssets", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var data any
	json.NewDecoder(resp.Body).Decode(&data)
	return extractArray(data), nil
}

// PushInfringements submits infringing URLs.
func PushInfringements(token, endpoint string, payload any) (int, any, error) {
	base := config.C.MarkscanBase
	return postRaw(token, base+"/"+endpoint, payload)
}

// InfringementHistory fetches history.
func InfringementHistory(token string) (any, error) {
	base := config.C.MarkscanBase
	req, _ := http.NewRequest("POST", base+"/infringmenthistorydetails", bytes.NewReader([]byte("")))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var data any
	json.NewDecoder(resp.Body).Decode(&data)
	return data, nil
}

// PendingCount calls PlatformDiscoveryqcCount.
func PendingCount(token string, payload any) (any, error) {
	base := config.C.MarkscanBase
	return post(token, base+"/PlatformDiscoveryqcCount", payload)
}

// GetDiscoveryQcURLs calls GetDiscoveryQcURLs endpoint.
func GetDiscoveryQcURLs(token, platform string, startDate, assetName string, isSourceURL bool) ([]any, error) {
	base := config.C.MarkscanBase
	payload := map[string]any{"platform": platform, "isSourceURL": isSourceURL}
	if startDate != "" {
		// strip time component if present
		if len(startDate) > 10 {
			startDate = startDate[:10]
		}
		payload["startDate"] = startDate
	}
	if assetName != "" {
		payload["assetName"] = assetName
	}
	_, data, err := postRaw(token, base+"/GetDiscoveryQcURLs", payload)
	if err != nil {
		return nil, err
	}
	if arr, ok := data.([]any); ok {
		return arr, nil
	}
	return []any{}, nil
}

// QCUrls posts to QcUrls endpoint (kept for compatibility).
func QCUrls(token string, payload any) (int, any, error) {
	base := config.C.MarkscanBase
	return postRaw(token, base+"/QcUrls", payload)
}

// QCEnforce posts to QcEnforce endpoint.
func QCEnforce(token string, payload any) (int, any, error) {
	base := config.C.MarkscanBase
	return postRaw(token, base+"/QcEnforce", payload)
}

// ─────────────────────────────────────────────────────────────────────────────

func post(token, url string, payload any) (any, error) {
	_, data, err := postRaw(token, url, payload)
	return data, err
}

func postRaw(token, url string, payload any) (int, any, error) {
	b, err := json.Marshal(payload)
	if err != nil {
		return 0, nil, err
	}
	req, _ := http.NewRequest("POST", url, bytes.NewReader(b))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var data any
	json.Unmarshal(raw, &data)
	if resp.StatusCode >= 400 && data == nil {
		// response wasn't JSON — surface the raw body as the error
		return resp.StatusCode, string(raw), nil
	}
	return resp.StatusCode, data, nil
}

func extractArray(data any) []any {
	if arr, ok := data.([]any); ok {
		return arr
	}
	if m, ok := data.(map[string]any); ok {
		for _, key := range []string{"data", "items", "result", "results", "list", "records",
			"platforms", "assets", "rows", "Data", "Items", "Result"} {
			if arr, ok := m[key].([]any); ok {
				return arr
			}
		}
		for _, v := range m {
			if arr, ok := v.([]any); ok {
				return arr
			}
		}
	}
	return []any{}
}
