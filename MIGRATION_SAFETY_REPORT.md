# Recall — Migration Safety Report

**Scope:** the two migrations applied during Milestone 7 —
`20261019120000_capture_classification_cache` and
`20261022120000_briefing_delivery` — against the local development SQLite
database.

**Status:** Both migrations applied and verified. This is a
migration-safety report, not a release-readiness sign-off.

**Tooling note:** the `sqlite3` command-line program is **not installed** in this
environment. Every inspection below was performed with Node's built-in
`node:sqlite` module (read-only) or through the Prisma CLI. No `sqlite3`
invocation is claimed.

## 1. Repository context

| Component | Verified value |
|-----------|----------------|
| Branch | `main` |
| HEAD | `4dad32f feat(m5): implement authenticated React dashboard` |
| Git status at the start of the Milestone 7 audit | 40 modified paths, 27 untracked paths, 0 staged |
| Prisma schema | `apps/server/prisma/schema.prisma` |
| Migrations applied | `20261019120000_capture_classification_cache`, `20261022120000_briefing_delivery` |

The counts above are a snapshot from the start of the Milestone 7 audit. They
changed as Milestone 7 edits were made and must not be treated as a live Git
status. An earlier draft of this report claimed 82 modified and 53 untracked
paths; that count was stale and is not used here.

## 2. Database target

The local development environment configures:

```text
DATABASE_URL="file:./dev.db"
```

Prisma resolves the relative SQLite path against the schema directory, giving:

```text
C:\Users\samue\Desktop\Personal_Memory_Assistant\apps\server\prisma\dev.db
```

No production or remote database was involved.

## 3. Migration history and status

`npm run db:status --workspace @recall/server` reports (2026-10-22):

```text
4 migrations found in prisma/migrations
Database schema is up to date!
```

The applied migrations are:

| Migration | Status |
|-----------|--------|
| `20261017215218_init` | Applied |
| `20261018102343_reminder_delivery_occurrence_key` | Applied |
| `20261019120000_capture_classification_cache` | Applied |
| `20261022120000_briefing_delivery` | Applied |

Read-only inspection of `_prisma_migrations` shows all four rows with
`finished_at` set and `rolled_back_at` null. No failed or rolled-back migration
was found.

## 4. Schema inspection

### 4.1 Capture classification cache

The migration is additive:

```sql
ALTER TABLE "captures" ADD COLUMN "classificationCache" TEXT;
ALTER TABLE "captures" ADD COLUMN "classificationCacheKey" TEXT;
```

Both columns are present in the working database, are nullable, and have no
default value. They contain no rows with non-null values in this database.

### 4.2 Briefing delivery

The migration creates one new table and four indexes. It does not alter or drop
any existing table, column or row:

```sql
CREATE TABLE "briefing_deliveries" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "occurrenceKey" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "channel" TEXT NOT NULL DEFAULT 'telegram',
    "scheduledFor" DATETIME NOT NULL,
    "attemptedAt" DATETIME,
    "deliveredAt" DATETIME,
    "nextRetryAt" DATETIME,
    "error" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "briefing_deliveries_idempotencyKey_key" ON "briefing_deliveries"("idempotencyKey");
CREATE INDEX "briefing_deliveries_status_nextRetryAt_idx" ON "briefing_deliveries"("status", "nextRetryAt");
CREATE INDEX "briefing_deliveries_occurrenceKey_idx" ON "briefing_deliveries"("occurrenceKey");
CREATE INDEX "briefing_deliveries_deliveredAt_idx" ON "briefing_deliveries"("deliveredAt");
```

The live database matches this DDL exactly (columns, types, nullability,
defaults and all four indexes). The unique index on `idempotencyKey` is what
makes a duplicate send impossible even across two ticks or two processes.

`PRAGMA integrity_check` returned `ok`.

## 5. Backups

The backup referenced by the earlier draft
(`backups/dev.db.backup_20261021T192642Z.bak`) does **not** exist. The verified
local backups are:

| File | Size | SHA-256 | Migration state |
|------|------|---------|-----------------|
| `backups/dev.db.pre-migration-20261021T192642Z.exact.bak` | 294,912 bytes | `6f65549c1f3729c92df8810a2b7a8c1f30fb250f34720b2c0fa872b44cbec379` | Only `init` and `reminder_delivery_occurrence_key`; **no cache columns** |
| `backups/dev.db.pre-migration-20261021T192642Z.bak` | 294,912 bytes | `77ab9d5f5dfd29b3e074a3b923dd8e443bd9771364492577856797f971d73d8d` | Only the first two migrations; **no cache columns** |
| `backups/dev.db.backup_.sqlite` | 294,912 bytes | `b66c46e3ab2b485eb301e1aefa582f39e793f3a955f0ba028918dd4b1c42bcb8` | All three migrations; cache columns present (post-migration copy) |
| `backups/dev.db.pre-briefing-migration-20261022T000916Z.bak` | 294,912 bytes | `b66c46e3ab2b485eb301e1aefa582f39e793f3a955f0ba028918dd4b1c42bcb8` | The three earlier migrations; **no `briefing_deliveries` table** |

The first two files are genuine pre-migration evidence: they contain only the two
earlier migrations and do not contain either cache column. The exact backup's
`PRAGMA integrity_check` returned `ok`.

The last file is the pre-briefing-migration backup taken immediately before
`20261022120000_briefing_delivery` was applied. Its 16 tables confirm it has no
`briefing_deliveries` table, while the live database now has 17. It is
byte-identical to `dev.db.backup_.sqlite` (same SHA-256), which is consistent:
both are copies of the same database state.

## 6. Row counts

The current schema has no `users` table; Recall is a single-owner application
configured through environment variables. The earlier draft's claim that a
`users` table contained one row was incorrect.

Every user-data table currently has zero rows (verified 2026-10-22, after the
briefing migration):

| Table | Rows |
|-------|------|
| `captures` | 0 |
| `tasks` | 0 |
| `notes` | 0 |
| `ideas` | 0 |
| `events` | 0 |
| `projects` | 0 |
| `reminders` | 0 |
| `reminder_deliveries` | 0 |
| `briefing_deliveries` | 0 |
| `tags` | 0 |
| `capture_tags` | 0 |
| `task_tags` | 0 |
| `note_tags` | 0 |
| `idea_tags` | 0 |
| `capture_relations` | 0 |
| `user_settings` | 0 |

Because there were no user rows before or after migration, this report can
confirm schema integrity and zero-row preservation, but it cannot claim a
successful preservation test against populated data.

## 7. Verification performed

- `npm run db:status --workspace @recall/server` — schema up to date,
  4 migrations found.
- `npx prisma validate` — schema valid.
- `npm run db:deploy --workspace @recall/server` — applied
  `20261022120000_briefing_delivery` to the development database; the command
  succeeded and `prisma generate` was re-run afterwards.
- Read-only SQLite inspection using Node's built-in `node:sqlite`:
  - migration history (`finished_at` / `rolled_back_at`)
  - `PRAGMA integrity_check`
  - table list and `briefing_deliveries` column/index definitions
  - row counts for every table
  - pre-migration vs post-migration backup comparison (SHA-256 + table list)
- No migration was rolled back during this report's verification.
- The working database was opened read-only for this inspection.

## 8. Verdict

**Both migrations applied and verified.**

Both are additive: one adds two nullable columns to `captures`, the other
creates a single new table with its indexes. Both are recorded as finished in
`_prisma_migrations`, both are present in the working database, and the
database integrity-checks `ok`. The pre-migration backups exist and do not
contain the new schema.

This report does not establish production readiness. It does not cover live
Telegram, AI, or speech-to-text integrations, browser behavior, TLS or reverse
proxy behavior, or a populated production restore drill.

