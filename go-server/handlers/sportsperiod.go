package handlers

/*
The reporting period the sports reports are bound to.

A sports report is not a live feed the way the others are. Its data is loaded
for a season, a tournament, or a contracted term, and outside that term the
tables hold either nothing or the leftovers of the term before. A reader given a
free calendar over that will happily pick a range that predates the data and
read the empty result as "nothing was found" — a very different and much more
alarming statement than "you are looking outside the period".

So one period is configured — a start and an end — and the sports reports are
held inside it. Two halves, and both are needed:

  - The CALENDAR is clamped to it, so the range cannot be set outside the period
    in the first place. That is the half a reader experiences.

  - The QUERY is clamped to it here, on every request, whatever the browser
    asked for. That is the half that makes it true: a saved filter, a pasted
    URL, a stale tab left open across a configuration change, or a request typed
    by hand all arrive with dates nobody clamped.

Only the sports reports. Everything else keeps the open calendar it has always
had — this is a statement about where the sports DATA lives, not a policy about
how far back anyone may look.
*/

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/ip-house/iphouse-api/db"
)

const (
	sportsPeriodTable = "report_sports_period"
	// Per-client overrides. A separate table rather than a client column on the
	// one above, because the default is genuinely a different thing: exactly one
	// of it, always present, and every client falls back to it. Folding both
	// into one table means a sentinel client id standing for "everyone", and a
	// sentinel that is also a valid-looking id is the kind of key that ends up
	// matched by accident.
	sportsPeriodClientTable = "report_sports_period_client"
)

// The default row is a singleton. A fixed key rather than an empty table, so
// the upsert below has something to conflict on.
const sportsPeriodRowID = 1

const ymdLayout = "2006-01-02"

var sportsPeriodOnce sync.Once

func ensureSportsPeriodSchema() {
	sportsPeriodOnce.Do(func() {
		if _, _, err := db.Exec(`
			CREATE TABLE IF NOT EXISTS ` + sportsPeriodTable + ` (
			  id          TINYINT      NOT NULL PRIMARY KEY,
			  is_enabled  TINYINT(1)   NOT NULL DEFAULT 0,
			  start_date  DATE         NULL,
			  end_date    DATE         NULL,
			  start_mode  VARCHAR(8)   NOT NULL DEFAULT 'month',
			  end_mode    VARCHAR(8)   NOT NULL DEFAULT 'month',
			  updated_by  VARCHAR(191) NOT NULL DEFAULT '',
			  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`); err != nil {
			log.Printf("[sports-period] create %s: %v", sportsPeriodTable, err)
		}
		/* Keyed by the REPORTING client id — the warehouse's own id, which is
		   what reportScope resolves a login to and therefore the only id the
		   query path has in its hand. Keying on the portal user id instead
		   would need a second lookup at exactly the point where the period has
		   to be cheap, and would break the moment two portal logins map to one
		   reporting client. */
		if _, _, err := db.Exec(`
			CREATE TABLE IF NOT EXISTS ` + sportsPeriodClientTable + ` (
			  client_id   VARCHAR(64)  NOT NULL PRIMARY KEY,
			  is_enabled  TINYINT(1)   NOT NULL DEFAULT 1,
			  start_date  DATE         NULL,
			  end_date    DATE         NULL,
			  start_mode  VARCHAR(8)   NOT NULL DEFAULT 'month',
			  end_mode    VARCHAR(8)   NOT NULL DEFAULT 'month',
			  updated_by  VARCHAR(191) NOT NULL DEFAULT '',
			  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`); err != nil {
			log.Printf("[sports-period] create %s: %v", sportsPeriodClientTable, err)
		}
	})
}

/*
sportsPeriodConfig is the configured window.

StartMode/EndMode record how the admin ENTERED each end — a whole month, or an
exact day. The dates are stored resolved either way, so nothing downstream has
to care; the modes exist only so the configuration screen can offer back the
control that was used, rather than turning "January 2025" into "2025-01-01" the
moment it is saved and reloaded.
*/
type sportsPeriodConfig struct {
	Enabled   bool   `json:"enabled"`
	Start     string `json:"start"`     // YYYY-MM-DD, inclusive
	End       string `json:"end"`       // YYYY-MM-DD, inclusive
	StartMode string `json:"startMode"` // "month" | "date"
	EndMode   string `json:"endMode"`
	UpdatedBy string `json:"updatedBy,omitempty"`
	UpdatedAt string `json:"updatedAt,omitempty"`
}

