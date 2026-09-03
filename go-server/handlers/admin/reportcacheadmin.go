package admin

// The Redis cache, as something an operator can see and steer.
//
// Settings live in the database like the reports API connection does, and the
// Redis PASSWORD is encrypted at rest with the same helper — a cache credential
// is a credential.
//
// Everything here is descriptive or reversible: look at the connection, list
// what is cached, force a pass, empty it. Nothing changes a report's numbers,
// so this is behind the report-config grant rather than Super Admin.

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	ipauth "github.com/ip-house/iphouse-api/auth"
	"github.com/ip-house/iphouse-api/db"
	"github.com/ip-house/iphouse-api/handlers"
	"github.com/ip-house/iphouse-api/reportcache"
)

const redisCfgTable = "report_cache_config"

var redisCfgOnce sync.Once

func ensureRedisCfgSchema() {
	redisCfgOnce.Do(func() {
		if _, _, err := db.Exec(`
			CREATE TABLE IF NOT EXISTS ` + redisCfgTable + ` (
			  id           TINYINT UNSIGNED NOT NULL PRIMARY KEY,
			  addr         VARCHAR(255) NOT NULL DEFAULT '',
			  password     TEXT         NULL,
			  db_index     INT          NOT NULL DEFAULT 0,
			  ttl_minutes  INT          NOT NULL DEFAULT 1440,
			  warm_enabled TINYINT(1)   NOT NULL DEFAULT 0,
			  warm_minutes INT          NOT NULL DEFAULT 30,
			  warm_days    INT          NOT NULL DEFAULT 30,
			  warm_conc    INT          NOT NULL DEFAULT 2,
			  maxmemory_mb INT          NOT NULL DEFAULT 0,
			  warm_windows VARCHAR(191) NOT NULL DEFAULT '1,7,15,30,90',
			  warm_calendar TINYINT(1)  NOT NULL DEFAULT 1,
			  skip_unchanged TINYINT(1) NOT NULL DEFAULT 1,
			  recheck_minutes INT       NOT NULL DEFAULT 10,
			  drill_minutes INT         NOT NULL DEFAULT 10,
			  updated_by   VARCHAR(191) NOT NULL DEFAULT '',
			  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`); err != nil {
			log.Printf("[report-cache] create %s: %v", redisCfgTable, err)
		}
		/* The memory cap arrived after the table did, and CREATE TABLE IF NOT
		   EXISTS does nothing to a table that already exists — so an install
		   created before this would read a column that is not there and get
		   zero for every setting on the row. Added separately, ignoring the
		   duplicate-column error, which is what a second run produces. */
		for _, alter := range []string{
			"ADD COLUMN maxmemory_mb INT NOT NULL DEFAULT 0",
			"ADD COLUMN warm_windows VARCHAR(191) NOT NULL DEFAULT '1,7,15,30,90'",
			"ADD COLUMN skip_unchanged TINYINT(1) NOT NULL DEFAULT 1",
			"ADD COLUMN warm_calendar TINYINT(1) NOT NULL DEFAULT 1",
			"ADD COLUMN recheck_minutes INT NOT NULL DEFAULT 10",
			"ADD COLUMN drill_minutes INT NOT NULL DEFAULT 10",
		} {
			if _, _, err := db.Exec("ALTER TABLE " + redisCfgTable + " " + alter); err != nil {
				if !strings.Contains(strings.ToLower(err.Error()), "duplicate column") {
					log.Printf("[report-cache] %s: %v", alter, err)
				}
			}
		}

		/* Retention moved from six hours to a day, and an install that already
		   has a row keeps whatever is in it — CREATE TABLE and ALTER only ever
		   set defaults for what comes after them.

		   So the old default is raised, and ONLY the old default: a row still
		   reading exactly 360 is one nobody chose, while 480 or 120 is a
		   decision someone made and a migration has no business overruling. The
		   same rule applies to the window list, which was a single 30-day range
		   and is now one per preset the date picker offers. */
		if _, n, err := db.Exec(
			"UPDATE "+redisCfgTable+" SET ttl_minutes = 1440 WHERE id = 1 AND ttl_minutes = ?", 360); err != nil {
			log.Printf("[report-cache] raise retention to 24h: %v", err)
		} else if n > 0 {
			log.Printf("[report-cache] retention raised from 6h to 24h (the previous default)")
		}
		if _, n, err := db.Exec(
			"UPDATE "+redisCfgTable+" SET warm_windows = ? WHERE id = 1 AND warm_windows = ?",
			"1,7,15,30,90", "30"); err != nil {
			log.Printf("[report-cache] widen the warm windows: %v", err)
		} else if n > 0 {
			log.Printf("[report-cache] warm windows widened to every date-picker preset")
		}
	})
}

