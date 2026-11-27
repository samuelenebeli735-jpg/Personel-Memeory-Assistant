# Recall — Roadmap

Legend: **Done** · **In progress** · **Not started**

Last updated: 2026-11-23 (Round 1 foundation fixes merged as PR #2, merge commit `7d808a2`)

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
offset is in memory; idempotency makes that harmless for captures, but a command can
run twice (see D19 and D58).

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

## Milestone 4 — Reminders  ·  **Done**

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

**Acceptance criteria — verified**

- [x] A reminder set for +10 minutes is delivered once, and only once.
- [x] Killing and restarting the process does not lose a pending reminder.
- [x] A completed or cancelled reminder is never delivered.
- [x] Delivery failures are recorded with the error and retried with backoff.
- [x] Quiet hours defer delivery to the end of the window.
- [x] The daily notification cap is enforced.
- [x] Tests use a controllable clock; no test sleeps for real time.

**Verification:** 361 tests pass across 22 files (`npx vitest run`,
`Test Files 22 passed`, `Tests 361 passed`, ~41s); `npm run typecheck` and
`npm run build` pass. The scheduler was tested against a fake notifier with an
injectable clock; no live Telegram delivery was claimed.

**Known limitation:** a restart re-fetches the last few Telegram updates because
the polling offset is in memory; idempotency makes that harmless for captures, but a
command can run twice (see D19 and D58).

---

## Milestone 5 — Dashboard  ·  **Done**

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

- [x] Every visible control/row performs its action: capture, task, reminder,
      note, idea, event and project rows link to registered detail pages.
- [x] Capture detail renders transcripts with provenance and never shows the
      internal voice placeholder as content.
- [x] Missing and unauthenticated detail requests show a generic state without
      record contents.
- [x] Unauthenticated visitors see only the login screen; the API rejects them anyway.
- [x] The app is usable at 360px width and by keyboard alone.
- [x] Empty, loading and error states exist for every list view.

**Verification:** the shared/server and web builds pass. 17 web tests cover
transcript presentation, detail error states, and every visible record-row link
against the registered route table using React server rendering in Node. 3 server
integration tests cover the detail API returning the requested record, rejecting
anonymous callers, and returning a non-leaking 404. On 2026-10-29 the Playwright
suite drove the real production dashboard bundle in Edge: 17/17 Playwright tests
(16 browser checks plus the login setup project) passed, including login/logout,
every top-level page, capture/task/reminder/library workflows, search, and axe WCAG
2.0/2.1 A/AA checks on seven screens.

**Known gaps:** the Vitest web tests remain component/navigation tests. The
separate `npm run test:e2e` Playwright suite now covers the real browser flows and
axe WCAG 2.0/2.1 A/AA checks locally; see the 2026-10-29 browser result below. The
axe pass now covers both light and dark color schemes, but it remains an automated
audit rather than a manual screen-reader review.

---

## Milestone 6 — Voice and AI  ·  **Done**

**Goal:** the owner can send a voice note and have it understood, while the
product keeps working exactly as before when no AI or speech provider is
configured.

**Delivered**

- **Voice ingestion** (`telegram/handler.ts`): claim → replay check →
  duration/format checks → download → transcribe → store. A replayed update is
  answered from the stored capture without a second download or transcription.
  Concurrent duplicate deliveries of the same message join the first attempt, so
  only one download and one transcription run; the claim is released on success or
  failure. This is adapter/process-local, not a distributed lock.
- **Bounded download**: the Telegram file is fetched only when a transcriber is
  configured, the mime type is supported (`lib/audio.ts`), and the clip is within
  `STT_MAX_AUDIO_SECONDS`. The body is read as a stream: declared oversized
  `Content-Length` is rejected before reading, and the reader cancels as soon as
  `STT_MAX_AUDIO_BYTES` would be exceeded. The cap is never applied only after
  buffering the whole response.
- **Transcript provenance**: the transcript is stored in `Capture.transcript`
  with `transcriptSource = SPEECH_PROVIDER` (never folded into `rawText`); the
  provider and model are recorded in capture metadata. `captureInputSchema`
  rejects a transcript that declares no provenance.
- **Caption + transcript**: `lib/voice.ts` combines the user's caption (first)
  with the transcript, collapsing identical or contained content. Classification
  reads the combined text; the caption is never discarded when transcription fails.
- **Transcript overflow policy**: provider output over 8,000 characters is
  rejected, not silently truncated. The capture is still stored with the caption
  or `VOICE_PLACEHOLDER`; metadata records `status: "transcript-too-long"`, the
  transcript/source stay `null`, and the reply explains the limit. Valid
  transcripts and caption-only messages keep their existing behavior.
- **Reprocess guard**: a voice capture with neither a usable caption nor a
  transcript stays `NEEDS_REVIEW`; reprocessing does not call the rules classifier
  or AI and creates no derived records.
- **Graceful degradation**: disabled STT, timeout, rate limit, empty output,
  unsupported mime, oversize download and provider error each store the capture
  with a `NEEDS_REVIEW` marker and a specific reply. Nothing is invented from the
  placeholder text.
- **Audio retention**: in-memory by default; `STT_RETAIN_AUDIO=false` means no
  audio touches the disk. When explicitly enabled, the file is written directly
  under `STT_AUDIO_DIR` and referenced by `mediaRef`. No temporary audio files are
  created or left behind. Permanent purge unlinks the retained file; undo keeps it
  because undo is a reversible soft delete. Deletion is fenced to a direct child
  of `STT_AUDIO_DIR`; traversal/outside paths are rejected, missing files are a
  no-op, and other filesystem errors roll the purge back.
- **AI classification** already ran behind the guarded path; this milestone adds
  re-validation of provider output against `classifyCaptureSchema` at the service
  boundary, so a broken implementation cannot smuggle a bad shape through.
- **Per-capture cache** (`classificationCache`/`classificationCacheKey`): keyed on
  text + hint + time zone + time defaults + project vocabulary + provider + model
  + exact reference instant. Relative dates resolve against the capture's original
  `capturedAt`, so a same-day or later reprocess cannot move a duration-relative
  deadline. Transient failures and rejected output are never cached; the entry is
  reread and sanitised on reuse.
- **Concurrency guard**: reprocessing the same capture twice in one process is
  refused, so two requests cannot write two sets of derived records.
- **Dashboard transcript presentation**: capture details label provider
  speech-to-text, manual transcripts, captions and untranscribed voice notes
  separately. The stored placeholder is never shown as content, and provider
  metadata, retained-audio paths and cache fields stay out of the public DTO.
- New migration `20261019120000_capture_classification_cache`; new configuration
  `STT_MAX_AUDIO_BYTES` and `STT_AUDIO_DIR`.

**Acceptance criteria — verified**

- [x] A voice message is transcribed and classified; the transcript is labelled as
      such and kept separate from inferred dates.
- [x] Concurrent duplicate deliveries of the same voice message in one process
      share one download, one transcription, one confirmation and one capture;
      a failed attempt releases the claim so a retry can proceed.
- [x] With `STT_PROVIDER=none` the message is still saved, clearly marked
      untranscribed, and nothing else breaks.
- [x] Malformed AI output is rejected and the capture survives with review needed.
- [x] Permanent purge removes retained audio from inside `STT_AUDIO_DIR`; undo
      keeps it by design. Missing files are a no-op and unsafe paths are refused.
- [x] Tests cover the implemented failure modes with mocked HTTP; no live provider
      is called. Gaps are listed under "Known limitations".

**Verification:** 458 server tests pass across 29 files (`npm run verify`,
`Test Files 29 passed`, `Tests 458 passed`, 63.53s), and 28 dashboard tests pass
across 5 files (`npm run test --workspace @recall/web`, 2.60s). The shared/server
and web builds pass. Voice is driven through a fake Bot API and an injected
`Transcriber`; AI through an injected `AiProvider`; the transcriber transport is
exercised with a mocked `fetch`. No live Telegram, AI or speech call was made or
claimed.

**Known limitations (audit 2026-10-20)**

- Voice duplicate coalescing is process-local. Within one adapter, concurrent
  deliveries of the same message share one download and transcription, and the
  claim is released after success or failure. Two server processes do not share the
  claim and can both transcribe; the unique `(source, externalId)` still prevents a
  second capture.
- Undo retains audio until the capture is permanently purged; there is no
  automatic age-based retention policy.
- Cleanup and the database commit are not atomic across filesystems. A commit
  failure after a successful unlink can leave the capture row with its audio file
  missing; the deliberate order avoids the worse state of a purged row with an
  orphaned file.
- If `STT_AUDIO_DIR` changes, existing `mediaRef` paths outside the new directory
  are refused; there is no automatic migration of retained audio.
- Dashboard transcript presentation and navigation are covered by Node-rendered
  component tests and, since 2026-10-29, by the real-browser Playwright suite and
  axe WCAG A/AA checks.
- No live Telegram, AI or STT integration has been exercised; all provider tests
  are mocked or injected.

---

## Milestone 7 — Recall and briefings  ·  **Done**

**Scope**

- `ask`/`/ask`: retrieve candidate records from the database first, then answer
  strictly from that evidence, citing record ids.
- Refusal when evidence is insufficient — "I could not find anything about that"
  rather than a fabricated memory.
- Optional daily briefing at a configured local time with configurable sections.
- Priorities are drawn only from existing records: the briefing orders real
  overdue, due-today, upcoming and later-deadline rows by their own timestamps.
  No model is asked to rank records or invent a priority.

**Delivered**

- `POST /api/ask` and Telegram `/ask` share `ask-service.ts`. Retrieval runs
  before generation; the evidence list is returned with the answer; provider
  citations are checked against that evidence; each statement is checked against
  the cited records, and unsupported statements are removed. A deterministic,
  cited summary is used when AI is absent, disabled, fails, or produces no
  grounded statement.
- **Claim-level grounding.** A valid citation is not treated as proof that every
  sentence of an answer is supported: each statement is split and checked against
  the cited evidence (content words, numbers, prefix matches and negation
  markers). Unsupported statements are dropped; if nothing survives, the answer
  falls back to a deterministic summary of the evidence with `deterministic: true`.
- **Evidence the owner can check.** The evidence excerpt is the record's own text
  (task description, note/idea body, event description, capture transcript,
  project description, reminder body), not the snippet cut around the search
  match, so the answer and the evidence can be verified against each other.
- **Question-shaped retrieval.** Search matches a record only when every query
  word appears in it, so a natural question ("what did I say about tiles") would
  find nothing. The ask service drops the filler words and, if the strict query
  still matches nothing, retries with the individual content words. The strict
  query always wins when it matches.
- `settings.aiEnabled` is the owner's switch: a configured provider is never
  called while AI is disabled.
- The answer prompt treats records and the question as untrusted data, with
  explicit delimiters and an instruction not to follow text inside a record.
- `GET /api/briefing` and `GET`/`PATCH /api/briefing/config` share
  `briefing-service.ts` with scheduled delivery. Briefings use the owner's IANA
  zone, return the configured sections in order (including empty ones), and
  never invent an item.
- **One briefing implementation.** The HTTP route and the scheduled delivery both
  call `generateBriefing`; there is no second copy of the section rules.
- Scheduled delivery runs on the reminder scheduler's single tick — there is no
  second scheduler. It is one occurrence per local date, respects quiet hours and
  the shared daily notification cap, defers rather than drops, skips a stale day,
  retries bounded transient failures, records permanent failures, recovers an
  interrupted send on startup, and uses a unique idempotency key to prevent
  duplicate delivery.
- `briefing_deliveries` stores each attempt, so pending state and duplicate
  prevention survive a restart.
- **Delivery is off by default.** `briefingEnabled` gates *scheduled delivery
  only*: a briefing can always be read on demand, whether or not the daily
  delivery is on.
- New migration `20261022120000_briefing_delivery` (one new table, additive).

**Acceptance criteria — verified**

- [x] Every answer is grounded: the evidence list is returned with the answer.
- [x] A question with no matching records produces an explicit no-evidence answer.
- [x] A statement the evidence does not support is removed, even when the
      citation itself is valid.
- [x] Without an AI provider, `/ask` falls back to a deterministic, cited summary.
- [x] The briefing reports only rows that exist, in the owner's zone, in the
      configured sections and order; an empty configured section is still
      returned.
- [x] The briefing respects quiet hours, the daily cap and the configured sections.
- [x] Scheduled delivery happens once per local day — not twice across ticks,
      not twice across a restart — and a briefing whose day has passed is
      skipped rather than delivered late.
- [x] Disabling the daily delivery stops the scheduled send but not the on-demand
      briefing.
- [x] The normal typecheck, build and server/web test gates pass without stubs or
      skipped modules.

**Verification (2026-10-22)**

- `npm run typecheck --workspace @recall/server` — passes.
- `npm test --workspace @recall/server` — `Test Files 35 passed (35)`,
  `Tests 577 passed (577)`, 101.56s.
- `npm run test --workspace @recall/web` — `Test Files 6 passed (6)`,
  `Tests 39 passed (39)`, 1.32s.
- `npm run build` — passes for `@recall/shared` and `@recall/server`.
- New tests: `tests/unit/ask-service.test.ts` (27),
  `tests/integration/ask-api.test.ts` (18), `tests/unit/briefing-service.test.ts` (18),
  `tests/integration/briefing-api.test.ts` (25),
  `tests/integration/briefing-delivery.test.ts` (20).
- The AI provider, the Telegram bot and the speech-to-text provider are fakes or
  injected doubles in every test. **No live Telegram, AI or STT call was made or
  claimed.**

**Known limitations**

- Retrieval relaxation is lexical: a question whose content words appear in
  different records may return a record that matches only one of them. The
  evidence list always shows what was found, so the owner can judge it.
- The grounding check is lexical, not semantic. A claim that is true but phrased
  with words that do not appear in the evidence is dropped rather than trusted.
- A briefing deferred past midnight (quiet hours or an exhausted daily cap
  crossing into the next day) is skipped, not delivered late: a stale briefing is
  worse than none. The attempt is recorded as `SKIPPED`.
- Scheduled delivery was exercised against a scripted notifier with an
  injectable clock. Live delivery to Telegram remains unverified and needs the
  owner's manual smoke test.

---

## Milestone 8 — Deployment  ·  In progress

**Scope**

- Documented local and production configuration, including HTTPS and reverse proxy.
- Process supervision with restart-on-failure and health monitoring.
- Backups (`sqlite3 .backup`-style copy plus export), retention, restore drill.
- Verification that the service runs continuously and recovers pending reminders.

**Implemented**

- `Dockerfile` builds a production server image and a Caddy image. The server is
  not published to the host; Caddy terminates TLS, serves the dashboard and
  proxies `/api/*`.
- `compose.yaml` runs migrations once before the app, keeps SQLite on a persistent
  volume, uses restart-on-failure and healthchecks, and provides a one-shot
  `backup` profile with host-mounted retention storage.
- `.env.production.example` and `deploy/Caddyfile` document the production
  environment and HTTPS/reverse-proxy configuration.
- `apps/server/src/services/backup-service.ts` creates a consistent
  `VACUUM INTO` snapshot plus the JSON export, verifies integrity, foreign keys,
  migrations and row counts, and prunes only managed timestamped files.
  `npm run recall -- backup` and `verify-backup` expose it locally and in the
  container.
- `apps/server/tests/integration/backup-service.test.ts` covers snapshot
  consistency, JSON export, a standalone restore drill, retention, foreign-key
  verification and missing files.
- `docs/OPERATIONS.md` now contains the first-deploy, upgrade, TLS, backup,
  off-host copy, restore, supervision and health procedures.

**Acceptance criteria**

- [ ] A documented, reproducible deploy on a small always-on host. A disposable
      Docker Compose stack ran locally on 2026-10-26; a remote always-on host has
      not been provisioned.
- [ ] A restore from backup is performed and verified, not merely described. A
      populated local snapshot/restore drill and a restore on the disposable
      deployment volume passed; a restore of the owner's production backup on a
      real host is still pending.
- [ ] Pending reminders survive a deliberate restart in production configuration.
      A pending reminder and its single delivery row survived a local container
      restart without a duplicate; a configured Telegram channel and actual
      exactly-once delivery remain pending.
- [ ] `docs/OPERATIONS.md` matches what was actually executed. The local Docker
      sections are recorded; live host/TLS/Telegram sections remain marked
      pending.

**Verification (2026-10-25, local only)**

- `npm run verify` — shared/server typecheck passed and the full server suite
  passed 36 files, 587/587 tests. The test config caps Vitest at two workers on
  Windows to avoid host-level SQLite contention timeouts.
- `npm run test --workspace @recall/web` — 39/39 tests passed.
- `npm run build:all` — shared, server and production dashboard builds passed.
- `docker compose --env-file .env.production config --quiet` — passed for the
  default services and, with `--profile backup`, the backup service.
- A populated CLI drill against a throwaway migrated database captured a task,
  created a `VACUUM INTO` snapshot and JSON export, copied the snapshot, and
  verified both: integrity `ok`, zero foreign-key violations, four applied
  migrations and one capture/one task in each.
- **Not performed on 2026-10-25:** Docker image build/start or Caddyfile execution
  (Docker daemon unavailable at that time), remote host deployment, public DNS/TLS
  certificate issuance, live Telegram/AI/STT calls, a container restart with
  pending reminders, and a production restore on the owner's host.

**Verification (2026-10-26, disposable local Docker stack)**

- Docker engine client/server `29.7.2`. `recall-migrate:latest` and
  `recall-caddy:latest` built successfully. The app runtime image also built and
  ran after removing the optional `# syntax=docker/dockerfile:1.7` line, which
  caused repeated BuildKit frontend failures on this host; the current Dockerfile
  does not use any newer syntax, so the directive was unnecessary. The validated
  image is retained as `recall-app:validated-20261026` (ID `9d319933fb63`). A fresh
  rebuild from the edited repository Dockerfile had reached its slow `npm prune`
  stage when this record was written.
- `docker compose --env-file .env.production up -d --no-build` created the stack.
  The compose client call timed out after container creation, so the containers
  were started explicitly. `migrate` exited 0 after applying all four migrations
  to a fresh `recall_recall_data` volume; `app` reached Docker health `healthy`;
  Caddy listened on 80/443.
- Caddy returned the dashboard with 200 and `/api/health/live` with 200. Plain
  HTTP redirected with 308 to HTTPS. Caddy logged `certificate obtained
  successfully` for `localhost` with issuer `local`, so `curl -k` was required;
  no publicly trusted certificate was involved. Port 4000 was not published on
  the host (`docker port recall-app-1` was empty). Login and `/api/auth/session`
  returned 200 over HTTPS, capture creation 201, and reminder creation 201.
  Dashboard JS/CSS assets returned 200, the `/reminders` SPA fallback returned the
  dashboard, and an unknown `/api/*` path returned 404 JSON. Both services use
  `restart: unless-stopped`; the app has a Docker healthcheck. A Caddy container
  restart came back with 200 for the dashboard and health endpoint and reused its
  persisted local CA certificate.
- A due reminder was queued as one `PENDING` delivery and deferred with
  `no delivery channel is configured`. A deliberate `docker restart
  recall-app-1` returned health `healthy`; the reminder stayed `SCHEDULED`, the
  same single delivery stayed `PENDING`, and no duplicate row was created.
- The `backup` profile wrote a snapshot and JSON export. The summary reported
  integrity `ok`, zero foreign-key violations, four applied migrations, and rows
  captures 1, tasks 1, notes 0, ideas 0, events 0, projects 0, reminders 1.
  Standalone `verify-backup` reported the same.
- Restore drill: stopped `app`, copied the verified snapshot into the disposable
  deployment volume, removed stale WAL/SHM siblings, restored ownership, and
  restarted. Health, the authenticated session, the capture and the reminder all
  survived with unchanged counts.
- **Not performed on 2026-10-26:** remote always-on host, public DNS and publicly
  trusted TLS, live Telegram/AI/STT calls, real notification delivery (this stack
  had no channel), exactly-once delivery against a reachable channel, and restore
  of the owner's production backup.

**Verification (2026-10-29, local browser acceptance)**

- `npm run test:e2e` — 17/17 Playwright tests passed in 1.6m on Microsoft Edge 156
  headless, against a fresh disposable SQLite database and the production dashboard
  bundle. The suite covers login/logout, bad-password rejection, unauthorised
  redirects, overview, all sidebar destinations, settings, capture, task status,
  reminder snooze, note/idea/event/project detail flows, search, and axe WCAG
  2.0/2.1 A/AA checks on the login screen plus six authenticated pages. No axe
  violations remain in the light color scheme.
- The browser pass found and closed real defects: the missing
  `/api/dashboard/overview` route, bodyless POSTs rejected because they claimed a
  JSON body, task creation sending an empty priority, insufficient badge/status
  contrast, and status selects without accessible names.
- Regression checks after the fixes: `npm run verify` passed (37 server files,
  589/589 tests), `npm run test --workspace @recall/web` passed 39/39, and
  `npm run build:all` passed.
- This was a local production-bundle run, not a run through the Docker/Caddy
  stack. It does not validate public HTTPS, remote supervision or the deployed
  container image.

**Verification (2026-11-01, overnight local acceptance follow-up)**

- `npm run test:e2e` passed **71/71** Playwright tests in Microsoft Edge 156
  headless: 70 browser checks plus the login setup project. Axe WCAG 2.0/2.1 A/AA
  checks passed in both light and dark schemes. The suite also covered keyboard
  navigation, modal focus trapping, responsive desktop/tablet/mobile layouts,
  session expiry, anonymous access, empty/error/missing-record states, console
  errors and failed application requests.
- `npm run verify` passed **37 files / 590 tests**, `npm run test --workspace
  @recall/web` passed **40/40**, and `npm run build:all` passed. Disposable Prisma
  migration status reported the schema up to date.
- Backup hardening now exports JSON from the verified SQLite snapshot. The new
  regression test passes with a write injected after snapshot finalization and
  proves the JSON does not include that later write. Project API pagination now
  honors offsets.
- Docker/Caddy was not rerun because the Docker daemon was unavailable, and no
  production env file was created. M8 remains In progress.

**Known limitations**

- The local compose stack proves the image, Caddy config and volume behavior, not
  a particular remote host, DNS name or publicly trusted certificate. Public DNS/TLS
  issuance and remote supervision remain unvalidated.
- The app image build required removing the unused BuildKit syntax directive on
  this host. The edited repository Dockerfile had not finished a fresh rebuild
  when this record was written; the image used in the stack came from the same
  instructions with only that directive omitted.
- The backup command copies the database and text export. Retained voice audio
  (`STT_RETAIN_AUDIO=true`) is a separate directory and must be backed up
  independently.
- The restart drill used the `none` notifier. It proves persistence and the absence
  of a duplicate delivery row, but not actual Telegram send or end-to-end
  exactly-once delivery. Live Telegram delivery remains an owner smoke test.

---

## Round 1 — Foundation fixes  ·  **Done**

Source: the 2026-11-17 completion audit (findings N1–N17). Merged into `main` on
2026-11-23 as PR #2 (merge commit `7d808a2`; reviewed head `54f3157`).

| ID | Task | Commit | Audit finding | Decision |
| --- | --- | --- | --- | --- |
| R1-00 | Preserve M6–M8 work on `feat/m6-m8` | `aa59749` | — | — |
| R1-01 | Settings saves; AI toggle; section checkboxes; IANA zones | `c408642` | N1 | — |
| R1-02 | One owner time zone (dashboard + server); capture ack zone | `183a510` | N2, N10 | D54 |
| R1-02b | Natural-language dates in the Settings zone | `2d9b6ac` | (found during R1-02) | D55 |
| R1-03 | Ask answers date and time questions | `1c4631f` | N3 | D56 |
| R1-04 | AI providers: SDK, explicit model, privacy by default | `e589c44` | N4, N6 | D57 |
| R1-05 | Telegram polling recovery; audible reminders | `dc83591`, `3abc799`, `bea4359` | N5 | D58 |
| R1-06 | Briefing sent within 2 hours or skipped | `75ccb0e`, `3abc799` | N12 | D59 |
| — | `/settings` AI line; test totals; replay-claim docs | `babe8a1`, `54f3157` | — | — |

**Verification evidence:** At `bea4359`, server tests passed 758/758 under UTC+14
and UTC, web tests passed 67/67, and Playwright passed 80/80 with axe. The
subsequent documentation-only commit `54f3157` passed typecheck and 24/24 polling
tests. No live Telegram, AI or speech-to-text call was made. The repository has no
CI workflow.

**Accepted limitations** (owner decision, 2026-11-23; see D58 and OPERATIONS):
retry and dead-letter state are in process memory and reset on restart, with no
durable dead-letter record; a command can run twice in a narrow restart window; a
voice note can be transcribed again; an acknowledged dead letter is not recovered
automatically; the answer on a dead-lettered button press is best effort.

## Round 2 — Dashboard  ·  **Done**

Source: the approved Round 2 design (v2, decisions D1–D8, refinements 1–7) and the
clickable prototype, verified in a real browser on 2026-11-23 (179/179 checks after
fixing seven prototype-only issues). Delivered as one branch, `feat/round2-dashboard`,
and one pull request: merged into `main` on 2026-11-26 as PR #7 (merge commit
`5c8f9a4`; reviewed head `900af51`). The feature branch is kept.

