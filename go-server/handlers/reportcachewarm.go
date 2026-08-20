package handlers

// Warming the cache for a client someone names, rather than only for the ones
// the mapping happens to cover.
//
// The scheduled pass warms every MAPPED client, which is the right default: a
// warehouse client with no portal login is a report nobody can open. But it
// leaves two gaps that an operator hits in practice —
//
//   - a client that is about to be onboarded, whose first report should not be
//     the slow one
//   - a window nobody has configured as a standing range, wanted once
//
// — and both are the same small request: this client, this many days, every
// platform. That is what this file serves.

import (
	"context"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/ip-house/iphouse-api/db"
	"github.com/ip-house/iphouse-api/reportcache"
	"github.com/ip-house/iphouse-api/reportsapi"
)

/*
── The warehouse's client list ───────────────────────────────────────────────

	Two answers from one read, because two different questions are asked of it:

	  active  the companies an operator may CHOOSE — the warm form's picker, the
	          portal-to-warehouse mapping, the targets a pass covers. This is the
	          CLIENT MASTER and nothing else: /v1/masters/clients through the API,
	          mediascan.ClientMaster in direct-SQL mode. It is the list the
	          warehouse actually maintains.
	  all     the master PLUS every client id the fact tables mention, used only
	          to put a NAME on something that already exists. A report cached
	          last week for a company the master no longer lists still has
	          entries in Redis and a row on the admin screen, and drawing it as a
	          bare GUID because it is no longer selectable makes that screen less
	          legible, not more accurate.

	The two used to be one list, and the fact tables' client column was merged
	into it — which is how companies the master has never listed ended up in the
	picker and in the warm targets.

	THROUGH THE API THERE IS NOTHING LEFT TO FILTER. /v1/masters/clients already
	returns active companies only — it serves Id, CompanyName, ClientTypeId,
	CountrySpecific and Global, and no activity column, because the filtering has
	happened before the rows leave that service. Its response IS the active list,
	and the picker is that response exactly. Do not read the absent column as a
	filter this code forgot.

	Direct-SQL mode reads the table rather than the service, so it has to do the
	filtering itself — see clientMasterRows. There, inactive companies are
	removed by SUBTRACTION: offered unless the master says otherwise. That
	direction matters. Selecting on Active = 1 instead would empty every picker
	in the product the moment the column is missing or renamed, and an empty
	picker looks exactly like a broken backend.
*/

// clientCollector merges id → name from sources that disagree about how to
// spell a GUID. The first spelling seen wins and later sources may only fill in
// a name that was missing, so one company cannot arrive twice — once named and
// once not — and get cached twice under two keys.
type clientCollector struct {
	seen map[string]string // lowercased id → the spelling kept
	out  map[string]string
}

func newClientCollector() *clientCollector {
	return &clientCollector{seen: map[string]string{}, out: map[string]string{}}
}

func (c *clientCollector) add(id, name string) {
	id, name = strings.TrimSpace(id), strings.TrimSpace(name)
	if id == "" || name == "" {
		return
	}
	if kept, dup := c.seen[strings.ToLower(id)]; dup {
		// First readable name wins; a source spelling it as the id again must
		// not overwrite a good one.
		if cur := c.out[kept]; cur == "" || strings.EqualFold(cur, kept) {
			c.out[kept] = name
		}
		return
	}
	c.seen[strings.ToLower(id)] = id
	c.out[id] = name
}

