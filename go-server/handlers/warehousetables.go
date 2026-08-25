package handlers

// The warehouse, as a list somebody can curate.
//
// reports_api can enumerate every table in the database — several hundred of
// them, most of which will never back a report. The platform picker offered all
// of them, so choosing a data source meant reading past the noise to find the
// dozen that matter, and a mistyped guess looked exactly like a real option.
//
// So: one screen listing what is there, with a switch per table. A hidden table
// is dropped from the picker and from nowhere else — it is a curation of the
// CHOICES, not a permission and not a deletion. Nothing stops reading a table
// that is already configured, because hiding a source out from under a running
// report would be a way to break one silently.

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/ip-house/iphouse-api/db"
	"github.com/ip-house/iphouse-api/reportsapi"
)

const warehouseHiddenTable = "report_table_hidden"

var warehouseHiddenOnce sync.Once

func ensureWarehouseHiddenSchema() {
	warehouseHiddenOnce.Do(func() {
		if _, _, err := db.Exec(`
			CREATE TABLE IF NOT EXISTS ` + warehouseHiddenTable + ` (
			  table_name VARCHAR(191) NOT NULL PRIMARY KEY,
			  updated_by VARCHAR(191) NOT NULL DEFAULT '',
			  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`); err != nil {
			log.Printf("[warehouse] create %s: %v", warehouseHiddenTable, err)
		}
	})
}

/*
hiddenTables is the set that must not appear in the picker.

Only the HIDDEN ones are stored, so a table nobody has an opinion about is
visible by default and a newly created one appears without anybody having to
approve it. The alternative — a row per table with a flag — starts empty and
therefore hides the entire warehouse until somebody ticks it.

Keyed lower-case: the schema endpoint returns the table's own spelling and a
platform stores whatever was picked, and MySQL will happily disagree about the
case of the two.
*/
func hiddenTables() map[string]bool {
	ensureWarehouseHiddenSchema()
	out := map[string]bool{}
	rows, err := db.Query("SELECT table_name FROM " + warehouseHiddenTable)
	if err != nil {
		// Fail OPEN. A visibility list that cannot be read must not empty the
		// picker — the failure would present as "the warehouse has no tables",
		// which sends someone to look at the wrong service entirely.
		log.Printf("[warehouse] read hidden list: %v", err)
		return out
	}
	for _, r := range rows {
		if t := strings.TrimSpace(strFromAny(r["table_name"])); t != "" {
			out[strings.ToLower(t)] = true
		}
	}
	return out
}

// IsTableHidden reports whether a table has been hidden from the picker.
func IsTableHidden(table string) bool {
	return hiddenTables()[strings.ToLower(strings.TrimSpace(table))]
}

/*
platformsUsingTables maps each configured table to the platforms reading it.

Lower-cased keys throughout: a platform stores whatever the picker offered and
the schema endpoint returns the table's own spelling, and the two are not
guaranteed to agree about case. A comparison that misses here would report a
table as unused and let it be hidden out from under a live report — which is the
exact failure this map exists to prevent.
*/
func platformsUsingTables() map[string]string {
	out := map[string]string{}
	for _, p := range loadPlatforms() {
		for _, t := range p.Tables {
			key := strings.ToLower(strings.TrimSpace(t))
			if key == "" {
				continue
			}
			if out[key] != "" {
				out[key] += ", " + p.Label
			} else {
				out[key] = p.Label
			}
		}
	}
	return out
}