**Verification evidence:** CI on the merge commit (run `45828544855`, push to
`main`) passed all four jobs: typechecks, Prisma validation and drift check, web
tests and production builds; the server suite with the test host at UTC and at
UTC+14; and the browser suite in Edge with axe, 117/117 with zero retries. Locally at
`900af51`: server 785/785 in both zones and web 125/125. The manual NVDA + Edge pass
has been completed by the owner (NVDA on Windows 10 with Microsoft Edge; see TESTING).

| ID | Task | Commit(s) | Audit finding |
| --- | --- | --- | --- |
| — | Almanac tokens and base styles (D1, D2, D7) | `6fb5df9` | — |
| — | Shared dialog, pagination, state and toast patterns | `1dd812f` | — |
| R2-07 | API client and session: timeouts, bounded read retries, no write retries, 401-only sign-out, start-up retries (D6) | `0321941` | N9 |
| R2-03, R2-05, R2-06 | Server: S1 inbox total, S2 paginated projects, S3 25 MB restore route, S4 id tie-breakers, restore by file bytes with a check token | `7b1568e` | — |
| R2-07 | One form and error pattern for every create form | `cec74c4` | N8 |
| R2-05 | Pagination on every list and search, in the URL | `0f93ac5` | N7 |
| R2-04 | Edit and delete every record type; idea to task | `a90dcdf` | N7 |
| R2-03 | Inbox review (keep, reprocess, Undo, purge, J/K, badge) | `dac919a` | N7 |
| R2-01, R2-02 | Ask and Today; "Now" navigation | `c5328fa` | N7 |
| R2-06 | Settings → Your data: export and the restore wizard | `dd604f6` | N7 |
| — | Error, accessibility and reflow tests; docs | `3e018bf` | — |
| — | Final review: error log without query strings; accessibility fixes | `900af51` | — |

