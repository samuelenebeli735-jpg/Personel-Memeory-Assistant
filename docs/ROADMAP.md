# Recall — Roadmap

Legend: **Done** · **In progress** · **Not started**

Last updated: 2026-10-17 (session 1)

---

## Milestone 1 — Foundation  ·  **Done**

**Goal:** a running, configured, tested skeleton with a real database and health
checks, before any feature work.

**Delivered**

- npm workspaces monorepo: `packages/shared`, `apps/server`, `apps/web`.
- Strict TypeScript everywhere (`strict`, `noUncheckedIndexedAccess`,
  `verbatimModuleSyntax`).
- Zod-validated configuration loaded from environment variables, with
  production hardening rules (see `docs/SECURITY.md`).
- Structured JSON logger that redacts message content, transcripts and secrets by
  default.
- Prisma schema for all core entities + first versioned migration
  (`20261017215218_init`), applied to SQLite.
- SQLite tuned for a long-running single-owner process (WAL, foreign keys, busy
  timeout, synchronous=NORMAL).
- Error taxonomy (`AppError` and friends) mapped to safe HTTP responses.
- Fastify HTTP API with cookie sessions, CORS allow-list, per-IP rate limiting,
  request logging without bodies, and a JSON error handler.
- Endpoints: `GET /api/health/live` (public), `GET /api/health` (owner),
  `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/session`,
  `GET /api/settings`, `PATCH /api/settings`.
- Time-zone core (`Africa/Lagos` default), quiet-hours logic, local-day ranges.
- Deterministic natural-language date extraction with an ambiguity allow-list that
  refuses to invent dates.
- Rules-only classifier so the product works with **no** AI provider.
- Retry with bounded exponential backoff and injectable sleep.
- AI + speech-to-text provider interfaces, OpenAI-compatible and Anthropic
  implementations, and factories that return `null` when unconfigured.
- Tests: 118 across configuration, time zones, NLP, classification, retry,
  sessions/logging and HTTP integration.

**Acceptance criteria — verified**

- [x] `npm run db:migrate` creates the database from version-controlled SQL.
- [x] `GET /api/health/live` responds `200` with no credentials.
- [x] `GET /api/health` returns `401` without a session and a full JSON report with one.
- [x] A wrong dashboard password is rejected; a right one sets an HttpOnly cookie.
- [x] A tampered session cookie is rejected.
- [x] Invalid configuration fails fast with an actionable, secret-free message.
- [x] Logs never contain the capture text, transcripts or secrets.
- [x] The process reports `degraded` (not a crash) when the database is unreachable.
- [x] `npm run verify` passes.

**Notable decisions** — recorded in `docs/ARCHITECTURE.md` §Decisions.

---

## Milestone 2 — Capture  ·  Not started

**Goal:** the owner can send a message to Telegram and know it was saved.

**Scope**

- Telegram adapter: `getUpdates` long polling for local development and a
  webhook route with `secret_token` verification for production.
- Owner-only authorization enforced before the update is processed, with a
  neutral refusal for anyone else (no information disclosure).
- Idempotent processing keyed on `(source, externalId)` = `telegram:<chatId>:<messageId>`,
  so Telegram's at-least-once delivery cannot duplicate a capture.
- Raw text preserved verbatim in `Capture.rawText`; a transaction writes the
  capture *and* any derived record, or neither.
- Confirmation reply with the interpreted kind and the extracted date, phrased so
  an incorrect guess is obvious.
- Correction: inline buttons to change the kind, reassign to another type, or
  mark for review.
- `/undo` removes the most recent capture and its derived records, with a
  confirmation step.
- `/help`, `/start`, and a `/settings` summary command.
- Every message path wraps classification in a guard: **a failed AI call stores
  the capture anyway** and replies that it will be classified later.
- Unsupported input (stickers, documents, unsupported media) is acknowledged
  politely and ignored, not silently dropped.
- Voice messages are accepted and stored in Milestone 2 with a clear "not
  transcribed yet" marker; real transcription lands in Milestone 6.

**Acceptance criteria**

- [ ] A text message creates exactly one capture, with the original text intact.
- [ ] Replaying the same Telegram update creates no second capture.
- [ ] A message from a non-owner gets a refusal and writes nothing.
- [ ] With the AI provider unreachable, the capture is still stored.
- [ ] Editing the kind updates the structured record and keeps the original capture.
- [ ] `/undo` removes the capture and its derived records after confirmation.
- [ ] Integration tests cover duplicate updates and unauthorized users.

---

## Milestone 3 — Tasks, library and search  ·  Not started

**Scope**

- Task CRUD with states `PENDING → IN_PROGRESS → COMPLETED|CANCELLED`, a guarded
  transition table, priority, deadline, tags, category and project.
- Ideas, notes and saved references are separate entities and never auto-promote
  into obligations.
- Events carry `startsAt`/`endsAt`.
- Projects group tasks, ideas, notes and events.
- Search across capture text, task titles, note bodies, idea titles and project
  names, with filters for type, status, project, tag, date and priority, plus
  sorting and pagination.
- `/tasks`, `/today`, `/overdue`, `/search`, `/ideas`, `/notes`, `/projects`
  Telegram commands and matching API endpoints.
- Data export (JSON) and restore.

**Acceptance criteria**

- [ ] An idea is distinguishable from a task everywhere, including search.
- [ ] Completing a task records `completedAt` and never happens as a side effect of
      discussing it.
