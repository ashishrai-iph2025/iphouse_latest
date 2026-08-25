package handlers

// Who may see where the reports actually come from.
//
// A warehouse table name is not a label — it is the schema, the table and, once
// the shape has been inferred, the column names and the SQL that reads them.
// Handed to anyone holding the report-config grant, that is a map of the
// analytics estate given to every admin who was let in to rename a report or
// hide one from the sidebar. Those are different acts, and the second does not
// need the first.
//
// So the real names are Super Admin only, and everybody else gets an ALIAS:
// enough to tell one source from another, to say which one is broken, and to
// quote a reference to someone who can look it up — and nothing that identifies
// a table in the warehouse.
//
// This is disclosure control, not authentication. The gate that matters is on
// the endpoints (see main.go and the checks below); the alias exists so the
// screen still works for the people who are not through it.

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"github.com/ip-house/iphouse-api/db"
)

// maySeeWarehouseNames reports whether this login may be shown real schema,
// table and column names. Super Admin only — the report-config grant is
// permission to CONFIGURE reports, which is a different question.
func maySeeWarehouseNames(r *http.Request) bool {
	claims := ClaimsFrom(r)
	return claims != nil && claims.Role != nil && *claims.Role >= 2
}

/*
sourceRef is the stable, non-identifying handle for a table.

A hash rather than a counter, because it has to mean the same thing on every
screen and in every support conversation: "source 2" changes the moment a table
is added above it, and two people then discuss different tables believing they
discuss one. Six hex characters over the full name — short enough to read aloud,
and not something a table name can be recovered from.
*/
func sourceRef(table string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(table))))
	return hex.EncodeToString(sum[:])[:6]
}

/*
sourceAlias names a table the way the report already thinks of it.

Related, per the requirement, rather than anonymous: a platform reading two
tables reads them because they are the two halves of one report — the pages that
LINK to infringing content and the ones that HOST it — and inferRole already
knows which is which. "Open Web — Linking source" says everything an admin needs
to tell the pair apart and nothing about where either lives.

Falls back to an ordinal within the platform where there is no role to name,
which is the case for every platform that reads a single table.
*/
func sourceAlias(platformLabel string, index, total int, roleLabel string) string {
	switch {
	case roleLabel != "":
		return fmt.Sprintf("%s — %s source", platformLabel, strings.ToLower(roleLabel))
	case total <= 1:
		return platformLabel + " — data source"
	default:
		return fmt.Sprintf("%s — source %d", platformLabel, index+1)
	}
}

/*
redactWarehouseNames strips real identifiers out of a message meant for a
reader who may not see them.

Inference errors quote the table they are about, and reports_api's own errors
quote the dataset and sometimes the base URL. Passing those through unchanged
would hand back through the error channel exactly what the payload was careful
not to say — which is the usual way a redaction leaks.

Deliberately blunt: anything shaped like a qualified name goes, and so does a
URL. A message that loses a word is a worse message; a message that keeps a
table name is a worse outcome.
*/
var (
	qualifiedName = regexp.MustCompile(`\b[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*\b`)
	anyURL        = regexp.MustCompile(`\bhttps?://\S+`)
)

func redactWarehouseNames(msg, alias string) string {
	if msg == "" {
		return ""
	}
	msg = anyURL.ReplaceAllString(msg, "the reports service")
	msg = qualifiedName.ReplaceAllString(msg, alias)
	return msg
}

/*
sourceSummaryFor describes one platform's tables to a reader who may not see
their names.

Everything that is about the STATE of a source survives — whether it can be
read, how many panels it can fill, and what is wrong with it if anything —
because that is what the screen is for. Everything that identifies it in the
warehouse does not: no table, no client or date column, no measure SQL.
*/
// roleLabelFor names what a table describes within its platform — "Linking" or
// "Host" — or empty where the distinction does not apply. Shared so the alias a
// reader sees on one tab is the alias they see on the next.
func roleLabelFor(p platformDef, table string) string {
	if s, ok := inferSpec(p.Key, p.Label, table); ok {
		return s.RoleLabel
	}
	return ""
}

