package admin

/*
"KEEP THE MOST-USED CLIENTS READY" — the top-clients auto-cache.

Every open of a client's Reports, Traffic Analysis or Torrent Analysis is
counted in Redis (reportcache/usage.go). On a schedule, this ranks clients by
those opens over a look-back window, takes the top N, and keeps each one's:

	Reports   every enabled platform, the last `reportDays` days, through the
	          same builder the on-demand "cache these clients now" uses — with
	          the freshness probe ON, so a report whose data has not moved is
	          left as it is rather than rebuilt (handlers/autotopwarm.go)
	Traffic   the default Overview + Domains views, via reports_api
	Torrent   the default search (latest month), via reports_api

It sits BESIDE the existing options on the Cache & Redis tab and changes none of
them: "Keep every client's reports ready" still covers every mapped client, and
on-demand caching still does exactly what an operator asks. This one follows
what people actually open — including clients nobody has mapped.

Settings live in this portal's own database (report_cache_autotop, one row),
created on first use exactly as report_cache_config is. Nothing here writes to
the warehouse; every warehouse read is the reports' own SELECTs.

	GET  /api/admin/report-cache/autotop       settings, last run, ranking
	PUT  /api/admin/report-cache/autotop       save settings
	POST /api/admin/report-cache/autotop/run   run a pass now
*/

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/ip-house/iphouse-api/db"
	"github.com/ip-house/iphouse-api/handlers"
	"github.com/ip-house/iphouse-api/reportcache"
	"github.com/ip-house/iphouse-api/reportsapi"
)

const autoTopTable = "report_cache_autotop"

type autoTopSettings struct {
	Enabled      bool `json:"enabled"`
	TopN         int  `json:"topN"`         // how many clients
	LookbackDays int  `json:"lookbackDays"` // ranking window
	EveryMinutes int  `json:"everyMinutes"` // how often a pass runs
	Reports      bool `json:"reports"`
	Traffic      bool `json:"traffic"`
	Torrent      bool `json:"torrent"`

	/* The period kept ready — at most a year, for all three. It rolls with
	   the schedule, so each pass works out its own dates:

	     "days"    the last ReportDays days (7…365)
	     "months"  the last Months calendar months, this one included (1…12),
	               each month kept on its own
	     "start"   StartDate → today; if that grows past a year, the oldest
	               days drop off and the card says so */
	PeriodMode string `json:"periodMode"`
	ReportDays int    `json:"reportDays"`
	Months     int    `json:"months"`
	StartDate  string `json:"startDate"`
}

func defaultAutoTop() autoTopSettings {
	return autoTopSettings{Enabled: false, TopN: 10, LookbackDays: 14, EveryMinutes: 60,
		Reports: true, Traffic: true, Torrent: true, PeriodMode: "days", ReportDays: 30, Months: 3}
}

// clamp keeps every setting inside what a pass can sensibly do.
func (s *autoTopSettings) clamp() {
	clampInt := func(v *int, lo, hi, def int) {
		if *v < lo || *v > hi {
			*v = def
		}
	}
	d := defaultAutoTop()
	clampInt(&s.TopN, 1, 50, d.TopN)
	clampInt(&s.LookbackDays, 1, 35, d.LookbackDays)
	clampInt(&s.EveryMinutes, 15, 1440, d.EveryMinutes)
	clampInt(&s.ReportDays, 1, 365, d.ReportDays)
	clampInt(&s.Months, 1, 12, d.Months)
	switch s.PeriodMode {
	case "days", "months":
	case "start":
		t, err := time.Parse("2006-01-02", s.StartDate)
		if err != nil || t.After(time.Now().UTC()) {
			s.PeriodMode, s.StartDate = "days", ""
		}
	default:
		s.PeriodMode = "days"
	}
}

// autoTopPeriod is one pass's dates, worked out from the settings at run time.
type autoTopPeriod struct {
	Label   string                   `json:"label"`
	Note    string                   `json:"note,omitempty"` // e.g. the start date was held to a year
	Windows []handlers.SectionWindow `json:"windows"`        // for the reports
	Months  []string                 `json:"months,omitempty"`
	From    string                   `json:"from,omitempty"`
	To      string                   `json:"to,omitempty"`
}

