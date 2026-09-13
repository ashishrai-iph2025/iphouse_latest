package handlers

// Which months the programme calendar on /welcome will let a client page to.
//
// See components/client/ProgramCalendar.tsx for the reasoning that used to make
// this a fixed, non-navigable single month: a reader who paged away and came
// back later saw a calendar with no clock reset, and nothing on screen to say
// the month they were looking at was not "now" any more. Two things below hold
// that guarantee even with paging turned back on — the "This month" pill is
// computed off the wall clock rather than the page state, so it only ever
// lights on the real current month, and a "Today" control returns to it in one
// click. Whether to accept that trade at all is Report Configuration's call,
// per client, which is what this settles.
//
// Three independent flags rather than one three-way choice, because the ask
// was "let a client page backward, forward, or both" and those are not mutually
// exclusive: a client with both PREVIOUS and NEXT checked (or COMPLETE, which
// is both at once by definition) can move either way; checking only one gives
// a single arrow in that direction and none in the other. COMPLETE is not
// derived from the other two being on — it is its own checkbox, stored as its
// own bit, so a client can be switched straight to the shipped default without
// two separate ticks.

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"sync"

	"github.com/ip-house/iphouse-api/db"
)

const calendarNavTable = "welcome_calendar_nav"

var calendarNavSchemaOnce sync.Once

func ensureCalendarNavSchema() {
	calendarNavSchemaOnce.Do(func() {
		if _, _, err := db.Exec(`
			CREATE TABLE IF NOT EXISTS ` + calendarNavTable + ` (
			  client_id     VARCHAR(64)  NOT NULL DEFAULT '',
			  show_previous TINYINT(1)   NOT NULL DEFAULT 0,
			  show_next     TINYINT(1)   NOT NULL DEFAULT 0,
			  -- The shipped answer: every direction, for a portal with nothing
			  -- configured. Only the shared default row (client_id = '') is
			  -- created with this on; a client row an admin creates explicitly
			  -- starts from whatever they ticked on the form.
			  complete      TINYINT(1)   NOT NULL DEFAULT 0,
			  updated_by    VARCHAR(191) NOT NULL DEFAULT '',
			  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
			  PRIMARY KEY (client_id)
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`); err != nil {
			log.Printf("[calendar-nav] create %s: %v", calendarNavTable, err)
			return
		}
		// The shared default row, seeded once so a portal with nobody having
		// touched this screen still ships with every direction open — the
		// answer the calendar gave before this setting existed.
		if _, _, err := db.Exec(
			"INSERT IGNORE INTO "+calendarNavTable+
				" (client_id, show_previous, show_next, complete) VALUES ('', 0, 0, 1)"); err != nil {
			log.Printf("[calendar-nav] seed default row: %v", err)
		}
	})
}

// CalendarNav is one resolved answer: which arrows this client's welcome
// calendar draws.
type CalendarNav struct {
	Previous bool `json:"previous"`
	Next     bool `json:"next"`
	Complete bool `json:"complete"`
	// Which row this came from — "" for the shared default, the client id for
	// a client's own. The admin screen reads it the same way appearanceFor's
	// callers do; the calendar itself ignores it.
	Source string `json:"source"`
}

// CanPrevious and CanNext are what the calendar actually gates the arrows on:
// COMPLETE turns both on regardless of the other two, because it is defined as
// "every direction" rather than as shorthand for ticking both by hand.
func (c CalendarNav) CanPrevious() bool { return c.Complete || c.Previous }
func (c CalendarNav) CanNext() bool     { return c.Complete || c.Next }

/*
calendarNavFor resolves the two-layer lookup for one client — the client's own
row where one exists, the shared row otherwise. Same shape as appearanceFor in
reportappearance.go, and never fails for the same reason: a calendar that
cannot read this table draws as the fixed single month it always used to,
which is a safe, working answer rather than an error over a page of titles.
*/
func calendarNavFor(clientID string) CalendarNav {
	ensureCalendarNavSchema()
	out := CalendarNav{Complete: true}

	rows, err := db.Query(
		"SELECT client_id, show_previous, show_next, complete FROM "+calendarNavTable+
			" WHERE client_id IN ('', ?) ORDER BY client_id ASC", strings.TrimSpace(clientID))
	if err != nil {
		log.Printf("[calendar-nav] read for client %q: %v", clientID, err)
		return out
	}
	for _, row := range rows {
		id := strFromAny(row["client_id"])
		if id != "" && id != strings.TrimSpace(clientID) {
			continue
		}
		out.Previous = flagOn(row["show_previous"])
		out.Next = flagOn(row["show_next"])
		out.Complete = flagOn(row["complete"])
		out.Source = id
	}
	return out
}

