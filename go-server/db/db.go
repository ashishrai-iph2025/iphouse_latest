package db

import (
	"database/sql"
	"fmt"
	"log"
	"strings"
	"sync"

	_ "github.com/go-sql-driver/mysql"
	"github.com/ip-house/iphouse-api/config"
)

var (
	pool *sql.DB
	mu   sync.Mutex
)

func Init() error {
	mu.Lock()
	defer mu.Unlock()
	var err error
	pool, err = newPool()
	if err != nil {
		return err
	}
	log.Printf("[db] Connected to %s/%s", config.C.DBHost, config.C.DBName)
	return nil
}

func newPool() (*sql.DB, error) {
	// loc=UTC matches the DB server's own system time zone (confirmed via
	// NOW() == UTC_TIMESTAMP() on the server) — every DATETIME/TIMESTAMP value
	// read into a Go time.Time is tagged with this location. It previously said
	// Asia/Kolkata, which mistagged already-UTC values as IST on every read
	// (5.5h skew) and would have written explicit time.Time params in IST wall
	// clock into columns everything else assumes are UTC.
	dsn := fmt.Sprintf("%s:%s@tcp(%s:%s)/%s?parseTime=true&loc=UTC&charset=utf8mb4",
		config.C.DBUser, config.C.DBPass, config.C.DBHost, config.C.DBPort, config.C.DBName)
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(3)
	return db, db.Ping()
}

func Get() *sql.DB {
	mu.Lock()
	defer mu.Unlock()
	return pool
}