**Contracts confirmed in code and tests:**

- **Restore identity:** the server applies only the exact bytes it checked. It
  hashes what it receives and requires the dry run's `checkToken` (an HMAC of
  that hash), so a client-side hash alone is never trusted.
- **Repeated restores:** a restore repeated against the real server adds
  nothing.
- **Start-up session check:** 1 initial attempt plus up to 3 retries
  (1 s, 2 s, 4 s).
- **Retries:** writes are never retried automatically.
- **Pagination order:** every paginated list ends with an id tie-breaker.
- **Sign-out:** only a 401 signs the dashboard out.
- **Limits:** the global 2 MB body limit and the login rate limit are unchanged.
- **Undo and purge:** capture Undo (soft, not reversible from the dashboard) and
  permanent purge keep their distinct semantics.

**Changes beyond the dashboard:**

- The rules classifier now lets the owner's explicit kind override its "a question
  is never a task" heuristic. Before this, "Keep as task" on a question created
  nothing.
- No migration and no new dependency.

**Final review fixes (2026-11-26):**

- The API error log records the path only. It used to include query strings,
  which hold search words and, for restore, the file hash and check token.
- Relative times read "just now" instead of "in 0 min".
- Today's date field has one accessible name.
- Ask says when a period simply has no records.

**Screen-reader pass (refinement 6): completed.** The owner performed the manual
NVDA + Microsoft Edge verification on Windows 10 using the TESTING checklist and was
satisfied with the results (recorded 2026-11-27). It had been blocked in the
automated review because NVDA was not installed there.