func (s autoTopSettings) period(now time.Time) autoTopPeriod {
	today := now.UTC().Truncate(24 * time.Hour)
	ymd := func(t time.Time) string { return t.Format("2006-01-02") }
	switch s.PeriodMode {
	case "months":
		var months []string
		first := time.Date(today.Year(), today.Month(), 1, 0, 0, 0, 0, time.UTC)
		for i := s.Months - 1; i >= 0; i-- {
			months = append(months, first.AddDate(0, -i, 0).Format("2006-01"))
		}
		ws, _ := handlers.SectionWindows(months, "", "")
		label := "this month"
		if s.Months > 1 {
			label = fmt.Sprintf("last %d months (%s – %s)", s.Months, ws[0].Label, ws[len(ws)-1].Label)
		}
		return autoTopPeriod{Label: label, Windows: ws, Months: months}
	case "start":
		from, _ := time.Parse("2006-01-02", s.StartDate)
		p := autoTopPeriod{}
		if earliest := today.AddDate(0, 0, -365); from.Before(earliest) {
			p.Note = fmt.Sprintf("the start date %s is more than a year ago, so the oldest days are left out", ymd(from))
			from = earliest
		}
		p.From, p.To = ymd(from), ymd(today)
		p.Label = fmt.Sprintf("%s → today", from.Format("2 Jan 2006"))
		p.Windows = []handlers.SectionWindow{{From: p.From, To: p.To, Label: p.Label}}
		return p
	default:
		from := today.AddDate(0, 0, -s.ReportDays+1)
		label := "today"
		if s.ReportDays > 1 {
			label = fmt.Sprintf("last %d days", s.ReportDays)
		}
		return autoTopPeriod{Label: label, From: ymd(from), To: ymd(today),
			Windows: []handlers.SectionWindow{{From: ymd(from), To: ymd(today), Label: label}}}
	}
}

var autoTopSchema sync.Once

func ensureAutoTopSchema() {
	autoTopSchema.Do(func() {
		if _, _, err := db.Exec(`
			CREATE TABLE IF NOT EXISTS ` + autoTopTable + ` (
			  id            TINYINT UNSIGNED NOT NULL PRIMARY KEY,
			  settings      TEXT         NOT NULL,
			  updated_by    VARCHAR(191) NOT NULL DEFAULT '',
			  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`); err != nil {
			log.Printf("[auto-top] create %s: %v", autoTopTable, err)
		}
	})
}

func loadAutoTop() (autoTopSettings, string, string) {
	ensureAutoTopSchema()
	s := defaultAutoTop()
	rows, err := db.Query("SELECT settings, updated_by, updated_at FROM " + autoTopTable + " WHERE id = 1")
	if err != nil || len(rows) == 0 {
		return s, "", ""
	}
	_ = json.Unmarshal([]byte(strVal(rows[0]["settings"])), &s)
	s.clamp()
	return s, strVal(rows[0]["updated_by"]), strVal(rows[0]["updated_at"])
}

// ── the pass ─────────────────────────────────────────────────────────────

type autoTopClient struct {
	ClientID   string                   `json:"clientId"`
	ClientName string                   `json:"clientName"`
	Usage      reportcache.ClientUsage  `json:"usage"`
	Reports    *handlers.ReportsOutcome `json:"reports,omitempty"`
}

type autoTopRun struct {
	Trigger     string          `json:"trigger"` // schedule | manual
	Period      autoTopPeriod   `json:"period"`
	StartedAt   time.Time       `json:"startedAt"`
	FinishedAt  time.Time       `json:"finishedAt"`
	Stage       string          `json:"stage"`
	Clients     []autoTopClient `json:"clients"`
	TrafficSent bool            `json:"trafficSent"`
	TorrentSent bool            `json:"torrentSent"`
	Error       string          `json:"error,omitempty"`
}

var autoTop = struct {
	sync.Mutex
	running bool
	last    *autoTopRun
	nextRun time.Time
}{}

