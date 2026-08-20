package handlers

// Integration check for the reports_api bridge.
//
// SKIPS unless REPORTS_API_URL and TEST_CLIENT_ID are set, so a normal `go test
// ./...` is unaffected and CI without the service still passes. Run it against a
// live pair with:
//
//	REPORTS_API_URL=http://127.0.0.1:8091 REPORTS_API_KEY=… \
//	TEST_CLIENT_ID=<guid> go test ./handlers -run Bridge -v
//
// It is deliberately end-to-end rather than mocked. The thing that can actually
// break here is the agreement between two services about column names, dimension
// keys and measure names — and a mock is a copy of one side's belief about the
// other, which is exactly the thing that drifts.

import (
	"os"
	"testing"
	"time"
)

func skipUnlessLive(t *testing.T) string {
	t.Helper()
	if os.Getenv("REPORTS_API_URL") == "" {
		t.Skip("REPORTS_API_URL is not set — skipping the live bridge check")
	}
	client := os.Getenv("TEST_CLIENT_ID")
	if client == "" {
		t.Skip("TEST_CLIENT_ID is not set — skipping the live bridge check")
	}
	return client
}

// The schema seam: without this the engine cannot infer a spec at all, and every
// platform reports that none of its tables can be read.
func TestBridgeTableShape(t *testing.T) {
	skipUnlessLive(t)
	if !reportsViaAPI() {
		t.Fatal("REPORTS_API_URL is set but reportsViaAPI() is false")
	}

	const table = "dashboards.Agg_Daily_Telegram_Sports_Raw"
	shape := tableShapeOf(table)
	if len(shape.Columns) == 0 {
		t.Fatalf("no columns for %s: %s", table, shape.Err)
	}
	for _, want := range []string{"clientid", "urluploaddate", "assetid"} {
		if _, ok := shape.Columns[want]; !ok {
			t.Errorf("column %q missing from the shape reports_api reports", want)
		}
	}
	t.Logf("%s → %d columns", table, len(shape.Columns))
}

// The data seam: a whole section assembled over HTTP, in the shape everything
// downstream expects.
func TestBridgeRunSpec(t *testing.T) {
	client := skipUnlessLive(t)

	const table = "dashboards.Agg_Daily_Telegram_Sports_Raw"
	spec, ok := inferSpec("telegram-sports", "Telegram - Sports", table)
	if !ok {
		t.Fatalf("could not infer a spec for %s — the shape came back unusable", table)
	}
	t.Logf("inferred: client=%s date=%s ident=%q dims=%d",
		spec.ClientCol, spec.DateCol, spec.IdentExpr, len(spec.Dimensions))

	to := time.Now().UTC()
	from := to.AddDate(0, 0, -30)
	out := runSpecViaAPI(spec, map[string]string{
		"clientId": client,
		"from":     from.Format("2006-01-02"),
		"to":       to.Format("2006-01-02"),
	}, false)

	if w, ok := out["queryWarning"].(string); ok && w != "" {
		t.Fatalf("bridge reported failures: %s", w)
	}
	if out["ok"] != true {
		t.Fatalf("not ok: %v", out["error"])
	}

	kpi, _ := out["kpi"].(map[string]any)
	if kpi == nil {
		t.Fatal("no kpi block")
	}
	ident := numOf(kpi["identified"])
	if ident <= 0 {
		t.Fatalf("identified was %d — expected rows for this client in the last 30 days", ident)
	}

	/* The invariants that matter, because each one is a way the two services can
	   disagree without erroring: a total that does not match the sum of its own
	   trend means the filters differ between the two calls. */
	daily, _ := out["daily"].([]map[string]any)
	if len(daily) == 0 {
		t.Fatal("no daily points")
	}
	var sum int64
	for _, d := range daily {
		sum += numOf(d["urls"])
	}
	if sum != ident {
		t.Errorf("trend does not add up to the KPI: summary=%d, sum(daily)=%d — "+
			"the two calls are not being sent the same filters", ident, sum)
	}

	breakdowns, _ := out["breakdowns"].(map[string]any)
	if len(breakdowns) == 0 {
		t.Fatal("no breakdowns")
	}
	nonEmpty := 0
	for key, v := range breakdowns {
		rows, _ := v.([]map[string]any)
		if len(rows) == 0 {
			continue
		}
		nonEmpty++
		// Every row needs both halves: the label a reader sees and the value a
		// click filters on. A panel with labels and no values renders fine and
		// cross-filters to nothing.
		for _, r := range rows {
			if strFromAny(r["label"]) == "" {
				t.Errorf("breakdown %q has a row with no label", key)
				break
			}
			if strFromAny(r["value"]) == "" {
				t.Errorf("breakdown %q has a row with no value — its cross-filter would send nothing", key)
				break
			}
		}
	}
	if nonEmpty == 0 {
		t.Error("every breakdown came back empty")
	}
	t.Logf("identified=%d daily=%d breakdowns=%d (%d with rows)",
		ident, len(daily), len(breakdowns), nonEmpty)
}

