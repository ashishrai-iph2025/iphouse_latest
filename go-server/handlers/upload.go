package handlers

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"

	ipauth "github.com/ip-house/iphouse-api/auth"
	"github.com/ip-house/iphouse-api/db"
	"github.com/ip-house/iphouse-api/email"
	"github.com/ip-house/iphouse-api/markscan"
	"github.com/ip-house/iphouse-api/notify"
)

// GET /api/upload-url — list history
// POST /api/upload-url — submit URLs
func UploadURL(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		uploadURLHistory(w, r)
	case http.MethodPost:
		uploadURLSubmit(w, r)
	default:
		Fail(w, 405, "Method not allowed")
	}
}

func uploadURLHistory(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	apiToken := ResolveAPIToken(claims)
	if apiToken == "" {
		Fail(w, 401, "API token missing")
		return
	}

	raw, err := markscan.InfringementHistory(apiToken)
	if err != nil {
		OK(w, map[string]any{"success": true, "items": []any{}})
		return
	}

	data, ok := raw.([]any)
	if !ok {
		OK(w, map[string]any{"success": true, "items": []any{}})
		return
	}

	// The history is company-wide — one MarkScan token per company — and a single
	// date+platform group mixes the URLs every colleague submitted that day. So
	// the filter runs per URL, not per group: a plain user's group is rebuilt from
	// only the URLs the ledger attributes to them, and a group left with nothing
	// disappears. See requestledger.go.
	seesAll := seesAllCompanyRequests(claims)
	ledger := map[string]uploadOwner{}
	if claims != nil {
		ledger = uploadLedger(claims.UserID, claims.LoginID, seesAll)
	}

	items := []any{}
	hidden := 0
	for _, dateGroup := range data {
		dg, ok := dateGroup.(map[string]any)
		if !ok {
			continue
		}
		date, _ := dg["date"].(string)
		platforms, _ := dg["data"].([]any)
		for _, pg := range platforms {
			platformGroup, ok := pg.(map[string]any)
			if !ok {
				continue
			}
			platform, _ := platformGroup["platform"].(string)
			urlRecords, _ := platformGroup["data"].([]any)

			kept := make([]any, 0, len(urlRecords))
			var urls []string
			var assetName string
			submitters := map[string]bool{}
			for _, rec := range urlRecords {
				rm, ok := rec.(map[string]any)
				if !ok {
					continue
				}
				u, _ := rm["url"].(string)
				owner, attributed := ledger[normURL(u)]

				if !seesAll && !attributed {
					hidden++
					continue
				}
				if attributed {
					if label := owner.label(); label != "" {
						submitters[label] = true
						// Named per row too, so a mixed group stays readable.
						rm["submittedBy"] = label
					}
				}
				kept = append(kept, rec)
				if u != "" {
					urls = append(urls, u)
				}
				if assetName == "" {
					assetName, _ = rm["assetName"].(string)
				}
			}
			if len(kept) == 0 {
				continue
			}

			// urlCount must come from what survived the filter; upstream's own
			// count covers the whole company's rows for that group.
			urlCount := len(kept)
			if seesAll && len(kept) == len(urlRecords) {
				if uc, ok := platformGroup["urlCount"].(float64); ok {
					urlCount = int(uc)
				}
			}

			names := make([]string, 0, len(submitters))
			for n := range submitters {
				names = append(names, n)
			}
			sort.Strings(names)

			items = append(items, map[string]any{
				"id":         date + "_" + platform,
				"date":       date,
				"platform":   platform,
				"assetName":  assetName,
				"urlCount":   urlCount,
				"urls":       urls,
				"records":    kept,
				"submitters": names,
			})
		}
	}
	OK(w, map[string]any{
		"success":     true,
		"items":       items,
		"scope":       requestScope(claims),
		"hiddenCount": hidden,
	})
}

