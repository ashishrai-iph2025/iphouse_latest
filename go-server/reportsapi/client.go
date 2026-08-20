// Package reportsapi talks to the reports_api service.
//
// It exists so the portal can render its reports WITHOUT warehouse credentials
// of its own. Set REPORTS_API_URL and the report engine stops opening a MySQL
// connection to the analytics server entirely: it asks reports_api for totals,
// trends and breakdowns over HTTP, and that service is the only thing holding a
// database password.
//
// That is the point of the arrangement, not a side effect. The portal is the
// internet-facing application; the warehouse credential it no longer has is a
// credential that cannot leak from it.
//
// Leave REPORTS_API_URL unset and nothing here runs — the engine keeps querying
// the warehouse directly, exactly as before. There is no migration to perform
// and no flag day: the switch is one environment variable, and it is reversible
// by removing it.
package reportsapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

/*
Dataset is one table reports_api will answer for, as IT describes itself.

Nothing here is written down twice. The portal does not keep its own list of
which dataset key corresponds to which warehouse table, which columns exist, or
which dimensions can be grouped — it reads all of that from
GET /v1/sports/datasets at run time. A dataset added over there becomes readable
here with no change to this code, and more importantly, the two cannot drift
into disagreeing about a column name.
*/
type Dataset struct {
	Key           string   `json:"key"`
	Label         string   `json:"label"`
	Table         string   `json:"table"`
	Group         string   `json:"group"`
	Measures      []string `json:"measures"`
	Columns       []string `json:"columns"`
	ClientParam   string   `json:"clientParam"`
	DateParam     string   `json:"dateParam"`
	DateFromParam string   `json:"dateFromParam"`
	DateToParam   string   `json:"dateToParam"`
	SupportsDelta bool     `json:"supportsDelta"`
	Dimensions    []Dim    `json:"dimensions"`
}

type Dim struct {
	Key         string `json:"key"`
	Column      string `json:"column"`
	LabelColumn string `json:"labelColumn"`
}

// HasMeasure reports whether this dataset can answer for a measure, so a caller
// asks for what exists rather than reading a zero for something the table does
// not record. The two are not the same answer and must not look alike.
func (d Dataset) HasMeasure(key string) bool {
	for _, m := range d.Measures {
		if m == key {
			return true
		}
	}
	return false
}

/*
DimByColumn maps a warehouse column to the dimension key that groups by it.

The portal's specs are written in terms of columns; reports_api takes dimension
keys. This is the join between the two vocabularies, and it comes from the
service rather than from a table maintained here.

LABEL COLUMNS COUNT, AND ARE TRIED FIRST.

The portal's specs name the column a reader should SEE — AssetName, CountryName,
GenreName, ChannelName — because a panel of GUIDs ranks rows nobody can identify
and a slicer of them cannot be picked from at all. reports_api almost never
offers those as groupable dimensions: it groups by the id and carries the name
as that dimension's `labelColumn`. Matching on `column` alone therefore missed
every name the portal asked for, and the panel and its slicer came back empty
with nothing to say why — which is exactly what "No data." on Assets, Country,
Language, Genre and Channels was.

Label BEFORE column, rather than as a fallback, because several datasets offer
both spellings: open-web has `assetId` (labelled AssetName) and a bare
`assetName`. Taking the label form on every dataset means each slicer holds ONE
kind of value across all of them — the id — and the summary merges several
datasets into one slicer. A slicer carrying ids from one table and names from
another filters correctly on neither.
*/
func (d Dataset) DimByColumn(col string) (string, bool) {
	if col == "" {
		return "", false
	}
	for _, dim := range d.Dimensions {
		if dim.LabelColumn != "" && strings.EqualFold(dim.LabelColumn, col) {
			return dim.Key, true
		}
	}
	for _, dim := range d.Dimensions {
		if strings.EqualFold(dim.Column, col) {
			return dim.Key, true
		}
	}
	return "", false
}

/*
ColumnForDim is the column the service actually GROUPS BY for a dimension key.

Not the same question as DimByColumn, and the difference matters to anything
that has to reproduce a breakdown's grouping from raw rows. The portal asks for
AssetName; the dataset offers `assetId`, grouped on AssetId and labelled with
AssetName — so the breakdown's `value` is the id, and tallying rows by the name
would match none of them.
*/
func (d Dataset) ColumnForDim(key string) string {
	for _, dim := range d.Dimensions {
		if dim.Key == key {
			return dim.Column
		}
	}
	return ""
}