type cacheSettings struct {
	Addr        string
	Password    string
	DBIndex     int
	TTLMinutes  int
	WarmEnabled bool
	WarmMinutes int
	/*
		SUPERSEDED by WarmWindows and kept only so an existing row round-trips.

		It was the single window a pass covered, back when there was one. Nothing
		reads it any more — Configure takes WarmWindows — so do not add a control
		for it: a field on the screen that changes no behaviour is worse than an
		absent one.
	*/
	WarmDays int
	WarmConc int
	// 0 means "leave whatever Redis was started with alone".
	MaxMemoryMB int
	// The date windows precomputed, in days. Several, because a reader who opens
	// the default month and one who opens the year ask different questions.
	WarmWindows []int
	// Also precompute this month, last month and this year — the three picker
	// presets whose dates no days-back window ever lands on.
	WarmCalendar bool
	// Skip a rebuild when a cheap probe says nothing changed.
	SkipUnchanged bool
	/* How long a served entry may go unchecked before the next read asks the
	   warehouse whether it has moved. This is the STALENESS, as distinct from
	   the retention above: a report is kept for a day and checked every few
	   minutes. 0 turns the check off. */
	RecheckMinutes int
	/*
		How long a DRILL-DOWN lives — a report with a filter applied, which is what
		every click on a bar produces.

		Separate from the retention above and much shorter, because the two are
		different bargains: a plain scope is read by everyone all day, a filtered
		view is usually read once. Its short life is also what makes it exempt from
		the freshness check, so this value IS the staleness bound for a drill-down.

		0 turns drill-down caching off, and then every click recomputes the whole
		report — which is what the product did before they were cached at all.
	*/
	DrillMinutes int
}

// loadCacheSettings reads the row, falling back to REDIS_ADDR so an install that
// already set the environment variable keeps working with no configuration.
func loadCacheSettings() cacheSettings {
	ensureRedisCfgSchema()
	/* A day of retention. Long enough that a report opened this afternoon is
	   still a read tomorrow morning, which is only safe because staleness is
	   handled separately — see RecheckMinutes and the read-path check in
	   handlers/reportcachebridge.go. */
	s := cacheSettings{TTLMinutes: 1440, WarmMinutes: 30, WarmDays: 30, WarmConc: 2,
		WarmWindows: []int{1, 7, 15, 30, 90}, WarmCalendar: true,
		SkipUnchanged: true, RecheckMinutes: 10, DrillMinutes: 10}

	row, _ := db.QueryOne("SELECT * FROM " + redisCfgTable + " WHERE id = 1 LIMIT 1")
	if row != nil {
		s.Addr = strings.TrimSpace(strVal(row["addr"]))
		if enc := strings.TrimSpace(strVal(row["password"])); enc != "" {
			s.Password = ipauth.DecryptMain(enc)
		}
		s.DBIndex = int(intVal(row["db_index"]))
		if v := int(intVal(row["ttl_minutes"])); v > 0 {
			s.TTLMinutes = v
		}
		s.WarmEnabled = intVal(row["warm_enabled"]) == 1
		if v := int(intVal(row["warm_minutes"])); v > 0 {
			s.WarmMinutes = v
		}
		if v := int(intVal(row["warm_days"])); v > 0 {
			s.WarmDays = v
		}
		if v := int(intVal(row["warm_conc"])); v > 0 {
			s.WarmConc = v
		}
		s.MaxMemoryMB = int(intVal(row["maxmemory_mb"]))
		if v := parseWindows(strVal(row["warm_windows"])); len(v) > 0 {
			s.WarmWindows = v
		}
		s.SkipUnchanged = intVal(row["skip_unchanged"]) == 1
		s.WarmCalendar = intVal(row["warm_calendar"]) == 1
		/* Read as stored, including zero — zero means "do not check", which is a
		   real choice and must not be quietly replaced by the default the way a
		   zero interval or TTL is. */
		s.RecheckMinutes = int(intVal(row["recheck_minutes"]))
		// Zero is a choice here too — "do not cache drill-downs" — so it is read
		// as stored rather than replaced by the default.
		s.DrillMinutes = int(intVal(row["drill_minutes"]))
	}
	if s.Addr == "" {
		s.Addr = strings.TrimSpace(os.Getenv("REDIS_ADDR"))
	}
	return s
}