func uploadURLSubmit(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	apiToken := ResolveAPIToken(claims)
	if apiToken == "" {
		Fail(w, 401, "API token missing")
		return
	}

	var platform, assetName, officialURL, remarks string
	var urls []string

	ct := r.Header.Get("Content-Type")
	if strings.Contains(ct, "multipart/form-data") {
		r.ParseMultipartForm(32 << 20)
		platform = r.FormValue("platform")
		assetName = r.FormValue("assetName")
		officialURL = r.FormValue("officialUrl")
		remarks = r.FormValue("remarks")
		file, _, err := r.FormFile("urlFile")
		if err == nil {
			defer file.Close()
			text, _ := io.ReadAll(file)
			for _, u := range strings.FieldsFunc(string(text), func(c rune) bool {
				return c == '\r' || c == '\n' || c == ',' || c == ';'
			}) {
				u = strings.TrimSpace(u)
				if strings.HasPrefix(u, "http") {
					urls = append(urls, u)
				}
			}
		}
	} else {
		var body struct {
			Platform    string   `json:"platform"`
			AssetName   string   `json:"assetName"`
			OfficialURL string   `json:"officialUrl"`
			Remarks     string   `json:"remarks"`
			URLs        []string `json:"urls"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		platform = body.Platform
		assetName = body.AssetName
		officialURL = body.OfficialURL
		remarks = body.Remarks
		urls = body.URLs
	}

	if platform == "" {
		Fail(w, 422, "Platform is required")
		return
	}
	if assetName == "" {
		Fail(w, 422, "Asset name is required")
		return
	}
	if len(urls) == 0 {
		Fail(w, 422, "At least one URL is required")
		return
	}

	var userEmail string
	if claims != nil {
		userEmail = claims.LoginUsername
	}

	platformLc := strings.ToLower(platform)
	isSource := strings.Contains(platformLc, "internet") || strings.Contains(platformLc, "thirdpartyapp")

	var endpoint string
	var payload any

	if isSource {
		if officialURL == "" {
			Fail(w, 422, "Official URL is required for Internet/ThirdPartyApp platforms")
			return
		}
		type urlItem struct {
			SourceURLs     string `json:"sourceurls"`
			InfringingURLs string `json:"infringingUrls"`
		}
		urlItems := make([]urlItem, len(urls))
		for i, u := range urls {
			urlItems[i] = urlItem{SourceURLs: officialURL, InfringingURLs: u}
		}
		endpoint = "PushInfringementswithSource"
		payload = map[string]any{
			"assetName": assetName, "platform": platform,
			"emailId": userEmail, "officialURL": officialURL,
			"publisherName": "NA", "authorName": "NA", "urls": urlItems,
		}
	} else {
		endpoint = "PushInfringements"
		payload = map[string]any{
			"name": "", "emailid": userEmail,
			"platform": platform, "assetName": assetName,
			"urls": urls, "remarks": remarks,
		}
	}

	status, data, err := markscan.PushInfringements(apiToken, endpoint, payload)
	if err != nil {
		Fail(w, 500, err.Error())
		return
	}
	if status >= 400 {
		Fail(w, 502, fmt.Sprintf("API error %d", status))
		return
	}

	// Record who submitted which URLs, so the history can be filtered back to
	// this login — MarkScan's own history is company-wide and carries no
	// submitter. Best-effort: the submission has already succeeded upstream.
	recordUploadClaim(claims, platform, assetName, urls)

	// On success, send confirmation emails:
	//   1. to the API-credential client email (dcp_user.email of the selected account)
	//   2. to the logged-in dashboard user (login_username)
	go sendUploadEmails(claims, platform, assetName, remarks, urls)

	// Raise it to the admin bell.
	pushNotify(claims, notify.Event{
		Type:    notify.TypeURLUpload,
		Title:   "URLs submitted for takedown",
		Message: fmt.Sprintf("%d URL%s on %s%s", len(urls), plural(len(urls)), platformDisplay(platform), forAsset(assetName)),
		Meta:    map[string]any{"platform": platform, "assetName": assetName, "urlCount": len(urls)},
	})

	OK(w, map[string]any{"success": true, "message": "URLs submitted successfully", "data": data})
}

// sendUploadEmails fires the client + user confirmation emails after a successful
// takedown submission. Runs in a goroutine so email latency never blocks the response.
func sendUploadEmails(claims *ipauth.Claims, platform, assetName, remarks string, urls []string) {
	if claims == nil {
		return
	}

	// Client email + name from the selected account (dcp_user).
	var clientEmail, clientName string
	if row, err := db.QueryOne("SELECT email, name FROM dcp_user WHERE userId = ? LIMIT 1", claims.UserID); err == nil && row != nil {
		clientEmail = strFromAny(row["email"])
		clientName = strFromAny(row["name"])
	}
	if clientName == "" {
		clientName = strings.TrimSpace(claims.LoginFirstName + " " + claims.LoginLastName)
	}

	// Logged-in dashboard user.
	userEmail := claims.LoginUsername
	userName := strings.TrimSpace(claims.LoginFirstName + " " + claims.LoginLastName)
	if userName == "" {
		userName = "User"
	}

	if clientEmail != "" {
		_ = email.SendInfringementClientConfirmation(clientEmail, clientName, platformDisplay(platform), assetName, remarks, urls)
	}
	// Avoid sending a duplicate to the same mailbox.
	if userEmail != "" && !strings.EqualFold(userEmail, clientEmail) {
		_ = email.SendInfringementUserNotification(userEmail, userName, platformDisplay(platform), assetName, urls)
	}
}