/*
Master is one lookup list — the table an id in a report resolves against.

Kept apart from Dataset because it is a different kind of thing and reports_api
lists it separately: a dataset is a fact table with millions of rows, a client
scope and a date; a master is thirty-eight search engines with neither. The
portal needs them for the dimensions a fact table records ONLY as an id and
carries no name beside — the social dashboard is entirely like this — where
there is no labelColumn for a breakdown to read and the row would otherwise be
drawn as a GUID.
*/
type Master struct {
	Key            string `json:"key"`
	Label          string `json:"label"`
	Table          string `json:"table"`
	IDColumn       string `json:"idColumn"`
	NameColumn     string `json:"nameColumn"`
	ClientRequired bool   `json:"clientRequired"`
}

type Client struct {
	http *http.Client

	mu      sync.RWMutex
	catalog []Dataset
	fetched time.Time
	// The credentials the cached catalogue was fetched WITH. Pointing the portal
	// at a different service, or fixing a wrong key, must not keep serving the
	// answer the old one gave — including the cached error.
	catalogFor string
	catalogE   error

	// The master registry, cached on the same terms as the dataset catalogue.
	masters    []Master
	mastersAt  time.Time
	mastersFor string
	mastersE   error

	// Resolved id → name maps, per master and per client. Held longer than the
	// catalogue because a lookup table is what changes least in the warehouse,
	// and re-fetching 126k assets for every panel of every report would cost
	// more than the report.
	names map[string]nameSet

	// The client master, held on the same terms. Its own slot rather than a
	// nameSet, because it answers two questions — every company, and the ones
	// still active — from one fetch.
	clientMasters map[string]clientMasterSet
}

type nameSet struct {
	at  time.Time
	m   map[string]string
	err error
}

// One fetch of the client master, holding both answers it supports: every
// company it lists, and the ones it still marks active.
type clientMasterSet struct {
	at        time.Time
	all       map[string]string
	active    map[string]string
	sawActive bool
	err       error
}

var (
	once   sync.Once
	shared *Client

	srcMu sync.RWMutex
	src   = envSource
)

/*
Where the base URL and key come from.

Env by default, so an install that configures nothing behaves exactly as it did.
SetSource replaces it with the stored configuration — see
handlers/admin/reportsapiconfig.go — which is what lets the pair be changed from
the Configuration screen without a redeploy or a restart.

A function rather than a value because the answer CHANGES: the whole point of
storing it is that someone can rotate the key at 3pm and have the next request
use it.
*/
func envSource() (string, string) {
	return os.Getenv("REPORTS_API_URL"), os.Getenv("REPORTS_API_KEY")
}

// SetSource installs a different provider. Called once at startup.
func SetSource(fn func() (base, key string)) {
	srcMu.Lock()
	defer srcMu.Unlock()
	if fn != nil {
		src = fn
	}
}

func current() (base, key string) {
	srcMu.RLock()
	fn := src
	srcMu.RUnlock()
	b, k := fn()
	return strings.TrimRight(strings.TrimSpace(b), "/"), strings.TrimSpace(k)
}

// Configured reports whether the portal should read through the API at all.
func Configured() bool { b, _ := current(); return b != "" }

// Get returns the shared client. Only the HTTP transport and the catalogue
// cache live on it; the credentials are read per call, so a change takes effect
// on the next request rather than the next restart.
func Get() *Client {
	once.Do(func() {
		shared = &Client{
			http: &http.Client{
				// Generous, because an aggregate over a client's slice of a
				// 3M-row table is genuinely slow — but bounded, because a report
				// page must not hold a portal worker open indefinitely.
				Timeout: envDuration("REPORTS_API_TIMEOUT_SECONDS", 90*time.Second),
			},
		}
	})
	return shared
}

func envDuration(k string, def time.Duration) time.Duration {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return time.Duration(n) * time.Second
		}
	}
	return def
}

// BaseURL is what the portal is currently pointed at — read live, because it is
// used in error messages and one that names the previous target is worse than
// none.
func (c *Client) BaseURL() string { b, _ := current(); return b }