// ApplyReportCacheSettings connects the cache and starts or stops the warmer to
// match what is stored. Called at boot and after every save, so a change takes
// effect without a restart.
func ApplyReportCacheSettings() {
	s := loadCacheSettings()

	reportcache.Get().Configure(reportcache.Config{
		Addr: s.Addr, Password: s.Password, DB: s.DBIndex,
		TTL: time.Duration(s.TTLMinutes) * time.Minute,
	})

	/* Re-applied on every connect, because CONFIG SET does not survive a restart
	   of Redis — see reportcache.SetMaxMemory. This covers a portal restart; a
	   Redis restart while the portal keeps running is the case the operator is
	   warned about on the screen. */
	if s.MaxMemoryMB > 0 && reportcache.Get().Enabled() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		if err := reportcache.Get().SetMaxMemory(ctx, int64(s.MaxMemoryMB)*1024*1024); err != nil {
			log.Printf("[report-cache] could not apply the %d MB limit: %v", s.MaxMemoryMB, err)
		} else {
			log.Printf("[report-cache] memory limit set to %d MB", s.MaxMemoryMB)
		}
		cancel()
	}

	// The read-path freshness check — see handlers/reportcachebridge.go. Applied
	// before the warmer so a save takes effect on the very next report opened.
	handlers.SetCacheRecheck(time.Duration(s.RecheckMinutes) * time.Minute)

	/* The drill-down life, likewise.

	   This had a setter and no caller: the value was fixed at ten minutes in the
	   binary, and no configuration reached it. An exported Set- with nothing
	   calling it reads as a wired setting to anyone auditing the file, which is
	   how it survived. */
	handlers.SetDrillTTL(time.Duration(s.DrillMinutes) * time.Minute)

	/* The recorded misses describe the configuration that produced them. Keeping
	   them across a save would leave an operator who has just widened the warm
	   windows staring at the misses that made them do it, unable to tell whether
	   the change worked. */
	reportcache.Get().ForgetMisses()

	/* Said at startup, because the commonest cache question is "is this report
	   from the build I just deployed" and the answer is otherwise invisible. */
	if tag, how := reportcache.EngineTag(); reportcache.Get().Enabled() {
		log.Printf("[report-cache] entries are scoped to build %s (identified by %s)", tag, how)
	}

	w := reportcache.GetWarmer()
	w.Configure(time.Duration(s.WarmMinutes)*time.Minute, s.WarmWindows, s.WarmCalendar,
		s.WarmConc, s.SkipUnchanged)

	// The warmer is pointless without somewhere to put the result, so it only
	// runs when the cache is actually connected.
	if s.WarmEnabled && reportcache.Get().Enabled() {
		w.Start()
	} else {
		w.Stop()
	}
}

