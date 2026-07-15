package handlers

import (
	"bufio"
	"context"
	"database/sql"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/ip-house/iphouse-api/db"
)

// dumpDatabase writes a full, restorable SQL dump of dbName to w, using the
// application's own (already-authenticated) MySQL connection. This keeps the
// backup fully self-contained inside the container — no mysqldump binary, no
// aws CLI, no external tools — and works against an external MySQL server
// exactly the way the app already connects to it.
//
// The reads run inside a single REPEATABLE-READ consistent-snapshot
// transaction, giving the same point-in-time consistency as
// `mysqldump --single-transaction`.
func dumpDatabase(ctx context.Context, dbName string, w io.Writer) error {
	conn, err := db.Get().Conn(ctx)
	if err != nil {
		return fmt.Errorf("open connection: %w", err)
	}
	defer conn.Close()

	if _, err := conn.ExecContext(ctx, "USE `"+identEsc(dbName)+"`"); err != nil {
		return fmt.Errorf("select database %q: %w", dbName, err)
	}
	conn.ExecContext(ctx, "SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ")
	if _, err := conn.ExecContext(ctx, "START TRANSACTION WITH CONSISTENT SNAPSHOT"); err != nil {
		return fmt.Errorf("start snapshot: %w", err)
	}
	defer conn.ExecContext(ctx, "COMMIT")

	bw := bufio.NewWriterSize(w, 1<<20)

	fmt.Fprintf(bw, "-- IP House database backup\n-- Database: %s\n-- Generated (UTC): %s\n\n", dbName, time.Now().UTC().Format(time.RFC3339))
	fmt.Fprint(bw, "/*!40101 SET NAMES utf8mb4 */;\n")
	fmt.Fprint(bw, "SET FOREIGN_KEY_CHECKS=0;\nSET UNIQUE_CHECKS=0;\nSET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO';\n\n")

	// Enumerate base tables and views.
	type tbl struct{ name, kind string }
	var items []tbl
	rows, err := conn.QueryContext(ctx, "SHOW FULL TABLES")
	if err != nil {
		return fmt.Errorf("list tables: %w", err)
	}
	for rows.Next() {
		var name, kind string
		if err := rows.Scan(&name, &kind); err != nil {
			rows.Close()
			return err
		}
		items = append(items, tbl{name, kind})
	}
	rows.Close()

	// Base tables first (schema + data), then views (which may depend on tables).
	for _, it := range items {
		if !strings.EqualFold(it.kind, "VIEW") {
			if err := dumpTable(ctx, conn, it.name, bw); err != nil {
				return err
			}
		}
	}
	for _, it := range items {
		if strings.EqualFold(it.kind, "VIEW") {
			dumpView(ctx, conn, it.name, bw) // best-effort
		}
	}

	// Triggers, routines and events — best-effort (skipped silently if the
	// account lacks the privilege or none exist).
	dumpTriggers(ctx, conn, bw)
	dumpRoutines(ctx, conn, dbName, bw)
	dumpEvents(ctx, conn, dbName, bw)

	fmt.Fprint(bw, "\nSET SQL_MODE=@OLD_SQL_MODE;\nSET FOREIGN_KEY_CHECKS=1;\nSET UNIQUE_CHECKS=1;\n")
	return bw.Flush()
}

// identEsc escapes a backtick identifier (doubles any backtick).
func identEsc(s string) string { return strings.ReplaceAll(s, "`", "``") }

