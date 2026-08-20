package handlers

// Live check for the config picker's data source.
//
// SKIPS unless REPORTS_API_URL is set, like the other bridge tests, so a plain
// `go test ./...` is unaffected.
//
// Exercises apiTableList — the CATALOGUE list, which is what pickerTables falls
// back to when the warehouse cannot be enumerated. The fallback is the path
// nobody notices is broken until the day it is needed, so it is the one worth a
// standing check.

import (
	"context"
	"os"
	"strings"
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

/*
The picker as it is actually built — the curated WAREHOUSE list.

Checks the two properties that make it safe rather than the exact contents,
which depend on what somebody has hidden: every option carries a name, and every
option is marked with whether reports_api serves it. The second is what stops a
platform being pointed at a table that saves cleanly and fails at read time.
*/
func TestBridgePickerTables(t *testing.T) {
	if os.Getenv("REPORTS_API_URL") == "" {
		t.Skip("REPORTS_API_URL is not set — skipping the live picker check")
	}

	tables, err := pickerTables(context.Background())
	if err != nil {
		t.Fatalf("pickerTables: %v", err)
	}
	if len(tables) == 0 {
		t.Fatal("no tables — the picker would render 'Nothing matches'")
	}

	served := 0
	for _, tb := range tables {
		if strFromAny(tb["name"]) == "" {
			t.Errorf("a table option has no name: %v", tb)
		}
		if _, present := tb["served"]; !present {
			t.Errorf("%s is offered without saying whether it is served", strFromAny(tb["name"]))
		}
		if s, _ := tb["served"].(bool); s {
			served++
		}
	}
	t.Logf("picker would offer %d table(s), %d of them served by reports_api",
		len(tables), served)

	/* A hidden table must not be offered. Asserted against the store rather
	   than against a fixture, so the check holds whatever has been hidden — and
	   is a no-op on an install where nothing has. */
	hidden := hiddenTables()
	inUse := map[string]bool{}
	for _, p := range loadPlatforms() {
		for _, t := range p.Tables {
			inUse[strings.ToLower(t)] = true
		}
	}
	for _, tb := range tables {
		k := strings.ToLower(strFromAny(tb["name"]))
		if hidden[k] && !inUse[k] {
			t.Errorf("%s is hidden and unused, but the picker still offers it", k)
		}
	}
}