/*
active reports whether this period should actually constrain anything.

A half-filled row constrains nothing. A window with one end missing is not a
window, and treating it as one would clamp every sports report to a boundary
nobody finished setting — which reads on the page as data that has gone missing.
*/
func (p sportsPeriodConfig) active() bool {
	return p.Enabled && p.Start != "" && p.End != "" && p.Start <= p.End
}

func loadSportsPeriod() sportsPeriodConfig {
	ensureSportsPeriodSchema()
	row, err := db.QueryOne(
		"SELECT is_enabled, start_date, end_date, start_mode, end_mode, updated_by, updated_at FROM "+
			sportsPeriodTable+" WHERE id = ? LIMIT 1", sportsPeriodRowID)
	if err != nil {
		/* Fail OPEN, and say so in the log.

		   A period that cannot be read must not clamp every sports report to an
		   empty window: that failure presents as "the sports data is gone",
		   which sends someone to look at the warehouse rather than at this
		   table. An unreadable period is no period. */
		log.Printf("[sports-period] read: %v", err)
		return sportsPeriodConfig{}
	}
	if row == nil {
		return sportsPeriodConfig{}
	}
	return scanPeriod(row)
}

// scanPeriod turns one row of either table into a config. Shared so the default
// and an override cannot drift in how they are read.
func scanPeriod(row map[string]any) sportsPeriodConfig {
	return sportsPeriodConfig{
		Enabled:   numOf(row["is_enabled"]) == 1,
		Start:     dateOnly(row["start_date"]),
		End:       dateOnly(row["end_date"]),
		StartMode: periodMode(strFromAny(row["start_mode"])),
		EndMode:   periodMode(strFromAny(row["end_mode"])),
		UpdatedBy: strFromAny(row["updated_by"]),
		UpdatedAt: strFromAny(row["updated_at"]),
	}
}

const periodCols = "is_enabled, start_date, end_date, start_mode, end_mode, updated_by, updated_at"

/*
clientSportsPeriod reads one client's override, if it has one.

The bool is the whole point and is NOT the same as `active()`. Three states, and
they are all reachable on purpose:

  - no row        → this client follows the default
  - row, enabled  → this client has its own window
  - row, disabled → this client has NO period, whatever the default says

Without the third there would be no way to exempt a single client from a default
that applies to everyone else, and "exempt this one" is the reason per-client
settings get asked for in the first place.
*/
func clientSportsPeriod(clientID string) (sportsPeriodConfig, bool) {
	clientID = strings.TrimSpace(clientID)
	if clientID == "" {
		return sportsPeriodConfig{}, false
	}
	ensureSportsPeriodSchema()
	row, err := db.QueryOne(
		"SELECT "+periodCols+" FROM "+sportsPeriodClientTable+" WHERE client_id = ? LIMIT 1", clientID)
	if err != nil {
		// Fail open, exactly as the default does: an unreadable override falls
		// back rather than inventing a window.
		log.Printf("[sports-period] read override for %s: %v", clientID, err)
		return sportsPeriodConfig{}, false
	}
	if row == nil {
		return sportsPeriodConfig{}, false
	}
	return scanPeriod(row), true
}

/*
resolveSportsPeriod is the one answer to "which window governs this client".

Every read path goes through here so the precedence is stated once. A client's
own row wins outright — including a disabled one, which is how a client is
exempted — and everything else falls to the default.
*/
func resolveSportsPeriod(clientID string) sportsPeriodConfig {
	if p, ok := clientSportsPeriod(clientID); ok {
		return p
	}
	return loadSportsPeriod()
}

// listClientSportsPeriods reads every override, for the configuration screen.
func listClientSportsPeriods() []map[string]any {
	ensureSportsPeriodSchema()
	rows, err := db.Query("SELECT client_id, " + periodCols + " FROM " + sportsPeriodClientTable + " ORDER BY client_id")
	if err != nil {
		log.Printf("[sports-period] list overrides: %v", err)
		return []map[string]any{}
	}
	out := make([]map[string]any, 0, len(rows))
	for _, r := range rows {
		p := scanPeriod(r)
		out = append(out, map[string]any{
			"clientId": strFromAny(r["client_id"]),
			"enabled":  p.Enabled, "start": p.Start, "end": p.End,
			"startMode": p.StartMode, "endMode": p.EndMode,
			"updatedBy": p.UpdatedBy, "updatedAt": p.UpdatedAt,
		})
	}
	return out
}

