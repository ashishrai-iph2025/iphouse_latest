package markscan

import (
	"context"
	"fmt"
	"log"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ─────────────────────────────────────────────────────────────────────────────
// War Room: fan-out fetch across every platform + aggregation of the flat
// MarkScan rows into the dashboard model. The paged endpoints, ugcPlatformMap
// and postRaw all live in client.go and are reused here.
// ─────────────────────────────────────────────────────────────────────────────

// warRoomPlatforms are the endpoints the War Room draws from, in display order.
var warRoomPlatforms = []string{
	"facebook", "youtube", "instagram", "twitter", "telegram",
	"internet",
	"ugc and other social media",
	"i-tunes", "play store", "third party app", "third party mobile app",
}

// PlatformLabels maps the internal key to a friendly label for the UI strip.
var PlatformLabels = map[string]string{
	"facebook":                   "Facebook",
	"youtube":                    "YouTube",
	"instagram":                  "Instagram",
	"twitter":                    "X (Twitter)",
	"telegram":                   "Telegram",
	"internet":                   "Open Web",
	"ugc and other social media": "UGC & Other",
	"i-tunes":                    "iTunes",
	"play store":                 "Play Store",
	"third party app":            "Third-Party App",
	"third party mobile app":     "Third-Party Mobile",
}

// PlatformsForWarRoom returns the ordered platform keys.
func PlatformsForWarRoom() []string { return warRoomPlatforms }

// UGCSubPlatform is one concrete platform value behind the "ugc and other
// social media" umbrella. Key is the endpoint/request key (also present in
// ugcPlatformMap and infringementEndpoints); Label is the display name tagged
// onto rows fetched via that value.
type UGCSubPlatform struct{ Key, Label string }

// UGCSubPlatforms returns the named UGC platforms that must each be requested
// with their own "platform" value — MarkScan's /UGCPlatform/Paged returns only
// the platform named in the request body, so the umbrella value alone yields
// just the residual "other" bucket. The umbrella itself is fetched separately
// and its rows get their platform derived from the videoURL domain instead.
func UGCSubPlatforms() []UGCSubPlatform {
	return []UGCSubPlatform{
		{"tiktok", "TikTok"},
		{"chomikuj", "Chomikuj"},
		{"sharechat", "ShareChat"},
		{"vk", "VK"},
		{"ok", "OK"},
		{"bilibili", "Bilibili"},
		{"dailymotion", "Dailymotion"},
	}
}

// maxPages caps pagination so a runaway asset can't loop forever. Raised well
// past any real platform's page count (Facebook alone has been seen at 225
// pages @ 1000 rows/page) — the old cap of 200 was silently truncating data.
const maxPages = 2000

// FetchAllPages pulls every page of a platform's /Paged endpoint and returns the
// concatenated flat rows. body is the base request (startDate/updatedSince/
// assetName/etc.); pageNo is overwritten per page. sem bounds how many page
// requests (across every platform in the current fan-out) may be in flight at
// once — pages within THIS platform are fetched concurrently too, not just
// platforms against each other, since a single huge platform (hundreds of
// pages) fetched one page at a time was the real bottleneck. ctx is the
// original HTTP request's context — if the client disconnects (page reload,
// a second Generate click, tab close), every in-flight and still-queued page
// fetch stops immediately instead of continuing in the background, which
// previously kept hammering MarkScan for a response nobody was waiting for
// and could pile up alongside a fresh request into real rate-limit/500s.
func FetchAllPages(ctx context.Context, token, platform string, body map[string]any, sem chan struct{}) ([]map[string]any, error) {
	url, ok := infringementEndpoints[platform]
	if !ok {
		return nil, fmt.Errorf("unknown platform: %s", platform)
	}

	base := map[string]any{}
	if ugc, ok2 := ugcPlatformMap[platform]; ok2 {
		base["platform"] = ugc
	}
	for k, v := range body {
		base[k] = v
	}

	fetchPage := func(page int) (int, any, error) {
		select {
		case <-ctx.Done():
			return 0, nil, ctx.Err()
		case sem <- struct{}{}:
		}
		defer func() { <-sem }()
		b := make(map[string]any, len(base)+1)
		for k, v := range base {
			b[k] = v
		}
		b["pageNo"] = page
		return postPageWithRetry(token, url, b, platform, page)
	}

	// Page 1 tells us totalPages; fetch it alone first.
	status, raw, err := fetchPage(1)
	if err != nil {
		return nil, err
	}
	if status == 401 || status == 403 {
		return nil, fmt.Errorf("unauthorized")
	}
	if status >= 400 {
		return nil, fmt.Errorf("markscan %s returned %d", platform, status)
	}
	rows, totalPages := extractPaged(raw)
	out := append([]map[string]any{}, rows...)
	if totalPages > maxPages {
		totalPages = maxPages
	}
	if totalPages <= 1 || len(rows) == 0 {
		return out, nil
	}

	// Remaining pages fetched concurrently, bounded by the shared sem.
	var mu sync.Mutex
	var wg sync.WaitGroup
	var firstErr error
	for page := 2; page <= totalPages; page++ {
		if ctx.Err() != nil {
			break
		}
		page := page
		wg.Add(1)
		go func() {
			defer wg.Done()
			status, raw, err := fetchPage(page)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				if firstErr == nil {
					firstErr = err
				}
				return
			}
			if status >= 400 {
				if firstErr == nil {
					firstErr = fmt.Errorf("markscan %s page %d returned %d", platform, page, status)
				}
				return
			}
			rows, _ := extractPaged(raw)
			out = append(out, rows...)
		}()
	}
	wg.Wait()
	return out, firstErr
}

