# Recall

A personal memory and task assistant for **one owner**. Capture a thought in
Telegram (text or voice) or from the web dashboard, and Recall keeps the original
words, works out what it probably is (task, idea, note, event), stores it durably,
reminds you on time, and lets you find it again later.

Recall is **not** a surveillance tool. It only accepts information you
deliberately send it. There is no background recording, no keystroke logging, no
screenshots of your activity.

---

## Status

| Milestone | Scope | State |
| --- | --- | --- |
| 1. Foundation | workspaces, config validation, database + migrations, health checks, logging, baseline tests | **Done** |
| 2. Capture | Telegram bot (polling + webhook), text + voice capture, classification, confirmation, correction, undo, idempotency, capture API | **Done** |
| 3. Tasks, library and search | task state machine, ideas/notes/events/projects, cross-entity search, library API, export/restore | **Done** |
| 4. Reminders | natural-language dates, persistent scheduling, retries, restart recovery | **Done** |
| 5. Dashboard | React/Vite web interface on the authenticated API | **Done** |
| 6. Voice + AI | speech-to-text with provenance, replaceable AI providers, per-capture cache, degraded operation | **Done** |
| 7. Recall + briefings | database-grounded retrieval, configurable daily briefing | **Done** |
| 8. Deployment | production config, persistent hosting, backups, recovery | **In progress** — Docker/Caddy stack, local backup/restore drill and operations runbook; live host/TLS validation pending |
| Round 1 foundation fixes | audit 2026-11-17: settings, time zones, Ask dates, AI privacy, Telegram recovery, briefing deadline | **Done** — merged as PR #2 |
| Round 2 dashboard | Ask, Today, inbox review, edit/delete, pagination, export/restore, error handling, accessibility | **Done** — merged as PR #7 |
| Round 3 testing and hardening | safe `db:seed`, scheduler starvation and grace sweep, liveness probe, session revocation, CSP, trusted proxy, log redaction, pinned images, Docker drill | **Done** — merged as PR #10 (migration `20261127120000_revoked_sessions`) |
| Round 4 host and live integrations | trusted TLS host, live Telegram/AI/STT, scheduled off-host backups, monitoring, release | **Not started** — blocked on a host, a domain and credentials; preparatory work under way |

Full detail, acceptance criteria and remaining work: [`docs/ROADMAP.md`](docs/ROADMAP.md).

---

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | milestones, acceptance criteria, status, what is next |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | components, data flow, data model, architectural decisions |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | running locally, deployment, secrets, logs, backups, recovery, troubleshooting |
| [`docs/SECURITY.md`](docs/SECURITY.md) | authentication, permissions, threat model, data handling, external providers |
| [`docs/TESTING.md`](docs/TESTING.md) | test layout, commands, what is covered, actual recorded results |

---

## Requirements

- **Node.js >= 20.11** (developed and tested on Node 24.17, npm 11.13)
- No external database server: SQLite ships with Recall.
- No cloud account is required. AI classification and speech-to-text are optional
  and off by default; deterministic parsing handles the core flows.

---

## Quick start

```bash
# 1. Install dependencies (also generates the Prisma client)
npm install

# 2. Create your local environment file and set a password
cp .env.example .env        # Windows: copy .env.example .env
#    then edit .env:
#      DASHBOARD_PASSWORD=<a long random value>
#      SESSION_SECRET=<at least 32 random characters>

# 3. Create the database and apply migrations
npm run db:migrate

# 4. Start the API
npm run dev:server

# 5. Check it is healthy
curl http://127.0.0.1:4000/api/health/live
```

Generate strong values locally (they are never committed):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

### Verification

```bash
npm run verify        # typecheck + full test suite
npm test              # tests only
npm run typecheck     # TypeScript only
```

Recorded results are in [`docs/TESTING.md`](docs/TESTING.md).

---

## Using it

### Telegram bot