func periodMode(v string) string {
	if strings.TrimSpace(strings.ToLower(v)) == "date" {
		return "date"
	}
	return "month"
}

// dateOnly reduces whatever the driver hands back for a DATE column to
// YYYY-MM-DD. Depending on the connection that is a time.Time, a []byte, or a
// string already carrying a midnight time part.
func dateOnly(v any) string {
	if t, ok := v.(time.Time); ok {
		return t.Format(ymdLayout)
	}
	s := strings.TrimSpace(strFromAny(v))
	if len(s) >= 10 {
		s = s[:10]
	}
	if _, err := time.Parse(ymdLayout, s); err != nil {
		return ""
	}
	return s
}

/*
── Which reports the period governs ─────────────────────────────────────────

	Read off the TABLES a platform reads, not off its name. A label is free text
	an admin can change at will — renaming "Open Web - Sports" to "Open Web
	(2025 season)" must not quietly release it from the period — while the
	tables are what actually decide which rows the report contains, and the
	warehouse spells "Sports" in every one of their names.

	The key and label are still consulted, for the one platform the table test
	cannot answer: the Sports Summary holds no tables of its own and reads
	whatever the platforms it covers read.
*/
func isSportsPlatform(p platformDef) bool {
	if containsFold(p.Key, "sports") || containsFold(p.Label, "sports") {
		return true
	}
	for _, t := range p.Tables {
		if containsFold(t, "sports") {
			return true
		}
	}
	return false
}

func containsFold(hay, needle string) bool {
	return strings.Contains(strings.ToLower(hay), needle)
}

/*
clampToSportsPeriod holds a request's window inside the configured period.

BOTH ends are pulled into the period, not only the one that sticks out, which is
what makes the result always a valid window inside it. A request that does not
overlap the period at all therefore collapses onto the nearest boundary — a day
of real data rather than an empty report, which is the more readable of the two
answers to "you asked outside the period", and which a clamped calendar cannot
produce in the first place.

An absent end is filled from the period rather than left alone. specWhere
applies its date filter only when BOTH ends are present, so an empty one would
have been a way to read the whole table by simply not sending a date.

Reports whether anything moved, so the caller can tell the page its window was
adjusted instead of quietly showing a different range than the one it asked for.
*/
func clampToSportsPeriod(q map[string]string, p sportsPeriodConfig) bool {
	if !p.active() {
		return false
	}
	wasFrom, wasTo := strings.TrimSpace(q["from"]), strings.TrimSpace(q["to"])

	from, to := wasFrom, wasTo
	if from == "" {
		from = p.Start
	}
	if to == "" {
		to = p.End
	}
	// ISO dates compare correctly as strings, which is the whole reason this
	// codebase passes them around in that form.
	into := func(d string) string {
		if d < p.Start {
			return p.Start
		}
		if d > p.End {
			return p.End
		}
		return d
	}
	from, to = into(from), into(to)
	// A window handed in backwards stays backwards after clamping, and BETWEEN
	// would then return nothing while looking like a real answer.
	if from > to {
		from, to = to, from
	}
	q["from"], q["to"] = from, to
	return from != wasFrom || to != wasTo
}

/*
sportsPeriodFor returns the period governing a platform for one client.

The one place that decides all three questions together — is this a sports
report, does this client have a window of its own, and is that window usable —
so a caller cannot get the platform test right and the precedence wrong.
*/
func sportsPeriodFor(p platformDef, clientID string) (sportsPeriodConfig, bool) {
	if !isSportsPlatform(p) {
		return sportsPeriodConfig{}, false
	}
	cfg := resolveSportsPeriod(clientID)
	return cfg, cfg.active()
}

/*
── GET /api/admin/report-sports-period ─────────────────────────────────────

	The default and every override in one answer. The screen shows them
	together — an override only means anything beside the default it replaces —
	and two endpoints would be two chances to render a stale half.

	Client NAMES are not resolved here. The configuration screen already holds
	the warehouse client directory for its own picker, and resolving names on
	this path would put a warehouse round-trip behind a settings read.
*/
func SportsPeriodGet(w http.ResponseWriter, r *http.Request) {
	OK(w, map[string]any{
		"success": true,
		"period":  loadSportsPeriod(),
		"clients": listClientSportsPeriods(),
	})
}

