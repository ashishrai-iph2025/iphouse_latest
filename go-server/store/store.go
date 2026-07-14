// Package store is the War Room's fail-soft incremental dataset store. It holds
// the MarkScan rows accumulated for each asset so the dashboard aggregates from
// a stored set and each refresh only pulls what changed (via updatedSince).
//
// Backed by Redis when REDIS_ADDR is set; otherwise (or if Redis is unreachable)
// it degrades to an in-process map with identical behaviour — never fatal, so the
// War Room keeps working without Redis, just without cross-restart persistence.
package store

import (
	"context"
	"encoding/json"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// Row is one MarkScan infringement record plus an injected "platform" field.
type Row = map[string]any

// TTL bounds how long an asset's accumulated set lives without a refresh.
const rowTTL = 7 * 24 * time.Hour

// Store is the interface the handler depends on. Both backends satisfy it.
type Store interface {
	// Rows returns every stored row for an asset key.
	Rows(ctx context.Context, key string) ([]Row, error)
	// Upsert inserts/updates rows keyed by their MarkScan "id".
	Upsert(ctx context.Context, key string, rows []Row) error
	// Reset clears every stored row and metadata for an asset key.
	Reset(ctx context.Context, key string) error
	// Meta returns the last successful fetch time, the startDate the stored
	// dataset covers from (YYYY-MM-DD, "" if unknown), and stored row count.
	Meta(ctx context.Context, key string) (lastFetch time.Time, coverageStart string, count int, ok bool)
	// SetMeta records the last successful fetch time and the coverage
	// startDate for an asset key.
	SetMeta(ctx context.Context, key string, lastFetch time.Time, coverageStart string) error
	// Kind reports the active backend ("redis" or "memory") for diagnostics.
	Kind() string
}

// Key normalises an asset name into a storage key ("_all" when unset).
func Key(assetName string) string {
	a := strings.ToLower(strings.TrimSpace(assetName))
	if a == "" {
		return "_all"
	}
	return a
}

func rowID(r Row) string {
	if v, ok := r["id"]; ok {
		if s, ok := v.(string); ok && s != "" {
			return s
		}
	}
	// Fall back to sourceURL so a row without an id still de-dupes sanely.
	if v, ok := r["sourceURL"]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

// New returns a Redis-backed store when addr is set and reachable, otherwise an
// in-memory store. A momentarily-unreachable Redis still returns the Redis store
// (go-redis reconnects); only an empty addr forces memory.
func New(addr string) Store {
	if strings.TrimSpace(addr) == "" {
		log.Printf("[warroom store] REDIS_ADDR not set — using in-memory store")
		return newMemStore()
	}
	rdb := redis.NewClient(&redis.Options{
		Addr:         addr,
		DialTimeout:  2 * time.Second,
		ReadTimeout:  3 * time.Second,
		WriteTimeout: 3 * time.Second,
	})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := rdb.Ping(ctx).Err(); err != nil {
		log.Printf("[warroom store] redis %s unreachable now (%v) — will retry per request", addr, err)
	} else {
		log.Printf("[warroom store] connected to redis at %s", addr)
	}
	return &redisStore{rdb: rdb, mem: newMemStore()}
}

// ─── Redis backend (with in-memory shadow for outages) ────────────────────────

type redisStore struct {
	rdb *redis.Client
	// mem is used transparently whenever a Redis op errors, so a mid-session Redis
	// outage doesn't lose the accumulated data or break the dashboard.
	mem *memStore
}

func (s *redisStore) Kind() string { return "redis" }

func (s *redisStore) rowsKey(key string) string { return "war:v1:" + key + ":rows" }
func (s *redisStore) metaKey(key string) string { return "war:v1:" + key + ":meta" }

func (s *redisStore) Rows(ctx context.Context, key string) ([]Row, error) {
	m, err := s.rdb.HGetAll(ctx, s.rowsKey(key)).Result()
	if err != nil {
		log.Printf("[warroom store] redis HGetAll failed (%v) — serving from memory", err)
		return s.mem.Rows(ctx, key)
	}
	out := make([]Row, 0, len(m))
	for _, v := range m {
		var r Row
		if json.Unmarshal([]byte(v), &r) == nil {
			out = append(out, r)
		}
	}
	return out, nil
}

func (s *redisStore) Upsert(ctx context.Context, key string, rows []Row) error {
	// Keep the in-memory shadow in lock-step so a later Redis outage is seamless.
	_ = s.mem.Upsert(ctx, key, rows)
	if len(rows) == 0 {
		return nil
	}
	pairs := make([]any, 0, len(rows)*2)
	for _, r := range rows {
		id := rowID(r)
		if id == "" {
			continue
		}
		b, err := json.Marshal(r)
		if err != nil {
			continue
		}
		pairs = append(pairs, id, b)
	}
	if len(pairs) == 0 {
		return nil
	}
	if err := s.rdb.HSet(ctx, s.rowsKey(key), pairs...).Err(); err != nil {
		log.Printf("[warroom store] redis HSet failed (%v) — kept in memory", err)
		return nil
	}
	s.rdb.Expire(ctx, s.rowsKey(key), rowTTL)
	return nil
}

func (s *redisStore) Reset(ctx context.Context, key string) error {
	_ = s.mem.Reset(ctx, key)
	if err := s.rdb.Del(ctx, s.rowsKey(key), s.metaKey(key)).Err(); err != nil {
		log.Printf("[warroom store] redis Del failed (%v) — kept in memory", err)
	}
	return nil
}

type metaBlob struct {
	LastFetch     time.Time `json:"lastFetch"`
	CoverageStart string    `json:"coverageStart"`
	Count         int       `json:"count"`
}

func (s *redisStore) Meta(ctx context.Context, key string) (time.Time, string, int, bool) {
	raw, err := s.rdb.Get(ctx, s.metaKey(key)).Bytes()
	if err != nil {
		return s.mem.Meta(ctx, key)
	}
	var mb metaBlob
	if json.Unmarshal(raw, &mb) != nil {
		return time.Time{}, "", 0, false
	}
	// count reflects the live hash length, not the stale meta snapshot.
	n, _ := s.rdb.HLen(ctx, s.rowsKey(key)).Result()
	return mb.LastFetch, mb.CoverageStart, int(n), true
}

func (s *redisStore) SetMeta(ctx context.Context, key string, lastFetch time.Time, coverageStart string) error {
	_ = s.mem.SetMeta(ctx, key, lastFetch, coverageStart)
	b, _ := json.Marshal(metaBlob{LastFetch: lastFetch, CoverageStart: coverageStart})
	if err := s.rdb.Set(ctx, s.metaKey(key), b, rowTTL).Err(); err != nil {
		log.Printf("[warroom store] redis SetMeta failed (%v) — kept in memory", err)
	}
	return nil
}

// ─── In-memory backend ────────────────────────────────────────────────────────

type memMeta struct {
	lastFetch     time.Time
	coverageStart string
}

type memStore struct {
	mu   sync.RWMutex
	data map[string]map[string]Row // key → id → row
	meta map[string]memMeta
}

func newMemStore() *memStore {
	return &memStore{data: map[string]map[string]Row{}, meta: map[string]memMeta{}}
}

func (s *memStore) Kind() string { return "memory" }

func (s *memStore) Rows(_ context.Context, key string) ([]Row, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	m := s.data[key]
	out := make([]Row, 0, len(m))
	for _, r := range m {
		out = append(out, r)
	}
	return out, nil
}

func (s *memStore) Upsert(_ context.Context, key string, rows []Row) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.data[key]
	if m == nil {
		m = map[string]Row{}
		s.data[key] = m
	}
	for _, r := range rows {
		if id := rowID(r); id != "" {
			m[id] = r
		}
	}
	return nil
}

func (s *memStore) Reset(_ context.Context, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.data, key)
	delete(s.meta, key)
	return nil
}

func (s *memStore) Meta(_ context.Context, key string) (time.Time, string, int, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	m, ok := s.meta[key]
	if !ok {
		return time.Time{}, "", 0, false
	}
	return m.lastFetch, m.coverageStart, len(s.data[key]), true
}

func (s *memStore) SetMeta(_ context.Context, key string, lastFetch time.Time, coverageStart string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.meta[key] = memMeta{lastFetch: lastFetch, coverageStart: coverageStart}
	return nil
}