/*
warehouseClients reads both lists.

Both backends, because the rest of the engine works either way: reports_api's
directory when the portal reads through it, and the platforms' own client
columns when it reads the warehouse directly. An unreachable backend returns
empty maps rather than an error — a table that shows an id instead of a name is
worse than the name and better than no table.
*/
func warehouseClients(ctx context.Context) (all map[string]string, active map[string]string) {
	// Everything nameable, and separately the master — which alone decides what
	// may be chosen.
	every := newClientCollector()
	master := newClientCollector()
	// Lowercased ids the master explicitly marks inactive. Only these are
	// withheld — see the note above on subtraction.
	inactive := map[string]bool{}

	if reportsViaAPI() {
		api := reportsapi.Get()

		/* The client master first, and it is the ONLY thing the picker is built
		   from — /v1/masters/clients is the list the warehouse maintains, and it
		   is the answer to "which companies are there".

		   The sports datasets' own client list is read too, but only to NAME
		   things: it is derived from fact rows, so it carries ids the master has
		   never listed, and merging it into the choosable list was how companies
		   nobody maintains ended up in the picker and in the warm targets. */
		mAll, mActive, sawActive, derr := api.ClientDirectory(ctx)
		if derr != nil {
			log.Printf("[report-cache] client master: %v", derr)
		}
		for id, name := range mAll {
			master.add(id, name)
			every.add(id, name)
		}
		if sawActive {
			for id := range mAll {
				if _, ok := mActive[id]; !ok {
					inactive[strings.ToLower(id)] = true
				}
			}
		}

		/* Names only. A report cached from a live request for a client outside
		   the master had nothing to resolve against and was drawn as a bare
		   GUID; this is what fixes that, without making those ids selectable. */
		rows, err := api.Clients(ctx)
		if err != nil {
			log.Printf("[report-cache] dataset client list: %v", err)
		}
		for _, r := range rows {
			every.add(strFromAny(r["id"]), strFromAny(r["name"]))
		}

		/* If the master could not be read at all, the picker falls back to
		   everything rather than to nothing. An empty list is indistinguishable
		   from a broken screen, and this is exactly the moment someone is
		   looking at it. */
		if len(master.out) == 0 {
			return every.out, every.out
		}
		return every.out, withoutInactive(master.out, inactive)
	}

	if !db.ReportsConfigured() {
		return every.out, every.out
	}

	// Same split in direct-SQL mode: the master is the list, the platforms'
	// client columns only add names.
	rows, sawActive, err := clientMasterRows()
	if err != nil {
		log.Printf("[report-cache] client master: %v", err)
	}
	for _, r := range rows {
		id := strFromAny(r["id"])
		name := strFromAny(r["name"])
		master.add(id, name)
		every.add(id, name)
		if sawActive && !clientIsActive(r["active"]) {
			inactive[strings.ToLower(strings.TrimSpace(id))] = true
		}
	}
	for _, sp := range summarySpecs(enabledPlatforms()) {
		for _, cl := range idNamePairs(clientOptions(sp)) {
			every.add(strFromAny(cl["id"]), strFromAny(cl["name"]))
		}
	}
	if len(master.out) == 0 {
		return every.out, every.out
	}
	return every.out, withoutInactive(master.out, inactive)
}

func withoutInactive(all map[string]string, inactive map[string]bool) map[string]string {
	if len(inactive) == 0 {
		return all
	}
	out := make(map[string]string, len(all))
	for id, name := range all {
		if !inactive[strings.ToLower(id)] {
			out[id] = name
		}
	}
	return out
}

/*
clientMasterRows reads the master in direct-SQL mode, with its activity column
if it has one.

Tried WITH the column and retried without it on failure, rather than probing
information_schema first. The retry costs one failed query on an install whose
master has no such column; the alternative — assuming it is there — turns the
whole company list into an error and every name on the screen back into a GUID,
which is precisely the failure this code has already had once.
*/
func clientMasterRows() ([]map[string]any, bool, error) {
	const base = "SELECT Id AS id, CompanyName AS name%s FROM " + clientMasterTable +
		" WHERE Id IS NOT NULL AND CompanyName IS NOT NULL AND CompanyName != ''"

	rows, err := db.ReportsQuery(fmt.Sprintf(base, ", Active AS active"))
	if err == nil {
		return rows, true, nil
	}
	if !strings.Contains(strings.ToLower(err.Error()), "unknown column") {
		return nil, false, err
	}
	log.Printf("[report-cache] %s has no Active column — every company will be offered", clientMasterTable)
	rows, err = db.ReportsQuery(fmt.Sprintf(base, ""))
	return rows, false, err
}

/*
clientIsActive reads the master's activity flag out of whatever the driver hands
back: a MySQL TINYINT arrives as int64, []byte or bool depending on the column
and the driver's settings.

Separate from download_watch.go's truthy, which reads MarkScan's processed flag.
They look alike and are not the same question — this one also accepts the word
"Active", which would be meaningless there.
*/
func clientIsActive(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case int64:
		return t != 0
	case int:
		return t != 0
	case float64:
		return t != 0
	case []byte:
		return activeWord(string(t))
	case string:
		return activeWord(t)
	}
	return false
}

func activeWord(s string) bool {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "1", "true", "y", "yes", "active":
		return true
	}
	return false
}

/*
WarehouseClientDirectory is the list an operator may CHOOSE from: the client
master, minus any company it marks inactive.
*/
func WarehouseClientDirectory(ctx context.Context) map[string]string {
	_, active := warehouseClients(ctx)
	return active
}

/*
WarehouseClientNames is every company the warehouse can name — the master plus
any client id the fact tables mention, active or not.

Only for putting a name on something that already exists — a cached report, a
mapping someone made last year. Never for a picker: offering a retired company
is what this pair of functions exists to stop.
*/
func WarehouseClientNames(ctx context.Context) map[string]string {
	all, _ := warehouseClients(ctx)
	return all
}

