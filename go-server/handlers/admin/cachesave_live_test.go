package admin

// Drives the real POST handler against the real database, because that is the
// only thing that would have caught the bug that shipped: the statement is
// assembled in the handler, and its argument count is checked by the driver at
// run time. A diagnostic that retypes the statement and its arguments by hand
// proves only that the hand-written pair agrees with itself — mine did exactly
// that, passed, and the handler still failed.
//
// Skips when there is no database, so it stays safe in CI.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/joho/godotenv"

	"github.com/ip-house/iphouse-api/config"
	"github.com/ip-house/iphouse-api/db"
)

func TestReportCacheConfigSaveLive(t *testing.T) {
	// The env file lives at the repository root, three levels above this package.
	for _, p := range []string{"../../../.env.local", "../../../.env"} {
		if _, err := os.Stat(p); err == nil {
			godotenv.Load(p)
		}
	}
	// config.Load calls log.Fatal on a missing JWT secret, which kills the test
	// binary with no output. This test never checks a token, so a placeholder is
	// enough to get past it.
	if os.Getenv("NEXTAUTH_SECRET") == "" && os.Getenv("JWT_SECRET") == "" {
		os.Setenv("JWT_SECRET", "test-only-not-a-real-secret")
	}
	config.Load()
	if err := db.Init(); err != nil {
		t.Skip("no database:", err)
	}

	// The handler writes row id=1, which is the operator's live configuration.
	// Snapshot it and put it back, whatever happens.
	ensureRedisCfgSchema()
	before, err := db.Query("SELECT * FROM " + redisCfgTable + " WHERE id = 1")
	if err != nil {
		t.Skip("cannot read config table:", err)
	}
	t.Cleanup(func() { restoreCacheRow(t, before) })

	body := `{"addr":"redis:6379","password":"","dbIndex":0,"ttlMinutes":360,
	          "warmEnabled":true,"warmMinutes":30,"warmDays":30,"warmConc":2,
	          "maxMemoryMb":2048,"warmWindows":"30, 90, 400","skipUnchanged":true}`
	req := httptest.NewRequest(http.MethodPost, "/api/admin/report-cache", strings.NewReader(body))
	rec := httptest.NewRecorder()
	ReportCacheConfig(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("save returned %d: %s", rec.Code, strings.TrimSpace(rec.Body.String()))
	}
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("unreadable response: %v (%s)", err, rec.Body.String())
	}
	if out["success"] != true {
		t.Fatalf("save reported failure: %v", out)
	}

	// The values must survive the round trip. A column that is inserted but
	// missing from ON DUPLICATE KEY UPDATE saves once and then silently stops.
	got := loadCacheSettings()
	if w := joinWindows(got.WarmWindows); w != "30,90,400" {
		t.Errorf("warm windows did not persist: got %q", w)
	}
	if !got.SkipUnchanged {
		t.Error("skipUnchanged did not persist")
	}
	if got.MaxMemoryMB != 2048 {
		t.Errorf("maxMemoryMb did not persist: got %d", got.MaxMemoryMB)
	}

	// Save a second time with different values — this is what catches a missing
	// ON DUPLICATE KEY UPDATE clause, which the first insert cannot.
	body2 := strings.Replace(body, `"warmWindows":"30, 90, 400"`, `"warmWindows":"7,400"`, 1)
	rec2 := httptest.NewRecorder()
	ReportCacheConfig(rec2, httptest.NewRequest(http.MethodPost, "/api/admin/report-cache", strings.NewReader(body2)))
	if rec2.Code != http.StatusOK {
		t.Fatalf("second save returned %d: %s", rec2.Code, strings.TrimSpace(rec2.Body.String()))
	}
	if w := joinWindows(loadCacheSettings().WarmWindows); w != "7,400" {
		t.Errorf("second save did not update warm windows: got %q", w)
	}
}

func restoreCacheRow(t *testing.T, before []map[string]any) {
	t.Helper()
	if len(before) == 0 {
		db.Exec("DELETE FROM " + redisCfgTable + " WHERE id = 1")
		return
	}
	cols, vals, marks := []string{}, []any{}, []string{}
	for k, v := range before[0] {
		if k == "updated_at" {
			continue // let the column keep its own semantics
		}
		cols = append(cols, "`"+k+"`")
		vals = append(vals, v)
		marks = append(marks, "?")
	}
	sets := make([]string, 0, len(cols))
	for _, c := range cols {
		sets = append(sets, c+"=VALUES("+c+")")
	}
	if _, _, err := db.Exec(
		"INSERT INTO "+redisCfgTable+" ("+strings.Join(cols, ",")+") VALUES ("+
			strings.Join(marks, ",")+") ON DUPLICATE KEY UPDATE "+strings.Join(sets, ","),
		vals...); err != nil {
		t.Errorf("could not restore the original cache settings — check the screen: %v", err)
	}
}