// GET/POST /api/admin/report-cache
func ReportCacheConfig(w http.ResponseWriter, r *http.Request) {
	ensureRedisCfgSchema()

	if r.Method == http.MethodGet {
		s := loadCacheSettings()
		live, addr, dbIdx, ttl, errText := reportcache.Get().Status()

		body := map[string]any{
			"success": true,
			"settings": map[string]any{
				"addr": s.Addr, "hasPassword": s.Password != "", "dbIndex": s.DBIndex,
				"ttlMinutes": s.TTLMinutes, "warmEnabled": s.WarmEnabled,
				"warmMinutes": s.WarmMinutes, "warmDays": s.WarmDays, "warmConc": s.WarmConc,
				"maxMemoryMb": s.MaxMemoryMB,
				"warmWindows": joinWindows(s.WarmWindows), "skipUnchanged": s.SkipUnchanged,
				"warmCalendar": s.WarmCalendar, "recheckMinutes": s.RecheckMinutes,
				"drillMinutes": s.DrillMinutes,
			},
			"connection": map[string]any{
				"connected": live, "addr": addr, "dbIndex": dbIdx,
				"ttlMinutes": int(ttl / time.Minute), "error": errText,
			},
			"stats":  reportcache.Get().Stats(),
			"warmer": reportcache.GetWarmer().Status(),
			/* The scopes readers asked for and did not find — see
			   reportcache.NoteMiss. This is what turns "hit rate 0%" from an alarm
			   into a diagnosis: the windows on this list against the windows the
			   pass covers is the whole answer, and the commonest cause is that they
			   are different. */
			"misses": namedMisses(r.Context(), reportcache.Get().RecentMisses(12)),
			// What the last "cache these clients" request did, per client. The
			// screen needs it to distinguish still-queued from produced-nothing.
			"onDemand": namedOnDemand(r.Context()),
		}
		tag, how := reportcache.EngineTag()
		engine := map[string]any{"tag": tag, "source": how}
		if live {
			/* How much of Redis belongs to builds that are no longer running.
			   Unreachable rather than wrong — the key scoping already guarantees
			   nobody is served it — but it is memory, and an operator cannot see
			   it any other way. */
			sctx, scancel := context.WithTimeout(r.Context(), 5*time.Second)
			if n, err := reportcache.Get().Sweep(sctx, false); err == nil {
				engine["otherBuilds"] = n
			}
			scancel()
		}
		body["engine"] = engine

		if live {
			ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
			if info, err := reportcache.Get().Info(ctx); err == nil {
				body["server"] = info
			}
			if mem, err := reportcache.Get().Memory(ctx); err == nil {
				body["memory"] = mem
			}
			cancel()
		}
		ok(w, body)
		return
	}

	var in struct {
		Addr           string `json:"addr"`
		Password       string `json:"password"`
		ClearPassword  bool   `json:"clearPassword"`
		DBIndex        int    `json:"dbIndex"`
		TTLMinutes     int    `json:"ttlMinutes"`
		WarmEnabled    bool   `json:"warmEnabled"`
		WarmMinutes    int    `json:"warmMinutes"`
		WarmDays       int    `json:"warmDays"`
		WarmConc       int    `json:"warmConc"`
		MaxMemoryMB    int    `json:"maxMemoryMb"`
		WarmWindows    string `json:"warmWindows"`
		SkipUnchanged  bool   `json:"skipUnchanged"`
		WarmCalendar   bool   `json:"warmCalendar"`
		RecheckMinutes int    `json:"recheckMinutes"`
		DrillMinutes   int    `json:"drillMinutes"`
	}
	json.NewDecoder(r.Body).Decode(&in)

	cur := loadCacheSettings()
	pass := cur.Password
	switch {
	case in.ClearPassword:
		pass = ""
	case strings.TrimSpace(in.Password) != "":
		pass = strings.TrimSpace(in.Password)
	}
	encPass := any(nil)
	if pass != "" {
		encPass = ipauth.EncryptMain(pass)
	}

	if _, _, err := db.Exec(`
		INSERT INTO `+redisCfgTable+`
		  (id, addr, password, db_index, ttl_minutes, warm_enabled, warm_minutes, warm_days, warm_conc,
		   maxmemory_mb, warm_windows, skip_unchanged, warm_calendar, recheck_minutes, drill_minutes,
		   updated_by)
		VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE addr=VALUES(addr), password=VALUES(password), db_index=VALUES(db_index),
		  ttl_minutes=VALUES(ttl_minutes), warm_enabled=VALUES(warm_enabled), warm_minutes=VALUES(warm_minutes),
		  warm_days=VALUES(warm_days), warm_conc=VALUES(warm_conc), maxmemory_mb=VALUES(maxmemory_mb),
		  warm_windows=VALUES(warm_windows), skip_unchanged=VALUES(skip_unchanged),
		  warm_calendar=VALUES(warm_calendar), recheck_minutes=VALUES(recheck_minutes),
		  drill_minutes=VALUES(drill_minutes), updated_by=VALUES(updated_by)`,
		/* Fifteen, matching the fifteen placeholders above. The count is
		   checked by database/sql at RUN time, not by the compiler — so a column
		   added here without its argument builds cleanly and fails only when
		   someone presses Save. See TestCacheSaveArgCount. */
		strings.TrimSpace(in.Addr), encPass, in.DBIndex, in.TTLMinutes,
		boolInt(in.WarmEnabled), in.WarmMinutes, in.WarmDays,
		/* Stored at the value that will RUN. The warmer clamps this anyway, so
		   storing what was typed left the screen reporting a concurrency the
		   pass never used. */
		reportcache.ClampWarmConcurrency(in.WarmConc), in.MaxMemoryMB,
		joinWindows(parseWindows(in.WarmWindows)), boolInt(in.SkipUnchanged),
		boolInt(in.WarmCalendar), clampRecheck(in.RecheckMinutes),
		clampDrill(in.DrillMinutes), adminName(r)); err != nil {
		/* The cause travels with the message. This endpoint is behind the
		   report-config grant, so the reader is an operator who can act on
		   "Unknown column" or "Access denied" — and "Could not save the cache
		   settings" sent them to ask rather than to look, which is the whole
		   cost of a generic error on an admin screen. */
		log.Printf("[report-cache] save: %v", err)
		fail(w, 500, "Could not save the cache settings: "+err.Error())
		return
	}

	ApplyReportCacheSettings()
	live, _, _, _, errText := reportcache.Get().Status()

	/* Whether the limit actually took is reported separately from whether the
	   settings saved. They are different outcomes: the row is stored either
	   way, and a Redis that forbids CONFIG SET has to say so rather than let
	   the screen imply a cap that is not in force. */
	memNote := ""
	if in.MaxMemoryMB > 0 && live {
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		if mem, err := reportcache.Get().Memory(ctx); err == nil {
			want := int64(in.MaxMemoryMB) * 1024 * 1024
			if mem.MaxBytes != want {
				memNote = "The memory limit could not be applied — Redis is still capped at " +
					humanBytes(mem.MaxBytes) + ". Set it where the server is started."
			}
		}
		cancel()
	}
	ok(w, map[string]any{"success": true, "connected": live, "error": errText, "memoryNote": memNote})
}

