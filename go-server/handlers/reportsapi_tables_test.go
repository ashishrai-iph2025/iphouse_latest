package handlers

// Live check for the config picker's data source.
//
// SKIPS unless REPORTS_API_URL is set, like the other bridge tests, so a plain
// `go test ./...` is unaffected.

import (
	"os"
	"testing"
)

func TestBridgeTableList(t *testing.T) {
	if os.Getenv("REPORTS_API_URL") == "" {
		t.Skip("REPORTS_API_URL is not set — skipping the live picker check")
	}

	tables, err := apiTableList()
	if err != nil {
		t.Fatalf("apiTableList: %v", err)
	}
	if len(tables) == 0 {
		t.Fatal("no tables — the picker would render 'Nothing matches'")
	}
	for _, tb := range tables {
		if strFromAny(tb["name"]) == "" {
			t.Errorf("a table option has no name: %v", tb)
		}
	}
	t.Logf("picker would offer %d tables", len(tables))
	for _, tb := range tables {
		t.Logf("   %-52s %s", strFromAny(tb["name"]), strFromAny(tb["label"]))
	}

	/* Every offered table must also answer for its columns, or the picker
	   offers a choice that fails the moment it is selected — which is the
	   failure mode the old picker had for the ~2000 tables no report could
	   read. */
	for _, tb := range tables {
		name := strFromAny(tb["name"])
		cols, ok := apiTableColumns(name)
		if !ok {
			t.Errorf("%s is offered but has no columns", name)
			continue
		}
		if len(cols) == 0 {
			t.Errorf("%s returned an empty column list", name)
		}
	}

	// And a table nobody serves must be refused rather than returned empty.
	if _, ok := apiTableColumns("dashboards.NoSuchTableAnywhere"); ok {
		t.Error("an unknown table reported columns")
	}
}
