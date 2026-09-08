package handlers

/*
Which platforms the live counts card lists SEPARATELY, and which it rolls up.

The sports card sits over a report covering fifteen platforms, of which a fixture
usually touches three or four. It already drops the ones that found nothing; this
is the other half of the same problem — a client who cares about Facebook and
TikTok and nothing else on the social side still gets a row for every
account-based platform that happened to catch a clip.

So the UGC and social platforms become a CHOICE, made per platform report and per
client on the same Report Configuration screen that already names, resizes and
describes the card. A platform that is rolled up is not hidden: its count is
summed into one "UGC & Social Media" row, which is the difference between a tidier
card and a card that under-reports.

── Why the stored list is the ones ROLLED UP, not the ones shown ─────────────

Both express the same configuration and only one of them survives the day a new
platform appears upstream. Storing what is SHOWN would leave a platform the
service starts counting next month absent from every stored list, and it would
disappear into the rollup for every client already configured — the first anyone
would know is a number that had quietly stopped being broken out.

Storing what is rolled up defaults a new platform to its own row: visible, and
somebody can then decide to fold it. An empty list folds nothing, which is exactly
what every install does today, so none of this changes a card until it is used.
*/

import (
	"log"
	"strings"
	"sync"

	"github.com/ip-house/iphouse-api/db"
)

/*
The families a platform must be in to be configurable here.

Read off the FAMILY the counts service reports for each platform rather than off
a list of platform names kept here — the same rule the rest of this file follows,
and for the same reason: a platform this portal has never heard of still lands in
the right group, and one that moves between groups moves without an edit here.

Open Web is deliberately not among them. It carries most of the volume on every
sports report, and a control that can fold it into an "other" row is a control
that can make the card understate by an order of magnitude with one tick.
*/
var realtimeRollupFamilies = map[string]bool{"ugc": true, "social": true}

// isRollupCandidate says whether this platform may be folded away.
func isRollupCandidate(p RealtimePlatform) bool {
	return realtimeRollupFamilies[strings.ToLower(strings.TrimSpace(p.Family))]
}

/*
The row every folded platform is summed into.

Its key is one the service does not use, deliberately. A key that could collide
with a real platform would be summed into that platform on the next reading and
the card would report the same counts twice.
*/
const (
	realtimeRollupKey    = "rollup:ugc-social"
	realtimeRollupLabel  = "UGC & Social Media"
	realtimeRollupFamily = "social"
)

/*
── The platform catalogue ────────────────────────────────────────────────────

	The configuration screen has to list the platforms an admin may fold, and the
	only authority on what those are is the counts service. Asking it live would
	put a warehouse count behind opening a settings screen — and would answer with
	nothing at all when the screen is opened on the all-clients default, which has
	no client to count for.

	So the portal REMEMBERS. Every reading records the platforms it carried and the
	screen reads that back. It accumulates rather than replacing: a platform that
	answered last week and is quiet this week still has to be configurable, or a
	quiet fortnight would take a client's own setting off the screen while it
	stayed in force.

	Label and family are refreshed on every sighting, so a platform the service
	renames is renamed here too.
*/

const realtimePlatformTable = "report_realtime_platforms"

var realtimePlatformSchemaOnce sync.Once

func ensureRealtimePlatformSchema() {
	realtimePlatformSchemaOnce.Do(func() {
		if _, _, err := db.Exec(`
			CREATE TABLE IF NOT EXISTS ` + realtimePlatformTable + ` (
			  platform_key VARCHAR(64)  NOT NULL,
			  label        VARCHAR(191) NOT NULL DEFAULT '',
			  family       VARCHAR(64)  NOT NULL DEFAULT '',
			  last_seen    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
			  PRIMARY KEY (platform_key)
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`); err != nil {
			log.Printf("[realtime] create %s: %v", realtimePlatformTable, err)
		}
	})
}

