package reportcache

/*
What a cached report was built BY, folded into the key that stores it.

── The failure this exists to make impossible ────────────────────────────────

	The key was platform | client | dates | shape, where shape hashes the tables
	and panels a report draws. That covers a report whose CONFIGURATION changed
	and misses one whose CODE changed — and the numbers in a report are produced
	by code.

	It happened. The removal count for sports social media was fixed, shipped,
	and then not seen for hours: the shape was identical, so the key was
	identical, so every reader kept being served an entry built the day before
	with removed = 0. The retention window had just been raised to 24 hours, so
	it would have kept serving it until the next afternoon. The fix looked like
	it had not worked, and the next move — bumping a constant by hand — was one
	nobody would think of unless they already knew this was how it failed.

	A comment saying "bump this when the payload changes" is not a mechanism. It
	is a note asking every future change to remember something invisible, and it
	will be missed again, most likely by whoever is under the most pressure.

── What replaces it ──────────────────────────────────────────────────────────

	The identity of the running BUILD, in the key. A new binary cannot read the
	old binary's entries, so shipping a change to how a report is computed
	invalidates every report — automatically, with nothing to remember and
	nothing to press.

	Three sources, best first:

	  1. the VCS revision Go stamps into the binary (Go 1.18+, when built inside
	     a repository). Exact, free, and already there.
	  2. a hash of the executable itself. Works in any build — a Docker image
	     built from a copied tree has no VCS stamp — and changes precisely when
	     the binary does.
	  3. payloadVersion below, if neither is readable. A constant is the last
	     resort rather than the only line of defence.

	The cost is one read of the binary at startup, once, on a path that already
	waits on a database.

── What this deliberately does NOT do ────────────────────────────────────────

	It does not try to be clever about WHICH parts of the code affect a report.
	A dependency graph from handler to panel would be wrong the first time
	somebody changed a shared helper, and wrong silently. Invalidating
	everything on deploy costs one cold pass — minutes of warming that already
	happens on a schedule — and cannot be wrong.
*/

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"os"
	"runtime/debug"
	"strings"
	"sync"
)

/*
payloadVersion is the manual backstop, and the ONLY reason to change it is a
change that must invalidate the cache without the binary changing — which in
practice means never. The automatic sources above carry this normally.
*/
const payloadVersion = "v3"

var (
	engineOnce sync.Once
	engineTag  string
	engineHow  string
)

// engine returns the short tag identifying the running build.
func engine() string {
	engineOnce.Do(func() {
		if rev, ok := vcsRevision(); ok {
			engineTag, engineHow = payloadVersion+"-"+rev, "vcs revision"
			return
		}
		if sum, ok := binaryHash(); ok {
			engineTag, engineHow = payloadVersion+"-"+sum, "binary hash"
			return
		}
		/* Neither was readable. The constant still separates deliberate payload
		   changes, and the log says the automatic guard is not in force —
		   because an operator debugging "my fix is not showing" needs to know
		   that this is once again something someone has to remember. */
		engineTag, engineHow = payloadVersion, "the payload constant only"
		log.Printf("[report-cache] build identity unavailable; cache keys use %s. "+
			"A change to how reports are computed will NOT invalidate cached reports on its own.",
			payloadVersion)
	})
	return engineTag
}

// EngineTag is what the admin screen shows, so "is this entry from the build I
// just deployed" is a question the screen answers rather than one an operator
// has to infer from a timestamp.
func EngineTag() (tag, source string) {
	t := engine()
	return t, engineHow
}

func vcsRevision() (string, bool) {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return "", false
	}
	for _, s := range info.Settings {
		if s.Key == "vcs.revision" && len(s.Value) >= 12 {
			/* Dirty trees get the hash instead. A revision that does not
			   describe what is actually running is worse than no revision: two
			   different builds would share a key and one would serve the
			   other's reports. */
			for _, m := range info.Settings {
				if m.Key == "vcs.modified" && m.Value == "true" {
					return "", false
				}
			}
			return s.Value[:12], true
		}
	}
	return "", false
}

func binaryHash() (string, bool) {
	path, err := os.Executable()
	if err != nil {
		return "", false
	}
	f, err := os.Open(path)
	if err != nil {
		return "", false
	}
	defer f.Close()

	h := sha1.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", false
	}
	return hex.EncodeToString(h.Sum(nil))[:12], true
}

/*
── The key space ─────────────────────────────────────────────────────────────

	Functions rather than constants, because the tag is not known until the
	process has looked at itself.

	Everything a build writes lives under one prefix, so a build's whole
	footprint can be swept in one pass — see Sweep.
*/
func keyPrefix() string { return "rpt:" + engine() + ":" }
func metaKey() string   { return keyPrefix() + "__meta" }

/*
Sweep reports — and optionally removes — what PREVIOUS builds left behind.

Correctness does not depend on it. A new build simply cannot read an old build's
entries, so the stale data is already unreachable; this is about the MEMORY it
still occupies until its retention window expires, which under a 24-hour default
is a day of paying for reports nothing can read.

`apply` is false by default and the reason matters: during a rolling deploy the
previous container is still serving. Sweeping automatically at startup would
delete the working set of a process still using it, sending live requests cold
and inviting both builds to rewrite each other's keys. So the count is reported
on the admin screen and the deletion is a button — the operator knows whether
the old instance is gone; this code cannot.

SCAN, not KEYS: this runs against a keyspace with thousands of entries and must
not block Redis. Deletes are batched for the same reason.
*/
func (c *Cache) Sweep(ctx context.Context, apply bool) (int, error) {
	rdb := c.client()
	if rdb == nil {
		return 0, fmt.Errorf("cache is not connected")
	}
	keep := keyPrefix()
	var (
		cursor uint64
		found  int
		batch  = make([]string, 0, 256)
	)

	flush := func() error {
		if len(batch) == 0 || !apply {
			batch = batch[:0]
			return nil
		}
		err := rdb.Del(ctx, batch...).Err()
		batch = batch[:0]
		return err
	}

	for {
		keys, next, err := rdb.Scan(ctx, cursor, "rpt:*", 500).Result()
		if err != nil {
			return found, err
		}
		for _, k := range keys {
			if strings.HasPrefix(k, keep) {
				continue
			}
			found++
			batch = append(batch, k)
			if len(batch) >= 256 {
				if err := flush(); err != nil {
					return found, err
				}
			}
		}
		cursor = next
		if cursor == 0 {
			break
		}
	}
	if err := flush(); err != nil {
		return found, err
	}
	if apply && found > 0 {
		log.Printf("[report-cache] removed %d entrie(s) written by earlier builds", found)
	}
	return found, nil
}

// describeEngine is the line written at startup, so a deploy records which
// build's reports are being cached.
func describeEngine() string {
	tag, how := EngineTag()
	return fmt.Sprintf("cache keys are scoped to build %s (from %s)", tag, how)
}
