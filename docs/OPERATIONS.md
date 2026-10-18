# Recall — Operations

Everything here describes what has actually been done or is currently true.
Anything that has not yet been executed is marked **(pending)**.

## 1. Local development

### Prerequisites

- Node.js >= 20.11 (verified on Node 24.17.0, npm 11.13.0)
- No database server required (SQLite)

### First run

```bash
npm install                 # also runs `prisma generate`
cp .env.example .env        # Windows: copy .env.example .env
```

Set at minimum in `.env`:

```
DASHBOARD_PASSWORD=<long random value>
SESSION_SECRET=<at least 32 random characters>
```

Generate both with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Then:

```bash
npm run db:migrate          # creates apps/server/prisma/dev.db
npm run dev:server          # http://127.0.0.1:4000
curl http://127.0.0.1:4000/api/health/live
```

`npm run dev:web` starts the dashboard dev server (Milestone 5).

### Environment file resolution

- The application searches for `.env` from the working directory upwards (up to
  five levels). Real environment variables always win, so a platform-provided
  value is never shadowed by a local file.
- The Prisma CLI does not read the repository-root `.env` when run inside
  `apps/server`, so `apps/server/scripts/prisma.mjs` loads it explicitly and then
  delegates to Prisma. This is why the `db:*` scripts call that wrapper.

### Database file location

`DATABASE_URL="file:./dev.db"` resolves **relative to `apps/server/prisma/`**,
so the development database is `apps/server/prisma/dev.db`. Use an absolute path
in production (`file:/data/recall.db`) so the location does not depend on the
working directory.

## 2. Configuration and secrets

- All configuration is environment variables, validated at startup by
  `src/config/env.ts`. An invalid value stops the process with a readable list of
  problems; it never starts in an ambiguous state.
- `.env.example` holds placeholders only. `.env` is git-ignored. See
  `docs/SECURITY.md` for the full handling policy.
- Placeholder-looking values are rejected when the owning feature is enabled, so
  a copied template cannot be mistaken for a working configuration.

### Production hardening enforced by validation

| Setting | Requirement |
| --- | --- |
| `DASHBOARD_PASSWORD` | must be set |
| `SESSION_SECRET` | >= 32 characters |
| `COOKIE_SECURE` | must be `true` (HTTPS only) |
| `TELEGRAM_WEBHOOK_URL` | must be `https://` in webhook mode |
| `TELEGRAM_WEBHOOK_SECRET` | must be set in webhook mode |

A local development configuration therefore **cannot** be mistaken for a secure
production deployment: the process refuses to start.

### Telegram bot runtime

Capture over Telegram is off unless `TELEGRAM_ENABLED=true`, and it needs both a
bot token and at least one owner id. `TELEGRAM_OWNER_IDS` is a list of numeric
Telegram **user** ids — not usernames, not the bot's own id.

| Mode | When to use it | How it runs |
| --- | --- | --- |
| `TELEGRAM_MODE=polling` (default) | Local development, or any host without a public HTTPS URL | `getUpdates` long-polling, started after the HTTP server is listening |
| `TELEGRAM_MODE=webhook` | Production behind HTTPS | `setWebhook` on boot; updates arrive at `POST /api/telegram/webhook` |

Polling and webhook mode are mutually exclusive; there is no fallback from one to
the other, so a misconfigured deployment fails loudly instead of silently dropping
messages.

Operational notes:

- **Polling offset lives in memory.** A restart re-fetches the last few updates.
  The `(source, externalId)` idempotency key means each one is recognised and no
  second capture is stored — the bot simply replies "Already saved". Persistent
  offsets may be added later; the current behaviour is intentional and safe.
- **The poll loop backs off.** Transient failures retry with exponential backoff
  and honour Telegram's `retry_after`. An invalid token aborts polling with
  `telegram getMe failed` but never stops the HTTP API — captures via the web or
  CLI keep working, so a bot outage cannot lose data.
- **Shutdown.** `SIGINT`/`SIGTERM` stops polling (with a 2-second cap on the
  in-flight long poll) before the HTTP server closes.
- **Webhook registration is done for you.** On boot in webhook mode the process
  calls `setWebhook` with the configured URL and secret. If you change the secret,
  restart the server to re-register.
- **A failed reply is not a failed capture.** The confirmation is best-effort; the
  capture is committed first and a send failure is logged, not retried into a
  duplicate.
- **Nothing is stored from group chats.** The owner is asked to message privately.

## 3. Commands