/*
rememberRealtimePlatforms records what a reading carried.

Fire and forget, and it must stay that way: this is bookkeeping for a settings
screen, and a portal database that is briefly unavailable must not turn a live
count into an error on a report. Failures are logged and dropped.

Only the platforms that can be folded — the catalogue exists to populate one
checklist and nothing else, so recording Open Web and the search engines would be
storing rows nothing reads.
*/
func rememberRealtimePlatforms(ps []RealtimePlatform) {
	ensureRealtimePlatformSchema()
	for _, p := range ps {
		key := strings.TrimSpace(p.Key)
		if key == "" || !isRollupCandidate(p) {
			continue
		}
		if _, _, err := db.Exec(
			"INSERT INTO "+realtimePlatformTable+" (platform_key, label, family) VALUES (?, ?, ?) "+
				"ON DUPLICATE KEY UPDATE label = VALUES(label), family = VALUES(family)",
			key, strings.TrimSpace(p.Label), strings.TrimSpace(p.Family)); err != nil {
			// One log line, then stop: if the first insert failed the rest will
			// too, and a reading carrying fifteen platforms would otherwise write
			// fifteen identical lines per poll.
			log.Printf("[realtime] remember platform %s: %v", key, err)
			return
		}
	}
}

// realtimePlatformChoice is one line on the configuration screen.
type realtimePlatformChoice struct {
	Key    string `json:"key"`
	Label  string `json:"label"`
	Family string `json:"family"`
	/* Whether this platform is currently folded into the rollup row for the
	   layout being edited. The screen ticks what is SHOWN and therefore draws
	   this inverted — see the note at the top on why the stored list is the
	   other way round. */
	RolledUp bool `json:"rolledUp"`
}

/*
How long a platform stays on the list after it was last counted.

The catalogue grew from a fixed thirteen to something open-ended when the
reporting service began reporting the sites INSIDE the UGC capture table — that
lookup holds 188 of them, and every one that ever appears in any client's
reading is recorded here for ever. Unfiltered, this screen becomes a grid of a
hundred and fifty tick boxes, most of them sites nobody has seen since last
season.

Ninety days rather than a shorter window because these are seasonal: a site that
carried a competition in the spring is one an operator still recognises and may
want configured before it comes back.

Nothing is DELETED. The row keeps its last_seen and returns to the list the next
time it is counted, which is the difference between a list of what matters now
and losing the record.
*/
const realtimePlatformStaleDays = 90

// realtimePlatformChoices is the catalogue, with this layout's selection on it.
func realtimePlatformChoices(rolled map[string]bool) []realtimePlatformChoice {
	ensureRealtimePlatformSchema()
	/*
		Recent, OR already folded by this layout.

		The second half is not a nicety. A folded platform that dropped off the
		list could not be un-folded — the tick box would be gone while the stored
		key kept summing it into the rollup row — so an operator's own choice
		would become unreachable by going quiet, which is exactly when they would
		want to revisit it.
	*/
	keep := make([]any, 0, len(rolled))
	for k := range rolled {
		keep = append(keep, k)
	}
	where := "last_seen > (UTC_TIMESTAMP() - INTERVAL ? DAY)"
	args := []any{realtimePlatformStaleDays}
	if len(keep) > 0 {
		ph := strings.TrimSuffix(strings.Repeat("?,", len(keep)), ",")
		where += " OR LOWER(platform_key) IN (" + ph + ")"
		args = append(args, keep...)
	}
	rows, err := db.Query(
		"SELECT platform_key, label, family FROM "+realtimePlatformTable+
			" WHERE "+where+
			" ORDER BY label, platform_key", args...)
	if err != nil {
		log.Printf("[realtime] read platform catalogue: %v", err)
		return nil
	}
	out := make([]realtimePlatformChoice, 0, len(rows))
	for _, r := range rows {
		key := strFromAny(r["platform_key"])
		label := strFromAny(r["label"])
		if label == "" {
			label = key
		}
		out = append(out, realtimePlatformChoice{
			Key: key, Label: label, Family: strFromAny(r["family"]),
			RolledUp: rolled[strings.ToLower(key)],
		})
	}
	return out
}