// pageRetries bounds retries for a single page fetch. Large-volume endpoints
// (Open Web, Instagram, ...) are the most exposed to a transient connection
// blip mid-pagination — without a retry, one dropped page previously aborted
// the whole platform and lost every row already fetched for it.
const pageRetries = 3

func postPageWithRetry(token, url string, body map[string]any, platform string, page int) (int, any, error) {
	var lastErr error
	for attempt := 1; attempt <= pageRetries; attempt++ {
		status, raw, err := postRaw(token, url, body)
		if err == nil {
			return status, raw, nil
		}
		lastErr = err
		logf("platform %s page %d attempt %d/%d network error: %v", platform, page, attempt, pageRetries, err)
		if attempt < pageRetries {
			time.Sleep(time.Duration(attempt) * 500 * time.Millisecond)
		}
	}
	return 0, nil, lastErr
}

// extractPaged pulls the data array + totalPages from a /Paged response, which is
// either { data:[...], totalPages:N } or a bare array.
func extractPaged(raw any) ([]map[string]any, int) {
	switch v := raw.(type) {
	case []any:
		return toRowSlice(v), 1
	case map[string]any:
		var arr []any
		for _, k := range []string{"data", "Data", "items", "rows", "result", "Result"} {
			if a, ok := v[k].([]any); ok {
				arr = a
				break
			}
		}
		total := 1
		for _, k := range []string{"totalPages", "TotalPages", "totalPage"} {
			if t, ok := toInt(v[k]); ok {
				total = t
				break
			}
		}
		return toRowSlice(arr), total
	}
	return nil, 1
}