/*
namedMisses is the recent-miss list with company names filled in.

Named on the SERVER, like every other client column on this screen, rather than
by handing the page a directory to join against. The panel already receives
clientName on each cached-report row and each on-demand row; a list that arrived
as bare ids would be the only table here that did not, and the page has no map to
resolve them with.

Names, not the picker's list — the same rule as namedOnDemand. A company retired
since somebody last opened its report is still the right label on a row about
that report.
*/
func namedMisses(ctx context.Context, ms []reportcache.Miss) []map[string]any {
	if len(ms) == 0 {
		return nil
	}
	names := lowerKeys(clientNames())
	unresolved := false
	for _, m := range ms {
		if names[strings.ToLower(m.ClientID)] == "" {
			unresolved = true
			break
		}
	}
	if unresolved {
		dctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		for id, name := range handlers.CachedClientNames(dctx) {
			k := strings.ToLower(id)
			if names[k] == "" && !strings.EqualFold(id, name) {
				names[k] = name
			}
		}
		cancel()
	}

	out := make([]map[string]any, 0, len(ms))
	for _, m := range ms {
		out = append(out, map[string]any{
			"platform": m.Platform, "clientId": m.ClientID,
			"clientName": names[strings.ToLower(m.ClientID)],
			"from":       m.From, "to": m.To,
			"count": m.Count, "lastAt": m.LastAt.Format(time.RFC3339),
		})
	}
	return out
}

/*
namedOnDemand is the last on-demand warm with company names filled in.

The portal's mapping first, then the warehouse directory for the rest — and the
rest is most of them. The whole point of the on-demand form is to reach clients
the mapping does NOT cover, so naming from the mapping alone left the one table
about those clients showing a column of bare GUIDs.

The directory is memoised for a few minutes (CachedClientNames), which is what
makes it affordable here: this is on the settings GET, and the screen polls it
every few seconds while a pass runs. Names rather than the picker's list, so a
client retired since the pass ran is still named on the row reporting it.
*/
func namedOnDemand(ctx context.Context) map[string]any {
	st := handlers.OnDemandWarmStatus()
	rows, _ := st["clients"].([]map[string]any)
	if len(rows) == 0 {
		return st
	}

	names := lowerKeys(clientNames())
	// Only reached for if the mapping actually left something unnamed.
	unresolved := false
	for _, r := range rows {
		if names[strings.ToLower(strVal(r["clientId"]))] == "" {
			unresolved = true
			break
		}
	}
	if unresolved {
		dctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		// Names again, for the same reason as the entries table above.
		for id, name := range handlers.CachedClientNames(dctx) {
			k := strings.ToLower(id)
			if names[k] == "" && !strings.EqualFold(id, name) {
				names[k] = name
			}
		}
		cancel()
	}

	for _, r := range rows {
		id := strVal(r["clientId"])
		if n := names[strings.ToLower(id)]; n != "" {
			r["clientName"] = n
		} else {
			r["clientName"] = id
		}
	}
	return st
}

/*
parseWindows reads "30, 90, 400" into days.

Deduplicated, sorted and capped, because each window multiplies the pass: three
windows over nine platforms and twenty clients is 540 reports, and a typo of an
extra digit would quietly turn a five-minute pass into an hour of warehouse time.
*/
func parseWindows(s string) []int {
	seen := map[int]bool{}
	out := []int{}
	for _, part := range strings.Split(s, ",") {
		n, err := strconv.Atoi(strings.TrimSpace(part))
		if err != nil || n <= 0 || seen[n] {
			continue
		}
		// A little over a year is the most anyone asks a report for, and it is
		// also the point past which one pass stops finishing before the next.
		if n > 800 {
			n = 800
		}
		seen[n] = true
		out = append(out, n)
		/* Eight, one per preset the date picker offers. It was five, which is
		   fewer than the picker has — so whichever presets came last could not
		   be warmed at all no matter what an operator typed. */
		if len(out) >= 8 {
			break
		}
	}
	sort.Ints(out)
	return out
}

/*
clampRecheck keeps the read-path check inside what is useful.

0 is kept as given — it means "do not check", leaving the scheduled pass as the
only thing that refreshes an entry. Above that there is a floor: a cooldown of
seconds would put a warehouse probe behind a large share of report opens, which
is the load the cache exists to avoid.
*/
func clampRecheck(m int) int {
	switch {
	case m <= 0:
		return 0
	case m < 2:
		return 2
	case m > 720:
		return 720
	}
	return m
}