| Command | Purpose |
| --- | --- |
| `npm run verify` | typecheck + tests — run before every commit |
| `npm run typecheck` | TypeScript only |
| `npm test` | test suite |
| `npm run dev:server` | API with hot reload (`tsx watch`) |
| `npm run build` | compile `packages/shared` then `apps/server` |
| `npm run build:all` | also build the dashboard (Milestone 5) |
| `npm start --workspace @recall/server` | run the compiled server (`dist/index.js`) |
| `npm run recall -- doctor` | configuration + database check |
| `npm run recall -- capture "text"` | store a capture from the terminal |
| `npm run recall -- inbox` | captures waiting for review |
| `npm run recall -- serve` | start the API and any adapters |
| `npm run db:migrate` | create + apply a migration (development) |
| `npm run db:deploy` | apply existing migrations (production) |
| `npm run db:status` | show migration state |
| `npm run db:studio` | browse the database |
| `npm run db:seed` | **development only** fictional data |
| `npm run db:reset:dev` | **development only** drop + recreate |

`db:seed` and `db:reset:dev` refuse to run when `NODE_ENV=production`.

## 4. Migrations

- Migrations are version-controlled SQL under `apps/server/prisma/migrations/`.
  The first one is `20261017215218_init`.
- Development: `npm run db:migrate` (Prisma prompts for a name).
- Production: `npm run db:deploy`, which only applies pending migrations.
- **The production database is never recreated, reset or dropped to apply a schema
  change.** `prisma migrate reset` is wired only to the development-only script.
- Before deploying a migration: copy the database file (see backups) so a rollback
  is possible.

## 5. Logging

- Structured JSON on stdout (`info` and below) and stderr (`warn`, `error`, `fatal`).
- One line per HTTP request: method, path without query string, status. Bodies and
  query strings are never logged.
- **Redacted by default:** `rawText`, `transcript`, `body`, `text`, `password`,
  `token`, `botToken`, `apiKey`, `secret`, `sessionSecret`, `authorization`,
  `cookie`. Set `LOG_MESSAGE_CONTENT=true` to see message text — local development
  only; it puts private thoughts into your logs.
- Level via `LOG_LEVEL` (`fatal|error|warn|info|debug|trace|silent`).

## 6. Health monitoring

| Endpoint | Auth | Use |
| --- | --- | --- |
| `GET /api/health/live` | none | liveness — restart the process if this fails |
| `GET /api/health` | owner session | readiness — database, scheduler, providers, counts |

`GET /api/health` returns HTTP 200 with `status: "degraded"` when a dependency is
down, and includes the database latency, scheduler state (last tick, due count)
and whether AI/STT/Telegram are configured and enabled. This distinguishes
"process down" from "dependency down".

## 7. Backups

### What to back up

1. The database file (default `apps/server/prisma/dev.db`) **plus** its `-wal` and
   `-shm` siblings if WAL mode is active. Copying only the `.db` file while a
   writer is active can capture a torn state.
2. `.env` (separately, encrypted — it contains your password and API keys).

### Recommended procedure

Stop writes, or use SQLite's own consistent copy:

```bash
# Consistent copy without stopping the service (requires the sqlite3 CLI):
sqlite3 apps/server/prisma/dev.db ".backup 'backups/recall-2026-10-17.db'"
```

If the `sqlite3` CLI is unavailable, a logical export is equivalent and is built
into the product (`GET /api/export`, JSON):

```bash
curl -H "cookie: recall_session=<token>" http://127.0.0.1:4000/api/export > backups/export.json
```

Store backups outside the repository. `backups/` and `exports/` are git-ignored.
An export bundle contains every message you have saved, so treat it exactly like the
database file: never commit it, and encrypt it if it leaves the machine.

### Restoring from an export

Restore is **additive**: it never deletes or overwrites, it reuses rows that already
exist (by id, or by natural key such as a tag name or `(source, externalId)`), and it
writes nothing unless asked to. Always check first:

```bash
# 1. Dry run (the default) — reports what would be inserted and skipped.
curl -X POST http://127.0.0.1:4000/api/restore \
  -H "cookie: recall_session=<token>" -H 'content-type: application/json' \
  -d '{"bundle": '"$(cat backups/export.json)"'}'

# 2. Apply it.
curl -X POST http://127.0.0.1:4000/api/restore \
  -H "cookie: recall_session=<token>" -H 'content-type: application/json' \
  -d '{"bundle": '"$(cat backups/export.json)"', "dryRun": false}'
```

Read the `errors` array: a row that could not be written is listed with its table and
id, and the rest still load. Because the operation is id-based and additive, fixing
the bundle and re-running is safe.

**(pending)** A full restore drill from a production-shaped backup is a Milestone 8
acceptance criterion; this section will be updated with the executed commands and
results. The restore path itself runs end to end in
`apps/server/tests/integration/export-restore.test.ts` (export → wipe → restore →
re-export) against a real SQLite database, but that is a throwaway test database, not
an owner's backup.