func toRowSlice(arr []any) []map[string]any {
	out := make([]map[string]any, 0, len(arr))
	for _, it := range arr {
		if m, ok := it.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

// ─── Aggregation model ────────────────────────────────────────────────────────

type Totals struct {
	Identified int   `json:"identified"`
	Removed    int   `json:"removed"`
	Enforced   int   `json:"enforced"`
	Views      int64 `json:"views"`
	Engagement int64 `json:"engagement"`
}

type Funnel struct {
	Discovered int `json:"discovered"`
	Enforced   int `json:"enforced"`
	Removed    int `json:"removed"`
	Pending    int `json:"pending"`
}

type Removal struct {
	URLRemoved          int   `json:"urlRemoved"`
	URLPending          int   `json:"urlPending"`
	ChannelsTotal       int   `json:"channelsTotal"`
	ChannelsRemoved     int   `json:"channelsRemoved"`
	ChannelsActive      int   `json:"channelsActive"`
	SubscribersImpacted int64 `json:"subscribersImpacted"`
}

type Segment struct {
	Key        string `json:"key"`
	Label      string `json:"label"`
	Identified int    `json:"identified"`
	Removed    int    `json:"removed"`
}

type MetricPoint struct {
	Date       string `json:"date"`
	Identified int    `json:"identified"`
	Removed    int    `json:"removed"`
}

type Breakdowns struct {
	ByDate     []MetricPoint `json:"byDate"`
	ByReason   []Segment     `json:"byReason"`
	ByQuality  []Segment     `json:"byQuality"`
	ByLanguage []Segment     `json:"byLanguage"`
	ByCountry  []Segment     `json:"byCountry"`
	ByStatus   []Segment     `json:"byStatus"`
}

type PlatformResult struct {
	Platform   string     `json:"platform"`
	Label      string     `json:"label"`
	Available  bool       `json:"available"`
	Totals     Totals     `json:"totals"`
	Funnel     Funnel     `json:"funnel"`
	Removal    Removal    `json:"removal"`
	Breakdowns Breakdowns `json:"breakdowns"`
}

type WarRoomReport struct {
	Summary    Totals           `json:"summary"`
	Funnel     Funnel           `json:"funnel"`
	Removal    Removal          `json:"removal"`
	Breakdowns Breakdowns       `json:"breakdowns"`
	Platforms  []PlatformResult `json:"platforms"`
}

// NormalizeRow aligns platform-specific field names to the common schema the
// aggregation and the client expect. Open Web (/Internet/Paged) rows use
// language1 / removalstatus / delistingremovalstatus instead of the social
// platforms' language / removalStatus, and distinguish source URLs (the pirate
// player/host page) from infringing URLs (the page that embeds or links it).
// A row with no sourceURL is an infringing-URL row.
func NormalizeRow(platform string, r map[string]any) {
	// UGC umbrella rows don't say which platform they belong to — derive it
	// from the videoURL's domain instead (tiktok.com → TikTok, vk.com → VK, …)
	// and keep it as subPlatform for the per-platform UGC breakdown chart.
	// Running here (not just at ingestion) retroactively tags rows cached
	// before subPlatform existed, since stored rows keep their videoURL.
	if platform == "ugc and other social media" && !notEmpty(r["subPlatform"]) {
		r["subPlatform"] = ugcSubPlatformOf(r)
	}

	// Canonical channel/profile fields: every platform with the concept exposes
	// it under a different name (fb/insta/twitter profileUrl, telegram
	// channelUrl, UGC channelOrProfileUrl — with casing drift on all of them).
	// Fold them into channelOrProfileUrl / profileRemovalStatus once, so the
	// trimmed client rows can rebuild the Channels/Profiles card under any
	// cross-filter the same way the server-side aggregation does.
	if !notEmpty(r["channelOrProfileUrl"]) {
		if v := firstNonEmpty(r,
			"ChannelOrProfileUrl", "channelOrProfileURL", "channelorprofileurl",
			"profileUrl", "ProfileUrl", "profileURL", "profileurl",
			"channelUrl", "ChannelUrl", "channelURL", "channelurl"); v != "" {
			r["channelOrProfileUrl"] = v
		}
	}
	if !notEmpty(r["profileRemovalStatus"]) {
		if v := firstNonEmpty(r,
			"ProfileRemovalStatus", "profileremovalstatus",
			"profile_removal_status", "Profile_Removal_Status"); v != "" {
			r["profileRemovalStatus"] = v
		}
	}

	// Numeric engagement fields drift by platform too: UGC rows carry views /
	// like_count / comment_count / subscribers instead of the common viewCount /
	// likeCount / commentCount / subscriberCount every other platform uses —
	// fold them in so the Views/Engagement KPIs and Subscribers-impacted count.
	// firstNonEmptyVal (not firstNonEmpty) because these arrive as JSON numbers.
	if !notEmpty(r["viewCount"]) {
		if v := firstNonEmptyVal(r, "views", "Views", "view_count", "viewcount"); v != nil {
			r["viewCount"] = v
		}
	}
	if !notEmpty(r["likeCount"]) {
		if v := firstNonEmptyVal(r, "like_count", "likes", "Likes", "likecount"); v != nil {
			r["likeCount"] = v
		}
	}
	if !notEmpty(r["commentCount"]) {
		if v := firstNonEmptyVal(r, "comment_count", "comments", "Comments", "commentcount"); v != nil {
			r["commentCount"] = v
		}
	}
	if !notEmpty(r["subscriberCount"]) {
		if v := firstNonEmptyVal(r, "subscribers", "Subscribers", "subscrbers", "followersCount", "followers", "members"); v != nil {
			r["subscriberCount"] = v
		}
	}
	// Facebook/Instagram/Twitter carry the language breakdown value under
	// audioLanguage rather than the generic "language" field every other
	// platform uses — copy it over once here so aggregation (server-side) and
	// cross-filter re-aggregation (client-side, from the same trimmed field)
	// both just work off "language" without needing platform-specific logic.
	switch platform {
	case "facebook", "instagram", "twitter":
		if !notEmpty(r["language"]) {
			if v := firstNonEmpty(r, "audioLanguage", "AudioLanguage", "audiolanguage"); v != "" {
				r["language"] = v
			}
		}
	case "telegram":
		// Telegram rows carry language under "language1" and quality of print
		// under "quality" — align both to the common schema.
		if !notEmpty(r["language"]) {
			if v := firstNonEmpty(r, "language1", "Language1"); v != "" {
				r["language"] = v
			}
		}
		if !notEmpty(r["qualityOfPrint"]) {
			if v := firstNonEmpty(r, "quality", "Quality"); v != "" {
				r["qualityOfPrint"] = v
			}
		}
	}

	if platform != "internet" {
		return
	}
	if !notEmpty(r["language"]) && notEmpty(r["language1"]) {
		r["language"] = r["language1"]
	}
	if !notEmpty(r["removalStatus"]) && notEmpty(r["removalstatus"]) {
		r["removalStatus"] = r["removalstatus"]
	}
	if !notEmpty(r["delistingStatus"]) && notEmpty(r["delistingremovalstatus"]) {
		r["delistingStatus"] = r["delistingremovalstatus"]
	}
	r["isSource"] = notEmpty(r["sourceURL"])
}

// ugcDomainPlatforms maps a videoURL host suffix to its display platform name.
// Matched against the host itself or any subdomain of it (m.tiktok.com,
// vm.tiktok.com, …). Hosts matching nothing keep their bare domain as the
// label so a new platform shows up by name instead of vanishing into "Other".
var ugcDomainPlatforms = map[string]string{
	"tiktok.com":       "TikTok",
	"vk.com":           "VK",
	"vkvideo.ru":       "VK",
	"ok.ru":            "OK",
	"odnoklassniki.ru": "OK",
	"sharechat.com":    "ShareChat",
	"dailymotion.com":  "Dailymotion",
	"dai.ly":           "Dailymotion",
	"bilibili.com":     "Bilibili",
	"bilibili.tv":      "Bilibili",
	"b23.tv":           "Bilibili",
	"chomikuj.pl":      "Chomikuj",
}

// ugcSubPlatformOf resolves the concrete platform behind a UGC umbrella row
// from its videoURL's domain — the response carries no platform field of its
// own. Falls back to other URL fields, then to the residual bucket label.
func ugcSubPlatformOf(r map[string]any) string {
	raw := firstNonEmpty(r,
		"videoURL", "VideoURL", "videoUrl", "videourl",
		"infringingURL", "infringingUrl", "url", "URL", "postURL", "postUrl")
	host := hostOf(raw)
	if host == "" {
		return "UGC And Other Social Media"
	}
	for suffix, name := range ugcDomainPlatforms {
		if host == suffix || strings.HasSuffix(host, "."+suffix) {
			return name
		}
	}
	return strings.TrimPrefix(host, "m.")
}

// hostOf extracts the lowercased host (no www., no port) from a URL string,
// tolerating scheme-less values.
func hostOf(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	if !strings.Contains(s, "://") {
		s = "https://" + s
	}
	u, err := url.Parse(s)
	if err != nil || u.Hostname() == "" {
		return ""
	}
	return strings.TrimPrefix(strings.ToLower(u.Hostname()), "www.")
}

// trimFields are the only row fields the frontend needs to recompute the model
// client-side for cross-filtering. Keeping the payload small keeps it fast.
var trimFields = []string{
	// id lets the UI show WHICH MarkScan rows sit behind a blank/"Unknown"
	// breakdown value, so data-quality gaps can be traced back at the source.
	"id",
	// subPlatform: the concrete UGC platform (tiktok/vk/…) behind an
	// "ugc and other social media" row — drives the UGC breakdown chart.
	"platform", "subPlatform", "assetName", "infringementType", "qualityOfPrint", "language", "country",
	"removalStatus", "removalTime", "enforcementTime",
	// Date fields for ReportDay's fallback chain — see ReportDay's comment for
	// why more than the two preferred fields are needed.
	"urlUploadDate", "discoveryDoneAt", "uploadDate", "createdAt",
	"viewCount", "likeCount", "commentCount", "channelId", "isChannelSuspended",
	"subscriberCount",
	// Canonical channel/profile identity (see NormalizeRow) — lets the client
	// compute distinct channels + profileRemovalStatus=Dead removals per filter.
	"channelOrProfileUrl", "profileRemovalStatus",
	// Open Web (internet) extras
	"isSource", "sourceURL", "sourceDomain", "infringingURL", "infringingDomain", "searchEngine",
	"delistingTime", "delistingStatus",
}

// TrimRows returns each row reduced to the fields needed for client-side
// cross-filtering, so the browser can re-aggregate any filter combination
// instantly without a round-trip.
func TrimRows(rows []map[string]any) []map[string]any {
	out := make([]map[string]any, 0, len(rows))
	for _, r := range rows {
		t := make(map[string]any, len(trimFields))
		for _, f := range trimFields {
			if v, ok := r[f]; ok {
				t[f] = v
			}
		}
		out = append(out, t)
	}
	return out
}

var reportDateLayouts = []string{
	"2006-01-02",
	"2006-01-02T15:04:05",
	"2006-01-02 15:04:05",
	"2006-01-02T15:04:05.000Z",
	"2006-01-02 15:04:05.000Z",
	time.RFC3339,
}

func parseReportDay(value string) (time.Time, bool) {
	if len(value) >= 10 {
		candidate := value[:10]
		if d, err := time.Parse("2006-01-02", candidate); err == nil {
			return d, true
		}
	}
	for _, layout := range reportDateLayouts {
		if t, err := time.Parse(layout, value); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

// FilterRowsByDate retains rows whose report day falls inside the requested
// start/end date window. The report day is derived from urlUploadDate or
// discoveryDoneAt, and the filter compares actual dates rather than raw strings.
func FilterRowsByDate(rows []map[string]any, startDate, endDate string) []map[string]any {
	if startDate == "" && endDate == "" {
		return rows
	}
	start, hasStart := parseReportDay(startDate)
	end, hasEnd := parseReportDay(endDate)
	out := make([]map[string]any, 0, len(rows))
	for _, r := range rows {
		day := ReportDay(r)
		if day == "" {
			continue
		}
		d, ok := parseReportDay(day)
		if !ok {
			continue
		}
		if hasStart && d.Before(start) {
			continue
		}
		if hasEnd && d.After(end) {
			continue
		}
		out = append(out, r)
	}
	return out
}

// Aggregate maps the accumulated flat rows into the full War Room model, plus a
// per-platform block that drives the selectable platform strip.
func Aggregate(rows []map[string]any) WarRoomReport {
	report := WarRoomReport{}
	report.Summary, report.Funnel, report.Removal, report.Breakdowns = aggregateSet(rows)

	// Per-platform, preserving the canonical order.
	byPlat := map[string][]map[string]any{}
	for _, r := range rows {
		p := strFrom(r["platform"])
		byPlat[p] = append(byPlat[p], r)
	}
	for _, key := range warRoomPlatforms {
		set := byPlat[key]
		t, f, rem, b := aggregateSet(set)
		report.Platforms = append(report.Platforms, PlatformResult{
			Platform:   key,
			Label:      PlatformLabels[key],
			Available:  t.Identified > 0,
			Totals:     t,
			Funnel:     f,
			Removal:    rem,
			Breakdowns: b,
		})
	}
	return report
}

func aggregateSet(rows []map[string]any) (Totals, Funnel, Removal, Breakdowns) {
	var t Totals
	reason := newSegAgg()
	quality := newSegAgg()
	language := newSegAgg()
	country := newSegAgg()
	status := newSegAgg()
	dateAgg := map[string]*MetricPoint{}

	// Channel/profile tracking, distinct by the platform-appropriate identity
	// field (see channelIdentity). subs is the max subscriber count seen for
	// that profile across its rows, since the same channel/profile can appear
	// on many infringing-URL rows and shouldn't be double-counted.
	type chState struct {
		suspended bool
		subs      int64
	}
	channels := map[string]*chState{}

	// Open Web identification is distinct sourceURL + distinct infringingURL,
	// not raw row count — the same URL can appear on many rows.
	owRows := 0
	owSrcURLs := map[string]struct{}{}
	owInfURLs := map[string]struct{}{}

	for _, r := range rows {
		removed := isRemoved(r)
		enforced := notEmpty(r["enforcementTime"])

		t.Identified++
		if removed {
			t.Removed++
		}
		if enforced {
			t.Enforced++
		}
		t.Views += toNum(r["viewCount"])
		t.Engagement += toNum(r["likeCount"]) + toNum(r["commentCount"])

		addSeg(reason, strFrom(r["infringementType"]), removed)
		addSeg(quality, strFrom(r["qualityOfPrint"]), removed)
		addSeg(language, strFrom(r["language"]), removed)
		addSeg(country, strFrom(r["country"]), removed)
		addSeg(status, statusLabel(r), removed)

		// date bucket (urlUploadDate, else discoveryDoneAt) → YYYY-MM-DD
		if day := dayOf(r); day != "" {
			mp := dateAgg[day]
			if mp == nil {
				mp = &MetricPoint{Date: day}
				dateAgg[day] = mp
			}
			mp.Identified++
			if removed {
				mp.Removed++
			}
		}

		if id, chRemoved, ok := channelIdentity(strFrom(r["platform"]), r); ok {
			cs := channels[id]
			if cs == nil {
				cs = &chState{}
				channels[id] = cs
			}
			if chRemoved {
				cs.suspended = true
			}
			if s := toNum(r["subscriberCount"]); s > cs.subs {
				cs.subs = s // max seen for this channel/profile, avoids per-URL double count
			}
		}

		if strFrom(r["platform"]) == "internet" {
			owRows++
			if u := strings.ToLower(strings.TrimSpace(strFrom(r["sourceURL"]))); u != "" {
				owSrcURLs[u] = struct{}{}
			}
			if u := strings.ToLower(strings.TrimSpace(strFrom(r["infringingURL"]))); u != "" {
				owInfURLs[u] = struct{}{}
			}
		}
	}

	// Replace the Open Web raw row count with its distinct-URL identification.
	if owRows > 0 {
		t.Identified += len(owSrcURLs) + len(owInfURLs) - owRows
	}

	funnel := Funnel{
		Discovered: t.Identified,
		Enforced:   t.Enforced,
		Removed:    t.Removed,
		Pending:    t.Identified - t.Removed,
	}
	if funnel.Pending < 0 {
		funnel.Pending = 0
	}

	var removal Removal
	removal.URLRemoved = t.Removed
	removal.URLPending = t.Identified - t.Removed
	if removal.URLPending < 0 {
		removal.URLPending = 0
	}
	for _, cs := range channels {
		removal.ChannelsTotal++
		if cs.suspended {
			removal.ChannelsRemoved++
			removal.SubscribersImpacted += cs.subs
		} else {
			removal.ChannelsActive++
		}
	}

	breakdowns := Breakdowns{
		ByDate:     orderedDates(dateAgg),
		ByReason:   reason.sorted(),
		ByQuality:  quality.sorted(),
		ByLanguage: language.sorted(),
		ByCountry:  country.sorted(),
		ByStatus:   status.sorted(),
	}
	return t, funnel, removal, breakdowns
}

// ─── segment aggregation ──────────────────────────────────────────────────────

type segAgg struct {
	order []string
	byKey map[string]*Segment
}

func newSegAgg() *segAgg { return &segAgg{byKey: map[string]*Segment{}} }

func addSeg(a *segAgg, label string, removed bool) {
	if strings.TrimSpace(label) == "" {
		label = "Unknown"
	}
	// Use lowercase as the map key so "Dead" and "DEAD" are the same bucket.
	normKey := strings.ToLower(label)
	s := a.byKey[normKey]
	if s == nil {
		s = &Segment{Key: label, Label: label}
		a.byKey[normKey] = s
		a.order = append(a.order, normKey)
	}
	s.Identified++
	if removed {
		s.Removed++
	}
}

// sorted returns segments by identified desc (largest bars first).
func (a *segAgg) sorted() []Segment {
	out := make([]Segment, 0, len(a.order))
	for _, k := range a.order {
		out = append(out, *a.byKey[k])
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Identified > out[j].Identified })
	return out
}

func orderedDates(m map[string]*MetricPoint) []MetricPoint {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]MetricPoint, 0, len(keys))
	for _, k := range keys {
		out = append(out, *m[k])
	}
	return out
}

// ─── row field helpers ────────────────────────────────────────────────────────

// isRemoved: a URL counts as removed when it's marked Dead or has a removalTime.
// Open Web infringing URLs are also removed once delisting is Approved.
func isRemoved(r map[string]any) bool {
	if notEmpty(r["removalTime"]) {
		return true
	}
	st := strings.ToLower(strFrom(r["removalStatus"]))
	if st == "dead" || st == "removed" {
		return true
	}
	return strings.EqualFold(strings.TrimSpace(strFrom(r["delistingStatus"])), "approved")
}

// statusLabel normalises removalStatus for the status breakdown.
// Always returns title-case so "DEAD" and "Dead" are treated as the same value.
func statusLabel(r map[string]any) string {
	s := strings.TrimSpace(strFrom(r["removalStatus"]))
	if s == "" {
		return "Pending"
	}
	runes := []rune(s)
	return strings.ToUpper(string(runes[0])) + strings.ToLower(string(runes[1:]))
}

// channelIdentity resolves the platform-specific channel/profile identity and
// its removal status. Different MarkScan endpoints expose the "channel/profile
// behind this URL" concept under different field names entirely:
//
//	youtube                     channelId + isChannelSuspended (bool)
//	facebook/instagram/twitter  profileUrl + profileRemovalStatus ("Active"/"Dead")
//	telegram                    channelUrl + profileRemovalStatus
//	ugc and other social media  channelOrProfileUrl + profileRemovalStatus
//
// Every other platform (Open Web, iTunes, Play Store, third-party app/mobile)
// has no channel/profile concept and is skipped (ok=false). id is lowercased so
// the same profile isn't double-counted over casing differences across rows.
func channelIdentity(platform string, r map[string]any) (id string, removed bool, ok bool) {
	canonicalID := firstNonEmpty(r,
		"channelOrProfileUrl", "ChannelOrProfileUrl", "channelOrProfileURL", "channelorprofileurl",
		"profileUrl", "ProfileUrl", "profileURL", "Profileurl", "profileurl",
		"channelUrl", "ChannelUrl", "channelURL", "Channelurl", "channelurl")

	switch platform {
	case "youtube":
		cid := strFrom(r["channelId"])
		if canonicalID != "" {
			return strings.ToLower(strings.TrimSpace(canonicalID)),
				profileDead(r) || boolFrom(r["isChannelSuspended"]), true
		}
		if cid == "" {
			return "", false, false
		}
		// Every paged endpoint now carries profileRemovalStatus (Active/Dead);
		// isChannelSuspended is kept as a fallback for older cached rows.
		return strings.ToLower(strings.TrimSpace(cid)),
			profileDead(r) || boolFrom(r["isChannelSuspended"]), true
	case "facebook", "instagram", "twitter":
		id = canonicalID
	case "telegram":
		id = canonicalID
	case "ugc and other social media":
		id = canonicalID
	default:
		return "", false, false
	}
	if id == "" {
		return "", false, false
	}
	return strings.ToLower(strings.TrimSpace(id)), profileDead(r), true
}

// profileDead reports whether the row's channel/profile is marked Dead.
// profileRemovalStatus is Active/Dead on every paged endpoint's rows.
func profileDead(r map[string]any) bool {
	s := strings.ToLower(strings.TrimSpace(firstNonEmpty(r,
		"profileRemovalStatus", "ProfileRemovalStatus", "profileremovalstatus",
		"profile_removal_status", "Profile_Removal_Status")))
	return s == "dead"
}

// firstNonEmpty tries each key in order and returns the first non-empty string
// value — a defensive lookup for fields whose exact casing varies by endpoint.
func firstNonEmpty(r map[string]any, keys ...string) string {
	for _, k := range keys {
		if s := strFrom(r[k]); s != "" {
			return s
		}
	}
	return ""
}

// firstNonEmptyVal is firstNonEmpty for values of any type — needed for
// numeric fields (JSON numbers arrive as float64, which strFrom rejects).
func firstNonEmptyVal(r map[string]any, keys ...string) any {
	for _, k := range keys {
		if notEmpty(r[k]) {
			return r[k]
		}
	}
	return nil
}

// ReportDay is the canonical "reporting date" for a row: when the infringing URL
// was discovered/added (urlUploadDate, falling back to discoveryDoneAt), NOT the
// content's original upload date. This is the timeline a startDate filter and the
// trend chart should follow — a 2021 episode pirated and discovered in 2026
// belongs to 2026, not 2021.
//
// Not every MarkScan platform endpoint populates urlUploadDate/discoveryDoneAt —
// e.g. Facebook/Instagram/Twitter/Telegram/Internet/UGC rows have been seen with
// neither field set while YouTube's do. FilterRowsByDate drops any row with no
// day at all, so treating those two fields as the ONLY source silently made
// every other platform's rows vanish from the date-filtered report (while still
// correctly sitting in the store — "rows stored" >> "rows shown"). The fields
// below are a safety net, tried only when neither preferred field is present, so
// a platform's rows still get a usable day instead of disappearing outright.
func ReportDay(r map[string]any) string {
	for _, k := range []string{
		"urlUploadDate", "URLUploadDate", "discoveryDoneAt", "DiscoveryDoneAt",
		"uploadDate", "UploadDate", "enforcementTime", "removalTime", "createdAt", "CreatedAt",
	} {
		s := strFrom(r[k])
		if len(s) >= 10 {
			return s[:10]
		}
	}
	return ""
}

func dayOf(r map[string]any) string { return ReportDay(r) }

func strFrom(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case fmt.Stringer:
		return t.String()
	}
	return ""
}