**Still open:**

- Production access logs: **resolved in Round 3** (step 9, `f81caa4`). Caddy's
  access log now drops the query string from the request URI and the `Referer`
  header, so search text and the restore hash and token are no longer logged.

### Product boundary: ALIVE and Recall

- **ALIVE** is the primary conversational intelligence, planning and
  orchestration layer.
- **Recall** provides structured memory, retrieval, tasks, reminders, events and
  the supporting execution APIs.
- **Recall Ask** is a lightweight, single-question information-retrieval feature.
  It answers from stored records with sources. It is **not** ALIVE's
  conversational interface:
  - it keeps no conversation state;
  - it does not plan;
  - it does not create or change records.

Round 2 adds no multi-turn conversation, no intent-planning engine and no
conversational task creation to Recall, and none of these is claimed to exist.

**Deferred ALIVE requirements** (not part of Recall Round 2, not implemented):

- multi-turn conversation with context carried across turns;
- intent recognition and planning across tools;
- creating or changing tasks, reminders and events through conversation;
- the native Windows and Android clients, with native notifications replacing the
  temporary Telegram bridge (see the ALIVE architecture decision).

## Round 3 — Testing and hardening  ·  **Done** (merged as PR #10, `6ae758c`)

Scope approved by the owner on 2026-11-27. Delivered as one branch,
`feat/round3-hardening`, and one pull request. Design reviewed against `main` at
`7fd78ce` before any implementation.