Text capture works with no AI provider and no cloud account.

```bash
# .env
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=123456:your-real-token        # from @BotFather
TELEGRAM_OWNER_IDS=123456789                     # your id, from @userinfobot
TELEGRAM_MODE=polling                            # local development
```

Then `npm run dev:server`. Send the bot any message and it replies with what it
understood:

```
Saved as a task:
• call Ada
Due: Sun 18 Oct 2026, 16:00 (tomorrow at 4:00 PM)
```

Every confirmation carries buttons: **Task / Idea / Note / Appointment** to correct
the classification, and **Undo** (which asks for confirmation before removing
anything).

Commands that work today:

| Command | What it does |
| --- | --- |
| `/tasks` | Open tasks, soonest deadline first (`/tasks all` includes finished ones) |
| `/today` | Tasks due in your local day |
| `/overdue` | Open tasks past their deadline |
| `/search <words>` | Search captures, tasks, notes, ideas, appointments, projects and reminders (alias `/find`) |
| `/ideas` | Your ideas |
| `/notes` | Your notes and saved links |
| `/projects` | Projects with their open-task counts |
| `/inbox` | Captures that need review |
| `/undo` | Undo your most recent capture |
| `/ask <question>` | Answer from your records, with the sources it used |
| `/settings` | Your configuration |
| `/help` | This list |
| `/remind <when> <what>` | Set a reminder (e.g. `/remind in 10 minutes Review docs`, `/remind tomorrow at 9am Call office`) |
| `/reminders` | Your reminders (`/reminders all` includes finished) |
| `/snooze <10m|1h|tomorrow 9am> [id]` | Snooze a reminder |
| `/cancel [id]` | Cancel a reminder |

`/ask` retrieves matching records first, answers only from that evidence, and
lists the records behind the answer. With no AI provider (or with AI disabled in
settings) it returns a deterministic, cited summary; with no matching records it
says so instead of inventing an answer.

Anything other than text, voice, or a known command — stickers, documents, photos —
is acknowledged and ignored rather than silently dropped.

### Voice and AI

Both integrations are optional and off by default.

- **Voice:** with `STT_PROVIDER=openai` (or any OpenAI-compatible
  `/audio/transcriptions` endpoint), a voice note is downloaded, transcribed and
  classified. The transcript is stored separately from your caption with explicit
  provenance and shown in the confirmation. If you add a caption, both are used —
  caption first, transcript second — and neither is discarded. Concurrent duplicate
  deliveries of the same voice message are coalesced within one server process, so
  they share one download and one transcription; the unique capture identity still
  prevents a second stored row. Audio is never written to disk unless
  `STT_RETAIN_AUDIO=true`; with no transcriber, the message is stored and clearly
  marked "not transcribed" instead of failing. Retained
  files live directly inside `STT_AUDIO_DIR`; permanent purge unlinks the file,
  while undo keeps it because undo is a reversible soft delete.
- **AI:** with `AI_PROVIDER` set, classification uses the provider only when AI is
  enabled in settings. Output is validated against a strict schema; any timeout,
  rate limit, outage or malformed reply falls back to the deterministic rules and
  says so. Successful results are cached per capture, keyed on the content,
  configuration and exact capture reference instant. Relative dates resolve
  against `capturedAt`, so a reprocess does not move "in two hours" and retries do
  not pay twice. Failures are never cached.

Known limits: clips over `STT_MAX_AUDIO_SECONDS` are refused before download, and
oversized downloads are stopped while streaming at `STT_MAX_AUDIO_BYTES` (a
declared oversized `Content-Length` is rejected before the body is read). Voice
duplicate coalescing is process-local; a multi-process deployment would not share
it, though the database unique constraint still prevents a second capture. No live
Telegram, AI or speech provider is exercised by the test suite; providers are
mocked or injected.