- [ ] Invalid state transitions are rejected with a clear error.
- [ ] Search returns matches from captures *and* structured records, with the
      matched field reported.
- [ ] REST endpoints are covered by integration tests, including pagination.

---

## Milestone 4 — Reminders  ·  Not started

**Scope**

- Persistent scheduler: a database-backed tick loop (no in-memory-only timers),
  with the interval configurable.
- `Reminder` + `ReminderDelivery` rows; each attempt is recorded with its
  outcome; the unique `idempotencyKey` prevents double sends.
- Retries with bounded exponential backoff; permanent failures stop retrying and
  surface in the health report and dashboard.
- Startup recovery: on boot, overdue reminders inside the grace window fire, and
  ones past it are marked `MISSED` instead of arriving late and confusing.
- Snooze (`10m`, `1h`, `tomorrow 9am`), edit and cancel.
- Quiet hours defer (never drop) a notification; the daily cap is enforced.
- Recurring reminders (`DAILY`, `WEEKLY` with weekdays, `MONTHLY`) generate a
  bounded number of occurrences, each with its own delivery record.
- `/reminders`, `/remind`, `/snooze`, `/cancel` commands.
- Timing behaviour verified with an injectable clock.

**Acceptance criteria**

- [ ] A reminder set for +10 minutes is delivered once, and only once.
- [ ] Killing and restarting the process does not lose a pending reminder.
- [ ] A completed or cancelled reminder is never delivered.
- [ ] Delivery failures are recorded with the error and retried with backoff.
- [ ] Quiet hours defer delivery to the end of the window.
- [ ] The daily notification cap is enforced.
- [ ] Tests use a controllable clock; no test sleeps for real time.

---

## Milestone 5 — Dashboard  ·  Not started

**Scope**

- React + TypeScript + Vite, talking only to the authenticated API.
- Views: overview, capture inbox, all tasks, today, upcoming reminders, overdue,
  ideas, notes/references, events, projects, search, settings + export.
- Prominent, keyboard-accessible quick capture.
- Real forms with validation, loading, empty and error states, and confirmation
  feedback. No decorative buttons.
- Mobile-first responsive layout, visible focus rings, correct labels, readable
  contrast.

**Acceptance criteria**

- [ ] Every visible control performs its action against the API (verified by tests).
- [ ] Unauthenticated visitors see only the login screen; the API rejects them anyway.
- [ ] The app is usable at 360px width and by keyboard alone.
- [ ] Empty, loading and error states exist for every list view.

---

## Milestone 6 — Voice and AI  ·  Not started

**Scope**

- Telegram voice messages: download, transcribe via a configured provider, store
  the transcript with provenance (`transcriptSource`, provider, model).
- Raw audio is not retained by default (`STT_RETAIN_AUDIO=false`).
- Structured classification via AI behind the same guarded path as the rules
  classifier, with strict Zod validation of model output.
- Per-capture caching of AI results so a retry does not pay for the same call twice.
- Explicit degraded modes for missing credentials, timeouts, rate limits,
  malformed output, provider outages and unsupported models.

**Acceptance criteria**

- [ ] A voice message is transcribed and classified; the transcript is labelled as
      such and kept separate from inferred dates.
- [ ] With `STT_PROVIDER=none` the message is still saved, clearly marked
      untranscribed, and nothing else breaks.
- [ ] Malformed AI output is rejected and the capture survives with review needed.
- [ ] Tests cover each failure mode with mocked HTTP; no live provider is called.

---

## Milestone 7 — Recall and briefings  ·  Not started

**Scope**

- `ask`/`/ask`: retrieve candidate records from the database first, then answer
  strictly from that evidence, citing record ids.
- Refusal when evidence is insufficient — "I could not find anything about that"
  rather than a fabricated memory.
- Optional daily briefing at a configured local time with configurable sections.
- Suggested priorities drawn only from existing records.

**Acceptance criteria**

- [ ] Every answer is grounded: the evidence list is returned with the answer.
- [ ] A question with no matching records produces an explicit no-evidence answer.
- [ ] The briefing respects quiet hours, the daily cap and the configured sections.
- [ ] Without an AI provider, `/ask` falls back to a deterministic, cited summary.

---

## Milestone 8 — Deployment  ·  Not started

**Scope**

- Documented local and production configuration, including HTTPS and reverse proxy.
- Process supervision with restart-on-failure and health monitoring.
- Backups (`sqlite3 .backup`-style copy plus export), retention, restore drill.
- Verification that the service runs continuously and recovers pending reminders.

**Acceptance criteria**

- [ ] A documented, reproducible deploy on a small always-on host.
- [ ] A restore from backup is performed and verified, not merely described.
- [ ] Pending reminders survive a deliberate restart in production configuration.
- [ ] `docs/OPERATIONS.md` matches what was actually executed.

---

## Engineering backlog

- [ ] SQLite FTS5 virtual table for large-text search once volume justifies it
      (documented in `docs/ARCHITECTURE.md`; not needed yet).
- [ ] Semantic search only if a concrete retrieval need is demonstrated, with a
      documented design and migration path.
- [ ] Multi-user support (schema already keys everything for a single owner; the
      upgrade path is documented).
- [ ] Coverage thresholds enforced in CI.

## Test-data policy

`npm run db:seed` is **development and test only**. It refuses to run when
`NODE_ENV=production`, and it never runs automatically. The owner's real database
is never populated with fabricated history.