/*
CachedClientDirectory and CachedClientNames are the two lists with a short
memory, and one fetch behind both.

The directory is two backend round-trips over every company the warehouse knows,
and the screens that need it ask repeatedly: the cache page polls its settings
every few seconds while a pass runs, and each poll wants names for the clients in
that pass. Fetching the whole directory per poll costs far more than the warm it
is reporting on.

A few minutes is the right staleness for a company NAME, and for whether a
company is still active. A client renamed, retired or onboarded in the last five
minutes showing its old state for another five is not a problem anyone has;
re-reading the whole list forty times a minute is.

The maps are copied out, because callers merge their own entries into them.
*/
var (
	clientDirMu  sync.Mutex
	clientDirAll map[string]string
	clientDirAct map[string]string
	clientDirAt  time.Time
)

const clientDirTTL = 5 * time.Minute

func loadClientDir(ctx context.Context) {
	clientDirMu.Lock()
	defer clientDirMu.Unlock()
	if clientDirAll != nil && time.Since(clientDirAt) <= clientDirTTL {
		return
	}
	all, active := warehouseClients(ctx)
	/* An empty answer is NOT stored. The backend being briefly unreachable
	   would otherwise pin every screen to bare GUIDs for the whole TTL, which
	   is exactly when someone is most likely to be looking. The previous list,
	   even a stale one, names them. */
	if len(all) > 0 {
		clientDirAll, clientDirAct, clientDirAt = all, active, time.Now()
	}
}

func copyOf(m map[string]string) map[string]string {
	out := make(map[string]string, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// CachedClientDirectory is the list a picker may offer — active companies only.
func CachedClientDirectory(ctx context.Context) map[string]string {
	loadClientDir(ctx)
	clientDirMu.Lock()
	defer clientDirMu.Unlock()
	return copyOf(clientDirAct)
}

// CachedClientNames names anything that already exists, retired companies
// included. Never use it to populate a picker — see WarehouseClientNames.
func CachedClientNames(ctx context.Context) map[string]string {
	loadClientDir(ctx)
	clientDirMu.Lock()
	defer clientDirMu.Unlock()
	return copyOf(clientDirAll)
}

// The operational schema's company list, joined by the report engine for the
// same purpose — see clientOptions in reportsrun.go.
const clientMasterTable = "mediascan.ClientMaster"

// WarmRequest is one "cache this now" instruction: some clients, one window.
type WarmRequest struct {
	ClientIDs []string
	Days      int
}

/*
WarmClients builds every enabled platform for each client named, over the last
`days` days.

Deliberately NOT routed through the scheduled warmer. That one refuses to
overlap itself — correctly, because two passes over the same targets double the
warehouse load to produce one answer — and an operator asking for one client
should not be told to wait out a pass covering everybody else. These are
different targets, so they can run alongside it.

The freshness probe is skipped too. This is someone saying "cache this", and
answering "it looked unchanged so I did nothing" is not what was asked for.

Concurrency is the warmer's own cap for the same reason it has one: the live
page needs the warehouse more than this does.
*/
func WarmClients(ctx context.Context, req WarmRequest) (built int, attempted int) {
	days := req.Days
	if days <= 0 {
		days = 30
	}
	today := time.Now().UTC()
	from := today.AddDate(0, 0, -days+1).Format("2006-01-02")
	to := today.Format("2006-01-02")

	platforms := []string{}
	for _, p := range loadPlatforms() {
		if p.Enabled && p.Key != summaryKey {
			platforms = append(platforms, p.Key)
		}
	}

	clients := []string{}
	for _, c := range req.ClientIDs {
		if c = strings.TrimSpace(c); c != "" {
			clients = append(clients, c)
		}
	}

	onDemand.begin(clients, platforms, days, from, to)

	type job struct{ platform, client string }
	jobs := make(chan job)

	var (
		wg sync.WaitGroup
		mu sync.Mutex
	)
	for i := 0; i < reportcache.MaxWarmConcurrency; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range jobs {
				jctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
				/* Always forced. This is someone pressing "cache these clients
				   now", and reading back the copy that is already there is not
				   what was asked for — the scheduled pass is the one allowed to
				   decide a rebuild is unnecessary. */
				payload, err := warmOne(jctx, j.platform, j.client, from, to, true)
				cancel()

				mu.Lock()
				attempted++
				if err != nil {
					log.Printf("[report-cache] warm %s/%s: %v", j.platform, j.client, err)
				} else if len(payload) > 0 {
					built++
				}
				mu.Unlock()

				/* Recorded per client, not just counted. "Nothing was cached for
				   this one, and here is what it said" is the answer the admin
				   screen could not previously give — a client that produced no
				   report is absent from the cache listing, and absence read as
				   "the refresh is not running". */
				onDemand.record(j.client, j.platform, err)
			}
		}()
	}

	for _, c := range clients {
		for _, p := range platforms {
			jobs <- job{p, c}
		}
	}
	close(jobs)
	wg.Wait()

	onDemand.finish()

	log.Printf("[report-cache] on-demand warm done — %d of %d built for %d client(s) over %d day(s) (%s → %s)",
		built, attempted, len(clients), days, from, to)
	return built, attempted
}

