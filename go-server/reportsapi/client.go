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

// DimByColumn maps a warehouse column to the dimension key that groups by it.
// The portal's specs are written in terms of columns; reports_api takes
// dimension keys. This is the join between the two vocabularies, and it comes
// from the service rather than from a table maintained here.
func (d Dataset) DimByColumn(col string) (string, bool) {
	for _, dim := range d.Dimensions {
		if strings.EqualFold(dim.Column, col) {
			return dim.Key, true
		}
	}
	return "", false
}

type Client struct {
	base string
	key  string
	http *http.Client

	mu       sync.RWMutex
	catalog  []Dataset
	fetched  time.Time
	catalogE error
}

var (
	once   sync.Once
	shared *Client
)

// Configured reports whether the portal should read through the API at all.
func Configured() bool { return strings.TrimSpace(os.Getenv("REPORTS_API_URL")) != "" }

// Get returns the shared client, built on first use.
func Get() *Client {
	once.Do(func() {
		shared = &Client{
			base: strings.TrimRight(strings.TrimSpace(os.Getenv("REPORTS_API_URL")), "/"),
			key:  strings.TrimSpace(os.Getenv("REPORTS_API_KEY")),
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

func (c *Client) BaseURL() string { return c.base }

/*
get performs one call and decodes it.

The key travels as a header and never in the query string: a key in a URL is
written to this service's access log, to every proxy between here and there, and
to anything that samples URLs for tracing.
*/
func (c *Client) get(ctx context.Context, path string, q url.Values, out any) error {
	u := c.base + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	if c.key != "" {
		req.Header.Set("X-API-Key", c.key)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("reports API unreachable: %w", err)
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
	c.mu.RLock()
	ttl := catalogTTL
	if c.catalogE != nil {
		ttl = catalogErrTTL
	}
	if time.Since(c.fetched) < ttl && (c.catalog != nil || c.catalogE != nil) {
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
	if err != nil {
		c.catalogE = err
		return nil, err
	}
	c.catalog, c.catalogE = body.Datasets, nil
	return c.catalog, nil
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
	qq := cloneValues(q)
	qq.Set("by", by)
	if limit > 0 {
		qq.Set("limit", strconv.Itoa(limit))
	}
	var body struct {
		Rows []map[string]any `json:"rows"`
	}
	if err := c.get(ctx, "/v1/sports/"+ds.Key+"/breakdown", qq, &body); err != nil {
		return nil, err
	}
	return body.Rows, nil
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

func cloneValues(v url.Values) url.Values {
	out := make(url.Values, len(v)+2)
	for k, vs := range v {
		out[k] = append([]string(nil), vs...)
	}
	return out
}