/*
GET /api/admin/warehouse-tables?schema=&q=

Every table the warehouse holds, each marked with whether it is hidden, whether
reports_api serves it, and whether a platform already reads it. The last one is
what makes the switch safe to use: hiding a table that something depends on is
a different act from hiding one nothing has ever pointed at, and the screen has
to be able to say which it is about to do.
*/
func WarehouseTablesList(w http.ResponseWriter, r *http.Request) {
	if !requireWarehouseNames(w, r) {
		return
	}
	/* Only reports_api can enumerate a schema. Reading it directly would need a
	   warehouse connection the portal deliberately does not hold, and inventing
	   a second source for this list is how the two come to disagree about what
	   exists. */
	if !reportsViaAPI() {
		reportsUnavailable(w, r, fmt.Errorf(
			"the warehouse table list comes from reports_api — set REPORTS_API_URL to read it"))
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	body, err := reportsapi.Get().Schema(ctx,
		strings.TrimSpace(r.URL.Query().Get("schema")),
		strings.TrimSpace(r.URL.Query().Get("q")))
	if err != nil {
		/* Verbatim. This endpoint is restricted by address as well as by key on
		   the far side, so the likely failure is "this portal is not on the
		   admin allowlist" — a sentence that tells an operator exactly what to
		   change, and which "warehouse unavailable" would have thrown away. */
		reportsUnavailable(w, r, err)
		return
	}

	hidden := hiddenTables()

	// Which tables a platform already reads. This is what makes a table
	// un-hideable, so the screen can say so before a switch is thrown rather
	// than refuse after it.
	inUse := platformsUsingTables()

	schema := strFromAny(body["schema"])
	rows, _ := body["tables"].([]any)
	out := make([]map[string]any, 0, len(rows))
	hiddenCount := 0

	for _, raw := range rows {
		t, _ := raw.(map[string]any)
		if t == nil {
			continue
		}
		name := strFromAny(t["table"])
		if name == "" {
			continue
		}
		// Qualified, because that is the form a platform stores and the form the
		// picker offers. The bare name is what the schema endpoint returns.
		qualified := name
		if schema != "" && !strings.Contains(name, ".") {
			qualified = schema + "." + name
		}
		isHidden := hidden[strings.ToLower(qualified)] || hidden[strings.ToLower(name)]
		if isHidden {
			hiddenCount++
		}

		servedBy, _ := t["servedBy"].([]any)
		usedBy := inUse[strings.ToLower(qualified)]
		out = append(out, map[string]any{
			"table":   qualified,
			"name":    name,
			"type":    strFromAny(t["type"]),
			"engine":  strFromAny(t["engine"]),
			"rows":    numOf(t["rowsApprox"]),
			"bytes":   numOf(t["totalBytes"]),
			"comment": strFromAny(t["comment"]),
			"hidden":  isHidden,
			"served":  len(servedBy) > 0,
			"usedBy":  usedBy,
			/* Stated by the SERVER rather than re-derived from `usedBy` in the
			   page. The rule the save enforces and the rule the switch obeys
			   have to be one rule; two copies of "hideable means unused" is how
			   a disabled control and a 409 come to disagree. */
			"canHide": usedBy == "",
		})
	}

	OK(w, map[string]any{
		"success": true, "schema": schema, "tables": out,
		"hiddenCount": hiddenCount,
		"servedCount": numOf(body["servedCount"]),
		"rowsNote":    strFromAny(body["rowsNote"]),
	})
}

/*
PUT /api/admin/warehouse-tables — hide or show one table.

Body: { table, hidden }
*/
func WarehouseTablesSave(w http.ResponseWriter, r *http.Request) {
	if !requireWarehouseNames(w, r) {
		return
	}
	ensureWarehouseHiddenSchema()

	var in struct {
		Table  string `json:"table"`
		Hidden bool   `json:"hidden"`
	}
	json.NewDecoder(r.Body).Decode(&in)

	table := strings.TrimSpace(in.Table)
	if table == "" {
		Fail(w, 422, "A table name is required")
		return
	}
	// Same validation the platform save applies, for the same reason: this name
	// is compared against ones that reach SQL, and nothing should be able to
	// store a value there that could not have come from the warehouse.
	if !validSQLName(table) {
		Fail(w, 422, "Not a valid table name: "+table)
		return
	}

	/* A table a platform reads cannot be hidden.

	   Enforced here and not only in the page, because the page is one caller.
	   Hiding an in-use table does not stop the report — the picker's own escape
	   keeps offering it — so the harm is subtler than a broken report and
	   therefore easier to do by accident: the table vanishes from the list of
	   choices while still being read, and the next person to open the platform
	   sees a source that is not in the warehouse as far as this screen is
	   concerned.

	   Refused rather than warned. The warning was there and was the wrong
	   shape: it appeared AFTER the switch had been thrown, describing a state
	   the reader had just created. */
	if in.Hidden {
		if users := platformsUsingTables()[strings.ToLower(table)]; users != "" {
			Fail(w, 409, table+" is read by "+users+
				". Point that platform at something else on the Data sources tab first, then hide this.")
			return
		}
	}

	who := ""
	if c := ClaimsFrom(r); c != nil {
		who = c.LoginUsername
	}

	var err error
	if in.Hidden {
		err = db.MustExec(
			"INSERT INTO "+warehouseHiddenTable+" (table_name, updated_by) VALUES (?, ?) "+
				"ON DUPLICATE KEY UPDATE updated_by = VALUES(updated_by)", table, who)
	} else {
		err = db.MustExec("DELETE FROM "+warehouseHiddenTable+" WHERE table_name = ?", table)
	}
	if err != nil {
		log.Printf("[warehouse] save %s: %v", table, err)
		Fail(w, 500, "Could not save that change")
		return
	}
	log.Printf("[warehouse] %s %s by %s", table,
		map[bool]string{true: "hidden from the picker", false: "shown in the picker"}[in.Hidden], who)
	OK(w, map[string]any{"success": true})
}