// The slicer seam.
func TestBridgeOptions(t *testing.T) {
	client := skipUnlessLive(t)

	spec, ok := inferSpec("telegram-sports", "Telegram - Sports", "dashboards.Agg_Daily_Telegram_Sports_Raw")
	if !ok {
		t.Fatal("spec not usable")
	}
	for param, col := range spec.Filters {
		t.Logf("spec filter %-18s → column %s", param, col)
	}
	/* Listed under the same scope a report runs under. The window matters to
	   what comes back — that is the point of passing it — so this asks for one
	   rather than for everything the client has ever had. */
	to := time.Now().UTC()
	from := to.AddDate(0, 0, -30)
	opts := mergeSpecOptionsViaAPI([]reportSpec{spec}, client, map[string]string{
		"clientId": client,
		"from":     from.Format("2006-01-02"),
		"to":       to.Format("2006-01-02"),
	})

	/* Every filter the spec declares must come back under its OWN parameter
	   name — that is the key the page reads. A pluralised or prettified key
	   renders as an empty slicer with nothing to explain it, which is why this
	   is checked per parameter rather than by counting the response.

	   A parameter with no values is NOT an error here any more: scoped to a
	   window, a slicer whose values all fall outside it is correctly empty. What
	   would be an error is the key going missing, or a value arriving without
	   the name a reader picks it by. */
	for param := range spec.Filters {
		v, present := opts[param]
		if !present {
			t.Errorf("filter %q produced no options key", param)
			continue
		}
		vals, _ := v.([]map[string]any)
		if len(vals) == 0 {
			t.Logf("option %-18s no values in this window", param)
			continue
		}
		for _, o := range vals {
			if strFromAny(o["id"]) == "" {
				t.Errorf("filter %q has an option with no id: %v", param, o)
				break
			}
			if strFromAny(o["name"]) == "" {
				t.Errorf("filter %q has an option with no name: %v", param, o)
				break
			}
		}
		t.Logf("option %-18s %3d values (e.g. %q → %q)",
			param, len(vals), strFromAny(vals[0]["id"]), strFromAny(vals[0]["name"]))
	}
	if _, ok := opts["clients"]; !ok {
		t.Error("no clients key")
	}
}

/*
The asset lookup must resolve to a master reports_api actually serves.

It is spelled "assets", and an earlier fix asked for "asset" — which is not an
error anyone sees: MasterNames returns "no such master", the caller moves on,
and the slicer renders exactly as it did before. Pinning the table→key hop here
means a wrong name fails loudly instead of silently doing nothing.
*/
func TestAssetMasterTableIsSpelledAsTheRegistryHasIt(t *testing.T) {
	if assetMasterTable != "mediascan.Asset" {
		t.Errorf("asset master table is %q — dimensionCandidates declares mediascan.Asset", assetMasterTable)
	}
}
