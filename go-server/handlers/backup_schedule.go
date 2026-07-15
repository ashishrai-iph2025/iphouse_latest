package handlers

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/ip-house/iphouse-api/db"
	"github.com/robfig/cron/v3"
)

// In-app backup scheduler. Instead of a host crontab + shell script (which
// doesn't fit a container whose database lives elsewhere), the schedule lives
// in the database and a background goroutine runs the self-contained Go backup
// when due. The page shows enabled/next-run/last-run so the "cron status" is
// always visible.

// cronParser accepts standard 5-field cron expressions ("min hour dom mon dow").
var cronParser = cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow)

type scheduleRow struct {
	enabled   bool
	cronExpr  string
	lastRunAt string
	lastStat  string
	lastFile  string
	lastErr   string
}

func loadSchedule() scheduleRow {
	s := scheduleRow{cronExpr: "0 2 * * *"}
	row, _ := db.QueryOne("SELECT enabled, cron_expr, last_run_at, last_status, last_file, last_error FROM backup_schedule WHERE id = 1")
	if row == nil {
		return s
	}
	s.enabled = intFromAny(row["enabled"]) == 1
	if c := strFromAny(row["cron_expr"]); c != "" {
		s.cronExpr = c
	}
	s.lastRunAt = strFromAny(row["last_run_at"])
	s.lastStat = strFromAny(row["last_status"])
	s.lastFile = strFromAny(row["last_file"])
	s.lastErr = strFromAny(row["last_error"])
	return s
}

// GET/POST /api/admin/backup/schedule
func BackupSchedule(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s := loadSchedule()
		resp := map[string]any{
			"success":   true,
			"enabled":   s.enabled,
			"cronExpr":  s.cronExpr,
			"lastRunAt": s.lastRunAt,
			"lastStatus": s.lastStat,
			"lastFile":  s.lastFile,
			"lastError": s.lastErr,
		}
		if sched, err := cronParser.Parse(s.cronExpr); err == nil {
			resp["nextRun"] = sched.Next(time.Now()).UTC().Format(time.RFC3339)
		}
		OK(w, resp)

	case http.MethodPost:
		var body struct {
			Enabled  bool   `json:"enabled"`
			CronExpr string `json:"cronExpr"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		body.CronExpr = strings.TrimSpace(body.CronExpr)
		if body.CronExpr == "" {
			body.CronExpr = "0 2 * * *"
		}
		if _, err := cronParser.Parse(body.CronExpr); err != nil {
			Fail(w, 422, "Invalid schedule expression. Use a 5-field cron, e.g. \"0 2 * * *\" for daily at 02:00."); return
		}
		v := 0
		if body.Enabled {
			v = 1
		}
		if err := db.MustExec(`INSERT INTO backup_schedule (id, enabled, cron_expr) VALUES (1, ?, ?)
			ON DUPLICATE KEY UPDATE enabled=?, cron_expr=?`, v, body.CronExpr, v, body.CronExpr); err != nil {
			Fail(w, 500, "Could not save the schedule"); return
		}
		OK(w, map[string]any{"success": true})

	default:
		Fail(w, 405, "Method not allowed")
	}
}

// StartBackupScheduler launches the background loop. Called once at startup.
func StartBackupScheduler() {
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()

		var activeExpr string
		var next time.Time

		for range ticker.C {
			s := loadSchedule()
			if !s.enabled {
				activeExpr = "" // reset so the next enable recomputes cleanly
				continue
			}
			sched, err := cronParser.Parse(s.cronExpr)
			if err != nil {
				continue
			}
			// (Re)anchor whenever the expression changes or on first activation —
			// so enabling never triggers an immediate run.
			if s.cronExpr != activeExpr {
				activeExpr = s.cronExpr
				next = sched.Next(time.Now())
				continue
			}
			if time.Now().Before(next) {
				continue
			}
			next = sched.Next(time.Now())

			if !backupMu.TryLock() {
				continue // a manual/previous backup is still running; try next tick
			}
			func() {
				defer backupMu.Unlock()
				ctx, cancel := context.WithTimeout(context.Background(), 25*time.Minute)
				defer cancel()
				if _, _, _, err := performBackup(ctx, "scheduled"); err != nil {
					log.Printf("[backup] scheduled run failed: %v", err)
				}
			}()
		}
	}()
	log.Printf("[backup] scheduler started")
}