The dashboard now renders capture transcripts with provenance: speech-to-text
output is labelled separately from a user-supplied caption, and a voice note with
no transcript shows "Transcript unavailable" instead of the internal placeholder.
Capture, task, reminder, note, idea, event and project rows link to registered
detail pages; missing or unauthenticated records show a generic error without
record content. Provider metadata, retained-audio paths and classification-cache
fields are not part of the public DTO and never reach the browser. A provider
transcript longer than 8,000 characters is rejected rather than truncated; the
message is still stored with its caption or the placeholder, and the reply says
the transcript was too long. Retained audio has no age-based expiry: undo keeps it
until the capture is permanently purged.

**Production uses webhooks instead of polling:**

```bash
TELEGRAM_MODE=webhook
TELEGRAM_WEBHOOK_URL=https://recall.example.com/api/telegram/webhook  # full public path, no trailing slash
TELEGRAM_WEBHOOK_SECRET=<random string>            # verified in constant time
```

On boot Recall calls `setWebhook` for you. The update arrives at
`POST /api/telegram/webhook`; the secret is compared with `timingSafeEqual` and a
missing or wrong secret is rejected before anything is read. The public webhook is
rate-limited to 120 requests/minute per client IP. If Recall runs behind a reverse
proxy, set `TRUST_PROXY` to that proxy's address or CIDR so the limiter sees the
real client IP; leave it `false` when clients connect directly.

Switching back to polling needs no manual step: polling mode removes a leftover
webhook first (pending messages are kept). Give each deployment its own bot
token; Telegram allows one receiver per bot. Telegram is a temporary bridge until
ALIVE's native Windows and Android notifications exist (decision D58 in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)). Reminders alert with sound; the
daily briefing arrives silently.

### Production deployment

The repository includes a Docker Compose stack: a one-shot migration service, the
compiled server, Caddy terminating HTTPS and serving the dashboard, a persistent
SQLite volume and a one-shot backup profile. It is not deployed to a public host
in this repository's test environment.

```bash
cp .env.production.example .env.production
chmod 600 .env.production
mkdir -p backups
# set RECALL_DOMAIN, CORS_ORIGINS, DASHBOARD_PASSWORD, SESSION_SECRET;
# update TELEGRAM_WEBHOOK_URL if you enable Telegram webhooks
docker compose --env-file .env.production config
docker compose --env-file .env.production up -d --build
```

Create and verify a backup at any time while the service is running:

```bash
docker compose --env-file .env.production --profile backup run --rm backup
```