**Deferred (not in Round 3):**

- Telegram `/briefing` (N16): Telegram is a temporary bridge and is not extended.
- The durable Telegram dead-letter table.
- CI coverage thresholds.
- External uptime monitoring and alerting: Round 4.

| Step | Task | What changes | Files | Migration |
| --- | --- | --- | --- | --- |
| 1 | R3-04 `db:seed` (N11) | `prisma/seed.ts` never existed. Replace it with a seed that only creates a **new** disposable database. It refuses to run with `NODE_ENV=production`, refuses an existing or non-empty file, and refuses the configured `DATABASE_URL` and any `dev.db`, so it can never touch the owner's data. | `apps/server/prisma/seed.ts` (new), `apps/server/package.json` script, tests | No |
| 2 | R3-04 Transactional snooze and cancel | Cancel (including a series) and snooze become one transaction each, so a failure can't leave a cancelled reminder with live deliveries. | `services/reminder-service.ts`, tests | No |
| 3 | R3-02 Starvation (N13) | Due reminders that already have a `PENDING` or `SENDING` delivery are excluded from the queueing query, so 50+ deferred reminders can't hide newer due ones. The unique occurrence and idempotency keys still prevent duplicates. | `services/reminder-scheduler.ts`, tests | No |
| 4 | R3-02 Periodic MISSED sweep (N13) | The grace-window sweep also runs while the app is running (for example after the PC wakes from sleep). It marks a reminder MISSED only if it is past grace **and** has no delivery deliberately deferred into the future by quiet hours or the daily cap. That keeps the "a deferred reminder is never lost" rule. Start-up recovery is unchanged. | `services/reminder-scheduler.ts`, tests | No |
| 5 | N14 Scheduler liveness | A scheduler that is running but hasn't completed a tick within the stale limit is reported as stalled. A public, data-free `/api/health/scheduler` returns 503 when stalled, and the compose health check uses it. | `services/reminder-scheduler.ts`, `http/routes/*health*`, `compose.yaml`, shared types, tests | No |
| 6 | R3-03 Session revocation (N15) | Signing out records the token's `nonce` in a new `RevokedSession` table; the session guard refuses a revoked token, even a copied one. Expired rows are pruned. Existing tokens keep working. | `prisma/schema.prisma`, a new additive migration, `http/auth.ts`, `http/session-guard.ts`, `routes/public-routes.ts`, tests | **Yes, additive:** one new table, no existing table changed |
| 7 | R3-03 CSP and headers | A restrictive CSP in Caddy. `script-src 'self'` with no exceptions. The one documented exception is `style-src-attr 'unsafe-inline'`, for React inline `style` attributes only; `<style>` elements stay `'self'`. The same CSP is served by `vite preview`, so the browser suite runs under it, and a test keeps the two identical. The API sends its own restrictive CSP. | `deploy/Caddyfile`, `apps/web/vite.config.ts`, `http/server.ts`, tests | No |
| 8 | R3-03 Trusted proxy | The compose network gets a fixed subnet, and `TRUST_PROXY` names it, so the app trusts only Caddy for client addresses. | `compose.yaml`, `.env.production.example`, `docs/OPERATIONS.md` | No |
| 9 | R3-03 Access-log redaction | Caddy's access log drops query strings from the request URI and the `Referer` header (search words, restore hash and token). | `deploy/Caddyfile` | No |
| 10 | R3-04 Image digests | Pin `node:24-bookworm-slim` and `caddy:2-alpine` to their multi-architecture index digests. | `Dockerfile` | No |
| 11 | R3-04 N17 | Run the web suite 20 times under load. Fix any flaky test found, or record "not reproduced". | Web tests as needed | No |
| 12 | R3-05 Docker drill | Rebuild and start in a **separate compose project with disposable volumes**. Check health, restart with a pending reminder, backup, restore into a fresh volume, the CSP and log redaction. Needs Docker Desktop running and about 250–300 MB of downloads for the first build. | `docs/OPERATIONS.md` (recorded drill) | No |
| 13 | R3-01 and docs | Record the Round 2 browser, axe and owner NVDA evidence, the Round 3 results, and TESTING and OPERATIONS updates. | `docs/*` | No |

