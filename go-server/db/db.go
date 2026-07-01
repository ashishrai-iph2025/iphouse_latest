package db

import (
	"database/sql"
	"fmt"
	"log"
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
	dsn := fmt.Sprintf("%s:%s@tcp(%s:%s)/%s?parseTime=true&loc=Asia%%2FKolkata&charset=utf8mb4",
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
func Exec(sqlStr string, args ...any) (int64, int64, error) {
	db := Get()
	res, err := db.Exec(sqlStr, args...)
	if err != nil {
		return 0, 0, err
	}
	lid, _ := res.LastInsertId()
	aff, _ := res.RowsAffected()
	return lid, aff, nil
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