// clientNameMap names clients from the portal's mapping, then the warehouse's.
func clientNameMap(ctx context.Context) map[string]string {
	names := lowerKeys(clientNames())
	for id, n := range handlers.CachedClientNames(ctx) {
		if k := strings.ToLower(id); names[k] == "" && n != "" && !strings.EqualFold(n, id) {
			names[k] = n
		}
	}
	return names
}

func runAutoTop(trigger string) {
	autoTop.Lock()
	if autoTop.running {
		autoTop.Unlock()
		return
	}
	autoTop.running = true
	run := &autoTopRun{Trigger: trigger, StartedAt: time.Now().UTC(), Stage: "ranking clients"}
	autoTop.last = run
	autoTop.Unlock()
	defer func() {
		autoTop.Lock()
		autoTop.running = false
		run.FinishedAt, run.Stage = time.Now().UTC(), ""
		autoTop.Unlock()
	}()
	set := func(f func()) { autoTop.Lock(); f(); autoTop.Unlock() }

	s, _, _ := loadAutoTop()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Hour)
	defer cancel()
	top, err := reportcache.Get().TopClients(ctx, s.LookbackDays, reportcache.UsageKinds, s.TopN)
	if err != nil || len(top) == 0 {
		set(func() {
			if err != nil {
				run.Error = err.Error()
			} else {
				run.Error = "No client has been opened in the look-back window yet — nothing to rank."
			}
		})
		return
	}
	names := clientNameMap(ctx)
	ids := make([]string, 0, len(top))
	clients := make([]autoTopClient, 0, len(top))
	for _, u := range top {
		ids = append(ids, u.ClientID)
		clients = append(clients, autoTopClient{ClientID: u.ClientID, ClientName: names[strings.ToLower(u.ClientID)], Usage: u})
	}
	set(func() { run.Clients = clients })

	per := s.period(time.Now())
	set(func() { run.Period = per })

	/* Traffic and Torrent first: reports_api does them in the background, so
	   they proceed while the reports below are built here. Two asks each: the
	   default view (what the page opens with), and the period. */
	if reportsapi.Configured() {
		for _, sc := range []struct {
			on   bool
			name string
			sent *bool
		}{{s.Traffic, "traffic", &run.TrafficSent}, {s.Torrent, "torrent", &run.TorrentSent}} {
			if !sc.on {
				continue
			}
			base := url.Values{"scope": {sc.name}, "clients": {strings.Join(ids, ",")}}
			withPeriod := url.Values{"scope": {sc.name}, "clients": {strings.Join(ids, ",")}, "origin": {"auto"}}
			if len(per.Months) > 0 {
				withPeriod.Set("months", strings.Join(per.Months, ","))
			} else {
				withPeriod.Set("from", per.From)
				withPeriod.Set("to", per.To)
			}
			failed := false
			for _, q := range []url.Values{base, withPeriod} {
				var body map[string]any
				if err := reportsapi.Get().PostJSON(ctx, "/v1/admin/analytics-cache/prepare", q, &body); err != nil {
					log.Printf("[auto-top] %s prepare: %v", sc.name, err)
					set(func() { run.Error = sc.name + ": " + err.Error() })
					failed = true
				}
			}
			if !failed {
				set(func() { *sc.sent = true })
			}
		}
	}
	if s.Reports && reportcache.Get().Enabled() {
		set(func() { run.Stage = "building reports" })
		out := handlers.WarmReportsWindows(ctx, ids, per.Windows)
		set(func() {
			for i := range run.Clients {
				run.Clients[i].Reports = out[run.Clients[i].ClientID]
			}
		})
	}
	log.Printf("[auto-top] %s pass: %d client(s) kept ready", trigger, len(ids))
}