func dumpTable(ctx context.Context, conn *sql.Conn, table string, w *bufio.Writer) error {
	var name, createSQL string
	if err := conn.QueryRowContext(ctx, "SHOW CREATE TABLE `"+identEsc(table)+"`").Scan(&name, &createSQL); err != nil {
		return fmt.Errorf("show create table %q: %w", table, err)
	}
	fmt.Fprintf(w, "\n--\n-- Table structure for `%s`\n--\nDROP TABLE IF EXISTS `%s`;\n%s;\n\n", table, identEsc(table), createSQL)

	rows, err := conn.QueryContext(ctx, "SELECT * FROM `"+identEsc(table)+"`")
	if err != nil {
		return fmt.Errorf("read %q: %w", table, err)
	}
	defer rows.Close()

	cols, _ := rows.Columns()
	if len(cols) == 0 {
		return nil
	}
	colList := make([]string, len(cols))
	for i, c := range cols {
		colList[i] = "`" + identEsc(c) + "`"
	}
	insertPrefix := fmt.Sprintf("INSERT INTO `%s` (%s) VALUES ", identEsc(table), strings.Join(colList, ","))

	raw := make([]sql.RawBytes, len(cols))
	scan := make([]any, len(cols))
	for i := range raw {
		scan[i] = &raw[i]
	}

	const batch = 200
	inBatch := 0
	wroteAny := false
	for rows.Next() {
		if err := rows.Scan(scan...); err != nil {
			return err
		}
		if inBatch == 0 {
			w.WriteString(insertPrefix)
		} else {
			w.WriteByte(',')
		}
		w.WriteByte('(')
		for i, v := range raw {
			if i > 0 {
				w.WriteByte(',')
			}
			w.WriteString(sqlValue(v))
		}
		w.WriteByte(')')
		wroteAny = true
		inBatch++
		if inBatch >= batch {
			w.WriteString(";\n")
			inBatch = 0
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if inBatch > 0 {
		w.WriteString(";\n")
	}
	if wroteAny {
		w.WriteByte('\n')
	}
	return nil
}

func dumpView(ctx context.Context, conn *sql.Conn, view string, w *bufio.Writer) {
	// SHOW CREATE VIEW returns: View, Create View, character_set_client, collation_connection
	var name, createSQL, cs, col string
	if err := conn.QueryRowContext(ctx, "SHOW CREATE VIEW `"+identEsc(view)+"`").Scan(&name, &createSQL, &cs, &col); err != nil {
		return
	}
	fmt.Fprintf(w, "\n--\n-- View `%s`\n--\nDROP VIEW IF EXISTS `%s`;\n%s;\n", view, identEsc(view), createSQL)
}

func dumpTriggers(ctx context.Context, conn *sql.Conn, w *bufio.Writer) {
	rows, err := conn.QueryContext(ctx, "SHOW TRIGGERS")
	if err != nil {
		return
	}
	cols, _ := rows.Columns()
	var names []string
	for rows.Next() {
		vals := make([]sql.RawBytes, len(cols))
		scan := make([]any, len(cols))
		for i := range vals {
			scan[i] = &vals[i]
		}
		if rows.Scan(scan...) == nil && len(vals) > 0 {
			names = append(names, string(vals[0])) // Trigger name is the first column
		}
	}
	rows.Close()
	for _, n := range names {
		var tname, sqlMode, createSQL, cs, col, dbcol string
		if err := conn.QueryRowContext(ctx, "SHOW CREATE TRIGGER `"+identEsc(n)+"`").Scan(&tname, &sqlMode, &createSQL, &cs, &col, &dbcol); err == nil {
			fmt.Fprintf(w, "\nDROP TRIGGER IF EXISTS `%s`;\nDELIMITER ;;\n%s;;\nDELIMITER ;\n", identEsc(n), createSQL)
		}
	}
}

func dumpRoutines(ctx context.Context, conn *sql.Conn, dbName string, w *bufio.Writer) {
	for _, kind := range []string{"PROCEDURE", "FUNCTION"} {
		rows, err := conn.QueryContext(ctx, "SHOW "+kind+" STATUS WHERE Db = ?", dbName)
		if err != nil {
			continue
		}
		cols, _ := rows.Columns()
		var names []string
		nameIdx := 1 // Db, Name, ...
		for i, c := range cols {
			if strings.EqualFold(c, "Name") {
				nameIdx = i
			}
		}
		for rows.Next() {
			vals := make([]sql.RawBytes, len(cols))
			scan := make([]any, len(cols))
			for i := range vals {
				scan[i] = &vals[i]
			}
			if rows.Scan(scan...) == nil && nameIdx < len(vals) {
				names = append(names, string(vals[nameIdx]))
			}
		}
		rows.Close()
		for _, n := range names {
			// SHOW CREATE {PROCEDURE|FUNCTION}: Name, sql_mode, Create ..., cs, col, db_col
			var name, sqlMode, createSQL, cs, col, dbcol string
			if err := conn.QueryRowContext(ctx, "SHOW CREATE "+kind+" `"+identEsc(n)+"`").Scan(&name, &sqlMode, &createSQL, &cs, &col, &dbcol); err == nil && createSQL != "" {
				fmt.Fprintf(w, "\nDROP %s IF EXISTS `%s`;\nDELIMITER ;;\n%s;;\nDELIMITER ;\n", kind, identEsc(n), createSQL)
			}
		}
	}
}

func dumpEvents(ctx context.Context, conn *sql.Conn, dbName string, w *bufio.Writer) {
	rows, err := conn.QueryContext(ctx, "SHOW EVENTS WHERE Db = ?", dbName)
	if err != nil {
		return
	}
	cols, _ := rows.Columns()
	nameIdx := 1
	for i, c := range cols {
		if strings.EqualFold(c, "Name") {
			nameIdx = i
		}
	}
	var names []string
	for rows.Next() {
		vals := make([]sql.RawBytes, len(cols))
		scan := make([]any, len(cols))
		for i := range vals {
			scan[i] = &vals[i]
		}
		if rows.Scan(scan...) == nil && nameIdx < len(vals) {
			names = append(names, string(vals[nameIdx]))
		}
	}
	rows.Close()
	for _, n := range names {
		var name, sqlMode, tz, createSQL, cs, col, dbcol string
		if err := conn.QueryRowContext(ctx, "SHOW CREATE EVENT `"+identEsc(n)+"`").Scan(&name, &sqlMode, &tz, &createSQL, &cs, &col, &dbcol); err == nil && createSQL != "" {
			fmt.Fprintf(w, "\nDROP EVENT IF EXISTS `%s`;\nDELIMITER ;;\n%s;;\nDELIMITER ;\n", identEsc(n), createSQL)
		}
	}
}

// sqlValue renders a column value as a SQL literal. NULL stays NULL; every
// other value is emitted as a properly escaped quoted string (MySQL coerces it
// to the column type on restore), which safely handles numbers, dates and
// binary data alike.
func sqlValue(b sql.RawBytes) string {
	if b == nil {
		return "NULL"
	}
	var sb strings.Builder
	sb.Grow(len(b) + 2)
	sb.WriteByte('\'')
	for _, c := range b {
		switch c {
		case 0:
			sb.WriteString(`\0`)
		case '\n':
			sb.WriteString(`\n`)
		case '\r':
			sb.WriteString(`\r`)
		case '\\':
			sb.WriteString(`\\`)
		case '\'':
			sb.WriteString(`\'`)
		case 26:
			sb.WriteString(`\Z`)
		default:
			sb.WriteByte(c)
		}
	}
	sb.WriteByte('\'')
	return sb.String()
}