func sourceSummaryFor(p platformDef) []map[string]any {
	out := make([]map[string]any, 0, len(p.Tables))
	for i, t := range p.Tables {
		roleLabel := ""
		if s, ok := inferSpec(p.Key, p.Label, t); ok {
			roleLabel = s.RoleLabel
		}
		alias := sourceAlias(p.Label, i, len(p.Tables), roleLabel)

		entry := map[string]any{
			"alias": alias,
			"ref":   sourceRef(t),
		}
		if s, ok := inferSpec(p.Key, p.Label, t); ok {
			entry["usable"] = true
			entry["dimensions"] = len(s.Dimensions)
		} else {
			entry["usable"] = false
			sh := tableShapeOf(t)
			switch {
			case sh.Err != "":
				entry["error"] = redactWarehouseNames(sh.Err, alias)
			case len(sh.Columns) == 0:
				entry["error"] = "this source is not available from the reports service"
			default:
				entry["error"] = "this source has no column the report engine recognises as a client or a date"
			}
		}
		out = append(out, entry)
	}
	return out
}

/*
scrubReportPayload strips the warehouse's identity out of a rendered report.

A report answer carries more than its figures. It names the tables it read
(`tables`), the ones it could not (`skippedTables`), the single table behind an
unmerged result (`table`), and its warning text quotes the table a query failed
against — "3 of this report's queries failed against mediascan._InternetURLsNEW".
The endpoint serving all of that, /api/reports/data, is open to every login that
may open a report, a CLIENT login included. So the disclosure this file controls
everywhere else was going out with every report anyone ran.

What a reader can act on survives. That sources were skipped explains a figure
that looks short, so it is kept as a COUNT; which sources they were is the part
they could not act on anyway. Warning and notice text is redacted rather than
dropped for the same reason — "a query failed" and "a panel was folded from a
partial list" send a reader to different places, and only the names have to go.

Mutates in place, which is safe because every caller holds a map built for that
one response: a cache hit is unmarshalled fresh per read, and a miss is written
to the cache BEFORE this runs, so what is stored stays whole for a reader who
may see it.
*/
func scrubReportPayload(out map[string]any) {
	if out == nil {
		return
	}
	delete(out, "table")
	delete(out, "tables")

	if skipped := asStrings(out["skippedTables"]); len(skipped) > 0 {
		out["skippedSources"] = len(skipped)
	}
	delete(out, "skippedTables")

	const alias = "a data source"
	if wv := strFromAny(out["queryWarning"]); wv != "" {
		out["queryWarning"] = redactWarehouseNames(wv, alias)
	}
	if ev := strFromAny(out["error"]); ev != "" {
		out["error"] = redactWarehouseNames(ev, alias)
	}
	if notices := asStrings(out["notices"]); len(notices) > 0 {
		clean := make([]string, 0, len(notices))
		for _, n := range notices {
			clean = append(clean, redactWarehouseNames(n, alias))
		}
		out["notices"] = clean
	}
}

// storedTablesFor reads a platform's table list straight from the store, in
// order. Used to carry the list through a save made by someone who was never
// shown it.
func storedTablesFor(key string) []string {
	rows, err := db.Query(
		"SELECT table_name FROM "+platformTableTable+" WHERE platform_key = ? ORDER BY sort_order, table_name", key)
	if err != nil {
		return nil
	}
	out := make([]string, 0, len(rows))
	for _, r := range rows {
		if t := strings.TrimSpace(strFromAny(r["table_name"])); t != "" {
			out = append(out, t)
		}
	}
	return out
}

// sameStrings compares two lists as SETS, not sequences. A caller echoing a
// list back may reorder it, and reordering the tables behind one platform is
// not the disclosure this is guarding.
func sameStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	seen := make(map[string]int, len(a))
	for _, v := range a {
		seen[strings.ToLower(v)]++
	}
	for _, v := range b {
		k := strings.ToLower(v)
		seen[k]--
		if seen[k] < 0 {
			return false
		}
	}
	return true
}

// requireWarehouseNames refuses a request that would disclose real names to a
// login that may not see them. Returns false when it has already answered.
func requireWarehouseNames(w http.ResponseWriter, r *http.Request) bool {
	if maySeeWarehouseNames(r) {
		return true
	}
	Fail(w, 403, "Only a Super Admin may view or change the warehouse sources behind a report")
	return false
}