/*
parseRollup reads the stored list into a set.

Comma-separated keys, trimmed and lowercased. Empty in, empty out — and an empty
set folds nothing, which is the resting state every unconfigured card is in.
*/
func parseRollup(v string) map[string]bool {
	out := map[string]bool{}
	for _, part := range strings.Split(v, ",") {
		if p := strings.ToLower(strings.TrimSpace(part)); p != "" {
			out[p] = true
		}
	}
	return out
}

// joinRollup is the set as it is stored: the caller's own order, de-duplicated.
// Kept in the order the screen sent so a stored row can be read against what was
// on screen when it was saved.
func joinRollup(keys []string) string {
	seen := map[string]bool{}
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		k = strings.ToLower(strings.TrimSpace(k))
		if k == "" || seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, k)
	}
	return strings.Join(out, ",")
}

/*
applyRealtimeRollup folds the configured platforms into one row.

The rollup takes the SLOT of the first platform it absorbs rather than being
appended. The caller sorts by count immediately afterwards, so this decides
nothing about the finished card — but it means the function is also correct
called on its own, and a list that keeps its shape is far easier to read in a
test than one that always ends with the rollup last.

── The removal figure ────────────────────────────────────────────────────────

Summed only where EVERY folded platform answered on removals. One that did not
makes the sum a floor, and a floor drawn as a share bar beside an exact identified
count is a removal rate that reads as measured and is not. Where any member is
silent the rollup reports no removals at all, which the card draws as "not
answered" rather than as none — see RealtimePlatform.Removed.

The basis survives only where the members agree on one. Two platforms recording
different things under one word is what removedWord exists to keep apart, and the
rollup is the one row that could stack both; blank falls back to the neutral
"removed", which is the honest word for a mixed row.
*/
func applyRealtimeRollup(ps []RealtimePlatform, rolled map[string]bool) []RealtimePlatform {
	if len(rolled) == 0 {
		return ps
	}

	// Gathered first, folded second. Deciding whether to fold at all needs the
	// whole membership, and a single pass that built the row as it went would
	// have to unpick it for the one-member case below.
	members := make([]RealtimePlatform, 0, len(ps))
	for _, p := range ps {
		if isRollupCandidate(p) && rolled[strings.ToLower(strings.TrimSpace(p.Key))] {
			members = append(members, p)
		}
	}
	/* Nothing to do, and ONE is also nothing to do: a rollup of a single
	   platform is a rename, not a summary. It would report "UGC & Social Media
	   918" for a row that is entirely Telegram — less information under a vaguer
	   name, which is the opposite of what folding is for. */
	if len(members) < 2 {
		return ps
	}

	roll := RealtimePlatform{
		Key: realtimeRollupKey, Label: realtimeRollupLabel, Family: realtimeRollupFamily,
	}
	var removed int64
	allAnswered := true
	basis, basisMixed := "", false
	for _, p := range members {
		roll.Count += p.Count
		if p.Removed == nil {
			allAnswered = false
		} else {
			removed += *p.Removed
		}
		if b := strings.TrimSpace(p.RemovalBasis); b != "" {
			if basis == "" {
				basis = b
			} else if basis != b {
				basisMixed = true
			}
		}
	}
	if allAnswered {
		total := removed
		roll.Removed = &total
	}
	if !basisMixed {
		roll.RemovalBasis = basis
	}

	out := make([]RealtimePlatform, 0, len(ps))
	placed := false
	for _, p := range ps {
		if isRollupCandidate(p) && rolled[strings.ToLower(strings.TrimSpace(p.Key))] {
			if !placed {
				out = append(out, roll)
				placed = true
			}
			continue
		}
		out = append(out, p)
	}
	return out
}
