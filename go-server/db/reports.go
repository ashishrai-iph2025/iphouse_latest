package db

import (
	"database/sql"
	"fmt"
	"log"
	"os"
	"sync"
	"time"

	_ "github.com/go-sql-driver/mysql"
)

// Reports database — a SECOND, separate connection.
//
// The Reports pages read pre-aggregated analytics tables that live on their own
// MySQL server, not in the portal's own schema. Keeping it as a distinct pool
// rather than switching the main one means:
//
//   - the portal keeps working (login, notifications, config) if the analytics
//     server is unreachable; only the Reports pages degrade,
//   - the credentials can be read-only, which is all a report needs,
//   - a slow analytics query cannot exhaust the connections the portal itself
//     needs to serve a login.
//
// Configuration is env-only and never checked in. Set these in .env:
//
//	REPORTS_DB_HOST      (default 127.0.0.1)
//	REPORTS_DB_PORT      (default 3306)
//	REPORTS_DB_NAME      (default dashboards)
//	REPORTS_DB_USER
//	REPORTS_DB_PASS
//	REPORTS_DB_MAX_CONNS (default 6)
//
// The pool is built lazily on first use, so a portal deployment that does not
// use Reports needs no analytics credentials at all and logs nothing about them.

var (
	reportsPool *sql.DB
	reportsOnce sync.Once
	reportsErr  error
	reportsMu   sync.Mutex
)

// ReportsConfigured reports whether analytics credentials are present. Handlers
// use this to answer "not configured" cleanly instead of surfacing a driver
// error to the browser.
func ReportsConfigured() bool {
	return os.Getenv("REPORTS_DB_USER") != "" && os.Getenv("REPORTS_DB_HOST") != ""
}

// Reports returns the analytics pool, connecting on first call.
func Reports() (*sql.DB, error) {
	reportsOnce.Do(func() {
		host := envOr("REPORTS_DB_HOST", "127.0.0.1")
		port := envOr("REPORTS_DB_PORT", "3306")
		name := envOr("REPORTS_DB_NAME", "dashboards")
		user := os.Getenv("REPORTS_DB_USER")
		pass := os.Getenv("REPORTS_DB_PASS")

		if user == "" {
			reportsErr = fmt.Errorf("reports database is not configured — set REPORTS_DB_USER / REPORTS_DB_PASS / REPORTS_DB_HOST")
			return
		}

		// Same loc=UTC choice as the main pool: these tables carry DATE and
		// DATETIME columns, and tagging them with any other zone would shift
		// every day bucket in a report.
		dsn := fmt.Sprintf("%s:%s@tcp(%s:%s)/%s?parseTime=true&loc=UTC&charset=utf8mb4&timeout=10s&readTimeout=60s",
			user, pass, host, port, name)

		p, err := sql.Open("mysql", dsn)
		if err != nil {
			reportsErr = err
			return
		}
		// Deliberately smaller than the portal's own pool — report queries are
		// heavy scans, and a burst of them must not starve the analytics server.
		p.SetMaxOpenConns(envInt("REPORTS_DB_MAX_CONNS", 6))
		p.SetMaxIdleConns(2)
		p.SetConnMaxLifetime(30 * time.Minute)

		if err := p.Ping(); err != nil {
			// Left assigned: a report retries on the next request rather than
			// permanently disabling itself because the server blipped at boot.
			reportsErr = fmt.Errorf("reports database unreachable at %s:%s/%s: %w", host, port, name, err)
			reportsPool = p
			log.Printf("[reports-db] %v", reportsErr)
			return
		}
		reportsPool = p
		reportsErr = nil
		log.Printf("[reports-db] connected to %s:%s/%s (max %d conns)", host, port, name, envInt("REPORTS_DB_MAX_CONNS", 6))
	})

	reportsMu.Lock()
	defer reportsMu.Unlock()
	if reportsPool == nil {
		return nil, reportsErr
	}
	// A pool that failed its first Ping is still usable once the server is back,
	// so re-check rather than returning the stale boot-time error forever.
	if reportsErr != nil {
		if err := reportsPool.Ping(); err != nil {
			return nil, reportsErr
		}
		reportsErr = nil
		log.Printf("[reports-db] connection recovered")
	}
	return reportsPool, nil
}

// ReportsQuery runs a SELECT against the analytics pool and returns rows as maps,
// mirroring Query() on the main pool.
func ReportsQuery(sqlStr string, args ...any) ([]map[string]any, error) {
	p, err := Reports()
	if err != nil {
		return nil, err
	}
	rows, err := p.Query(sqlStr, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanRows(rows)
}

// ReportsQueryOne is ReportsQuery for a single expected row.
func ReportsQueryOne(sqlStr string, args ...any) (map[string]any, error) {
	rows, err := ReportsQuery(sqlStr, args...)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	return rows[0], nil
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	n := 0
	if _, err := fmt.Sscanf(v, "%d", &n); err != nil || n <= 0 {
		return def
	}
	return n
}