/*
clampDrill keeps the drill-down life inside what it is for.

0 is kept as given — it means "do not cache filtered views", and every click then
recomputes the report in full.

Above that there is a floor and a ceiling, and both come from what a drill-down
IS. A minute is shorter than the gesture it exists to serve — click a bar, read
it, click back — so the entry would expire mid-thought. And because a drill-down
is never revalidated, this number is also how stale one may get: a day of them
would be a day of filtered views nothing checks and nothing refreshes, which is
the retention window's job and not this one's.
*/
func clampDrill(m int) int {
	switch {
	case m <= 0:
		return 0
	case m < 2:
		return 2
	case m > 240:
		return 240
	}
	return m
}

func joinWindows(v []int) string {
	parts := make([]string, 0, len(v))
	for _, n := range v {
		parts = append(parts, strconv.Itoa(n))
	}
	return strings.Join(parts, ",")
}

// humanBytes is for a message an operator reads, not for arithmetic.
func humanBytes(b int64) string {
	switch {
	case b <= 0:
		return "unlimited"
	case b >= 1<<30:
		return fmt.Sprintf("%.1f GB", float64(b)/float64(1<<30))
	default:
		return fmt.Sprintf("%d MB", b/(1<<20))
	}
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

/*
clientNames maps the analytics client id to the company name.

From the portal's OWN mapping table rather than the warehouse: dcp_user already
holds both, it covers exactly the clients that get warmed, and it needs no
network call. A GUID identifies a row to a machine and nothing to a reader.
*/
func clientNames() map[string]string {
	out := map[string]string{}
	rows, err := db.Query(
		"SELECT DISTINCT " + handlers.ClientIDColumn + " AS cid, name FROM dcp_user " +
			"WHERE " + handlers.ClientIDColumn + " IS NOT NULL AND " + handlers.ClientIDColumn + " != '' AND deleted = 0")
	if err != nil {
		return out
	}
	for _, r := range rows {
		id, name := strings.TrimSpace(strVal(r["cid"])), strings.TrimSpace(strVal(r["name"]))
		// First non-empty name wins: several logins can share one company, and a
		// later blank must not overwrite a good name.
		if id != "" && name != "" && out[id] == "" {
			out[id] = name
		}
	}
	return out
}

// lowerKeys re-keys an id → name map on the lowercased id. Every system here
// writes GUIDs in the case it happens to hold them in — dcp_user, the warehouse
// and the cache all differ — and an exact-string lookup therefore failed to name
// clients whose names were sitting right there.
func lowerKeys(m map[string]string) map[string]string {
	out := make(map[string]string, len(m))
	for id, name := range m {
		if id = strings.TrimSpace(id); id != "" && name != "" {
			out[strings.ToLower(id)] = name
		}
	}
	return out
}

// How many rows the table is sent at once. The cache holds thousands and the
// screen is a table someone scans, not an export.
const entryPageSize = 500

/*
GET /api/admin/report-cache/entries — what is cached right now.

`?q=` filters it. The search is done HERE, over everything the cache holds,
rather than in the page over the rows it was sent: the page only ever receives
the newest few hundred, so a client whose entries fell outside that window would
be searched for and honestly reported as absent while sitting in Redis.

Listing everything costs no more than listing a page did — the cache reads every
key either way and truncates afterwards.
*/
func ReportCacheEntries(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	entries, err := reportcache.Get().List(ctx, 0)
	if err != nil {
		ok(w, map[string]any{"success": true, "entries": []any{}, "error": err.Error()})
		return
	}

	// Resolved server-side so the page renders what it is given, and an id with
	// no mapping still shows the id rather than an empty cell.
	names := lowerKeys(clientNames())
	// Counted BEFORE the directory is merged in below. This is the number the
	// screen reports as "mapped clients" and the number the scheduled pass
	// actually covers; filling it with every client the warehouse knows would
	// promise a pass far wider than the one that runs.
	mapped := len(names)

	/* Anything the mapping cannot name is looked up in the warehouse's own
	   directory.

	   The cache holds more than the scheduled pass puts there: staff opening a
	   report for a client nobody has mapped caches it too, and that entry had
	   nothing to name it — so the table showed a bare GUID in a column of
	   company names, which reads as corruption rather than as "not mapped".
	   Fetched once per request and only when something is actually unnamed. */
	unresolved := false
	for _, e := range entries {
		if names[strings.ToLower(e.ClientID)] == "" {
			unresolved = true
			break
		}
	}
	if unresolved {
		dctx, dcancel := context.WithTimeout(ctx, 10*time.Second)
		/* Names, not the picker's list. A client retired since its report was
		   cached still has entries in Redis and a row on this screen, and
		   drawing it as a bare GUID because it is no longer selectable would
		   make the table less legible, not more accurate. */
		for id, name := range handlers.CachedClientNames(dctx) {
			k := strings.ToLower(id)
			// A directory entry that only knows the id is no better than the id
			// the cell already holds, and must not win over a real name.
			if names[k] == "" && !strings.EqualFold(id, name) {
				names[k] = name
			}
		}
		dcancel()
	}

	/* Matched on the NAME as well as the id, because the name is what the table
	   shows and therefore what someone types. The id stays searchable too — it is
	   what a log line or a cache key carries, and pasting one in is how a
	   particular entry gets found. */
	q := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))

	/* Rolled up per client alongside the rows, and NOT truncated.

	   The row list is cut at entryPageSize because the cache holds thousands of
	   entries, and one client costs one row per platform per window — so a few
	   dozen clients fill the page and every client after them is missing from a
	   table headed "Cached reports". Absence there was read as "this client is
	   not being cached", which is the opposite of true.

	   A client roll-up has no such problem: there are hundreds of clients at
	   most, so the whole list fits and the screen can answer "is this one
	   cached" without a search. */
	type clientRoll struct {
		id        string
		name      string
		entries   int
		bytes     int
		platforms map[string]bool
		newest    time.Time
		oldest    time.Time
	}
	rolls := map[string]*clientRoll{}
	order := []string{}

	out := make([]map[string]any, 0, entryPageSize)
	matched := 0
	for _, e := range entries {
		name := names[strings.ToLower(e.ClientID)]
		if name == "" {
			name = e.ClientID
		}
		if q != "" && !strings.Contains(strings.ToLower(name+" "+e.ClientID+" "+e.Platform), q) {
			continue
		}
		matched++

		// Keyed on the lowercased id: the warehouse and the portal spell the
		// same GUID in different case, and keying naively split one company
		// into two rows in a list whose whole job is to say "this one is here".
		k := strings.ToLower(e.ClientID)
		roll := rolls[k]
		if roll == nil {
			roll = &clientRoll{id: e.ClientID, name: name, platforms: map[string]bool{},
				newest: e.StoredAt, oldest: e.StoredAt}
			rolls[k] = roll
			order = append(order, k)
		}
		roll.entries++
		roll.bytes += e.Bytes
		roll.platforms[e.Platform] = true
		if e.StoredAt.After(roll.newest) {
			roll.newest = e.StoredAt
		}
		if e.StoredAt.Before(roll.oldest) {
			roll.oldest = e.StoredAt
		}

		// Counted before the page is cut, so the screen can say how much of the
		// match it is looking at rather than implying it is all of it.
		if len(out) >= entryPageSize {
			continue
		}
		out = append(out, map[string]any{
			"platform": e.Platform, "clientId": e.ClientID, "clientName": name,
			"from": e.From, "to": e.To, "storedAt": e.StoredAt,
			"buildMs": e.BuildMS, "bytes": e.Bytes,
		})
	}

	clients := make([]map[string]any, 0, len(order))
	for _, k := range order {
		r := rolls[k]
		clients = append(clients, map[string]any{
			"clientId": r.id, "clientName": r.name, "entries": r.entries,
			"platforms": len(r.platforms), "bytes": r.bytes,
			"newest": r.newest, "oldest": r.oldest,
		})
	}
	// Newest first, matching the rows above: the client just warmed is the one
	// being looked for.
	sort.Slice(clients, func(i, j int) bool {
		a, _ := clients[i]["newest"].(time.Time)
		b, _ := clients[j]["newest"].(time.Time)
		return a.After(b)
	})

	ok(w, map[string]any{
		"success": true, "entries": out, "clientCount": mapped,
		// Every client the cache holds something for — the complete answer to
		// "is this one cached", regardless of how the rows above were cut.
		"clients": clients,
		// Three different numbers, and the screen was previously given one that
		// looked like all three: how many are cached, how many the search found,
		// and how many rows were actually sent.
		"total": len(entries), "matched": matched, "shown": len(out),
	})
}

