package markscan

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ip-house/iphouse-api/config"
)

var httpClient = &http.Client{
	Timeout: 90 * time.Second,
}

// cleanTransportError converts a low-level HTTP transport failure into an error
// that is safe to surface to end users.
//
// net/http wraps transport failures in a *url.Error whose text embeds the full
// request URL, e.g.:
//
//	Post "https://api.markscan.co.in/Internet/Paged": context deadline exceeded
//	(Client.Timeout exceeded while awaiting headers)
//
// Returning that verbatim leaks the upstream API endpoint — which this project
// must never expose to clients. The failure is logged server-side (with the URL
// stripped) so operators can still diagnose it, and a generic, endpoint-free
// message is handed back to the caller for display.
func cleanTransportError(op string, err error) error {
	if err == nil {
		return nil
	}
	log.Printf("[markscan] %s transport error: %s", op, safeCause(err))

	var netErr net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &netErr) && netErr.Timeout()) {
		return errors.New("The service took too long to respond. Please try again in a moment.")
	}
	return errors.New("The service is temporarily unavailable. Please try again shortly.")
}

// safeCause returns the reason for a transport error with any embedded request
// URL removed, so the upstream endpoint never appears in logs either. A
// *url.Error's inner Err holds the cause (e.g. "context deadline exceeded")
// without the URL that the wrapper's own Error() string would include.
func safeCause(err error) string {
	var ue *url.Error
	if errors.As(err, &ue) && ue.Err != nil {
		return ue.Err.Error()
	}
	return err.Error()
}

// ── In-memory API token cache ─────────────────────────────────────────────────

type tokenEntry struct {
	token   string
	expires time.Time
}

var (
	tokenCache   = map[int64]tokenEntry{}
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

/*
RateLimitedError is Markscan answering 429 — it rate-limits logins PER IP
("Rate limit exceeded (LoginIp). Retry after 144s.").

It is a distinct type because it is the one login failure that must never be
retried: every extra attempt is another request against the same bucket, so
retrying a 429 is what keeps the lockout alive rather than what recovers from
it. RetryAfter carries the service's own answer for how long to stay away.
*/
type RateLimitedError struct {
	RetryAfter time.Duration
	Body       string
}

func (e *RateLimitedError) Error() string {
	return fmt.Sprintf("markscan login rate-limited, retry after %s: %s", e.RetryAfter, e.Body)
}

// retryAfterRe reads the seconds out of the service's own message, which carries
// the figure in prose rather than in a Retry-After header.
var retryAfterRe = regexp.MustCompile(`(?i)retry after (\d+)\s*s`)

// Login authenticates against the Markscan API. The API occasionally rejects a
// valid login transiently (observed intermittent 400s with credentials that
// succeed moments later) — and a missing token locks the whole session to
// Dashboard-only — so failed attempts are retried before giving up.
//
// A 429 is the exception and returns IMMEDIATELY: the limit is counted per IP,
// so a retry cannot succeed and only pushes the window further out. See
// RateLimitedError.
func Login(apiUsername, apiPassword string) (string, error) {
	var lastErr error
	for attempt := 1; attempt <= 3; attempt++ {
		token, err := loginOnce(apiUsername, apiPassword)
		if err == nil {
			return token, nil
		}
		var rl *RateLimitedError
		if errors.As(err, &rl) {
			return "", err
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
		return "", cleanTransportError("login", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		snippet := string(raw)
		if len(snippet) > 200 {
			snippet = snippet[:200]
		}
		if resp.StatusCode == http.StatusTooManyRequests {
			// The window, from the Retry-After header if it is sent and from the
			// message body if it is not — this service states it in prose.
			wait := 120 * time.Second
			if h := strings.TrimSpace(resp.Header.Get("Retry-After")); h != "" {
				if n, err := strconv.Atoi(h); err == nil && n > 0 {
					wait = time.Duration(n) * time.Second
				}
			} else if m := retryAfterRe.FindStringSubmatch(snippet); m != nil {
				if n, err := strconv.Atoi(m[1]); err == nil && n > 0 {
					wait = time.Duration(n) * time.Second
				}
			}
			return "", &RateLimitedError{RetryAfter: wait, Body: snippet}
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
	"tiktok":       "tiktok",
	"chomikuj":     "chomikuj",
	"vk":           "vk",
	"ok":           "ok",
	"sharechat":    "sharechat",
	"dailymotion":  "dailymotion",
	"bilibili":     "bilibili",
	UGCUmbrellaKey: "UGC And Other Social Media",
}

func init() {
	base := config.C.MarkscanBase
	if base == "" {
		base = "https://api.markscan.co.in"
	}
	infringementEndpoints = map[string]string{
		"facebook":               base + "/Facebook/Paged",
		"internet":               base + "/Internet/Paged",
		"youtube":                base + "/YouTube/Paged",
		"instagram":              base + "/Instagram/Paged",
		"twitter":                base + "/Twitter/Paged",
		"telegram":               base + "/Telegram/Paged",
		"tiktok":                 base + "/UGCPlatform/Paged",
		"chomikuj":               base + "/UGCPlatform/Paged",
		"vk":                     base + "/UGCPlatform/Paged",
		"ok":                     base + "/UGCPlatform/Paged",
		"sharechat":              base + "/UGCPlatform/Paged",
		"dailymotion":            base + "/UGCPlatform/Paged",
		"bilibili":               base + "/UGCPlatform/Paged",
		UGCUmbrellaKey:           base + "/UGCPlatform/Paged",
		"meta ads":               base + "/MetaAds/Paged",
		"marketplace":            base + "/Marketplace/Paged",
		"i-tunes":                base + "/GetInfringements/ItunesApiUrls",
		"play store":             base + "/GetInfringements/GooglePlaystoreAPIurls",
		"third party app":        base + "/GetInfringements/ThirdPartyAppAPIurls",
		"third party mobile app": base + "/GetInfringements/ThirdPartyMobileAppAPIurls",
		"torrent":                base + "/GetInfringements/Internet/Test",
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
		return nil, cleanTransportError("GetDownloadStatus", err)
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
		return "", cleanTransportError("GetDownloadUrl", err)
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
		return nil, cleanTransportError("GetAllPlatforms", err)
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
		return nil, cleanTransportError("GetAllAssets", err)
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
		return nil, cleanTransportError("GetAllWarRoomAssets", err)
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
		return nil, cleanTransportError("InfringementHistory", err)
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

// QCEnforce posts to a QcEnforce endpoint that Markscan does not expose — every
// call returns 4xx. Approvals go through SendToEnforcementQc and rejections
// through MarkAsInvalid; handlers.QCEnforce does that routing. Kept only so an
// external caller does not break at build time.
//
// Deprecated: use SendToEnforcementQc or MarkAsInvalid.
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
		return 0, nil, cleanTransportError("request", err)
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
