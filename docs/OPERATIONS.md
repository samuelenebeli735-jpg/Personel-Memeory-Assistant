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
| `TELEGRAM_WEBHOOK_URL` | must be the full `https://` URL ending in `/api/telegram/webhook` in webhook mode |
| `TELEGRAM_WEBHOOK_SECRET` | must be set in webhook mode |

A local development configuration therefore **cannot** be mistaken for a secure
production deployment: the process refuses to start.

`TRUST_PROXY` is deliberately `false` by default. Set it only when Recall is
behind a reverse proxy you control, using that proxy's address/CIDR or a
comma-separated list. If it is enabled without a trusted proxy in front, a client
can spoof `X-Forwarded-For` and evade the per-IP rate limiter.

### Telegram bot runtime

Capture over Telegram is off unless `TELEGRAM_ENABLED=true`, and it needs both a
bot token and at least one owner id. `TELEGRAM_OWNER_IDS` is a list of numeric
Telegram **user** ids — not usernames, not the bot's own id.

| Mode | When to use it | How it runs |
| --- | --- | --- |
| `TELEGRAM_MODE=polling` (default) | Local development, or any host without a public HTTPS URL | `getUpdates` long-polling, started after the HTTP server is listening |
| `TELEGRAM_MODE=webhook` | Production behind HTTPS | `setWebhook` on boot; updates arrive at `POST /api/telegram/webhook` |

Set `TELEGRAM_WEBHOOK_URL` to the full public URL, for example
`https://recall.example.com/api/telegram/webhook`. Recall passes it to Telegram
unchanged; it does not append the route.

Polling and webhook mode are mutually exclusive; there is no fallback from one to
the other, so a misconfigured deployment fails loudly instead of silently dropping
messages.

**Telegram is a temporary bridge (D58).** It delivers reminders and the daily
briefing, and accepts captures and commands, until ALIVE's native Windows and
Android notifications exist. It is kept reliable but not extended, and it will be
retired only after native notifications are implemented, tested and confirmed
reliable.

**What depends on polling.** Polling (or the webhook) carries only what you send
*to* the bot: captures, voice notes, `/snooze`, `/cancel`, `/ask` and the
correction buttons. Reminders and briefings are sent with `sendMessage` to the
first `TELEGRAM_OWNER_IDS` entry and keep working while polling is down.

**Sound.** Reminders arrive with the normal Telegram alert (sound or vibration,
as set on the phone). The daily briefing arrives silently. Quiet hours and the
daily cap still apply to both.

**Switching from webhook to polling.** Telegram refuses `getUpdates` while a
webhook is set (HTTP 409). In polling mode Recall checks for a webhook before the
first poll and removes it, keeping pending updates (`drop_pending_updates:
false`); the log names the old webhook's host only. If the webhook comes back
mid-run, it is removed again at most once every 10 minutes. A webhook that keeps
returning means another deployment is using the same bot token in webhook mode:
give each deployment its own bot token.

Operational notes:

- **Polling offset lives in memory.** A restart re-fetches every update Telegram
  has not yet seen acknowledged. For captures the `(source, externalId)`
  idempotency key means each one is recognised and no second capture is stored —
  the bot simply replies "Already saved". Commands are not de-duplicated: a
  command handled just before the process stopped, but not yet acknowledged, can
  run a second time (for example `/remind` creating a second reminder). The
  window is the time between handling and the next poll, normally a fraction of
  a second. Persistent offsets may be added later.
- **The poll loop backs off.** Transient failures retry with exponential backoff
  (capped at 30 seconds) and honour Telegram's `retry_after`. The start-up token
  check retries the same way, so a server that starts before the network is
  ready begins polling once it is. Only a rejected token (401/403/404) stops
  polling, with `telegram rejected the bot token`; it never stops the HTTP API —
  captures via the web or CLI keep working, so a bot outage cannot lose data.
- **A message is acknowledged only after it was handled.** If handling an
  update fails (for example the database is briefly unavailable), Recall does
  not move past it: later updates wait, and the same update is fetched again
  after the normal backoff (`failed to handle telegram update N (attempt k of
  10) - it will be retried`). A capture is de-duplicated by its Telegram
  message id, so a retry cannot store it twice; a voice note can be downloaded
  and transcribed again on a retry if the failure came after transcription. An
  update that cannot succeed is dead-lettered so it cannot block the bot
  forever: immediately when the input is invalid, otherwise after 10 attempts.
  The nine waits before the tenth attempt are 1 + 2 + 4 + 8 + 16 + 30 + 30 + 30
  + 30 = 151 seconds, about 2.5 minutes (longer if an earlier poll failure had
  already raised the backoff). A dead letter is logged as an error (ids and
  reason only, never the text), counted in health (`deadLetteredUpdates`,
  `lastDeadLetterAt`), and the bot tells you: for a message, which one it could
  not process and that it may not have been saved; for a button press, that its
  action may not have taken effect. If that notice cannot be delivered, the
  dead letter still stands; the failure is logged as an error (`could not tell
  the owner about a dead-lettered telegram update`) and counted in
  `deadLetterNoticesFailed`.