/*
GET /api/admin/report-cache/clients — who can be warmed on demand.

The warehouse's whole directory, not the mapping, because the point of the
on-demand form is to reach a client the scheduled pass does not: one being
onboarded, or one whose portal users do not exist yet. `mapped` marks the ones
already covered, so the form can say which choices add something.
*/
func ReportCacheClients(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()

	mapped := clientNames()
	dir := handlers.CachedClientDirectory(ctx)

	// Compared case-insensitively throughout: the portal's mapping and the
	// warehouse store the same GUID in different case, and matching on the exact
	// string listed one client twice — once as a name, once as an id.
	lowMapped := lowerKeys(mapped)
	inDir := make(map[string]bool, len(dir))
	for id := range dir {
		inDir[strings.ToLower(id)] = true
	}

	// The mapping is merged IN, not replaced by the directory: a client the
	// portal knows must remain selectable even when the warehouse directory is
	// unreachable, which is exactly when someone is most likely to be here.
	for id, name := range mapped {
		if !inDir[strings.ToLower(id)] {
			dir[id] = name
			inDir[strings.ToLower(id)] = true
		}
	}

	out := make([]map[string]any, 0, len(dir))
	for id, name := range dir {
		_, isMapped := lowMapped[strings.ToLower(id)]
		out = append(out, map[string]any{"id": id, "name": name, "mapped": isMapped})
	}
	sort.Slice(out, func(i, j int) bool {
		return strings.ToLower(strVal(out[i]["name"])) < strings.ToLower(strVal(out[j]["name"]))
	})
	ok(w, map[string]any{
		"success": true, "clients": out,
		// What one client costs, so the form can say "9 reports" before the
		// button is pressed rather than after.
		"platformCount": handlers.WarmPlatformCount(),
	})
}