/*
The last on-demand warm, as something the screen can show while it runs.

The button answers immediately and the work takes minutes, so without this the
page has nothing to report between "started" and whenever the operator happens
to reload — and a client still queued looks exactly like a client that failed.
One request at a time is tracked, which is what the form can start.
*/
type onDemandState struct {
	mu       sync.Mutex
	running  bool
	started  time.Time
	finished time.Time
	days     int
	from     string
	to       string
	total    int
	done     int
	built    int
	// Per client, in the order they were asked for, so the screen lists what was
	// requested — including the ones nothing came back for.
	order   []string
	results map[string]*onDemandClient
}

type onDemandClient struct {
	Built     int
	Attempted int
	// The first thing that went wrong, which is what an operator acts on. Later
	// failures for the same client are almost always the same cause.
	Err string
}

var onDemand onDemandState

func (o *onDemandState) begin(clients, platforms []string, days int, from, to string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.running = true
	o.started = time.Now().UTC()
	o.finished = time.Time{}
	o.days, o.from, o.to = days, from, to
	o.total = len(clients) * len(platforms)
	o.done, o.built = 0, 0
	o.order = append([]string(nil), clients...)
	o.results = make(map[string]*onDemandClient, len(clients))
	for _, c := range clients {
		o.results[c] = &onDemandClient{}
	}
}

func (o *onDemandState) record(client, platform string, err error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.done++
	r := o.results[client]
	if r == nil {
		r = &onDemandClient{}
		o.results[client] = r
		o.order = append(o.order, client)
	}
	r.Attempted++
	if err != nil {
		if r.Err == "" {
			r.Err = platform + ": " + err.Error()
		}
		return
	}
	r.Built++
	o.built++
}

func (o *onDemandState) finish() {
	o.mu.Lock()
	o.running = false
	o.finished = time.Now().UTC()
	o.mu.Unlock()
}

/*
OnDemandWarmStatus is what the last "cache these clients" request is doing or
did, per client.

Reported even after it finishes, because the question it answers — "why is this
client not in the list" — is asked afterwards.
*/
func OnDemandWarmStatus() map[string]any {
	o := &onDemand
	o.mu.Lock()
	defer o.mu.Unlock()

	if o.started.IsZero() {
		return map[string]any{"ran": false}
	}
	clients := make([]map[string]any, 0, len(o.order))
	for _, id := range o.order {
		r := o.results[id]
		if r == nil {
			continue
		}
		clients = append(clients, map[string]any{
			"clientId": id, "built": r.Built, "attempted": r.Attempted, "error": r.Err,
		})
	}
	out := map[string]any{
		"ran": true, "running": o.running,
		"startedAt": o.started.Format(time.RFC3339),
		"days":      o.days, "from": o.from, "to": o.to,
		"total": o.total, "done": o.done, "built": o.built,
		"clients": clients,
	}

	/* How long the rest will take, measured rather than assumed.

	   The rate at which reports have actually completed, applied to the ones
	   left. No estimate from a per-report cost: what a report costs here is
	   dominated by waiting for the API's request budget, which depends on the
	   ceiling, on how much of it live traffic is using, and on the pass's own
	   concurrency. Elapsed-over-done captures all three without knowing any of
	   them. */
	if o.running && o.done > 0 && o.total > o.done {
		per := time.Since(o.started) / time.Duration(o.done)
		out["etaSeconds"] = int((per * time.Duration(o.total-o.done)) / time.Second)
	}
	if !o.started.IsZero() {
		end := o.finished
		if o.running {
			end = time.Now()
		}
		out["elapsedSeconds"] = int(end.Sub(o.started) / time.Second)
	}
	if !o.finished.IsZero() {
		out["finishedAt"] = o.finished.Format(time.RFC3339)
	}
	return out
}

// WarmPlatformCount is how many reports one client costs to warm — used to tell
// the operator what they are about to ask for before they ask for it.
func WarmPlatformCount() int {
	n := 0
	for _, p := range loadPlatforms() {
		if p.Enabled && p.Key != summaryKey {
			n++
		}
	}
	return n
}

// ValidWarmDays keeps a requested window inside what a report can actually be
// built for. A year and a half is already past every standing range; anything
// larger is a typo, and a typo here is an hour of warehouse time.
func ValidWarmDays(days int) (int, error) {
	switch {
	case days <= 0:
		return 0, fmt.Errorf("a number of days is required")
	case days > 550:
		return 0, fmt.Errorf("that is more than 550 days — pick a shorter window")
	}
	return days, nil
}