**Data and delivery risks, and how they are contained:**

- **The migration** is additive (a new table only). It is never run against
  `dev.db` by tests. The owner applies it with the normal migrate command, and
  should take a backup first.
- **Periodic MISSED sweep:** a reminder more than 12 hours past due (the default
  grace) while the app was suspended becomes MISSED instead of arriving late. Quiet
  hours and the daily cap keep their deferral.
- **The starvation change** alters which reminders are queued, not how they are
  delivered. The occurrence and idempotency keys still make duplicates impossible.
  Tests cover 60+ deferred reminders, restarts and duplicates.
- **CSP:** a too-strict policy could break the dashboard (for example the export
  download). The browser suite runs under the CSP to catch that.
- **Trusted proxy:** a wrong value makes everyone share one rate-limit bucket, or
  lets clients spoof addresses. The drill checks the login limit with spoofed
  `X-Forwarded-For`.
- **Tests and seeds** use temporary databases only. The Docker drill uses its own
  compose project and volumes and never touches existing volumes.

### Round 3 results (2026-11-27)

All 13 steps are implemented and verified on `feat/round3-hardening` (PR #10),
merged into `main` on 2026-11-27 as `6ae758c`. The owner's development database
was backed up, then migrated to `20261127120000_revoked_sessions` and verified the
same day.
The Docker drill (step 12) ran on 2026-11-27 against the real Caddy and app
containers; its commands and results are recorded in OPERATIONS ("Round 3 Docker
drill"). Test figures are in TESTING.

| Step | Commit | Result |
| --- | --- | --- |
| 1 `db:seed` (N11) | `cd0f015` | Creates only a new file. Refusals tested: production, no target, the configured `DATABASE_URL` (absolute, relative, not yet existing), any `dev.db` in any case, an existing empty or non-empty file or folder, a missing folder, a symlink (Linux CI; Windows lacks the privilege), and a file created between the checks and the write. The real `npm run db:seed` refused `dev.db` with its hash unchanged. |
| 2 Transactional snooze and cancel | `6cb54af`, `6d629eb` | Cancel (with its series), snooze and a schedule edit are each one transaction. Injected failures roll back fully; the rollback tests fail on the old code. |
| 3 Starvation (N13) | `d039a27` | Reminders with an outstanding attempt are left out of the queueing batch. Before relying on that, stuck states were closed: stale `SENDING` attempts are re-queued on every tick (not only at startup), a `PENDING` row without a time is processed, and recording an outcome is one transaction. Six of the new tests fail on the old code. |
| 4 Periodic MISSED sweep (N13) | `1df113e` | The grace window applies at startup and on every tick; quiet-hours and daily-cap deferrals are kept until released. Seven of the new tests fail on the old code. |
| 5 Scheduler liveness (N14) | `de316dd` | `/api/health/scheduler` (public, one word) returns 503 when stopped or stalled; `/api/health` is degraded; the compose and Dockerfile health checks use it. Autoheal and alerting stay in Round 4. |
| 6 Session revocation (N15) | `d86b40e` | Additive migration `20261127120000_revoked_sessions` (one table, one index). Sign-out revokes that session; a copy is refused; the guard fails closed. **Not applied to `dev.db`**; see OPERATIONS §4. |
| 7 CSP | `fbaed39` | One policy in `apps/web/src/csp.ts`, served by Caddy and `vite preview`; the API sends its own. A browser spec checks every page for violations. |
| 8 Trusted proxy | `1239d48` | Caddy has a fixed address on a fixed subnet and is the only proxy the app trusts. A spoofed `X-Forwarded-For` cannot dodge the login limit. |
| 9 Access-log redaction | `f81caa4` | Query strings are stripped from the URI and `Referer` in Caddy's log (configuration-tested; the real Caddy check is part of the drill). |
| 10 Image digests | `23e0f17` | Both base images pinned to multi-architecture index digests; a test refuses an unpinned `FROM`. |
| 11 N17 | — | **Not reproduced:** the web suite passed 20 out of 20 runs (131/131 each) while the full server suite ran alongside as load. No test changed. |
| 12 Docker drill | — | **Done** on real containers in isolated projects: real CSP and API headers; no query strings or `Referer` query data in the Caddy or app logs; spoofed `X-Forwarded-For` limited from the host and from a neighbouring container; one pending attempt kept, not duplicated, across a restart; backup and `verify-backup`; restore into a fresh volume with identical data. No defect found. |
| 13 R3-01 and docs | `2091e6c` and this commit | The owner's NVDA record (same wording as PR #9, cherry-picked so the two merge in either order), the Round 3 results, and TESTING, OPERATIONS and SECURITY updates. |

**Deviations from the design:**

- **Start-up recovery changed slightly** (step 4). The design said it stays
  unchanged. It now uses the same rule as the periodic sweep, so a restart no
  longer marks a reminder MISSED while quiet hours or the daily cap still hold it
  back (before, a reminder held to the next day by the cap was lost on a restart).
  It also finishes more than one batch of 50 over the following ticks instead of
  sending the rest late. Reverting to the old start-up behaviour is a small change
  if preferred.
- **Schedule edits** became transactional too (step 2): they had the same flaw as
  snooze and would otherwise have interfered with step 3.
- **Outcome records** became transactional (step 3), so that no stuck state can
  hold a reminder back once outstanding attempts are excluded.
- **Proxy trust** names Caddy's fixed address rather than the whole subnet (step 8).
  It is stricter, and the subnet is still fixed.
- **Fail-closed session guard** (step 6): if the sign-out list cannot be read,
  requests are refused with 503, except the data-free health report and session
  probe.

**Corrections from the final audit:**

- Sign-out reported `revoked: false` if pruning old rows failed after the
  session had been revoked; pruning is now separate housekeeping, and the
  response is accurate (tested).
- A schedule edit cancelled the series' generated occurrences but left their
  armed attempts `PENDING` (the scheduler would have skipped them when reached);
  it now skips them in the same transaction, as cancel does (tested).

**Remaining risks:**

- The browser suite under the CSP has not run locally (ports 4000 and 5173 were
  held by the owner's running development servers, which were not stopped). It
  passed in CI: run `45932147328`, 119/119 with zero retries. Its first CI run
  showed that sign-out tests must use their own session now that sign-out revokes
  on the server (fixed in `1101735`).
- Delivery through a real channel was not exercised: Telegram was off in the drill
  (no live calls in Round 3), so the pending attempt was deferred, not sent.
- Delivery stays at-least-once. If recording a successful send fails, that one
  message can be sent again once the attempt is stale (5 minutes).
- The new code must not start before the migration is applied, or every signed-in
  request gets a 503.

## Master completion checklist

Moved here from §19 of the 2026-11-17 audit; this file is now the source of truth.

- [x] Backend capture, classification, library, search, reminders and briefings implemented and tested
- [x] Migrations consistent with the schema; dev.db integrity ok
- [x] Typecheck and production build pass
- [x] Uncommitted work preserved on a branch (`feat/m6-m8` @ `aa59749`)
- [x] Settings page saves correctly (N1) — R1-01
- [x] Dashboard time zone follows settings (N2) — R1-02
- [x] Ask answers date and time questions (N3) — R1-03
- [x] AI provider transports correct and tested against mocks (N4, N6) — R1-04; live calls not yet made
- [x] Telegram mode switch self-heals (N5) — R1-05
- [x] Playwright suite green after Round 1 (80/80), extended for Round 2 on `feat/round2-dashboard`
- [x] Dashboard: Ask, Briefing, inbox review, edit/delete, pagination, export (N7) — Round 2, merged as PR #7 (`5c8f9a4`)
- [x] CI workflow reproducing the checks on pull requests — `.github/workflows/ci.yml` (PR #4, with the test-only rate-limit fix in PR #5)
  - Verified 2026-11-23 by the first run on `main` (run `45137724098`, commit `08454cb`):
    server 766/766 with the test host at UTC+14 and at UTC, web 67/67, browser
    80/80 with axe and zero retries, typechecks and production builds pass, Prisma
    schema valid with no migration drift.
- [x] Round 3 hardening (R3-02 to R3-04, N14) — merged as PR #10 (`6ae758c`)
- [x] Local Docker drill re-run on the current code (R3-05) — 2026-11-27, isolated projects, recorded in OPERATIONS
- [ ] Host deployed with trusted TLS (R4-01)
- [ ] Live Telegram capture and delivery verified (R4-02)
- [ ] Live AI and speech-to-text smoke tests (R4-03)
- [ ] Backup cron, off-host copy and a restore performed on the host (R4-04)
- [ ] Monitoring and alerting in place (N14, R4-04)
- [ ] Docs reconciled and release tagged (R4-05)

**Resolved by Round 2 (merged, PR #7):** N7 dashboard gaps, N8 silent create-modal
failures, N9 `capturesApi` contract drift.

**Resolved by Round 3 (merged, PR #10):** N11 safe
`db:seed`; N13 periodic MISSED sweep and no queue starvation; N14 stalled-scheduler
detection and health check; N15 session revocation and CSP; N17 not reproduced in
20 runs under load.

**Still open from the audit:** N14 autoheal and alerting (Round 4); N16 Telegram
`/briefing` (deferred: Telegram is a temporary bridge).

**Later rounds:** Round 2 (R2-01 to R2-07) is done and merged (PR #7, `5c8f9a4`),
including the owner's manual NVDA + Edge pass. Round 3 is done and merged (PR #10,
`6ae758c`), including its Docker drill; R3-02's
briefing window had already been delivered as R1-06.
In Round 4, R4-01 to R4-04 are blocked on a host, a domain and credentials, and
R4-05 (docs reconciled, release tagged) is not started.

---

## Engineering backlog

- [ ] SQLite FTS5 virtual table for large-text search once volume justifies it
      (documented in `docs/ARCHITECTURE.md`; not needed yet).
- [ ] Semantic search only if a concrete retrieval need is demonstrated, with a
      documented design and migration path.
- [ ] Multi-user support (schema already keys everything for a single owner; the
      upgrade path is documented).
- [ ] Coverage thresholds enforced in CI.
- [ ] Durable Telegram dead-letter record (needs a migration; see D58).
- [x] CI workflow running typecheck and the server and web tests on pull requests (done 2026-11-23; see the master checklist).

## Test-data policy

`npm run db:seed -- <new file>` is **development and test only**, and it never
runs automatically. It only creates a **new** disposable database with clearly
fictional "Sample:" records. The owner's real database is never populated with
fabricated history.

*Correction (Round 3, 2026-11-27):* this section previously described a production
refusal, but the script it named (`prisma/seed.ts`) never existed, so
`npm run db:seed` simply failed (N11). The seed now exists (R3-04), and before
writing anything it refuses:

- `NODE_ENV=production`;
- a missing target (there is no default);
- any file named `dev.db`;
- the configured `DATABASE_URL`, compared by real path, with symlinked and
  junctioned folders resolved;
- any target that already exists: a file, an empty file, a folder or a symlink.

It creates the file with an exclusive "create new" open, so a file that appears
in the meantime is never overwritten. Every refusal is covered by
`tests/integration/seed.test.ts`.