/*
RunAutoTop is the schedule: a one-minute tick that starts a pass whenever one
is due. Started from main; returns when ctx ends.
*/
func RunAutoTop(ctx context.Context) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		s, _, _ := loadAutoTop()
		autoTop.Lock()
		last := autoTop.last
		due := s.Enabled && !autoTop.running &&
			(last == nil || time.Since(last.StartedAt) >= time.Duration(s.EveryMinutes)*time.Minute)
		if s.Enabled && last != nil {
			autoTop.nextRun = last.StartedAt.Add(time.Duration(s.EveryMinutes) * time.Minute)
		} else if !s.Enabled {
			autoTop.nextRun = time.Time{}
		}
		autoTop.Unlock()
		if due {
			go runAutoTop("schedule")
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// ── handlers ─────────────────────────────────────────────────────────────

// GET / PUT /api/admin/report-cache/autotop
func ReportCacheAutoTop(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPut {
		var in autoTopSettings
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			fail(w, 400, "Could not read the settings")
			return
		}
		in.clamp()
		ensureAutoTopSchema()
		raw, _ := json.Marshal(in)
		if _, _, err := db.Exec("INSERT INTO "+autoTopTable+" (id, settings, updated_by) VALUES (1, ?, ?) "+
			"ON DUPLICATE KEY UPDATE settings = VALUES(settings), updated_by = VALUES(updated_by)",
			string(raw), adminName(r)); err != nil {
			fail(w, 500, err.Error())
			return
		}
		log.Printf("[auto-top] settings saved by %s: %s", adminName(r), raw)
	}

	s, by, at := loadAutoTop()
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()

	// The ranking as it stands now — what the next pass would pick.
	ranking, _ := reportcache.Get().TopClients(ctx, s.LookbackDays, reportcache.UsageKinds, 25)
	names := clientNameMap(ctx)
	// Which of them already have something cached, per product.
	cachedReports := map[string]int{}
	if entries, err := reportcache.Get().List(ctx, 0); err == nil {
		for _, e := range entries {
			cachedReports[strings.ToLower(e.ClientID)]++
		}
	}
	cachedAnalytics := map[string]map[string]bool{"traffic": {}, "torrent": {}}
	if reportsapi.Configured() {
		for _, sc := range []string{"traffic", "torrent"} {
			var body struct {
				Entries []struct {
					ClientID string `json:"clientId"`
					Current  bool   `json:"current"`
				} `json:"entries"`
			}
			if err := reportsapi.Get().GetJSON(ctx, "/v1/admin/analytics-cache", url.Values{"scope": {sc}}, &body); err == nil {
				for _, e := range body.Entries {
					if e.Current {
						cachedAnalytics[sc][strings.ToLower(e.ClientID)] = true
					}
				}
			}
		}
	}
	rank := make([]map[string]any, 0, len(ranking))
	for i, u := range ranking {
		k := strings.ToLower(u.ClientID)
		rank = append(rank, map[string]any{
			"rank": i + 1, "clientId": u.ClientID, "clientName": names[k], "counts": u.Counts,
			"total": u.Total, "lastDay": u.LastDay, "inTopN": i < s.TopN,
			"cached": map[string]any{"reports": cachedReports[k], "traffic": cachedAnalytics["traffic"][k],
				"torrent": cachedAnalytics["torrent"][k]},
		})
	}
	autoTop.Lock()
	status := map[string]any{"running": autoTop.running, "last": autoTop.last, "nextRun": autoTop.nextRun}
	autoTop.Unlock()
	ok(w, map[string]any{"success": true, "settings": s, "updatedBy": by, "updatedAt": at,
		"period": s.period(time.Now()),
		"status": status, "ranking": rank, "cacheConnected": reportcache.Get().Enabled()})
}

// POST /api/admin/report-cache/autotop/run
func ReportCacheAutoTopRun(w http.ResponseWriter, r *http.Request) {
	if !reportcache.Get().Enabled() {
		fail(w, 422, "The cache is not connected — save a working Redis address first")
		return
	}
	autoTop.Lock()
	running := autoTop.running
	autoTop.Unlock()
	if running {
		ok(w, map[string]any{"success": true, "started": false, "detail": "A pass is already running"})
		return
	}
	go runAutoTop("manual")
	log.Printf("[auto-top] manual pass requested by %s", adminName(r))
	ok(w, map[string]any{"success": true, "started": true})
}
