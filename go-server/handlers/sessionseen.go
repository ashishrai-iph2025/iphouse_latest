package handlers

/*
"Active in the last thirty minutes", made true.

The Active Sessions panel on /admin/super-admin reads dcp_user_login.last_seen_at
and shows anyone stamped inside the window. It showed nothing at all, ever, for
two reasons that compounded:

  - THE COLUMN DID NOT EXIST. `last_seen_at` is read by that panel and by the
    account drawer's security card, and written by three places in the login
    path, and nothing in this codebase ever created it. It is migration 001 now
    — see go-server/schema, which exists because of this. Every one of those
    writes is `go db.Exec(...)` — fire and forget, no error to check — and the
    panel's read is `rows, _ := db.Query(...)`, so a hard "Unknown column
    'last_seen_at'" came back on every request and was discarded at both ends.
    The screen said "No active sessions in the last 30 minutes", which is a
    sentence about the data, over a query that never ran.

  - IT WAS ONLY EVER STAMPED AT LOGIN. Even with the column present, the panel
    would have meant "logged in within the last half hour" — so the normal case,
    somebody signed in and working since this morning, is invisible. And the
    staff path (verifyStaffOTP) never stamped at all, so a Super Admin could not
    appear on a page only a Super Admin can open.

Both are fixed: the column arrives as a recorded migration at startup, and every
authenticated request stamps it — throttled, so a page of twenty API calls is one
write rather than twenty.
*/

import (
	"log"
	"sync"
	"time"

	ipauth "github.com/ip-house/iphouse-api/auth"
	"github.com/ip-house/iphouse-api/db"
)

/*
How often one login's stamp is rewritten.

The window the panel asks about is thirty minutes, so a five-minute stamp puts
somebody on the list within five minutes of their first request and keeps them
there for as long as they are working. Finer buys nothing a reader could see and
costs one write per request; coarser risks a gap, since a stamp older than the
window is the same as no stamp.
*/
const seenStampEvery = 5 * time.Minute

var (
	seenMu   sync.Mutex
	seenLast = map[int64]time.Time{}
)

/*
TouchLastSeen records that this session made a request.

Called from the authenticated middleware, so it covers every session type —
staff included, which the login path did not.

The username is part of the WHERE and that is not belt-and-braces. A staff
session's LoginID falls back to the dcp_super_admin row id when that person has
no login row of their own (see claimsForSuperAdminRow), and those two id spaces
are unrelated: super admin 3 and login 3 are different people. Matching the
username as well means a fallback id can only ever stamp the row that belongs to
the same account, and stamps nothing otherwise.

Fire-and-forget, but only after the throttle has already decided to write —
which is what keeps a page load from queueing twenty goroutines against one row.
*/
func TouchLastSeen(claims *ipauth.Claims) {
	if claims == nil || claims.LoginID == 0 || claims.LoginUsername == "" {
		return
	}

	now := time.Now()
	seenMu.Lock()
	if last, ok := seenLast[claims.LoginID]; ok && now.Sub(last) < seenStampEvery {
		seenMu.Unlock()
		return
	}
	seenLast[claims.LoginID] = now
	seenMu.Unlock()

	id, user := claims.LoginID, claims.LoginUsername
	go func() {
		if _, _, err := db.Exec(
			`UPDATE dcp_user_login SET last_seen_at = UTC_TIMESTAMP()
			  WHERE loginId = ? AND login_username = ?`, id, user); err != nil {
			/* Logged, not swallowed. The whole reason this panel was empty for
			   as long as it was is that the same statement failed silently in
			   three other places. */
			log.Printf("[sessions] stamp failed for login %d: %v", id, err)
		}
	}()
}

/* ── Schema entry points ──────────────────────────────────────────────────────

   The portal's schema functions are unexported and lazily fired. The manifest in
   package main needs to call them at startup, in a declared order, so each gets
   a one-line exported wrapper here rather than being renamed — a rename would
   touch every existing call site for no gain, and those call sites are what keep
   the old behaviour working on a database that has not booted the new binary yet.

   Gathered in ONE file, and this one, because the bug that produced this whole
   change was a column nobody created: a reader looking for "what creates the
   portal's tables" should find a single list rather than nineteen files.

   Each remains idempotent and each still logs its own failures — see
   schema.RunSteps on why these are recorded rather than enforced. */

// EnsureSecurityPolicySchema creates the password-policy, lockout, notice and
// history tables.
func EnsureSecurityPolicySchema() { ensureSecurityPolicySchema() }

// EnsurePasswordChangedColumns adds the password-age columns the expiry policy
// reads.
func EnsurePasswordChangedColumns() { ensurePasswordChangedColumns() }

// EnsureLayoutSchema creates the per-platform report layout table.
func EnsureLayoutSchema() { ensureLayoutSchema() }

// EnsurePlatformSchema creates the report platform registry and its table map.
func EnsurePlatformSchema() { ensurePlatformSchema() }

// EnsureReportConfigSchema creates the report source config and access tables.
func EnsureReportConfigSchema() { ensureReportConfigSchema() }

// EnsureVizPrefSchema creates the per-reader chart-type preference table.
func EnsureVizPrefSchema() { ensureVizPrefSchema() }

// EnsureClientMapSchema creates the portal→warehouse client mapping.
func EnsureClientMapSchema() { ensureClientMapSchema() }

// EnsureReportsModule registers the client-facing Reports module.
func EnsureReportsModule() { ensureReportsModule() }

// EnsureSportsPeriodSchema creates the default and per-client sports windows.
func EnsureSportsPeriodSchema() { ensureSportsPeriodSchema() }

// EnsureWarehouseHiddenSchema creates the hidden-warehouse-table list.
func EnsureWarehouseHiddenSchema() { ensureWarehouseHiddenSchema() }

// EnsureDownloadWatchSchema creates the download request watch and claim tables.
func EnsureDownloadWatchSchema() { ensureDownloadWatchSchema() }

// EnsureUploadClaimSchema creates the URL upload claim ledger.
func EnsureUploadClaimSchema() { ensureUploadClaimSchema() }