## 8. Recovery

| Situation | Action |
| --- | --- |
| Process crashed | Restart it. Pending reminders are recovered from the database on boot and fired once if inside `REMINDER_OVERDUE_GRACE_HOURS`. |
| Database file corrupt | Restore the most recent backup, then `npm run db:deploy` to confirm the schema is current. |
| Migration half-applied | `npm run db:status` reports the state. Restore the pre-migration backup rather than editing migration files. |
| Lost `SESSION_SECRET` | Regenerate it; everyone is signed out (sessions are signed, not stored). |
| Lost `DASHBOARD_PASSWORD` | Set a new one in `.env` and restart. |
| Wrong time zone | `PATCH /api/settings` with the correct IANA zone, or set `DEFAULT_TIME_ZONE` and restart. Stored instants are unaffected — only interpretation and display change. |

## 9. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Invalid configuration:` on start | The message lists each bad field. Fix `.env`; nothing about the values is echoed. |
| `Database is not reachable` | `DATABASE_URL` is wrong or the directory does not exist. Relative paths resolve against `apps/server/prisma/`. |
| `Prisma CLI not found` in tests | Run `npm install` first. |
| `Test template database missing` | The vitest `globalSetup` step failed; run `npx vitest run` and read the migration output. |
| Login returns 503 | `DASHBOARD_PASSWORD` or `SESSION_SECRET` is unset on the server. |
| 401 on every API call | The session cookie expired (`SESSION_TTL_HOURS`) or the secret changed. Sign in again. |
| 429 responses | Per-IP rate limit (240/min, and 10/min on login). Expected under load, not a bug. |
| Port already in use | Change `PORT`, or stop the other process. |
| Bot ignores your messages | `TELEGRAM_OWNER_IDS` does not contain your Telegram user id (not your username). Check with `npm run recall -- doctor` and the startup log line. |
| Bot replies "This bot is private" | You are messaging from an id that is not in `TELEGRAM_OWNER_IDS`. |
| `telegram getMe failed - polling not started` | The bot token is wrong or revoked. Nothing else is affected; capture via the API/CLI still works. |
| `telegram polling failed - retrying` | A transient network or Telegram error. Recall backs off (and honours `retry_after`) and recovers on its own. |
| Duplicate-looking behaviour after a restart | A restart re-fetches the last few updates because the polling offset is in memory. Idempotency means no second capture is stored; the reply is simply "Already saved". |
| Webhook returns 401 | `TELEGRAM_WEBHOOK_SECRET` on the server does not match the `secret_token` Telegram sends. Re-register by restarting the server. |
| Webhook returns 503 | `TELEGRAM_WEBHOOK_SECRET` is not set. Webhook mode will not accept unsigned updates. |
| `A reminder is set.` never appears | A reminder is only created when you asked for one ("remind me …") *and* a time was recognised. Tasks with a deadline get a `dueAt`, not a reminder. |
| Voice replies "cannot transcribe it yet" | Expected until Milestone 6. The message is stored with a marker. |
| Search finds nothing although you know the text exists | Every word in the query must appear somewhere in the row, and only the fields listed in `search-service.ts` are searched (for a task: title, description, category; for a capture: text and transcript). Try fewer words. An undone capture is excluded unless you pass `includeDeleted=true`. |
| Search results look stale | Results are computed from the database on every request; nothing is cached. An undone capture and a soft-deleted row are simply not returned. |
| `/today` shows a task you expected tomorrow (or the reverse) | `/today` uses `settings.timeZone`, not the server clock. Check it with `/settings` or `GET /api/settings`. |
| Restore returns `errors` | Nothing was lost: each entry names the table and row that could not be written (usually a missing parent row or a bundle edited by hand). Fix the bundle and re-run; rows already present are skipped. |
| Restore did nothing | It runs as a dry run unless `{"dryRun": false}` is passed. That is deliberate. |
| `DELETE /api/tasks/:id` returns 400 with `requiresConfirmation` | Same pattern as capture purge: destructive routes want an explicit confirmation in the body. |
| Conversion or undo refused after editing a record | Deliberate: converting or undoing a capture whose derived record you have since edited would discard your edits. Pass `{"force": true}` if that is what you want. |

## 10. Deployment

**(pending — Milestone 8.)** The intended target is a small always-on host running
the compiled server under a process supervisor, behind a reverse proxy that
terminates HTTPS, with the database on a persistent volume and a scheduled backup.
The deployment steps will be written here only after they have been executed and
verified, including a deliberate restart test with pending reminders and a restore
from backup.