- **Retry and dead-letter state is not durable.** All of it is held in process
  memory: attempt counts, retry timing, the offset and the health counters. A
  restart resets them; there is no dead-letter record in the database. In
  practice:
  - An update not yet acknowledged when the process stops (one being retried,
    or one handled but not yet acknowledged) is delivered again after the
    restart and starts again at attempt 1. Captures are recognised by message
    id; commands can run twice; voice notes can be downloaded and transcribed
    again.
  - A dead-lettered update that was already acknowledged is not replayed after a
    restart; Telegram does not redeliver it and Recall keeps no copy.
  - The error log (if your process manager keeps it) and your Telegram chat
    history may still show what happened, but they are evidence, not a Recall
    dead-letter record, and nothing recovers the message automatically. If in
    doubt, check the dashboard and resend.
- **Two copies polling with one token.** Telegram allows one poller per bot. The
  second gets a 409 and logs `another copy of Recall is polling with this bot
  token`; Recall deletes nothing and keeps retrying, so it takes over by itself
  once the other copy stops. Stop one of them.
- **Health shows the polling state.** `GET /api/health` reports
  `providers.telegram.polling`: `state` (`starting`, `running`, `retrying`,
  `stopped`), `lastPollAt`, `lastErrorAt`, a short `lastErrorCode`
  (`webhook_conflict`, `poller_conflict`, `update_failed`,
  `update_dead_lettered`, `http_<status>`, `timeout`, `network`),
  `stoppedReason` (`token_rejected`, `shutdown`), `retryingUpdateId` (an update
  being retried), `deadLetteredUpdates` / `lastDeadLetterAt` and
  `deadLetterNoticesFailed`. It never contains messages
  or the token, is kept in memory and resets on restart. It is `null` in webhook
  mode or when the bot is off.
- **Shutdown.** `SIGINT`/`SIGTERM` stops polling (with a 2-second cap on the
  in-flight long poll) before the HTTP server closes.
- **Webhook registration is done for you.** On boot in webhook mode the process
  calls `setWebhook` with the configured URL and secret. If you change the secret,
  restart the server to re-register.
- **A failed reply is not a failed capture.** The confirmation is best-effort; the
  capture is committed first and a send failure is logged, not retried into a
  duplicate.
- **Concurrent duplicate voice deliveries are coalesced in the process.** The
  adapter claims `telegram:<chatId>:<messageId>` before downloading. A webhook
  retry or redelivery that arrives while the first attempt is still running waits
  for it instead of calling speech-to-text again; both requests still receive a
  successful webhook response. The claim is removed on success or failure, so a
  later retry can proceed. This is not a distributed lock: a second server process
  does not share the claim, though the unique `(source, externalId)` constraint
  still prevents a second capture.
- **Nothing is stored from group chats.** The owner is asked to message privately.

### Voice, speech-to-text and AI

Both integrations are optional. With `STT_PROVIDER=none` (the default) and
`AI_PROVIDER=none`, capture, storage, search and reminders behave exactly as
before; voice notes are stored with a "not transcribed" marker and rules classify
text.