The full host setup, TLS, upgrade, backup/restore and restart-recovery procedure is
in [`docs/OPERATIONS.md`](docs/OPERATIONS.md#10-deployment). Live host/TLS and
live Telegram validation remain pending.

### Local command line

```bash
npm run recall -- doctor                    # configuration + database check
npm run recall -- capture "call Ada at 4pm" # store without Telegram
npm run recall -- inbox                     # what still needs review
npm run recall -- backup --out backups      # consistent DB snapshot + export
npm run recall -- verify-backup backups/recall-<timestamp>.db
npm run recall -- serve                     # start the API and any adapters
```

### Capture API

The dashboard and scripts use the same service layer as the bot. All routes need an
owner session (the server enforces this, not the UI).

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/captures` | Store a capture (`externalId` makes it idempotent) |
| `GET` | `/api/captures` | List with filters, sorting and pagination |
| `GET` | `/api/captures/inbox` | Captures waiting for review, oldest first; paginated with a real `total` |
| `GET` | `/api/captures/:id` | One capture |
| `POST` | `/api/captures/:id/reprocess` | Classify a capture that failed earlier |
| `POST` | `/api/captures/:id/convert` | Keep as another kind (`{kind, force}`; refused without `force` if a derived record was edited) |
| `POST` | `/api/captures/:id/undo` | Removes what the capture created and hides it (15 minutes, or `force`); not reversible from the dashboard |
| `DELETE` | `/api/captures/:id` | Permanent; requires `{"force": true}` |

### Library, search, export

The same session protects everything below; the server enforces it, never the UI.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET`/`POST` | `/api/tasks` | List (filter, sort, paginate) and create |
| `GET`/`PATCH`/`DELETE` | `/api/tasks/:id` | Read, update (guarded status), delete |
| `GET` | `/api/tasks/today` | Open tasks due in your local day |
| `GET` | `/api/tasks/overdue` | Open tasks past their deadline |
| `GET` | `/api/tasks/counts` | Counters for the dashboard |
| `GET`/`POST` | `/api/notes` | Notes and saved links |
| `GET`/`POST` | `/api/ideas` | Ideas |
| `POST` | `/api/ideas/:id/promote` | Turn an idea into a task (the idea is kept) |
| `GET`/`POST` | `/api/events` | Appointments |
| `GET`/`POST` | `/api/projects` | Projects, paginated (`DELETE` detaches members, never deletes them) |
| `GET` | `/api/tags`, `POST /api/tags/prune` | Labels, and removal of unused ones |
| `GET` | `/api/search` | One query across every entity; results state the matched field |
| `GET` | `/api/export` | Versioned JSON bundle of the whole database |
| `POST` | `/api/restore` | Additive restore of a JSON bundle (2 MB limit); **dry-run unless `{"dryRun": false}`** |
| `POST` | `/api/restore/file` | Restore an export file's raw bytes (25 MB); applying needs the dry run's `sha256` and `checkToken` |

Search accepts `q`, `types`, `status`, `kind`, `projectId`, `tag`, `priority`,
`from`, `to`, `includeDeleted`, `sort`, `order`, `limit` and `offset`. A
type-specific filter narrows the search to that type (`status`/`priority` → tasks,
`kind` → captures). Each result reports `matchedOn` so a match is never unexplained.

Restore never deletes or overwrites: a row that already exists (by id, or by its
natural key such as a tag name) is reused and reported as skipped, and any row that
cannot be written is listed in `errors` while the rest still load.

---

## Configuration

All configuration comes from environment variables, validated at startup with
Zod. A bad configuration stops the process with a readable message instead of
failing unpredictably later. `.env.example` contains **placeholders only**; the
real `.env` is git-ignored.

The most important variables:

| Variable | Purpose | Default |
| --- | --- | --- |
| `DATABASE_URL` | SQLite file, e.g. `file:./dev.db` | `file:./dev.db` |
| `DASHBOARD_PASSWORD` | Owner login for the dashboard | *(required)* |
| `SESSION_SECRET` | Signs dashboard sessions (>= 32 chars in production) | *(required)* |
| `TRUST_PROXY` | Trust `X-Forwarded-*` only from a reverse proxy; `true`, an address/CIDR, or a comma-separated list | `false` |
| `TELEGRAM_ENABLED` | Turn the bot on | `false` |
| `TELEGRAM_BOT_TOKEN` | From @BotFather | *(required when enabled)* |
| `TELEGRAM_OWNER_IDS` | The **only** Telegram user ids allowed to use the bot | *(required when enabled)* |
| `DEFAULT_TIME_ZONE` | IANA zone used to interpret and display local times | `Africa/Lagos` |
| `AI_PROVIDER` | `none`, `openai`, `openai-compatible`, `anthropic` | `none` |
| `AI_BASE_URL` / `STT_BASE_URL` | Provider endpoint; must be `http(s)` with no embedded credentials or fragment | AI: the provider's own endpoint; STT: OpenAI API URL |
| `AI_MODEL` | Model id; **required** whenever `AI_PROVIDER` is not `none` | *(none)* |
| `AI_ALLOW_RAW_TEXT` | Opt-in: may your own text be sent to the AI provider? | `false` |
| `STT_PROVIDER` | `none`, `openai` | `none` |
| `STT_MAX_AUDIO_SECONDS` / `STT_MAX_AUDIO_BYTES` | Voice clip limits; the byte cap is enforced while streaming the download | `180` / `25 MiB` |
| `STT_RETAIN_AUDIO` / `STT_AUDIO_DIR` | Keep raw voice audio on disk (opt-in only; permanent purge removes it) | `false` / `./data/audio` |

The full list, including quiet hours, retry and briefing settings, is in
`.env.example` with a comment on every value.

### Running without any external provider

With `AI_PROVIDER=none` and `STT_PROVIDER=none` (the default), Recall still
captures, stores, classifies with deterministic rules, schedules reminders,
searches and serves the dashboard. There are no placeholder features that
silently do nothing: `/api/health` reports exactly which providers are configured.

---

## Project layout

```
.
├── apps/
│   ├── server/           Node + TypeScript backend (API, bot, scheduler)
│   │   ├── prisma/       schema + versioned migrations
│   │   ├── scripts/      Prisma CLI wrapper (loads the repo-root .env)
│   │   ├── src/
│   │   │   ├── ai/       AI provider interfaces + implementations + rules
│   │   │   ├── config/   environment schema and validation
│   │   │   ├── db/       Prisma client, pragmas, transactions
│   │   │   ├── http/     Fastify server, auth, routes
│   │   │   ├── lib/      time, text, nlp, retry, errors, logging, crypto helpers
│   │   │   ├── services/ application services
│   │   │   ├── stt/      speech-to-text contract + OpenAI-compatible Whisper transport
│   │   │   ├── telegram/ bot API client, polling, webhook, commands, formatting
│   │   │   ├── cli.ts      local `doctor` / `capture` / `inbox` / `serve`
│   │   │   ├── context.ts  dependency container
│   │   │   ├── mappers.ts  database rows -> API DTOs
│   │   │   └── ports.ts    clock + notifier ports
│   │   └── tests/        unit + integration tests
│   └── web/              React + Vite dashboard
├── packages/
│   └── shared/           Zod contracts and DTO types shared by API + web
└── docs/                 architecture, operations, security, testing, roadmap
```

---

## Common commands

```bash
npm run dev:server              # API with hot reload
npm run dev:web                 # dashboard dev server
npm run test --workspace @recall/web  # dashboard component/navigation tests
npm run recall -- doctor         # check configuration and the database
npm run recall -- capture "…"    # store a capture from the terminal
npm run recall -- inbox          # captures waiting for review
npm run db:migrate              # create/apply a migration in development
npm run db:deploy               # apply migrations (production)
npm run db:status               # show migration state (read-only)
npm run db:studio               # browse the database
npm run db:seed -- <new file>   # DEVELOPMENT ONLY: create a NEW database file with fictional records
npm run db:reset:dev            # DEVELOPMENT ONLY drop + recreate the database
```

> `db:reset:dev` and `db:seed` refuse to run when `NODE_ENV=production`.
> `db:seed` has no default target: it only ever creates the new file you name and
> refuses `dev.db`, the configured `DATABASE_URL` and any existing file.
> Never point `db:reset:dev` at your real database.

---

## Privacy in one paragraph

Everything stored is treated as private. The Telegram bot answers only to the
owner ids in `TELEGRAM_OWNER_IDS`. The dashboard requires a password and the
server enforces authorization on every `/api` route. Message content, transcripts
and credentials are redacted from logs by default (`LOG_MESSAGE_CONTENT=false`).
Nothing is sent to an AI provider unless you configure one, keep AI on in
Settings, *and* set `AI_ALLOW_RAW_TEXT=true` (off by default). Voice audio is sent only to the configured speech
provider, is held in memory during that request, and is never written to disk
unless you set `STT_RETAIN_AUDIO=true`. Retained audio is deleted when you
permanently purge the capture; undo keeps it. You can export or delete all your
data. See [`docs/SECURITY.md`](docs/SECURITY.md).
