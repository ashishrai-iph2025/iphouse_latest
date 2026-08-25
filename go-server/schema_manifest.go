package main

/*
Every schema change the portal makes, in one ordered list.

This is the answer to "what creates the portal's tables". It used to be: nineteen
`ensure*` functions scattered across fifteen files, each fired by a sync.Once the
first time somebody happened to use its feature, none of them recorded anywhere.
That arrangement worked and cost three things — nothing said what a given database
had, schema work happened on a user's request rather than at deploy, and nothing
checked the schema the code ASSUMED. The third one bit: dcp_user_login.last_seen_at
was read by the Active Sessions panel and written by three login paths, and no
function ever created it.

So the functions are registered here instead. Named, numbered, ordered, run once
at startup, and recorded in schema_migrations beside the SQL migrations.

── Why this file is in package main ─────────────────────────────────────────────

Because it is the only package that already imports all of the others. Putting
the list inside `schema` would make the schema package depend on the whole HTTP
layer; putting it in `handlers` would leave out `db`, `notify` and `activity`.
main is where the wiring belongs, and this is wiring.

── Rules ────────────────────────────────────────────────────────────────────────

  - Versions start at 100, so this list and the SQL migrations in schema/ can
    both grow without colliding.
  - APPEND ONLY, and never renumber. A step recorded on a database is history.
  - NEW schema does not belong here. It goes in `migrations` in schema/schema.go
    as SQL, which is frozen in a way a function body is not. These entries exist
    to bring what was already written under one roof, and each can be retired
    into real SQL when someone is next working in that file — see MIGRATION.md.
  - Order is by DEPENDENCY, then by how early the feature is needed. The core
    portal tables come first because several later steps add columns to them.
*/

import (
	"github.com/ip-house/iphouse-api/activity"
	"github.com/ip-house/iphouse-api/db"
	"github.com/ip-house/iphouse-api/handlers"
	"github.com/ip-house/iphouse-api/handlers/admin"
	"github.com/ip-house/iphouse-api/notify"
	"github.com/ip-house/iphouse-api/schema"
)

func schemaSteps() []schema.Step {
	return []schema.Step{
		/* ── The core portal tables ──────────────────────────────────────────
		   First, and not only by convention: this one adds columns to
		   dcp_user_login, dcp_user, dcp_super_admin and module_permission, which
		   several steps below then read. It is also the largest — 254 lines and
		   twenty-five statements — and the strongest candidate for being split
		   into real SQL migrations when someone has reason to touch it. */
		{Version: 100, Name: "core portal tables and columns", Run: db.Migrate},

		/* ── What people did, and were told ──────────────────────────────────
		   Activity and notifications are written by request paths all over the
		   portal, so their tables are created before anything can serve. */
		{Version: 101, Name: "activity, login and dashboard-access logs", Run: activity.EnsureSchema},
		{Version: 102, Name: "admin notifications", Run: notify.EnsureSchema},

		/* ── Sign-in and the rules around it ─────────────────────────────────
		   The policy tables and the password-age columns are separate steps
		   because they are separate functions with separate failure modes: one
		   creates four tables, the other alters dcp_user_login. */
		{Version: 103, Name: "security policy, lockouts, notices, password history", Run: handlers.EnsureSecurityPolicySchema},
		{Version: 104, Name: "password-age columns", Run: handlers.EnsurePasswordChangedColumns},
		{Version: 105, Name: "session idle timeout settings", Run: admin.EnsureIdleSettingsTable},

		/* ── The reports engine ──────────────────────────────────────────────
		   Platform registry before layout: a layout row is keyed on a platform,
		   and a reader arriving at Report Configuration touches both. */
		{Version: 106, Name: "report platform registry and table map", Run: handlers.EnsurePlatformSchema},
		{Version: 107, Name: "report page layout", Run: handlers.EnsureLayoutSchema},
		{Version: 108, Name: "report source config and access", Run: handlers.EnsureReportConfigSchema},
		{Version: 109, Name: "report chart-type preferences", Run: handlers.EnsureVizPrefSchema},
		{Version: 110, Name: "portal to warehouse client mapping", Run: handlers.EnsureClientMapSchema},
		{Version: 111, Name: "client-facing Reports module", Run: handlers.EnsureReportsModule},
		{Version: 112, Name: "reports service connection config", Run: admin.EnsureReportsAPISchema},
		{Version: 113, Name: "report cache configuration", Run: admin.EnsureRedisCfgSchema},
		{Version: 114, Name: "sports period, default and per client", Run: handlers.EnsureSportsPeriodSchema},
		{Version: 115, Name: "hidden warehouse tables", Run: handlers.EnsureWarehouseHiddenSchema},

		/* ── Everything else that owns a table ───────────────────────────────*/
		{Version: 116, Name: "War Room per-client settings", Run: admin.EnsureWarRoomSettingsTable},
		{Version: 117, Name: "download request watch and claims", Run: handlers.EnsureDownloadWatchSchema},
		{Version: 118, Name: "URL upload claim ledger", Run: handlers.EnsureUploadClaimSchema},
	}
}