| Variable | Default | Meaning |
| --- | --- | --- |
| `STT_PROVIDER` | `none` | `none` or `openai` (any OpenAI-compatible `/audio/transcriptions` endpoint) |
| `STT_API_KEY` | empty | Required when `STT_PROVIDER=openai`; placeholder values are rejected |
| `STT_BASE_URL` | `https://api.openai.com/v1` | Provider base URL |
| `STT_MODEL` | `whisper-1` | Transcription model |
| `STT_MAX_AUDIO_SECONDS` | `180` | Clips longer than this are not downloaded or transcribed |
| `STT_MAX_AUDIO_BYTES` | `26214400` (25 MiB) | Maximum bytes read while streaming the download; oversized bodies are cancelled before transcription |
| `STT_RETAIN_AUDIO` | `false` | Write the downloaded clip to disk (including when transcription failed) |
| `STT_AUDIO_DIR` | `./data/audio` | Only used when retention is on; never served by the API |
| `AI_PROVIDER` | `none` | `none`, `openai`, `openai-compatible` or `anthropic` |
| `AI_API_KEY` | empty | Required when the provider is not `none` |
| `AI_BASE_URL` | empty (the provider's own endpoint: `https://api.anthropic.com` or `https://api.openai.com/v1`) | Set only for an OpenAI-compatible server or a gateway; plain `http://` is accepted only for loopback hosts outside development; an OpenAI address with `AI_PROVIDER=anthropic` is ignored with a startup warning |
| `AI_MODEL` | none (**required** with a provider) | Model id, e.g. `claude-opus-5-5` or `claude-haiku-5-5`; recorded in logs and health and used in the cache key. The server refuses to start without it when a provider is set |
| `AI_TIMEOUT_MS` | `15000` | Per-attempt timeout |
| `AI_MAX_RETRIES` | `2` | Bounded retries for retryable failures |
| `AI_ALLOW_RAW_TEXT` | `false` | Opt-in permission to send your own text (captures, transcripts, Ask evidence) to the provider. Off: a configured provider receives nothing |

Voice pipeline behaviour:

- The adapter checks for a replay **before** calling `getFile`; a duplicated
  Telegram update costs no download and no transcription.
- Duration and mime type are checked before the download. Supported formats are
  OGG/Opus, MP3, MP4/M4A, WAV, WebM and FLAC. Anything else is stored,
  untranscribed, with a reply naming the reason.
- Audio is held in memory. With the default `STT_RETAIN_AUDIO=false` it is never
  written to disk, so there is no temporary-file cleanup to fail. If retention is
  enabled, one file per downloaded clip lands in `STT_AUDIO_DIR` (git-ignored) and
  `Capture.mediaRef` records its path. The file is written even when transcription
  fails. Permanent purge unlinks it; undo keeps it because undo is a reversible
  soft delete. Deletion is limited to a direct child of `STT_AUDIO_DIR`: paths
  with `..`, paths that resolve outside the directory, and nested paths are
  refused. A missing file is a successful no-op; other filesystem errors are
  logged (without the path) and roll the purge back so it can be retried.
- A failed, timed-out or empty transcription never loses the capture. With a
  caption, the caption is classified and the reply says transcription failed;
  without one, the capture is marked `NEEDS_REVIEW` and the reply asks for text or
  a caption.
- The transcript is labelled and stored apart from the caption. If both exist,
  classification reads caption first, then transcript. A provider transcript over
  8,000 characters is rejected rather than truncated; the capture is still stored
  with its caption or placeholder, and the reply names the limit.

AI classification and cache:

- AI is used only when a provider is configured **and** AI is enabled in settings.
  Any failure falls back to deterministic rules, and the reply says so.
- Provider output is validated against `classifyCaptureSchema` before use.
- A validated result is cached per capture. The key covers text, hint, time zone,
  morning/evening defaults, project vocabulary, provider, model and the exact
  reference instant, so an entry is invalidated by a settings, provider or model
  change. Failures are never cached.
- Relative dates are resolved against the capture's original `capturedAt`, not the
  processing time. Reprocessing "remind me in two hours" later does not move the
  reminder, and the cached result stays correct. Reprocess is still a retry for
  failed processing, not a way to re-resolve relative times from a new clock.
- Reprocessing the same capture twice at once is refused (`already being
  processed`); recall is a single-process server.

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
| `npm run recall -- backup --out backups` | consistent SQLite snapshot + JSON export |
| `npm run recall -- verify-backup <file>` | integrity, foreign-key, migration and row-count check |
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
"process down" from "dependency down". In polling mode it also shows whether
Telegram polling is actually working (`providers.telegram.polling`, see
"Telegram bot runtime").

## 6a. Reminder scheduler configuration and behavior

The reminder scheduler is a database-backed tick loop; no reminders live only in
memory. Configuration is via environment variables (validated at startup):

| Variable | Default | Purpose |
| --- | --- | --- |
| `SCHEDULER_INTERVAL_SECONDS` | `20` | How often the scheduler ticks and checks for due reminders. |
| `REMINDER_MAX_ATTEMPTS` | `5` | Maximum delivery attempts before a reminder is marked `FAILED`. |
| `REMINDER_RETRY_BASE_SECONDS` | `30` | Base delay for exponential backoff between retries. |
| `REMINDER_OVERDUE_GRACE_HOURS` | `12` | On startup, overdue reminders inside this window fire once; older ones are marked `MISSED`. |
| `QUIET_HOURS_START` / `QUIET_HOURS_END` | *(unset)* | Local-time window (HH:MM) during which notifications are deferred, not dropped. Supports wrap past midnight (e.g. `22:00` / `07:00`). |
| `MAX_NOTIFICATIONS_PER_DAY` | `0` (unlimited) | Daily cap on delivered notifications. When reached, further deliveries are deferred to the next local day. |

**Startup recovery:** when the process starts, the scheduler runs a recovery pass
before the first tick. Reminders past their scheduled time but within the grace
window are delivered; those beyond it are marked `MISSED` and their series (if
recurring) advances to the next future occurrence. This prevents a notification
storm after prolonged downtime.

**Quiet hours and daily cap:** both defer rather than drop. A deferred delivery
remains `PENDING` with a future `nextRetryAt`; it is retried on the next tick
after the quiet window ends or the next local day begins. The `idempotencyKey`
(`<reminderId>:<scheduledForIso>:<attempt>`) guarantees exactly-once delivery
across restarts and concurrent processes.

**Recurrence:** `DAILY`, `WEEKLY` (with optional weekdays), and `MONTHLY` are
supported. Occurrences are generated one at a time, each with a unique
`occurrenceKey`, bounded by `maxOccurrences` and `until`. Editing or cancelling
a series head cancels all pending generated occurrences; cancelling a child
affects only that occurrence.

**Cancelling vs editing:** cancelling a reminder marks it `CANCELLED` and skips
all pending deliveries. Editing the schedule (time or recurrence) of a series
head cancels its pending children so the series restarts from the new definition.

## 6b. Daily briefing

The daily briefing is delivered by the **same** tick loop as the reminders
(`apps/server/src/services/reminder-scheduler.ts` → `briefing-delivery.ts`).
There is no second scheduler and no second timer: both features share one loop,
one quiet-hours rule and one daily cap.

| Setting | Default | Where | Meaning |
| --- | --- | --- | --- |
| `BRIEFING_ENABLED` | `false` | environment (initial value only) | Whether the daily delivery runs. The value stored in settings wins once the owner saves it. |
| `BRIEFING_TIME` | `07:30` | environment (initial value only) | Local time (HH:MM, 24-hour) in the owner's zone. |
| `briefingSections` | `today, overdue, upcoming` | `PATCH /api/briefing/config` | Which sections appear, in which order. Allowed: `today`, `overdue`, `deadlines`, `upcoming`, `ideas`. |

`GET /api/briefing/config` shows the current configuration, and
`PATCH /api/briefing/config` changes it. The dashboard's settings page edits the
same values.

**Delivery rules**

- **One briefing per local day.** The occurrence is the local calendar date in
  the owner's zone. A second tick, or a restart, does not produce a second
  briefing.
- **Off by default.** With the daily delivery disabled nothing is sent, but
  `GET /api/briefing` still returns a briefing on demand — the switch governs
  *scheduled delivery only*.
- **Quiet hours and the daily cap defer, within a deadline.** A deferred attempt
  stays `PENDING` with a future `nextRetryAt`; the row survives a restart. The
  daily cap counts reminder and briefing deliveries together, because that is
  what the owner experiences.
- **Sent within 2 hours, or skipped (D59).** The window opens at the briefing
  time. If that time falls inside quiet hours, it opens when those quiet hours
  end instead (briefing 06:00, quiet hours until 09:00: sendable until 11:00).
  It closes 2 real hours later; DST changes do not stretch it. The deadline
  governs the *start* of the send: it is checked again on the live clock
  immediately before the message is handed to Telegram, so time spent preparing
  the briefing cannot push a send past it; a send that starts in time is not
  cancelled if Telegram answers slowly. `deliveredAt` records when the send
  finished. Nothing else
  moves the deadline: a server that was off, a missing channel, the daily cap or
  a failed send only use up the same window. A briefing still unsent at the
  deadline is recorded as `SKIPPED` with the reason `more than 2 hours late`,
  logged once (`daily briefing skipped: more than 2 hours late`), and never sent
  later by a retry, a restart or a change of briefing time that day. Switching
  the briefing on more than 2 hours after its time therefore starts it
  tomorrow. The 2 hours are fixed in code (`BRIEFING_LATE_LIMIT_MS`); there is no
  setting. Reminders keep their own rule (`REMINDER_OVERDUE_GRACE_HOURS`).
- **A briefing belongs to its own day.** Midnight is a hard stop: a 23:00
  briefing can be sent until 23:59 at the latest. A row still waiting from an
  earlier day is skipped rather than delivered the next morning (reason `the
  briefing day had passed`). Missed days are never caught up or combined.
- **At-least-once with a bounded retry.** A transient failure is retried with
  exponential backoff (30 s base, 30-minute ceiling, 3 attempts in total). A
  permanent failure is recorded as `FAILED` and is not retried.
- **Nothing is invented.** Every line of the briefing is a row that exists in the
  database; an empty section is reported as empty rather than filled with
  plausible-looking placeholders.

Every attempt is stored in the `briefing_deliveries` table (`status`,
`attempt`, `scheduledFor`, `nextRetryAt`, `idempotencyKey`), so the state can be
inspected and duplicate delivery is impossible.

**(pending)** Live delivery to Telegram has not been exercised in this
environment — every test drives a scripted notifier with an injectable clock.
Verifying a real daily briefing against the bot is a manual smoke test on the
owner's machine.

## 7. Backups

### What to back up

1. The database file (default `apps/server/prisma/dev.db`) **plus** its `-wal` and
   `-shm` siblings if WAL mode is active. Copying only the `.db` file while a
   writer is active can capture a torn state.
2. `.env` (separately, encrypted — it contains your password and API keys).
3. Only if `STT_RETAIN_AUDIO=true`: the `STT_AUDIO_DIR` directory. Retained audio
   is **not** part of the JSON export, because the export bundle is deliberately
   text-only.

### Recommended procedure

The product includes a consistent backup command. It uses SQLite's
`VACUUM INTO`, so it works while the service is running and does not require the
`sqlite3` CLI. It writes a self-contained `.db` snapshot **and** the same JSON
export, then applies retention to managed files only:

```bash
npm run recall -- backup --out backups --keep 14
npm run recall -- verify-backup backups/recall-<timestamp>.db
```

The output reports SQLite integrity, foreign-key violations, applied/unfinished
migrations and row counts. A snapshot is accepted only when integrity is `ok`,
there are no foreign-key violations and no migration is unfinished. Retention
keeps the newest 14 timestamped pairs by default; files that do not match
`recall-<UTC timestamp>.db|json` are never deleted. Relative `--out` and
`verify-backup` paths are resolved against the repository root, even though the
npm workspace runs the CLI from `apps/server`.

If you prefer the `sqlite3` CLI:

```bash
# Consistent copy without stopping the service (requires the sqlite3 CLI):
sqlite3 apps/server/prisma/dev.db ".backup 'backups/recall-2026-10-17.db'"
```

The logical export remains available through the API (`GET /api/export`, JSON):

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

### Restoring a database snapshot

A snapshot is a complete SQLite database, not a partial copy. Restore it to a
**separate path first** and verify it before replacing a live database:

```bash
cp backups/recall-<timestamp>.db /tmp/recall-restore-drill.db
npm run recall -- verify-backup /tmp/recall-restore-drill.db
```

Compare the reported counts with the backup output. For a real file swap, stop
the service, remove the old `-wal`/`-shm` siblings, replace the database, apply
pending migrations and start again:

```bash
# local development
npm run recall -- verify-backup backups/recall-<timestamp>.db
# stop the server before the following copy
cp backups/recall-<timestamp>.db apps/server/prisma/dev.db
rm -f apps/server/prisma/dev.db-wal apps/server/prisma/dev.db-shm
npm run db:deploy
npm run dev:server
```

The container procedure is in section 10. The local restore drill is also covered
by `apps/server/tests/integration/backup-service.test.ts`, which copies a snapshot
to a new file and verifies its integrity, migration state and rows. The older
`export-restore.test.ts` covers the additive JSON round trip. Neither test is a
substitute for exercising the owner's real backup on the deployment host.

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
| 429 responses | Per-IP rate limit (240/min overall, 10/min on login, 120/min on the Telegram webhook). Expected under load, not a bug. |
| All clients appear to share one rate-limit bucket | Recall is behind a proxy but `TRUST_PROXY` is `false`. Set it to the proxy address/CIDR; never enable it for direct client connections. |
| Port already in use | Change `PORT`, or stop the other process. |
| Bot ignores your messages | `TELEGRAM_OWNER_IDS` does not contain your Telegram user id (not your username). Check with `npm run recall -- doctor` and the startup log line. |
| Bot replies "This bot is private" | You are messaging from an id that is not in `TELEGRAM_OWNER_IDS`. |
| `telegram rejected the bot token ... - polling stopped` | The bot token is wrong or revoked. Nothing else is affected; capture via the API/CLI still works. Fix the token and restart. |
| `telegram getMe failed - retrying before polling starts` | Telegram is unreachable at start-up (often the network is not up yet). Recall keeps retrying and starts polling once it can. |
| `telegram polling failed - retrying` | A transient network or Telegram error. Recall backs off (and honours `retry_after`) and recovers on its own. |
| `telegram webhook is set - removing it so polling can start` | The bot was last used in webhook mode. Expected once after switching to polling. |
| `telegram webhook keeps returning - another deployment may be using this bot token in webhook mode` | Another deployment re-registers its webhook. Give each deployment its own bot token. |
| `another copy of Recall is polling with this bot token` | Two processes poll with the same token. Stop one; the other recovers by itself. |
| Duplicate-looking behaviour after a restart | A restart re-fetches the last few updates because the polling offset is in memory. Idempotency means no second capture is stored; the reply is simply "Already saved". |
| Webhook returns 401 | `TELEGRAM_WEBHOOK_SECRET` on the server does not match the `secret_token` Telegram sends. Re-register by restarting the server. |
| Webhook returns 503 | `TELEGRAM_WEBHOOK_SECRET` is not set. Webhook mode will not accept unsigned updates. |
| `A reminder is set.` never appears | A reminder is only created when you asked for one ("remind me …") *and* a time was recognised. Tasks with a deadline get a `dueAt`, not a reminder. |
| Voice replies "did not transcribe it" | `STT_PROVIDER=none`, or the clip was too long, unsupported, oversized, or the provider failed. The capture is stored; add a caption or send the words as text. |
| Voice transcription fails repeatedly | Check `STT_API_KEY`, `STT_BASE_URL` and `STT_MODEL`, then `GET /api/health` to confirm the provider is reported as configured. The failure is logged without audio or keys. |
| The reply says "AI provider was unavailable" | The provider timed out, rate-limited, or returned invalid output. The rules classifier handled the capture and the failure was **not** cached, so the next reprocess tries again. |
| Search finds nothing although you know the text exists | Every word in the query must appear somewhere in the row, and only the fields listed in `search-service.ts` are searched (for a task: title, description, category; for a capture: text and transcript). Try fewer words. An undone capture is excluded unless you pass `includeDeleted=true`. |
| Search results look stale | Results are computed from the database on every request; nothing is cached. An undone capture and a soft-deleted row are simply not returned. |
| `/today` shows a task you expected tomorrow (or the reverse) | `/today` uses `settings.timeZone`, not the server clock. Check it with `/settings` or `GET /api/settings`. |
| Restore returns `errors` | Nothing was lost: each entry names the table and row that could not be written (usually a missing parent row or a bundle edited by hand). Fix the bundle and re-run; rows already present are skipped. |
| Restore did nothing | It runs as a dry run unless `{"dryRun": false}` is passed. That is deliberate. |
| `DELETE /api/tasks/:id` returns 400 with `requiresConfirmation` | Same pattern as capture purge: destructive routes want an explicit confirmation in the body. |
| Conversion or undo refused after editing a record | Deliberate: converting or undoing a capture whose derived record you have since edited would discard your edits. Pass `{"force": true}` if that is what you want. |
| The daily briefing never arrives | The daily delivery is off by default. Check `GET /api/briefing/config` — `enabled` must be `true`. `GET /api/briefing` returns a briefing regardless, so a working briefing with no message means the *delivery* is off, not the feature. |
| The daily briefing arrives at the wrong time | The time is local to `settings.timeZone`, not the server clock. Check the zone in `GET /api/settings` and the time in `GET /api/briefing/config`. |
| The daily briefing was not sent and the attempt says `SKIPPED` | Its local day had passed — quiet hours or the daily cap deferred it past midnight, and a stale briefing is skipped rather than delivered late. Adjust the briefing time or the quiet-hours window. |
| The daily briefing was not sent and the attempt says `DEFERRED`/still `PENDING` | Quiet hours, the daily cap or a missing delivery channel deferred it. The row stays pending with a future `nextRetryAt` and survives a restart. |

## 10. Deployment

### What this repository provides

The production stack is defined by:

| File | Purpose |
| --- | --- |
| `Dockerfile` | Multi-stage build for the server runtime and the static dashboard/Caddy image. |
| `compose.yaml` | One-shot migration, server, Caddy TLS proxy, persistent SQLite volume, one-shot backup profile. |
| `deploy/Caddyfile` | Automatic HTTPS, static SPA serving, `/api/*` reverse proxy and security headers. |
| `.env.production.example` | Production environment template with placeholders only. |

The server container is **not** published to the host. Caddy is the only public
process and proxies `/api/*` to `app:4000`; it serves the compiled dashboard from
`/srv`. SQLite lives on the `recall_data` volume at `/data/recall.db`.

### First deployment

Prerequisites: a small always-on Linux host with Docker Engine and Compose, a DNS
name whose A/AAAA record points at the host, and inbound TCP 80/443 plus UDP 443
open. Caddy obtains and renews the TLS certificate automatically once DNS works.

```bash
git clone <repository> /opt/recall
cd /opt/recall
cp .env.production.example .env.production
chmod 600 .env.production

# Generate the two required secrets, then put them in .env.production.
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"

# Edit at minimum: RECALL_DOMAIN, CORS_ORIGINS, DASHBOARD_PASSWORD, SESSION_SECRET.
# If enabling Telegram webhooks, set TELEGRAM_WEBHOOK_URL to
# https://<RECALL_DOMAIN>/api/telegram/webhook and set a webhook secret.
${EDITOR:-vi} .env.production

# Static validation without starting containers:
docker compose --env-file .env.production config

# Build, run migrations once, then start the app and Caddy.
docker compose --env-file .env.production up -d --build
docker compose --env-file .env.production ps
docker compose --env-file .env.production logs migrate
```

The `migrate` service must exit successfully before `app` starts. It applies
`prisma migrate deploy` to `/data/recall.db` as UID/GID 1000. If an existing volume
has the wrong ownership, fix it once while the app is stopped:

```bash
docker compose --env-file .env.production run --rm --user 0 \
  --entrypoint chown migrate -R 1000:1000 /data
```

Then verify:

```bash
curl -fsS https://recall.example.com/api/health/live
# Sign in through https://recall.example.com and check the authenticated report:
#   GET /api/health
```

### Upgrades

Back up first. Then rebuild, apply migrations and recreate only the app:

```bash
docker compose --env-file .env.production --profile backup run --rm backup
docker compose --env-file .env.production build
docker compose --env-file .env.production run --rm migrate
docker compose --env-file .env.production up -d app caddy
docker compose --env-file .env.production ps
```

The migration runner is deliberately a separate one-shot service. It is never
started implicitly by an app restart, so a normal restart cannot race a schema
change.

### Backups and off-host copies

`backup` is a compose profile, not a long-running service. It mounts the host's
`./backups` directory and the persistent database volume, writes a verified
snapshot and JSON export, and applies retention:

```bash
mkdir -p backups
# Linux only: make the bind mount writable by RECALL_UID/RECALL_GID (default 1000).
sudo chown 1000:1000 backups

docker compose --env-file .env.production --profile backup run --rm backup
ls -l backups
```

The command is safe while the app is running. Copy backups off the host and
encrypt them if they leave it:

```bash
rsync -a backups/ backup-host:/srv/recall-backups/
```

A daily host cron entry (adjust paths and UID/GID):

```cron
0 3 * * * cd /opt/recall && docker compose --env-file .env.production --profile backup run --rm backup >> /var/log/recall-backup.log 2>&1
```

Retention keeps the newest 14 managed pairs. The default can be changed with
`--keep` in the backup service command or on the local CLI.

### Restore on the host

Restore into the live volume only after verifying the snapshot:

```bash
docker compose --env-file .env.production --profile backup run --rm backup \
  node dist/cli.js verify-backup /backups/recall-<timestamp>.db

docker compose --env-file .env.production stop app
docker compose --env-file .env.production --profile backup run --rm --user 0 backup \
  sh -c 'rm -f /data/recall.db-wal /data/recall.db-shm && cp /backups/recall-<timestamp>.db /data/recall.db && chown 1000:1000 /data/recall.db'
docker compose --env-file .env.production run --rm migrate
docker compose --env-file .env.production up -d app caddy
```

The `verify-backup` step checks SQLite integrity, foreign keys, migration state and
row counts before the live file is touched. The copy step removes stale WAL/SHM
siblings because a snapshot is self-contained, and runs as root so the copy still
works when `RECALL_UID` differs from the app's container UID; the final `chown`
restores the app user's ownership. If the snapshot is incomplete, stop and use
another backup; do not run the copy.

Stop `app` before running `migrate` or touching the database. In validation, a
migration rerun while `app` was live failed with `SQLite database error: database is
locked`; with `app` stopped, the same migration run exited 0 and reported no pending
migrations. The copy/restore steps can otherwise appear successful while the live
process still holds the database.

### Supervision, health and restart behavior

- `restart: unless-stopped` restarts the app and Caddy after a crash or host
  reboot (provided the Docker service is enabled at boot).
- The app image has a Docker healthcheck against `/api/health/live`; Caddy waits
  for the app to become healthy before starting.
- `/api/health` (authenticated) reports database latency, scheduler state and
  provider configuration. A degraded dependency is visible without taking the
  process down.
- The scheduler's startup recovery is database-backed. Pending reminder and
  briefing rows survive a container restart; reminders inside the configured
  grace window are delivered once, older ones are marked missed. A deliberate
  restart on a disposable local stack preserved one pending reminder and its
  single delivery row without creating a duplicate. Because that stack used the
  `none` notifier, actual Telegram delivery and end-to-end exactly-once behavior
  still require a host test with a configured bot.
- Logs are JSON on stdout; use `docker compose logs -f app caddy` and configure
  log rotation at the Docker daemon level.

### Validation status

The local checks that have actually been executed are recorded in
[`TESTING.md`](TESTING.md). `docker compose --env-file .env.production config
--quiet` passed for both the default services and the `backup` profile. The full
server suite (590 tests), the dashboard suite (40 tests) and the Playwright browser
suite (71 tests: 70 checks plus the login setup project) pass.

On 2026-10-26 a disposable local Docker stack was built and started with generated
secrets, `RECALL_DOMAIN=localhost`, and Telegram/AI/STT disabled. The migration
container applied four migrations to a fresh volume and exited 0; the app became
Docker-healthy; Caddy served the dashboard over HTTPS with the local CA and proxied
`/api/*`. The app port was not exposed on the host. Login/session, capture creation
and reminder creation all succeeded through Caddy. Plain HTTP redirected to HTTPS.
A Caddy container restart returned 200 for the dashboard and health endpoint and
reused the persisted local CA certificate.

The `backup` profile created a snapshot and JSON export and reported integrity `ok`,
zero foreign-key violations, four applied migrations and matching counts. Standalone
`verify-backup` confirmed the same. The restore path above was then executed against
the disposable volume: `app` was stopped, the verified snapshot copied in, stale
WAL/SHM siblings removed, ownership restored, `migrate` run while `app` was stopped
(no pending migrations), and `app` restarted. Health, session, capture and reminder
data were intact with unchanged counts.

A due reminder on that stack was deferred as one `PENDING` delivery because the
stack used the `none` notifier. A deliberate app-container restart preserved the
reminder and its single delivery row and did not create a duplicate.

On 2026-11-01 the local browser acceptance run (`npm run test:e2e`) passed 71/71
tests in Microsoft Edge against a disposable database and the production
dashboard bundle. It covered login/logout, bad-password rejection, session expiry,
anonymous access, keyboard navigation, modal focus trapping, responsive layouts,
overview, all sidebar destinations, settings, capture, task edit/delete, task
status, reminder snooze, note/idea/event/project detail flows, search, empty and
failed-request states, console/request checks, and axe WCAG 2.0/2.1 A/AA checks
on the login screen plus six authenticated pages in both light and dark schemes.
No axe violations remain in either tested color scheme. The run also found and
closed application defects, recorded
in [`TESTING.md`](TESTING.md). This was a local preview run, not a run through
Caddy or the deployed container.

The same follow-up passed `npm run verify` (37 files, 590 tests),
`npm run test --workspace @recall/web` (40 tests), `npm run build:all`, and
disposable Prisma migration status. The backup regression suite now proves that
the JSON companion is exported from the verified SQLite snapshot even when the
live database changes immediately afterward. A fresh Docker/Caddy run was not
executed because the Docker daemon was unavailable (`failed to connect to the
docker API at npipe:////./pipe/dockerDesktopLinuxEngine`); no `.env.production` or
live credentials were created. Compose validation also stopped because the
referenced `.env.production` file was absent.

**Still pending:** a remote always-on host, public DNS and a publicly trusted TLS
certificate, live Telegram/AI/STT calls, actual notification delivery and
exactly-once delivery against a reachable channel, and restore of the owner's
production backup. The acceptance boxes in the roadmap remain open until those are
executed and recorded here. The app image was built after removing an unused
BuildKit syntax directive from `Dockerfile`; a fresh rebuild from the edited
repository file was still in its `npm prune` stage when this was recorded.
