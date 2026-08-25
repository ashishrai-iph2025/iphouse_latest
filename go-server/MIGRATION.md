# Database schema changes

**New schema goes in `schema/schema.go` as a numbered migration. Nowhere else.**

## Why this exists

The portal used to change its own schema lazily: nineteen `ensure*Schema()`
functions holding thirty-six `CREATE TABLE` and twenty `ALTER … ADD COLUMN`
statements, each fired by a `sync.Once` the first time its feature was used,
plus an unversioned `db.Migrate()` at startup. Nothing recorded what had run.

It failed the same way twice, and both times silently:

- **`dcp_settings`** was read and written by the Settings and Maintenance
  handlers and created by nothing. The maintenance-mode upsert failed on any
  environment that did not happen to have the table. From the comment in
  `db.Migrate`: *"only became visible once write errors stopped being
  swallowed."*
- **`dcp_user_login.last_seen_at`** was read by the Active Sessions panel and by
  the account drawer's security card, and written by three login paths. No
  `ensure*` ever created it. Every access discarded its error — the writes are
  `go db.Exec(...)`, the read was `rows, _ := db.Query(...)` — so MySQL returned
  `Unknown column` on every request for months and the screen printed "No active
  sessions in the last 30 minutes" over a query that never ran.

A migration runner stops you shipping the first. `schema.Verify()` catches the
second — a column the code assumes and the database lacks, whoever was supposed
to have created it.

## Adding a migration

Append to `migrations` in `schema/schema.go`:

```go
{
    Version: 2,
    Name:    "dcp_widget: add colour",
    Statements: []string{
        `ALTER TABLE dcp_widget ADD COLUMN colour VARCHAR(16) NULL DEFAULT NULL`,
    },
},
```

It applies at the next boot, records itself in `schema_migrations`, and logs
`[schema] applied 002 …`. Nothing else to run.

### Rules

- **Append only.** A migration that has run somewhere is history. Editing its SQL
  changes nothing on a database that already applied it and silently diverges the
  two. Fix a mistake with a new version.
- **Numbers never repeat and never backfill a gap.** The number is the identity.
- **Every statement must be safe to run twice.** MySQL has no transactional DDL,
  so a migration of four statements that fails on the third leaves two applied.
  The entry is therefore not recorded, and the re-run has to step over what
  already landed — `IF NOT EXISTS` where it exists, and the runner treats
  "duplicate column / duplicate key / table exists" as success.
- **Additive by default.** Prefer a new nullable column over changing an existing
  one; a deploy is not atomic and the old binary is still serving while the new
  schema is in place.
- **A failed migration stops the process.** Deliberate: a portal running on a
  schema it was not built for does not fail, it misbehaves one feature at a time.

## Asserting what the code assumes

`expected` in `schema.go` lists columns whose absence would be **silent** — the
ones every access to which is fire-and-forget or discards its error. `Verify()`
runs after the migrations and logs `[schema] MISSING …` for anything absent.

Add to it when you write code that reads a column without checking the error. Do
not add columns whose absence breaks a page loudly; those report themselves.

## The two lists

**`schema/schema.go` → `migrations`** — frozen SQL, numbered from 1. This is where
**new** schema changes go.

**`schema_manifest.go` → `schemaSteps()`** — the eighteen schema functions the
portal already had, numbered from 100. Each is named, ordered, run once at
startup, and recorded in the same `schema_migrations` table. They were previously
fired by a `sync.Once` the first time somebody used their feature, and recorded
nowhere.

Registering them rather than retyping their ~70 statements as SQL was a deliberate
call: on every existing database the DDL has already run, so a transcription would
have changed nothing except to duplicate each statement away from the comment
explaining why it exists. What registering buys is what the lazy version lacked —
schema work at deploy instead of on a user's request, a declared order, and a
record of what each database has had.

Its honest limit: a step's body can still change, so it is not frozen history the
way numbered SQL is, and a brand-new database needs this Go code rather than the
SQL alone. That is why new work goes in `migrations`.

### Retiring a step into real SQL

Do it when you are already working in that file, one at a time — never in a batch,
because the point of a numbered list is that each change is individually
attributable when something breaks.

1. Confirm the table/column exists on every environment.
2. Copy the DDL verbatim into a new numbered SQL migration.
3. Delete the `ensure*` function, its exported wrapper, its `sync.Once` and its
   lazy call sites.
4. Remove its step from the manifest — but **leave the version number retired**.
   Never renumber and never reuse it.
5. Add anything whose absence would be silent to `expected`.

### Verifying

The startup sequence is `schema.Run()` then `schema.RunSteps(schemaSteps())`. On a
database that has had everything, both are silent apart from `[schema] up to date`.
On a fresh one you get a line per migration and a line per step. Nineteen steps
applying against a fully-populated staging database produced no errors and no
schema changes, which is the property that makes registering them safe: every one
is idempotent.