/*
get performs one call and decodes it.

The key travels as a header and never in the query string: a key in a URL is
written to this service's access log, to every proxy between here and there, and
to anything that samples URLs for tracing.
*/
/*
GetJSON is one GET against the service, decoded into `out`.

Exported for endpoints the portal PASSES THROUGH rather than assembles — the
realtime counts are the service's own answer, and re-describing their shape here
would be a second definition to keep in step. Everything else in this package
should use a typed method instead: a caller naming a path is a caller that can
be pointed at the wrong one.
*/
func (c *Client) GetJSON(ctx context.Context, path string, q url.Values, out any) error {
	return c.get(ctx, path, q, out)
}

func (c *Client) get(ctx context.Context, path string, q url.Values, out any) error {
	base, key := current()
	if base == "" {
		return fmt.Errorf("no reports API base URL is configured")
	}
	/* Wait for room in the request budget before sending. The service counts
	   per address and the portal is one address, so without this the cache
	   warmer's thousand-odd calls a pass spend the same allowance as the page
	   somebody has open — and the refusals land on the page. See pace.go. */
	if err := budget.take(ctx); err != nil {
		return err
	}
	u := base + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	if key != "" {
		req.Header.Set("X-API-Key", key)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("reports API unreachable: %w", err)
	}

	/* A 429 despite the pacing means something else is calling from this
	   address. Honour the Retry-After once rather than surfacing an error that
	   empties a panel — the caller's own timeout still bounds the wait. */
	if resp.StatusCode == http.StatusTooManyRequests {
		if d, ok := retryAfter(resp.Header.Get("Retry-After")); ok {
			io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
			resp.Body.Close()
			t := time.NewTimer(d)
			select {
			case <-t.C:
				if err := budget.take(ctx); err != nil {
					return err
				}
				req2, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
				if err != nil {
					return err
				}
				if key != "" {
					req2.Header.Set("X-API-Key", key)
				}
				if resp, err = c.http.Do(req2); err != nil {
					return fmt.Errorf("reports API unreachable: %w", err)
				}
			case <-ctx.Done():
				t.Stop()
				return ctx.Err()
			}
		}
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if resp.StatusCode != http.StatusOK {
		// The service answers errors as JSON with a readable `error`; surface
		// that rather than a bare status, because it usually says exactly what
		// is wrong ("ClientId is required", "Unknown dimension: foo").
		var e struct {
			Error  string `json:"error"`
			Detail string `json:"detail"`
		}
		if json.Unmarshal(body, &e) == nil && e.Error != "" {
			if e.Detail != "" {
				return fmt.Errorf("reports API: %s — %s", e.Error, e.Detail)
			}
			return fmt.Errorf("reports API: %s", e.Error)
		}
		return fmt.Errorf("reports API returned %d", resp.StatusCode)
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(body, out)
}

const (
	catalogTTL = 5 * time.Minute
	// A FAILURE is held for far less time than a success. Five minutes of
	// cached "unreachable" after the service comes back is five minutes of a
	// portal insisting nothing can be read while everything can — but retrying
	// on every panel of every request would turn one outage into a stampede.
	catalogErrTTL = 15 * time.Second
)

/*
Catalog returns the dataset list, cached.

Cached because every panel on a report needs it and it changes only when the
other service is redeployed; re-fetched after a few minutes so that a deploy is
picked up without restarting the portal. A failure is cached too, briefly — a
warehouse that is down should not turn one slow page into a hundred retries.
*/
func (c *Client) Catalog(ctx context.Context) ([]Dataset, error) {
	/* Keyed on the credentials it was fetched with. Rotating a key or repointing
	   the base URL has to take effect NOW — the reason someone changes either is
	   usually that the current one is wrong, and answering them from a cache
	   filled by the wrong one is answering the question they just fixed. */
	base, key := current()
	fingerprint := base + "\x00" + key

	c.mu.RLock()
	ttl := catalogTTL
	if c.catalogE != nil {
		ttl = catalogErrTTL
	}
	if c.catalogFor == fingerprint && time.Since(c.fetched) < ttl &&
		(c.catalog != nil || c.catalogE != nil) {
		defer c.mu.RUnlock()
		return c.catalog, c.catalogE
	}
	c.mu.RUnlock()

	var body struct {
		Datasets []Dataset `json:"datasets"`
	}
	err := c.get(ctx, "/v1/sports/datasets", nil, &body)

	c.mu.Lock()
	defer c.mu.Unlock()
	c.fetched = time.Now()
	c.catalogFor = fingerprint
	if err != nil {
		c.catalogE = err
		return nil, err
	}
	c.catalog, c.catalogE = body.Datasets, nil
	return c.catalog, nil
}

/*
Masters returns the lookup registry, cached exactly as Catalog is.

Same fingerprinting, same short cache on failure, and for the same reasons —
see Catalog. Kept as its own call rather than folded into the catalogue because
reports_api serves them separately and a service too old to know /v1/masters
should lose only the id-to-name resolution, not every report on the page.
*/
func (c *Client) Masters(ctx context.Context) ([]Master, error) {
	base, key := current()
	fingerprint := base + "\x00" + key

	c.mu.RLock()
	ttl := catalogTTL
	if c.mastersE != nil {
		ttl = catalogErrTTL
	}
	if c.mastersFor == fingerprint && time.Since(c.mastersAt) < ttl &&
		(c.masters != nil || c.mastersE != nil) {
		defer c.mu.RUnlock()
		return c.masters, c.mastersE
	}
	c.mu.RUnlock()

	var body struct {
		Masters []Master `json:"masters"`
	}
	err := c.get(ctx, "/v1/masters", nil, &body)

	c.mu.Lock()
	defer c.mu.Unlock()
	c.mastersAt = time.Now()
	c.mastersFor = fingerprint
	if err != nil {
		c.mastersE = err
		return nil, err
	}
	c.masters, c.mastersE = body.Masters, nil
	return c.masters, nil
}

// MasterByTable finds the lookup that serves a warehouse table. The portal's
// dimension registry names lookups by table — mediascan.Asset — so this is how
// a declared lookup resolves to something the API will answer for.
func (c *Client) MasterByTable(ctx context.Context, table string) (Master, bool) {
	ms, err := c.Masters(ctx)
	if err != nil {
		return Master{}, false
	}
	for _, m := range ms {
		if strings.EqualFold(m.Table, table) {
			return m, true
		}
	}
	return Master{}, false
}

// masterNameTTL is how long a resolved lookup is held. Long, because these are
// the slowest-changing rows in the warehouse and every panel on every report
// reads them.
const masterNameTTL = 30 * time.Minute

/*
MasterNames resolves one lookup to an id → name map.

clientID is required for the masters that declare it (only Asset, which is 126k
rows across every client) and ignored by the rest. An unknown master, an
unreachable service or a warehouse error all return an error rather than an
empty map: a caller that cannot tell "no names exist" from "the names could not
be fetched" will happily render the ids and let the reader believe they are
names.
*/
func (c *Client) MasterNames(ctx context.Context, key, clientID string) (map[string]string, error) {
	m, ok := c.masterByKey(ctx, key)
	if !ok {
		return nil, fmt.Errorf("reports API serves no master named %q", key)
	}
	if m.ClientRequired && strings.TrimSpace(clientID) == "" {
		return nil, fmt.Errorf("master %q is client-scoped and no client was given", key)
	}

	base, apiKey := current()
	cacheKey := base + "\x00" + apiKey + "\x00" + key + "\x00" + clientID

	c.mu.RLock()
	if e, ok := c.names[cacheKey]; ok {
		ttl := masterNameTTL
		if e.err != nil {
			ttl = catalogErrTTL
		}
		if time.Since(e.at) < ttl {
			defer c.mu.RUnlock()
			return e.m, e.err
		}
	}
	c.mu.RUnlock()

	q := url.Values{}
	if m.ClientRequired {
		q.Set("ClientMasterId", clientID)
	}
	// The service caps this itself; asking for its maximum keeps a lookup from
	// being silently cut in half, which would resolve some rows and not others
	// — the worst of the three possible outcomes, because it looks like data.
	q.Set("limit", "100000")

	var body struct {
		Rows      []map[string]any `json:"rows"`
		Truncated bool             `json:"truncated"`
	}
	err := c.get(ctx, "/v1/masters/"+key, q, &body)

	var out map[string]string
	if err == nil {
		out = make(map[string]string, len(body.Rows))
		for _, r := range body.Rows {
			id := strOf(r[m.IDColumn])
			name := strOf(r[m.NameColumn])
			if id != "" && name != "" {
				out[strings.ToLower(id)] = name
			}
		}
	}

	c.mu.Lock()
	if c.names == nil {
		c.names = map[string]nameSet{}
	}
	c.names[cacheKey] = nameSet{at: time.Now(), m: out, err: err}
	c.mu.Unlock()
	return out, err
}

func (c *Client) masterByKey(ctx context.Context, key string) (Master, bool) {
	ms, err := c.Masters(ctx)
	if err != nil {
		return Master{}, false
	}
	for _, m := range ms {
		if m.Key == key {
			return m, true
		}
	}
	return Master{}, false
}

// strOf renders a JSON scalar as the string the warehouse would have stored.
// Ids arrive as numbers on some masters and as strings on others, and a map
// keyed on "%v" of a float64 would key 42 as "42" from one and "42.0" from the
// other.
func strOf(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(t)
	case float64:
		if t == float64(int64(t)) {
			return strconv.FormatInt(int64(t), 10)
		}
		return strconv.FormatFloat(t, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(t)
	}
	return strings.TrimSpace(fmt.Sprint(v))
}

/*
Schema lists every table in a warehouse schema, with sizes and whether this API
already serves it — GET /v1/admin/schema.

NOT cached. The dataset catalogue is a list of what this service is configured
to answer for and changes only on deploy; this is the state of the database
itself, read by someone who has come to look at exactly that. A stale answer
here is worse than a slow one.

`schema` empty means the warehouse this service is pointed at. `q` is a
contains-match on the table name, applied by the service.

This lives under /v1/admin rather than /v1/sports, which is a different gate:
the far side restricts it by address as well as by credential. A portal outside
that allowlist gets a refusal that names neither — hence the error being
returned verbatim rather than folded into "unavailable".
*/
func (c *Client) Schema(ctx context.Context, schema, q string) (map[string]any, error) {
	v := url.Values{}
	if s := strings.TrimSpace(schema); s != "" {
		v.Set("schema", s)
	}
	if t := strings.TrimSpace(q); t != "" {
		v.Set("q", t)
	}
	var body map[string]any
	if err := c.get(ctx, "/v1/admin/schema", v, &body); err != nil {
		return nil, err
	}
	return body, nil
}

// ByTable finds the dataset that serves a warehouse table. The portal's own
// configuration is written in table names, so this is how a configured platform
// resolves to something the API will answer for.
func (c *Client) ByTable(ctx context.Context, table string) (Dataset, bool) {
	sets, err := c.Catalog(ctx)
	if err != nil {
		return Dataset{}, false
	}
	for _, d := range sets {
		if strings.EqualFold(d.Table, table) {
			return d, true
		}
	}
	return Dataset{}, false
}

// Summary is the KPI band: one row of totals over everything the filters select.
func (c *Client) Summary(ctx context.Context, ds Dataset, q url.Values) (map[string]any, error) {
	var body struct {
		Summary map[string]any `json:"summary"`
	}
	if err := c.get(ctx, "/v1/sports/"+ds.Key+"/summary", q, &body); err != nil {
		return nil, err
	}
	return body.Summary, nil
}

// Timeseries is the trend: every measure per bucket.
func (c *Client) Timeseries(ctx context.Context, ds Dataset, q url.Values, bucket string) ([]map[string]any, error) {
	qq := cloneValues(q)
	qq.Set("bucket", bucket)
	var body struct {
		Points []map[string]any `json:"points"`
	}
	if err := c.get(ctx, "/v1/sports/"+ds.Key+"/timeseries", qq, &body); err != nil {
		return nil, err
	}
	return body.Points, nil
}

// BreakdownRow is one grouped row. Value is what a drill-down filters on; Label
// is what a reader sees. They differ wherever the grouping column is an id.
type BreakdownRow struct {
	Value  string         `json:"grp"`
	Label  string         `json:"label"`
	Fields map[string]any `json:"-"`
}

// Breakdown groups by one dimension and returns its rows with every measure.
func (c *Client) Breakdown(ctx context.Context, ds Dataset, q url.Values, by string, limit int) ([]map[string]any, error) {
	rows, _, err := c.BreakdownFull(ctx, ds, q, by, limit)
	return rows, err
}

/*
BreakdownAll is the limit the service reads as "every group".

A caller that AGGREGATES a breakdown rather than drawing it — folding hostnames
into the operator behind them — is wrong by however much the tail was cut, and
cut silently. A breakdown is bounded by how many distinct values there are, not
by how many rows were scanned: a million rows of one sports table collapse to
about five thousand domains.
*/
const BreakdownAll = 0

/*
BreakdownFull is Breakdown, plus whether the service cut the tail off.

The flag matters to anything that adds the rows up. A top-N panel is honestly a
top-N and says so in its title; a total computed from a truncated list is just
wrong, and nothing about the number says which it is.
*/
func (c *Client) BreakdownFull(ctx context.Context, ds Dataset, q url.Values, by string, limit int) ([]map[string]any, bool, error) {
	qq := cloneValues(q)
	qq.Set("by", by)
	if limit > 0 {
		qq.Set("limit", strconv.Itoa(limit))
	} else {
		// The vocabulary /v1/masters already uses, now accepted on breakdowns.
		qq.Set("limit", "all")
	}
	var body struct {
		Rows      []map[string]any `json:"rows"`
		Truncated bool             `json:"truncated"`
	}
	if err := c.get(ctx, "/v1/sports/"+ds.Key+"/breakdown", qq, &body); err != nil {
		return nil, false, err
	}
	return body.Rows, body.Truncated, nil
}

/*
Clients lists the companies the warehouse holds data for.

The one call here that names no client, because it is what a client PICKER is
built from — everything else refuses a request that does not name one, and a
picker cannot name the client it exists to let someone choose. reports_api
caches it; this does not, so a newly onboarded client appears as soon as the far
side's own window rolls over.
*/
func (c *Client) Clients(ctx context.Context) ([]map[string]any, error) {
	var body struct {
		Clients []map[string]any `json:"clients"`
	}
	if err := c.get(ctx, "/v1/sports/clients", nil, &body); err != nil {
		return nil, err
	}
	return body.Clients, nil
}

// clientMasterTable is the warehouse's own company list — the same table the
// direct-SQL path joins to put a name beside a client id.
const clientMasterTable = "mediascan.ClientMaster"

/*
ClientDirectory is every company the warehouse KEEPS, id → name, read from the
client master rather than from the fact tables.

Clients() answers from the sports datasets, so it knows a company only once rows
exist for it there. That is right for a picker and wrong for naming something
already cached: an entry written when staff opened a report for a client outside
that set had nothing to resolve against and was drawn as a bare GUID. The master
is the list the warehouse maintains, so an id that resolves nowhere else
resolves here.

Two maps, because the two questions are different. `all` names everything the
master holds, including companies the warehouse has retired — a report cached
for one before it was retired still has to be legible on the admin screen.
`active` is the subset a picker may offer, which is the one an operator is
choosing FROM.

`sawActive` says whether the master carried an activity column at all. Where it
does not, `active` is a copy of `all`: filtering on a field the service does not
return would empty every picker in the product, which is a worse answer than an
unfiltered one.

Ids keep the case the warehouse stores them in. They are cache keys and warm
targets, and a lowercased GUID would build a SECOND cached copy of a client that
already had one.
*/
func (c *Client) ClientDirectory(ctx context.Context) (all, active map[string]string, sawActive bool, err error) {
	// Defaults rather than a hard requirement on the registry: a service that
	// serves /v1/masters/clients but does not list the table under that name
	// should still answer, and these are the column names it returns.
	key, idCol, nameCol := "clients", "Id", "CompanyName"
	if m, ok := c.MasterByTable(ctx, clientMasterTable); ok {
		key = m.Key
		if m.IDColumn != "" {
			idCol = m.IDColumn
		}
		if m.NameColumn != "" {
			nameCol = m.NameColumn
		}
	}

	base, apiKey := current()
	cacheKey := base + "\x00" + apiKey + "\x00__clients\x00" + key

	c.mu.RLock()
	if e, ok := c.clientMasters[cacheKey]; ok {
		ttl := masterNameTTL
		if e.err != nil {
			ttl = catalogErrTTL
		}
		if time.Since(e.at) < ttl {
			defer c.mu.RUnlock()
			return e.all, e.active, e.sawActive, e.err
		}
	}
	c.mu.RUnlock()

	q := url.Values{}
	q.Set("limit", "100000")

	var body struct {
		Rows []map[string]any `json:"rows"`
	}
	err = c.get(ctx, "/v1/masters/"+key, q, &body)

	if err == nil {
		all = make(map[string]string, len(body.Rows))
		active = make(map[string]string, len(body.Rows))
		for _, r := range body.Rows {
			id := fieldOf(r, idCol, "Id", "ClientMasterId", "ClientId")
			name := fieldOf(r, nameCol, "CompanyName", "ClientName", "Name")
			if id == "" || name == "" {
				continue
			}
			all[id] = name
			on, had := activeFlag(r)
			if had {
				sawActive = true
			}
			if on {
				active[id] = name
			}
		}
		// The column was never seen on any row: there is nothing to filter by,
		// so everything is offered rather than nothing.
		if !sawActive {
			active = all
		}
	}

	c.mu.Lock()
	if c.clientMasters == nil {
		c.clientMasters = map[string]clientMasterSet{}
	}
	c.clientMasters[cacheKey] = clientMasterSet{
		at: time.Now(), all: all, active: active, sawActive: sawActive, err: err}
	c.mu.Unlock()
	return all, active, sawActive, err
}

/*
activeFlag reads whether a master row is still live.

Several spellings and several encodings, because this is one column in somebody
else's schema and it arrives as 1, "1", true, "Y" or "Active" depending on the
service and the JSON decoder in front of it. `had` distinguishes "the row says
inactive" from "the row does not say" — only the first is a reason to hide a
company.
*/
func activeFlag(r map[string]any) (on, had bool) {
	for _, name := range []string{"Active", "IsActive", "active", "isActive"} {
		v, ok := r[name]
		if !ok {
			// Case-insensitively too: the service spells its own columns.
			for k, vv := range r {
				if strings.EqualFold(k, name) {
					v, ok = vv, true
					break
				}
			}
		}
		if !ok || v == nil {
			continue
		}
		switch t := v.(type) {
		case bool:
			return t, true
		case float64:
			return t != 0, true
		case int:
			return t != 0, true
		case string:
			switch strings.ToLower(strings.TrimSpace(t)) {
			case "1", "true", "y", "yes", "active":
				return true, true
			case "0", "false", "n", "no", "inactive", "":
				return false, true
			}
		}
	}
	return false, false
}

// fieldOf reads the first of several spellings a row might use for one field,
// exact matches first and then ignoring case. The registry names the columns and
// is believed; the fallbacks exist so one renamed column does not turn a table
// of company names back into a table of GUIDs.
func fieldOf(r map[string]any, names ...string) string {
	for _, n := range names {
		if n == "" {
			continue
		}
		if s := strOf(r[n]); s != "" {
			return s
		}
	}
	for k, v := range r {
		for _, n := range names {
			if n != "" && strings.EqualFold(k, n) {
				if s := strOf(v); s != "" {
					return s
				}
			}
		}
	}
	return ""
}

/*
ProbeResult is what a trial of a URL and key found.

Three separate facts, because they fail separately and are fixed differently:
reachable says the address resolves and answers; authorized says the key is
accepted; warehouse says the far service can reach its own database. Collapsing
them into one boolean would send someone to check a key when the fault is DNS.
*/
type ProbeResult struct {
	Reachable   bool
	Authorized  bool
	WarehouseOK bool
	Datasets    int
	Detail      string
}

/*
Probe tries a base URL and key WITHOUT installing them.

Used by the Configuration screen so a key can be verified before it is saved —
otherwise saving is the only way to find out, and a wrong one is discovered
later by someone who did not make the change.

It deliberately does not touch the shared client's cache: this is a trial of
values that may never be adopted.
*/
func Probe(ctx context.Context, base, key string) ProbeResult {
	var out ProbeResult
	base = strings.TrimRight(strings.TrimSpace(base), "/")
	if base == "" {
		out.Detail = "No base URL given"
		return out
	}
	hc := &http.Client{Timeout: 15 * time.Second}

	do := func(path string) (int, []byte, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+path, nil)
		if err != nil {
			return 0, nil, err
		}
		if key != "" {
			req.Header.Set("X-API-Key", key)
		}
		resp, err := hc.Do(req)
		if err != nil {
			return 0, nil, err
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return resp.StatusCode, b, nil
	}

	// /health needs no key, so it separates "cannot reach it" from "key wrong".
	code, body, err := do("/health")
	if err != nil {
		out.Detail = err.Error()
		return out
	}
	out.Reachable = true
	var h struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	json.Unmarshal(body, &h)
	out.WarehouseOK = h.OK
	if !h.OK && h.Error != "" {
		out.Detail = "The service is reachable but reports: " + h.Error
	}
	if code != http.StatusOK && out.Detail == "" {
		out.Detail = fmt.Sprintf("/health returned %d", code)
	}

	// Then the key, against the one endpoint the portal cannot work without.
	code, body, err = do("/v1/sports/datasets")
	if err != nil {
		if out.Detail == "" {
			out.Detail = err.Error()
		}
		return out
	}
	switch {
	case code == http.StatusOK:
		out.Authorized = true
		var d struct {
			Datasets []struct{} `json:"datasets"`
		}
		json.Unmarshal(body, &d)
		out.Datasets = len(d.Datasets)
		if out.Datasets == 0 && out.Detail == "" {
			out.Detail = "Authorized, but the service reports no datasets."
		}
	case code == http.StatusUnauthorized || code == http.StatusForbidden:
		out.Detail = "The key was rejected (HTTP " + fmt.Sprint(code) + ")."
	default:
		if out.Detail == "" {
			out.Detail = fmt.Sprintf("/v1/sports/datasets returned %d", code)
		}
	}
	return out
}

// Health is what the portal's own /api/reports/health reports when the engine is
// reading through the API: whether the SERVICE is reachable and whether IT can
// reach the warehouse. Two hops, two ways to fail, and the page should be able
// to tell them apart.
func (c *Client) Health(ctx context.Context) (ok bool, database string, err error) {
	var body struct {
		OK       bool   `json:"ok"`
		Database string `json:"database"`
		Error    string `json:"error"`
	}
	if err := c.get(ctx, "/health", nil, &body); err != nil {
		return false, "", err
	}
	if !body.OK {
		return false, body.Database, fmt.Errorf("reports API cannot reach the warehouse: %s", body.Error)
	}
	return true, body.Database, nil
}

// CloneValues copies a scope so a caller can add a filter to it without
// disturbing the one the rest of the report is using.
func CloneValues(q url.Values) url.Values { return cloneValues(q) }

func cloneValues(v url.Values) url.Values {
	out := make(url.Values, len(v)+2)
	for k, vs := range v {
		out[k] = append([]string(nil), vs...)
	}
	return out
}

/*
── Raw rows ──────────────────────────────────────────────────────────────────

	Everything else here is an aggregate, because a report is a set of totals and
	asking the warehouse to add them up is the whole point of the service.

	Turnaround is the exception, and it is a real one. The band a removal falls
	into is RemovalTime minus DiscoveryDoneAt, and the service groups by COLUMNS:
	the two timestamps are on the row but there is no dimension over the interval
	between them, so no breakdown can answer it. Reading the rows and doing the
	subtraction here is the only way to compute it without changing the service.

	Bounded on purpose. Rows are the expensive shape and this is the only caller
	that asks for them, so it pages with a cap and reports when the cap was hit
	rather than quietly describing part of a month as if it were all of it.
*/

// RowPageMax is the largest page the service will serve (its MAX_LIMIT).
const RowPageMax = 5000

/*
Rows reads one page of raw rows for a scope, newest-cursor last.

`cursor` is empty for the first page; the value returned comes back on the next
call. Keyset paging, so a feed being written while it is read cannot serve the
same row twice or skip one — see the service's rows.go.
*/
func (c *Client) Rows(ctx context.Context, ds Dataset, q url.Values, limit int, cursor string) (rows []map[string]any, next string, more bool, err error) {
	qq := cloneValues(q)
	if limit <= 0 || limit > RowPageMax {
		limit = RowPageMax
	}
	qq.Set("limit", strconv.Itoa(limit))
	if cursor != "" {
		qq.Set("cursor", cursor)
	}
	var body struct {
		Rows       []map[string]any `json:"rows"`
		NextCursor string           `json:"nextCursor"`
		HasMore    bool             `json:"hasMore"`
	}
	// The dataset's own path with no suffix — /v1/sports/social is the rows
	// endpoint, /v1/sports/social/breakdown is the aggregate over it.
	if err := c.get(ctx, "/v1/sports/"+ds.Key, qq, &body); err != nil {
		return nil, "", false, err
	}
	return body.Rows, body.NextCursor, body.HasMore, nil
}
