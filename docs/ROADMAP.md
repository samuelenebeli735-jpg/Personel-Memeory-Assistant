# Recall — Roadmap

Legend: **Done** · **In progress** · **Not started**

Last updated: 2026-10-17 (session 1, Milestone 2 complete)

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

## Milestone 2 — Capture  ·  **Done**

**Goal:** the owner can send a message to Telegram and know it was saved.

**Delivered**

- Hand-written Bot API client on `fetch` (`telegram/client.ts`) with an injected
  transport for tests, timeouts, typed errors and `retry_after` handling.
- **Polling** mode with offset tracking and bounded exponential backoff
  (`telegram/polling.ts`); **webhook** mode with `secret_token` verification
  compared in constant time (`telegram/handler.ts`, `POST /api/telegram/webhook`).
- Owner-only authorization checked before anything is written, for both messages
  and callback queries; one neutral refusal that discloses nothing.
- Idempotency on `(source, externalId)` = `telegram:<chatId>:<messageId>`. A replay
  returns the existing capture and says "Already saved"; no second row is created.
- Verbatim `rawText`, classified after the capture is committed, with derived
  records written alongside it. `edited_message` updates are ignored so stored text
  is immutable.
- Confirmation reply stating the kind, the local time, tags, priority, any reminder,
  any assumed default time, and any AI/processing degradation.
- Inline correction buttons (`k:`), undo prompt (`u:`), confirmed undo (`U:`) and
  "keep it" (`K:`). Conversion keeps the original capture; undo is soft and removes
  derived records.
- `/start`, `/help`, `/inbox`, `/settings`, `/undo`. Commands from later milestones
  answer honestly with the milestone that will bring them.
- Voice messages are stored with an explicit `[voice message — not transcribed yet]`
  marker, `UNKNOWN`/`NEEDS_REVIEW`, provenance metadata, and never classified into a
  fabricated task. Real transcription is Milestone 6.
- Unsupported media (stickers, documents, photos, audio, video) is acknowledged and
  ignored, never silently dropped.
- Capture HTTP API: ingest (idempotent, `captureOnly`), list with pagination and
  filters, inbox, get, convert, reprocess, undo, and a guard on permanent delete.
- `npm run recall -- doctor|capture|inbox|serve` for local use without Telegram.

**Acceptance criteria — verified**

- [x] A text message creates exactly one capture, with the original text intact.
- [x] Replaying the same Telegram update creates no second capture.
- [x] A message from a non-owner gets a refusal and writes nothing.
- [x] With the AI provider unreachable, the capture is still stored.
- [x] Editing the kind updates the structured record and keeps the original capture.
- [x] `/undo` removes the capture and its derived records after confirmation.
- [x] Integration tests cover duplicate updates and unauthorized users.

**Verification:** 196 tests pass across 13 files (`npx vitest run`,
`Test Files 13 passed`, `Tests 196 passed`, 14.14s); `npm run typecheck` and
`npm run build` pass. The derivation transaction is proven by an injected
database-level write failure (`tests/integration/capture-atomicity.test.ts`).
Telegram was tested against a fake Bot API only — no live bot token exists in this
environment, so no live Telegram call is claimed.

**Known limitation:** a restart re-fetches the last few updates because the polling
offset is in memory; idempotency makes that harmless.

---

## Milestone 3 — Tasks, library and search  ·  **Done**

**Goal:** the owner can work with what was captured — find it, change it, and get
it back out — without a dashboard and without a cloud account.

**Delivered**

- Task management with the guarded transition table
  (`PENDING → IN_PROGRESS → COMPLETED|CANCELLED`, plus an explicit *reopen* back to
  `PENDING`). Completing records `completedAt`; reopening clears it; an invalid
  transition is rejected with the two states named. Nothing completes a task as a
  side effect of editing it.
- Notes, ideas, events and projects as separate entities with their own fields.
  An idea becomes a task only through an explicit `POST /ideas/:id/promote`, and
  the idea is kept.
- Projects group members, expose per-kind counts, and detach (never delete) their
  members on delete.
- **Cross-entity search** (`services/search-service.ts`): one query over captures,
  tasks, notes, ideas, events, projects and reminders, with filters for type,
  status, capture kind, project, tag, priority, date range and deleted rows, plus
  sorting (relevance, dates, title) and merged pagination with an accurate total.
  Every result reports the fields that matched (`matchedOn`) and a snippet centred
  on the match.
- Library HTTP API for every entity, with pagination and filters, plus
  `/tasks/today`, `/tasks/overdue`, `/tasks/counts`, `/tags` and `/tags/prune`.
- **Export and restore**: `GET /api/export` returns a versioned, lossless JSON
  bundle of every table; `POST /api/restore` is additive, dry-run by default,
  identity-aware (a tag that already exists by name or a capture that already
  exists by `(source, externalId)` is reused rather than duplicated) and reports
  any row it could not write instead of dropping it silently.
- Telegram commands `/tasks` (`all` for finished), `/today`, `/overdue`,
  `/search` (also `/find`), `/ideas`, `/notes`, `/projects`, all reading the owner's
  configured time zone.

**Acceptance criteria — verified**

- [x] An idea is distinguishable from a task everywhere, including search: they
      are separate rows, separate types in results, and promotion is explicit.
- [x] Completing a task records `completedAt` and never happens as a side effect of
      discussing it (asserted: editing the title leaves the task `PENDING`).
- [x] Invalid state transitions are rejected with a clear error naming both states.
- [x] Search returns matches from captures *and* structured records, with the
      matched field reported and the snippet centred on the match.
- [x] REST endpoints are covered by integration tests, including pagination and
      export/restore round-trip.

**Verification:** 292 tests pass across 18 files (`npx vitest run`,
`Test Files 18 passed`, `Tests 292 passed`, 37.81s); `npm run typecheck` and
`npm run build` pass. Search is exercised over seeded rows of every type, and
restore is checked by exporting a populated database, wiping it, restoring, and
exporting again to compare bundle-for-bundle.

**Known limitation:** search uses `LIKE` over a bounded per-type window
(`SEARCH_WINDOW_CAP = 200` rows per type per query) rather than full-text search;
correct for personal-scale data, and recorded in `docs/ARCHITECTURE.md` (D28) as a
backlog item.

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