/*
POST /api/admin/report-cache/warm-client — cache one or more clients now.

Body: { clientIds: [...], days: N }

Every enabled platform, for each client named, over the last N days. Answers
immediately and works in the background for the same reason the full pass does:
this is minutes of warehouse queries and an HTTP request that waits for it times
out having told the caller nothing.
*/
func ReportCacheWarmClient(w http.ResponseWriter, r *http.Request) {
	if !reportcache.Get().Enabled() {
		fail(w, 422, "The cache is not connected — save a working Redis address first")
		return
	}

	var in struct {
		ClientIDs []string `json:"clientIds"`
		Days      int      `json:"days"`
	}
	json.NewDecoder(r.Body).Decode(&in)

	clients := []string{}
	for _, c := range in.ClientIDs {
		if c = strings.TrimSpace(c); c != "" {
			clients = append(clients, c)
		}
	}
	if len(clients) == 0 {
		fail(w, 422, "Pick at least one client")
		return
	}
	days, err := handlers.ValidWarmDays(in.Days)
	if err != nil {
		fail(w, 422, err.Error())
		return
	}

	log.Printf("[report-cache] on-demand warm for %d client(s) over %d day(s) requested by %s",
		len(clients), days, adminName(r))

	// context.Background(), not the request's: the work outlives the response
	// by design, and a request-scoped context is cancelled the moment it is
	// written — which would stop the pass at the first job every time.
	go handlers.WarmClients(context.Background(), handlers.WarmRequest{ClientIDs: clients, Days: days})

	ok(w, map[string]any{
		"success": true, "started": true,
		"reports": len(clients) * handlers.WarmPlatformCount(),
	})
}

/*
POST /api/admin/report-cache/warm — force a pass now.

Answers immediately and does the work in the background: a full pass is minutes
of warehouse queries, and an HTTP request that waits for it will time out and
leave the caller unsure whether it ran.
*/
func ReportCacheWarm(w http.ResponseWriter, r *http.Request) {
	if !reportcache.Get().Enabled() {
		fail(w, 422, "The cache is not connected — save a working Redis address first")
		return
	}
	go reportcache.GetWarmer().RunOnce(context.Background())
	log.Printf("[report-cache] manual warm requested by %s", adminName(r))
	ok(w, map[string]any{"success": true, "started": true})
}

/*
POST /api/admin/report-cache/sweep — free what earlier builds left behind.

Separate from Purge, and not the same act. Purge empties the cache the reports
are being served from and makes the next reader wait; this removes only entries
no running build can read, so nothing gets slower.

Deliberately a button rather than something done at startup: during a rolling
deploy the previous container is still serving, and deleting its working set
would send live requests cold. The operator knows whether it has stopped.
*/
func ReportCacheSweep(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	n, err := reportcache.Get().Sweep(ctx, true)
	if err != nil {
		fail(w, 502, err.Error())
		return
	}
	log.Printf("[report-cache] swept %d earlier-build entrie(s) by %s", n, adminName(r))
	ok(w, map[string]any{"success": true, "removed": n})
}

// POST /api/admin/report-cache/purge — drop every cached report.
// Emptying the cache also forgets the recorded misses: every entry is about to
// be a miss, and keeping the old list would mix the two.
func ReportCachePurge(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	n, err := reportcache.Get().Purge(ctx)
	if err != nil {
		fail(w, 502, err.Error())
		return
	}
	/* The recorded misses go with the entries. Everything just became a miss, so
	   a list gathered against the old contents would be read as evidence about
	   the new ones — and the first thing an operator does after emptying the
	   cache is watch that list to see what gets asked for. */
	reportcache.Get().ForgetMisses()
	log.Printf("[report-cache] purged %d entrie(s) by %s", n, adminName(r))
	ok(w, map[string]any{"success": true, "removed": n})
}