func boolFrom(v any) bool {
	switch t := v.(type) {
	case bool:
		return t
	case string:
		return strings.EqualFold(t, "true")
	}
	return false
}

func notEmpty(v any) bool {
	if v == nil {
		return false
	}
	if s, ok := v.(string); ok {
		return strings.TrimSpace(s) != ""
	}
	return true
}

// toNum tolerates numbers arriving as strings ("132") or JSON numbers.
func toNum(v any) int64 {
	switch t := v.(type) {
	case float64:
		return int64(t)
	case int64:
		return t
	case int:
		return int64(t)
	case string:
		s := strings.TrimSpace(t)
		if s == "" {
			return 0
		}
		if n, err := strconv.ParseFloat(s, 64); err == nil {
			return int64(n)
		}
	}
	return 0
}

func toInt(v any) (int, bool) {
	switch t := v.(type) {
	case float64:
		return int(t), true
	case int:
		return t, true
	case int64:
		return int(t), true
	case string:
		if n, err := strconv.Atoi(strings.TrimSpace(t)); err == nil {
			return n, true
		}
	}
	return 0, false
}

// MarkScanTime formats a time for the MarkScan request bodies (ISO-8601 UTC).
func MarkScanTime(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

// logf is a thin wrapper so aggregation issues surface without a hard dep.
func logf(format string, args ...any) { log.Printf("[warroom] "+format, args...) }

var _ = logf // reserved for future diagnostics
