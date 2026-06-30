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