/*
── GET /api/admin/report-welcome-calendar?clientId= ─────────────────────────

	Which arrows this client's calendar draws, and whether that answer is their
	own row or the shared default — the admin screen needs both, same as
	Appearance, to say "following the shared setting" until there is an
	override to edit.
*/
func WelcomeCalendarGet(w http.ResponseWriter, r *http.Request) {
	clientID := strings.TrimSpace(r.URL.Query().Get("clientId"))
	got := calendarNavFor(clientID)
	OK(w, map[string]any{
		"success":   true,
		"clientId":  clientID,
		"nav":       got,
		"inherited": clientID != "" && got.Source != clientID,
		"clients":   calendarNavClients(),
	})
}

/*
── PUT /api/admin/report-welcome-calendar ────────────────────────────────────

	Save one row. An empty clientId writes the shared default; a client id
	writes that client's own, creating it if this is the first override.
*/
func WelcomeCalendarSave(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	ensureCalendarNavSchema()

	var body struct {
		ClientID string `json:"clientId"`
		Previous bool   `json:"previous"`
		Next     bool   `json:"next"`
		Complete bool   `json:"complete"`
	}
	json.NewDecoder(r.Body).Decode(&body)

	clientID := strings.TrimSpace(body.ClientID)
	if len(clientID) > 64 {
		Fail(w, 422, "That client id is too long")
		return
	}

	who := ""
	if claims != nil {
		who = claims.LoginUsername
	}

	/* COMPLETE replaces the other two rather than combining with them — see
	   the note at the top of this file. Enforced here as well as on the form:
	   the form cannot stop a row written straight against this endpoint, and a
	   stored "complete AND previous" is not a bigger permission than complete
	   alone, only a confusing one to read back on this screen. */
	if body.Complete {
		body.Previous, body.Next = false, false
	}

	if _, _, err := db.Exec(`
		INSERT INTO `+calendarNavTable+` (client_id, show_previous, show_next, complete, updated_by)
		VALUES (?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
		  show_previous=VALUES(show_previous), show_next=VALUES(show_next),
		  complete=VALUES(complete), updated_by=VALUES(updated_by)`,
		clientID, body.Previous, body.Next, body.Complete, who); err != nil {
		log.Printf("[calendar-nav] save for client %q: %v", clientID, err)
		Fail(w, 500, "Could not save this calendar setting")
		return
	}
	OK(w, map[string]any{"success": true, "clientId": clientID, "nav": calendarNavFor(clientID)})
}

/*
── DELETE /api/admin/report-welcome-calendar?clientId= ──────────────────────

	Drop a client's own row, putting them back on the shared default. With no
	clientId this resets the shared row itself, back to every direction open.
*/
func WelcomeCalendarReset(w http.ResponseWriter, r *http.Request) {
	ensureCalendarNavSchema()
	clientID := strings.TrimSpace(r.URL.Query().Get("clientId"))
	if clientID == "" {
		if _, _, err := db.Exec(
			"UPDATE "+calendarNavTable+" SET show_previous=0, show_next=0, complete=1 WHERE client_id=''"); err != nil {
			Fail(w, 500, "Could not reset this calendar setting")
			return
		}
	} else if _, _, err := db.Exec(
		"DELETE FROM "+calendarNavTable+" WHERE client_id = ?", clientID); err != nil {
		Fail(w, 500, "Could not reset this calendar setting")
		return
	}
	OK(w, map[string]any{"success": true, "clientId": clientID, "nav": calendarNavFor(clientID)})
}

// calendarNavClients lists the clients that have a calendar setting of their
// own, so the picker can mark them without a query per name.
func calendarNavClients() []string {
	out := []string{}
	rows, err := db.Query("SELECT client_id FROM " + calendarNavTable + " WHERE client_id != ''")
	if err != nil {
		return out
	}
	for _, r := range rows {
		if id := strFromAny(r["client_id"]); id != "" {
			out = append(out, id)
		}
	}
	return out
}
