package admin

// The save statement's placeholders and its arguments must agree.
//
// database/sql only checks that when the statement RUNS, so a column added to
// the INSERT without its argument compiles cleanly, passes vet, passes every
// test that does not touch a database, and then fails the first time an operator
// presses Save with "sql: expected 12 arguments, got 10". That is exactly what
// shipped, so it gets a test that needs no database.

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

func readSource(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(name)
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return string(b)
}

// The literal is read out of the source rather than duplicated here — a copy
// would drift and then agree with itself while disagreeing with the code.
func TestCacheSaveArgCount(t *testing.T) {
	src := readSource(t, "reportcacheadmin.go")

	start := strings.Index(src, "INSERT INTO `+redisCfgTable+`")
	if start < 0 {
		t.Fatal("could not find the save statement")
	}
	end := strings.Index(src[start:], "); err != nil {")
	if end < 0 {
		t.Fatal("could not find the end of the save call")
	}
	stmt := src[start : start+end]

	// Placeholders live only in the VALUES list; the ON DUPLICATE clause uses
	// VALUES(col) and has none.
	vals := regexp.MustCompile(`VALUES \(1(?:, \?)+\)`).FindString(stmt)
	if vals == "" {
		t.Fatal("could not find the VALUES list")
	}
	placeholders := strings.Count(vals, "?")

	// Everything after the closing backtick of the SQL literal is the argument
	// list. Commas at depth zero separate the arguments.
	tick := strings.LastIndex(stmt, "`,")
	if tick < 0 {
		t.Fatal("could not find the end of the SQL literal")
	}
	args := countArgs(stmt[tick+2:])

	if placeholders != args {
		t.Fatalf("the save statement has %d placeholders and %d arguments — "+
			"pressing Save would fail with \"sql: expected %d arguments, got %d\"",
			placeholders, args, placeholders, args)
	}
	t.Logf("%d placeholders, %d arguments", placeholders, args)

	// Every column the table has must also be written, or a setting saves
	// silently as its default and the screen shows the change until a reload.
	for _, col := range []string{"warm_windows", "skip_unchanged", "maxmemory_mb",
		"warm_calendar", "recheck_minutes"} {
		if !strings.Contains(stmt, col+"=VALUES("+col+")") {
			t.Errorf("%s is inserted but not updated — a second save would leave the old value", col)
		}
	}
}

func stripComments(s string) string {
	s = regexp.MustCompile(`(?s)/\*.*?\*/`).ReplaceAllString(s, "")
	return regexp.MustCompile(`(?m)//.*$`).ReplaceAllString(s, "")
}

// countArgs counts top-level commas, ignoring those inside calls, strings and
// comments. Comments matter: prose in the argument list contains commas, and
// counting those reports a mismatch that is not there.
func countArgs(s string) int {
	s = stripComments(s)
	depth, n, inStr := 0, 1, false
	for i := 0; i < len(s); i++ {
		switch c := s[i]; {
		case c == '"' && (i == 0 || s[i-1] != '\\'):
			inStr = !inStr
		case inStr:
		case c == '(':
			depth++
		case c == ')':
			if depth == 0 {
				return n // the closing paren of the Exec call
			}
			depth--
		case c == ',' && depth == 0:
			n++
		}
	}
	return n
}