// Query runs a SELECT and returns rows as a slice of maps.
func Query(sqlStr string, args ...any) ([]map[string]any, error) {
	db := Get()
	rows, err := db.Query(sqlStr, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanRows(rows)
}

// QueryOne returns the first row or nil.
func QueryOne(sqlStr string, args ...any) (map[string]any, error) {
	rows, err := Query(sqlStr, args...)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	return rows[0], nil
}

// Exec runs an INSERT/UPDATE/DELETE and returns lastInsertId and rowsAffected.
//
// Every failure is logged here, unconditionally. Many call sites historically
// discarded the returned error and reported success to the user anyway, so a
// rejected write (e.g. "Data too long for column") looked like a successful
// save. Callers should still check the error — MustExec below makes that the
// easy path — but this guarantees a failure is never completely silent.
func Exec(sqlStr string, args ...any) (int64, int64, error) {
	db := Get()
	res, err := db.Exec(sqlStr, args...)
	if err != nil {
		log.Printf("[db] EXEC FAILED: %v | sql=%s", err, truncateSQL(sqlStr))
		return 0, 0, err
	}
	lid, _ := res.LastInsertId()
	aff, _ := res.RowsAffected()
	return lid, aff, nil
}

// MustExec runs a write and reports whether it succeeded. Use it in handlers so
// a failed write can be surfaced to the caller instead of being reported as a
// success. Arguments are never logged (they carry credentials/PII).
func MustExec(sqlStr string, args ...any) error {
	_, _, err := Exec(sqlStr, args...)
	return err
}

// truncateSQL keeps the log readable and avoids dumping huge statements.
func truncateSQL(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > 160 {
		return s[:160] + "…"
	}
	return s
}

// Migrate ensures required tables exist. Safe to run on every startup.
func Migrate() {
	_, _, err := Exec(`CREATE TABLE IF NOT EXISTS dcp_password_resets (
		id         INT AUTO_INCREMENT PRIMARY KEY,
		userId     INT          NOT NULL,
		token      VARCHAR(128) NOT NULL UNIQUE,
		expires_at DATETIME     NOT NULL,
		used       TINYINT(1)   NOT NULL DEFAULT 0,
		created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
		INDEX idx_token (token),
		INDEX idx_userId (userId)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
	if err != nil {
		log.Printf("[db] migrate dcp_password_resets: %v", err)
	} else {
		log.Printf("[db] migrate: dcp_password_resets OK")
	}
	// A reset token must remember WHICH table it targets. Portal staff
	// (Admin/Super Admin) authenticate against dcp_super_admin.password_hash,
	// clients against dcp_user_login.login_password — the userId column alone
	// can't tell them apart, so a staff reset was silently writing to the wrong
	// table. 'login' (client) is the default for any pre-existing row.
	addColumnIfMissing("dcp_password_resets", "account_type", "VARCHAR(20) NOT NULL DEFAULT 'login'")

	// Global key/value settings (maintenance mode + message, and any other
	// app-wide flag). Read/written by the Settings and Maintenance handlers, but
	// the table was never created by the app — on an environment where it was
	// missing, the maintenance-mode upsert failed ("Table doesn't exist"), which
	// only became visible once write errors stopped being swallowed. The UNIQUE
	// key on `key` is required for the handlers' ON DUPLICATE KEY UPDATE upsert.
	_, _, err = Exec("CREATE TABLE IF NOT EXISTS dcp_settings (" +
		"id    INT AUTO_INCREMENT PRIMARY KEY," +
		"`key` VARCHAR(128) NOT NULL," +
		"`value` TEXT," +
		"UNIQUE KEY uniq_key (`key`)" +
		") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4")
	if err != nil {
		log.Printf("[db] migrate dcp_settings: %v", err)
	} else {
		log.Printf("[db] migrate: dcp_settings OK")
	}

	// AWS credentials for the S3 database-backup feature. Access key id and
	// secret are stored AES-256-CBC encrypted (same as every other stored
	// credential); region and S3 target are plain. Single active row.
	_, _, err = Exec("CREATE TABLE IF NOT EXISTS aws_credentials (" +
		"id INT AUTO_INCREMENT PRIMARY KEY," +
		"access_key_id VARCHAR(512)," +
		"secret_access_key VARCHAR(512)," +
		"region VARCHAR(64)," +
		"s3_uri VARCHAR(255)," +
		"updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP" +
		") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4")
	if err != nil {
		log.Printf("[db] migrate aws_credentials: %v", err)
	} else {
		log.Printf("[db] migrate: aws_credentials OK")
	}

	// Amazon SES credentials for outbound email. Kept separate from
	// aws_credentials (S3 backups) since it's a distinct integration that may use
	// a scoped-down IAM user; access key id and secret are AES-256-CBC encrypted.
	// Sending only switches over to SES once is_active=1 — until then the
	// existing SMTP path (master_email_credentials / env SMTP_*) keeps working
	// unchanged, so SES can be configured ahead of the cutover.
	_, _, err = Exec("CREATE TABLE IF NOT EXISTS ses_credentials (" +
		"id INT AUTO_INCREMENT PRIMARY KEY," +
		"access_key_id VARCHAR(512)," +
		"secret_access_key VARCHAR(512)," +
		"region VARCHAR(64)," +
		"from_email VARCHAR(255)," +
		"from_name VARCHAR(255)," +
		"is_active TINYINT(1) NOT NULL DEFAULT 0," +
		"updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP" +
		") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4")
	if err != nil {
		log.Printf("[db] migrate ses_credentials: %v", err)
	} else {
		log.Printf("[db] migrate: ses_credentials OK")
	}

	// Automatic database-backup schedule (in-app cron). Single row (id=1); also
	// holds the outcome of the most recent backup, manual or scheduled.
	_, _, err = Exec("CREATE TABLE IF NOT EXISTS backup_schedule (" +
		"id INT NOT NULL PRIMARY KEY," +
		"enabled TINYINT(1) NOT NULL DEFAULT 0," +
		"cron_expr VARCHAR(120) NOT NULL DEFAULT '0 2 * * *'," +
		"last_run_at DATETIME NULL," +
		"last_status VARCHAR(20) NULL," +
		"last_file VARCHAR(255) NULL," +
		"last_error TEXT NULL," +
		"updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP" +
		") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4")
	if err != nil {
		log.Printf("[db] migrate backup_schedule: %v", err)
	} else {
		log.Printf("[db] migrate: backup_schedule OK")
	}

	// Per-admin-login Configuration-module access. Grant-based (default deny):
	// only shared modules (granted = 1) are stored, so an admin login sees only
	// the modules a Super Admin explicitly shares with it. Keyed by loginId so
	// separate logins under the same account can have different access.
	_, _, err = Exec(`CREATE TABLE IF NOT EXISTS dcp_admin_config_access (
		id         INT AUTO_INCREMENT PRIMARY KEY,
		loginId    INT          NOT NULL,
		module_key VARCHAR(64)  NOT NULL,
		granted    TINYINT(1)   NOT NULL DEFAULT 1,
		updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
		UNIQUE KEY uniq_login_module (loginId, module_key),
		INDEX idx_loginId (loginId)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
	if err != nil {
		log.Printf("[db] migrate dcp_admin_config_access: %v", err)
	} else {
		log.Printf("[db] migrate: dcp_admin_config_access OK")
	}
	// Transitional: the first version of this table keyed on userId. Rename the
	// column to loginId if that older shape is present (errors harmlessly once
	// already renamed or on a fresh install).
	if _, _, aerr := Exec("ALTER TABLE dcp_admin_config_access CHANGE COLUMN userId loginId INT NOT NULL"); aerr == nil {
		log.Printf("[db] migrate: dcp_admin_config_access userId→loginId renamed")
	}

	// dcp_user_login had no timestamp columns at all in production — logins
	// could be created or edited with no record of when. Both are stamped
	// explicitly by the application (UTC_TIMESTAMP()) on every insert/update
	// rather than relying on a column DEFAULT, so the value is correct
	// regardless of the connection's or server's time zone configuration.
	addColumnIfMissing("dcp_user_login", "created_at", "DATETIME NULL")
	addColumnIfMissing("dcp_user_login", "updated_at", "DATETIME NULL")

	// dcp_user (client companies) has createdOn but never had an update
	// timestamp — same gap as dcp_user_login, same fix.
	addColumnIfMissing("dcp_user", "updated_at", "DATETIME NULL")

	// api_user_name/api_password hold AES+base64 ciphertext (~80–110 chars for
	// typical inputs). Older production schemas used VARCHAR(100), which made
	// credential updates fail under STRICT_TRANS_TABLES ("Data too long") once
	// the plaintext reached 32 chars. Idempotent and instant on MySQL 8.
	if _, _, aerr := Exec("ALTER TABLE dcp_user MODIFY api_user_name VARCHAR(255) NULL, MODIFY api_password VARCHAR(255) NULL"); aerr != nil {
		log.Printf("[db] migrate dcp_user api credential columns: %v", aerr)
	} else {
		log.Printf("[db] migrate: dcp_user api credential columns at VARCHAR(255)")
	}

	// Unify dcp_super_admin into the master portal-staff table: an "Admin" or
	// "SuperAdmin" tier is stored here (not just the original hand-seeded
	// Super Admin row). userId/loginId link a mirrored row back to the real
	// dcp_user / dcp_user_login account so existing loginId-keyed features
	// (e.g. Configuration Access) keep working when that person logs in
	// through this table. twofa_code(_expires) let these accounts use OTP
	// login the same way client accounts already do.
	addColumnIfMissing("dcp_super_admin", "role", "VARCHAR(20) NOT NULL DEFAULT 'SuperAdmin'")
	addColumnIfMissing("dcp_super_admin", "userId", "INT NULL")
	addColumnIfMissing("dcp_super_admin", "loginId", "INT NULL")
	addColumnIfMissing("dcp_super_admin", "twofa_code", "VARCHAR(10) NULL")
	addColumnIfMissing("dcp_super_admin", "twofa_code_expires", "DATETIME NULL")
	// Per-staff OTP login: each Admin/Super Admin can independently require an
	// email OTP after their password (default off). Managed per row on the
	// Super Admin Control → Admins & Super Admins tab.
	addColumnIfMissing("dcp_super_admin", "otp_login_enabled", "TINYINT(1) NOT NULL DEFAULT 0")
	addIndexIfMissing("dcp_super_admin", "idx_super_admin_userId", "INDEX idx_super_admin_userId (userId)")
	addIndexIfMissing("dcp_super_admin", "uniq_super_admin_email", "UNIQUE KEY uniq_super_admin_email (email)")
}

// addColumnIfMissing runs an ALTER TABLE ADD COLUMN only when the column does
// not already exist, so Migrate stays idempotent across every server restart
// without relying on "ADD COLUMN IF NOT EXISTS" (not supported on all MySQL
// versions this app may run against).
func addColumnIfMissing(table, column, ddl string) {
	row, err := QueryOne(`
		SELECT COUNT(*) AS c FROM information_schema.columns
		WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, table, column)
	if err != nil {
		log.Printf("[db] migrate: check column %s.%s failed: %v", table, column, err)
		return
	}
	if row != nil && countVal(row["c"]) > 0 {
		return
	}
	if _, _, err := Exec("ALTER TABLE " + table + " ADD COLUMN " + column + " " + ddl); err != nil {
		log.Printf("[db] migrate: add column %s.%s failed: %v", table, column, err)
		return
	}
	log.Printf("[db] migrate: %s.%s added", table, column)
}

// addIndexIfMissing mirrors addColumnIfMissing for indexes/unique keys.
func addIndexIfMissing(table, indexName, ddl string) {
	row, err := QueryOne(`
		SELECT COUNT(*) AS c FROM information_schema.statistics
		WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`, table, indexName)
	if err != nil {
		log.Printf("[db] migrate: check index %s.%s failed: %v", table, indexName, err)
		return
	}
	if row != nil && countVal(row["c"]) > 0 {
		return
	}
	if _, _, err := Exec("ALTER TABLE " + table + " ADD " + ddl); err != nil {
		log.Printf("[db] migrate: add index %s.%s failed: %v", table, indexName, err)
		return
	}
	log.Printf("[db] migrate: %s.%s added", table, indexName)
}

// countVal reads a COUNT(*) result regardless of which numeric Go type the
// MySQL driver chose to represent it as.
func countVal(v any) int64 {
	switch t := v.(type) {
	case int64:
		return t
	case float64:
		return int64(t)
	case int:
		return int64(t)
	}
	return 0
}

func scanRows(rows *sql.Rows) ([]map[string]any, error) {
	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	var result []map[string]any
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		row := make(map[string]any, len(cols))
		for i, col := range cols {
			v := vals[i]
			if b, ok := v.([]byte); ok {
				row[col] = string(b)
			} else {
				row[col] = v
			}
		}
		result = append(result, row)
	}
	return result, rows.Err()
}
