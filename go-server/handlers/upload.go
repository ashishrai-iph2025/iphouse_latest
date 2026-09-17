package handlers

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"sort"
	"strconv"
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
	var groups []uploadGroup

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
			/* ONE SUBMISSION, SEVERAL PLATFORMS.

			   A reader pastes in a list of URLs and presses the button once.
			   Upstream takes one platform per call, so that one action has to
			   become several calls — but it is still ONE submission, and the page
			   used to express the fan-out by posting here several times. That made
			   every part of the submission that is not the upstream call happen
			   once per platform too: the reader got a confirmation email per
			   platform, and the admin bell rang per platform, for a single press
			   of a single button.

			   So the fan-out moved to this side of the wire. The page posts the
			   whole submission, this loops upstream, and the email and the bell
			   fire once at the end — see uploadPushGroups. */
			Groups []uploadGroup `json:"groups"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		platform = body.Platform
		assetName = body.AssetName
		officialURL = body.OfficialURL
		remarks = body.Remarks
		urls = body.URLs
		groups = body.Groups
	}

	/* The single-platform body is the same thing with one group in it. Kept
	   working rather than migrated: the file upload path above builds a platform
	   and a URL list and has no groups to give, and so does any caller written
	   against this endpoint before it learned to batch. */
	if len(groups) == 0 {
		groups = []uploadGroup{{Platform: platform, URLs: urls}}
	}

	if assetName == "" {
		Fail(w, 422, "Asset name is required")
		return
	}
	for _, g := range groups {
		if strings.TrimSpace(g.Platform) == "" {
			Fail(w, 422, "Platform is required")
			return
		}
	}
	if uploadURLCount(groups) == 0 {
		Fail(w, 422, "At least one URL is required")
		return
	}

	var userEmail string
	if claims != nil {
		userEmail = claims.LoginUsername
	}

	results, sent, pushed := uploadPushGroups(apiToken, claims, groups, assetName, officialURL, remarks, userEmail)

	/* NOTHING GOT THROUGH — reported as a failure rather than as a partial
	   success with an empty list, which is what a caller reading only `success`
	   would otherwise act on. A batch where SOME platforms landed is a success
	   with the failures named in `results`: the URLs that went up are up, and
	   telling the reader the submission failed would invite them to send the
	   whole list again. */
	if len(sent) == 0 {
		detail := "submission failed"
		for _, res := range results {
			if res.Error != "" {
				detail = res.Platform + ": " + res.Error
				break
			}
		}
		/* Fail()'s body plus the per-platform detail. Written out rather than
		   added to Fail, which every other handler here calls with a message and
		   nothing else. */
		JSON(w, 502, map[string]any{"success": false, "error": detail, "results": results})
		return
	}

	/* ONE email and ONE bell for the whole submission, after every platform has
	   been tried — the point of batching. Both name every platform that actually
	   landed, so a reader who pasted a mixed list gets one message describing
	   what happened rather than one per queue it happened to touch.

	   Only the platforms that SUCCEEDED are named. An email listing a platform
	   whose push failed would be a receipt for something that did not happen. */
	go sendUploadEmails(claims, uploadPlatformsLabel(sent), assetName, remarks, uploadAllURLs(sent))

	/*
		THE BELL COUNTS WHAT LANDED, not what was posted.

		These two are not the same number and the gap is what sent somebody
		looking for a bug: the bell said "7 URLs on Facebook" while the
		submission history showed 2, because the bell counted the URLs the
		portal sent and the history shows the rows upstream kept. Both were
		telling the truth about different things, and neither said so.

		Where upstream reported a count for every platform, that is the figure
		used and the difference is spelled out. Where it reported none — an
		older response shape, or a body this could not read — the sent count
		stands, because a notification that silently drops to zero because a
		sentence changed wording would be worse than one that is occasionally
		optimistic.
	*/
	total := uploadURLCount(sent)
	stored, storedKnown := acceptedTotal(results)

	shown := total
	if storedKnown {
		shown = stored
	}
	msg := fmt.Sprintf("%d URL%s on %s%s", shown, plural(shown),
		uploadPlatformsLabel(sent), forAsset(assetName))
	if storedKnown && stored != total {
		msg = fmt.Sprintf("%d of %d URL%s recorded on %s%s", stored, total, plural(total),
			uploadPlatformsLabel(sent), forAsset(assetName))
	}

	meta := map[string]any{
		"platform":  uploadPlatformsLabel(sent),
		"platforms": uploadPlatformKeys(sent),
		"assetName": assetName,
		// urlCount stays what it has always been — the number submitted — so
		// nothing already reading it changes meaning underneath.
		"urlCount": total,
	}
	if storedKnown {
		meta["urlsRecorded"] = stored
	}

	pushNotify(claims, notify.Event{
		Type:    notify.TypeURLUpload,
		Title:   "URLs submitted for takedown",
		Message: msg,
		Meta:    meta,
	})

	OK(w, map[string]any{
		"success": true,
		"message": "URLs submitted successfully",
		"data":    pushed,
		// Per platform, so a partial batch can say which half landed.
		"results": results,
	})
}

/*
uploadGroup is one platform's share of a submission.

The URLs are already routed: the page decides which platform each URL belongs to
— from its host, and from the UGC sub-platform list, see ugcdomains.go — and
sends them grouped. This side does not re-derive that, because the page resolves
the token against the ACCOUNT's own platform master data and this handler has no
better view of it.
*/
type uploadGroup struct {
	Platform string   `json:"platform"`
	URLs     []string `json:"urls"`
}

// uploadResult is what happened to one group, reported per platform so a batch
// that half-landed can say which half.
type uploadResult struct {
	Platform string `json:"platform"`
	// What was SENT.
	Count int  `json:"count"`
	OK    bool `json:"ok"`
	/* What upstream says it actually STORED, which is not always Count — see
	   acceptedCount. A POINTER because zero accepted is a real and important
	   answer, and an int would make it indistinguishable from "the response did
	   not say". */
	Accepted *int   `json:"accepted,omitempty"`
	Error    string `json:"error,omitempty"`
}

/*
acceptedTotal adds up what upstream said it stored.

ALL OR NOTHING: if a single platform in the batch did not report a count, the
total is not known. Adding the ones that did to the sent count of the ones that
did not produces a number that is neither, and it would be reported with the
same confidence as a real one.
*/
func acceptedTotal(results []uploadResult) (int, bool) {
	total, any := 0, false
	for _, r := range results {
		if !r.OK {
			continue
		}
		if r.Accepted == nil {
			return 0, false
		}
		total += *r.Accepted
		any = true
	}
	return total, any
}

func uploadURLCount(groups []uploadGroup) int {
	n := 0
	for _, g := range groups {
		n += len(g.URLs)
	}
	return n
}

func uploadAllURLs(groups []uploadGroup) []string {
	out := make([]string, 0, uploadURLCount(groups))
	for _, g := range groups {
		out = append(out, g.URLs...)
	}
	return out
}

func uploadPlatformKeys(groups []uploadGroup) []string {
	out := make([]string, 0, len(groups))
	for _, g := range groups {
		out = append(out, g.Platform)
	}
	return out
}

/*
uploadPlatformsLabel names the platforms of a submission for a human.

The email templates and the bell each take ONE platform string, and a batch has
several. Joined rather than given a field of its own because that is all either
of them does with it — prints it on a line labelled "Platform" — and a list reads
correctly there: "Open Web, YouTube" is a true answer to "which platform", where
a second email would have been two half-answers.
*/
func uploadPlatformsLabel(groups []uploadGroup) string {
	seen := map[string]bool{}
	names := make([]string, 0, len(groups))
	for _, g := range groups {
		d := platformDisplay(g.Platform)
		if d == "" || seen[d] {
			continue
		}
		seen[d] = true
		names = append(names, d)
	}
	return strings.Join(names, ", ")
}

/*
uploadPushGroups sends each platform's URLs upstream, and reports each outcome.

SEQUENTIAL, not concurrent. A submission is one to three platforms in practice,
so there is nothing to win, and firing them at once would multiply this portal's
load on an API every other page here also depends on.

ONE GROUP'S FAILURE DOES NOT STOP THE REST. They are separate submissions
upstream and the reader pressed one button: refusing to try YouTube because Open
Web was refused would turn one platform's outage into a whole submission lost,
with no way to tell which part needed sending again.

Returns every outcome, and the groups that landed — the caller needs the second
to decide what the one email may claim.
*/
func uploadPushGroups(apiToken string, claims *ipauth.Claims, groups []uploadGroup,
	assetName, officialURL, remarks, userEmail string) ([]uploadResult, []uploadGroup, any) {

	results := make([]uploadResult, 0, len(groups))
	sent := make([]uploadGroup, 0, len(groups))
	var lastData any

	for _, g := range groups {
		if len(g.URLs) == 0 {
			continue
		}
		data, err := uploadPushOne(apiToken, g, assetName, officialURL, remarks, userEmail)
		res := uploadResult{Platform: g.Platform, Count: len(g.URLs), OK: err == nil}
		if err != nil {
			res.Error = err.Error()
			results = append(results, res)
			continue
		}
		if n, known := acceptedCount(data); known {
			res.Accepted = &n
			/* Worth a line in the log even though the request succeeded: a
			   submission that upstream mostly declined is the kind of thing
			   somebody asks about days later, and the response that explained it
			   is otherwise gone. */
			if n != len(g.URLs) {
				log.Printf("[upload] %s: sent %d URL(s), upstream stored %d — %v",
					g.Platform, len(g.URLs), n, data)
			}
		}

		/* Record who submitted which URLs, so the history can be filtered back to
		   this login — MarkScan's own history is company-wide and carries no
		   submitter. Per group, because the ledger is keyed by platform.
		   Best-effort: the submission has already succeeded upstream. */
		recordUploadClaim(claims, g.Platform, assetName, g.URLs)

		lastData = data
		sent = append(sent, g)
		results = append(results, res)
	}
	return results, sent, lastData
}

/*
THE UMBRELLA IS A REAL PUSH TARGET, and every UGC platform goes up as it.

Worth writing down, because the obvious reading of a 400 here is that
"UGC And Other Social Media" is not a platform PushInfringements accepts, and
acting on that reading makes things worse. It accepts it:

	{"platform": "UGC And Other Social Media",
	 "urls": ["https://www.snackvideo.com/@…/video/5259791520791324068"]}
	→ 200 "Successfully added 1 infringements."

The named UGC platforms — vk, ok, chomikuj, dailymotion, bilibili, tiktok,
sharechat — are submitted under the umbrella too, not under their own keys. They
share one store upstream and the umbrella is the value that store is written
through.

WHAT THE 400 ACTUALLY MEANS is that the API checks each URL's DOMAIN against the
platform it was sent with, and answers "Domain is of different platform
kwai.com". So the platform value is not a label to choose; it has to be the one
that domain genuinely belongs to. Rewriting a UGC submission to any other
platform key — even another UGC one — turns a working push into exactly that
error, which is how this was learned.

That is also what makes the domain matching in ugcdomains.go load-bearing rather
than cosmetic: routing each URL by the site list the API itself validates against
is what keeps the platform on the wire and the domain in the URL agreeing.
*/

/*
acceptedCount reads how many infringements upstream says it actually stored.

PushInfringements answers 200 with a sentence — "Successfully added 1
infringements." — and that number is NOT always the number sent. Seven Facebook
URLs can come back as one, and the portal used to discard the whole body on
success, so nothing downstream ever knew: the bell announced "7 URLs on
Facebook" because seven were sent, while the submission history showed what was
kept. Two screens disagreeing, both of them honest, neither of them complete.

This does not guess WHY the rest did not land. Upstream does not say, and the
plausible reasons — already recorded, rejected on validation — are different
enough that inventing one would be worse than reporting the number.

(ok = false) means the response did not carry a count at all, which is a
different state from zero and is why the caller gets a bool rather than a -1.
*/
var acceptedRe = regexp.MustCompile(`(?i)\badded\s+(\d+)\b`)

func acceptedCount(data any) (int, bool) {
	var msg string
	switch v := data.(type) {
	case string:
		msg = v
	case map[string]any:
		for _, k := range []string{"message", "Message", "result", "Result", "data"} {
			if s := strFromAny(v[k]); s != "" {
				msg = s
				break
			}
		}
	}
	m := acceptedRe.FindStringSubmatch(msg)
	if m == nil {
		return 0, false
	}
	n, err := strconv.Atoi(m[1])
	if err != nil {
		return 0, false
	}
	return n, true
}

/*
upstreamDetail turns whatever the API answered into something worth putting in
front of a person.

The body of a 4xx is where the reason lives, and it was being dropped: a reader
whose submission failed was told "API error 400" and had nothing to act on — not
which URL, not which field, not whether retrying would help. postRaw already
hands the decoded body back, so this is only a matter of reading it.

Truncated, because this ends up in a toast. A stack trace in a notification is
not more informative than a sentence, it is less.
*/
func upstreamDetail(data any) string {
	var msg string
	switch v := data.(type) {
	case string:
		msg = v
	case map[string]any:
		// The spellings seen from this API, most specific first.
		for _, k := range []string{"message", "Message", "error", "Error", "title", "detail"} {
			if s := strFromAny(v[k]); s != "" {
				msg = s
				break
			}
		}
		if msg == "" {
			if b, err := json.Marshal(v); err == nil {
				msg = string(b)
			}
		}
	}
	msg = strings.TrimSpace(msg)
	if msg == "" {
		return ""
	}
	if len(msg) > 200 {
		msg = msg[:200] + "…"
	}
	return " — " + msg
}

/*
uploadPayloadFor builds the request for one group.

Its own function so that the thing most easily got wrong here is testable without
an upstream: WHICH PLATFORM GOES ON THE WIRE. The API validates each URL's domain
against that value and answers "Domain is of different platform kwai.com" when
they disagree, so a platform rewritten anywhere between the reader's choice and
this payload turns a working submission into a 400 that names the URL rather than
the rewrite. It is passed through untouched, and uploadbatch_test.go says so.

Open Web and third-party-app submissions go to a different endpoint carrying a
source URL per infringing URL; everything else goes to PushInfringements. The
test is on the platform, so it is made per group rather than once per request: a
batch can and does contain one of each.
*/
func uploadPayloadFor(g uploadGroup, assetName, officialURL, remarks, userEmail string) (string, any, error) {
	platformLc := strings.ToLower(g.Platform)
	isSource := strings.Contains(platformLc, "internet") || strings.Contains(platformLc, "thirdpartyapp")

	if isSource {
		if officialURL == "" {
			return "", nil, fmt.Errorf("official URL is required for Internet/ThirdPartyApp platforms")
		}
		type urlItem struct {
			SourceURLs     string `json:"sourceurls"`
			InfringingURLs string `json:"infringingUrls"`
		}
		urlItems := make([]urlItem, len(g.URLs))
		for i, u := range g.URLs {
			urlItems[i] = urlItem{SourceURLs: officialURL, InfringingURLs: u}
		}
		return "PushInfringementswithSource", map[string]any{
			"assetName": assetName, "platform": g.Platform,
			"emailId": userEmail, "officialURL": officialURL,
			"publisherName": "NA", "authorName": "NA", "urls": urlItems,
		}, nil
	}

	return "PushInfringements", map[string]any{
		"name": "", "emailid": userEmail,
		"platform": g.Platform, "assetName": assetName,
		"urls": g.URLs, "remarks": remarks,
	}, nil
}

/*
uploadPushOne is the single upstream call, unchanged in substance from when this
handler could only make one.

Open Web and third-party-app submissions go to a different endpoint carrying a
source URL per infringing URL; everything else goes to PushInfringements. The
test is on the platform, so it is made per group rather than once for the
request: a batch can and does contain one of each.
*/
func uploadPushOne(apiToken string, g uploadGroup,
	assetName, officialURL, remarks, userEmail string) (any, error) {

	endpoint, payload, err := uploadPayloadFor(g, assetName, officialURL, remarks, userEmail)
	if err != nil {
		return nil, err
	}

	status, data, err := markscan.PushInfringements(apiToken, endpoint, payload)
	if err != nil {
		return nil, err
	}
	if status >= 400 {
		/* The upstream reason, not just the number. This message reaches the
		   reader in a toast and is the only thing they have to act on. */
		return nil, fmt.Errorf("API error %d%s", status, upstreamDetail(data))
	}
	return data, nil
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