/*
── DELETE /api/admin/report-sports-period?clientId= ────────────────────────

	Removes an override, returning that client to the default. Distinct from
	saving it as disabled, which is how a client is exempted from the default
	entirely — see clientSportsPeriod.
*/
func SportsPeriodDelete(w http.ResponseWriter, r *http.Request) {
	ensureSportsPeriodSchema()
	clientID := strings.TrimSpace(r.URL.Query().Get("clientId"))
	if clientID == "" {
		Fail(w, 422, "Which client's period should be removed?")
		return
	}
	if _, _, err := db.Exec("DELETE FROM "+sportsPeriodClientTable+" WHERE client_id = ?", clientID); err != nil {
		log.Printf("[sports-period] delete override %s: %v", clientID, err)
		Fail(w, 500, "Could not remove this client's period")
		return
	}
	OK(w, map[string]any{
		"success": true,
		"period":  loadSportsPeriod(),
		"clients": listClientSportsPeriods(),
	})
}

/*
── PUT /api/admin/report-sports-period ─────────────────────────────────────

	start/end are YYYY-MM-DD. The screen sends a resolved date whichever control
	was used — a month picker resolves to the 1st and to the last day of that
	month — because a month is only shorthand for a pair of days, and the place
	to expand it is the one that knows which control the admin touched. The mode
	travels with it so the screen can offer that control again.
*/
func SportsPeriodSave(w http.ResponseWriter, r *http.Request) {
	ensureSportsPeriodSchema()

	var body struct {
		Enabled   bool   `json:"enabled"`
		Start     string `json:"start"`
		End       string `json:"end"`
		StartMode string `json:"startMode"`
		EndMode   string `json:"endMode"`
		/* Absent or empty writes the DEFAULT; a client id writes that client's
		   override. One endpoint because the two are the same record with the
		   same validation, and splitting them was two places to keep a rule in
		   step with itself. */
		ClientID string `json:"clientId"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	clientID := strings.TrimSpace(body.ClientID)

	start := strings.TrimSpace(body.Start)
	end := strings.TrimSpace(body.End)

	/* Dates are validated even when the period is being turned OFF, so a
	   disabled row still holds a window somebody can switch back on without
	   re-entering it. An empty pair is allowed only while disabled. */
	if body.Enabled && (start == "" || end == "") {
		Fail(w, 422, "A reporting period needs both a start and an end")
		return
	}
	for _, d := range []string{start, end} {
		if d == "" {
			continue
		}
		if _, err := time.Parse(ymdLayout, d); err != nil {
			Fail(w, 422, "Not a valid date: "+d)
			return
		}
	}
	if start != "" && end != "" && start > end {
		Fail(w, 422, "The period ends before it starts")
		return
	}

	who := ""
	if claims := ClaimsFrom(r); claims != nil {
		who = claims.LoginUsername
	}

	// NULL rather than "" for an unset end: the column is a DATE, and MySQL
	// reads an empty string there as the zero date rather than as absent.
	var startArg, endArg any
	if start != "" {
		startArg = start
	}
	if end != "" {
		endArg = end
	}

	enabled := 0
	if body.Enabled {
		enabled = 1
	}

	table, keyCol, keyVal := sportsPeriodTable, "id", any(sportsPeriodRowID)
	if clientID != "" {
		table, keyCol, keyVal = sportsPeriodClientTable, "client_id", any(clientID)
	}

	if _, _, err := db.Exec(`
		INSERT INTO `+table+`
		  (`+keyCol+`, is_enabled, start_date, end_date, start_mode, end_mode, updated_by)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
		  is_enabled=VALUES(is_enabled), start_date=VALUES(start_date),
		  end_date=VALUES(end_date), start_mode=VALUES(start_mode),
		  end_mode=VALUES(end_mode), updated_by=VALUES(updated_by)`,
		keyVal, enabled, startArg, endArg,
		periodMode(body.StartMode), periodMode(body.EndMode), who); err != nil {
		log.Printf("[sports-period] save (%s): %v", table, err)
		Fail(w, 500, "Could not save the sports reporting period")
		return
	}

	scopeName := "default"
	if clientID != "" {
		scopeName = "client " + clientID
	}
	log.Printf("[sports-period] %s set to %s..%s (enabled=%v) by %s", scopeName, start, end, body.Enabled, who)
	OK(w, map[string]any{
		"success": true,
		"period":  loadSportsPeriod(),
		"clients": listClientSportsPeriods(),
	})
}
