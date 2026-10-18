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
| 3. Tasks | tasks, ideas, notes, events, projects, search/filter | Not started |
| 4. Reminders | natural-language dates, persistent scheduling, retries, restart recovery | Not started |
| 5. Dashboard | React/Vite web interface on the authenticated API | Not started |
| 6. Voice + AI | speech-to-text, replaceable AI providers, degraded operation | Not started |
| 7. Recall + briefings | database-grounded retrieval, configurable daily briefing | Not started |
| 8. Deployment | production config, persistent hosting, backups, recovery | Not started |

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
anything). `/help`, `/inbox`, `/settings`, `/undo` and `/start` are available; other
commands answer honestly with the milestone that will bring them.

Anything other than text, voice, or a known command — stickers, documents, photos —
is acknowledged and ignored rather than silently dropped. Voice messages are stored
with a "not transcribed yet" marker until Milestone 6.

**Production uses webhooks instead of polling:**

```bash
TELEGRAM_MODE=webhook
TELEGRAM_WEBHOOK_URL=https://recall.example.com    # public HTTPS, no trailing slash
TELEGRAM_WEBHOOK_SECRET=<random string>            # verified in constant time
```

On boot Recall calls `setWebhook` for you. The update arrives at
`POST /api/telegram/webhook`; the secret is compared with `timingSafeEqual` and a
missing or wrong secret is rejected before anything is read.

### Local command line

```bash
npm run recall -- doctor                    # configuration + database check
npm run recall -- capture "call Ada at 4pm" # store without Telegram
npm run recall -- inbox                     # what still needs review
npm run recall -- serve                     # start the API and any adapters
```

### Capture API

The dashboard and scripts use the same service layer as the bot. All routes need an
owner session (the server enforces this, not the UI).

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/captures` | Store a capture (`externalId` makes it idempotent) |
| `GET` | `/api/captures` | List with filters, sorting and pagination |
| `GET` | `/api/captures/inbox` | Captures waiting for review |
| `GET` | `/api/captures/:id` | One capture |
| `POST` | `/api/captures/:id/reprocess` | Classify a capture that failed earlier |
| `POST` | `/api/captures/:id/convert` | Change the kind (guarded) |
| `POST` | `/api/captures/:id/undo` | Reversible removal |
| `DELETE` | `/api/captures/:id` | Permanent; requires `{"force": true}` |

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
| `TELEGRAM_ENABLED` | Turn the bot on | `false` |
| `TELEGRAM_BOT_TOKEN` | From @BotFather | *(required when enabled)* |
| `TELEGRAM_OWNER_IDS` | The **only** Telegram user ids allowed to use the bot | *(required when enabled)* |
| `DEFAULT_TIME_ZONE` | IANA zone used to interpret and display local times | `Africa/Lagos` |
| `AI_PROVIDER` | `none`, `openai`, `openai-compatible`, `anthropic` | `none` |
| `STT_PROVIDER` | `none`, `openai` | `none` |

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
│   │   │   ├── stt/      speech-to-text provider interfaces
│   │   │   ├── telegram/ bot API client, polling, webhook, commands, formatting
│   │   │   ├── cli.ts      local `doctor` / `capture` / `inbox` / `serve`
│   │   │   ├── context.ts  dependency container
│   │   │   ├── mappers.ts  database rows -> API DTOs
│   │   │   └── ports.ts    clock + notifier ports
│   │   └── tests/        unit + integration tests
│   └── web/              React + Vite dashboard (Milestone 5)
├── packages/
│   └── shared/           Zod contracts and DTO types shared by API + web
└── docs/                 architecture, operations, security, testing, roadmap
```

---

## Common commands

```bash
npm run dev:server              # API with hot reload
npm run dev:web                 # dashboard dev server (Milestone 5)
npm run recall -- doctor         # check configuration and the database
npm run recall -- capture "…"    # store a capture from the terminal
npm run recall -- inbox          # captures waiting for review
npm run db:migrate              # create/apply a migration in development
npm run db:deploy               # apply migrations (production)
npm run db:status               # show migration state
npm run db:studio               # browse the database
npm run db:seed                 # DEVELOPMENT ONLY fictional sample data
npm run db:reset:dev            # DEVELOPMENT ONLY drop + recreate the database
```

> `db:reset:dev` and `db:seed` refuse to run when `NODE_ENV=production`.
> Never point them at your real database.

---

## Privacy in one paragraph

Everything stored is treated as private. The Telegram bot answers only to the
owner ids in `TELEGRAM_OWNER_IDS`. The dashboard requires a password and the
server enforces authorization on every `/api` route. Message content, transcripts
and credentials are redacted from logs by default (`LOG_MESSAGE_CONTENT=false`).
Nothing is sent to an AI provider unless you configure one *and* leave
`AI_ALLOW_RAW_TEXT=true`. You can export or delete all your data. See
[`docs/SECURITY.md`](docs/SECURITY.md).
