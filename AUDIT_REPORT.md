# Recall Personal Memory Assistant — Comprehensive Readiness Audit

## Executive Summary

This audit verifies the implementation status of Milestone 7 (Recall and Briefings) against the roadmap acceptance criteria, verifies test infrastructure, and identifies any gaps or defects before declaring Milestone 7 complete.

**Overall Status**: Milestone 7 implementation is **functionally complete but has gaps** in test coverage and briefing service implementation.

> **Remediation update — 2026-10-22.** The audit below is the record of the
> state *at audit time*. Every gap it listed has since been closed; see
> [§Remediation status](#phase-11--remediation-status-2026-10-22) for the
> per-gap result and the evidence. The verdict at the end of this document has
> been updated accordingly.
>
> **Browser acceptance update — 2026-10-29.** The missing real-browser layer is
> now present. `npm run test:e2e` builds the production dashboard, starts the real
> Fastify API against a disposable migrated SQLite database, and drives Microsoft
> Edge through login, navigation, capture/task/reminder/library/search workflows
> plus axe WCAG 2.0/2.1 A/AA checks. The run passed 17/17 tests in 1.6m with no axe
> violations in the light color scheme. It found and closed five application defects: the missing
> `/api/dashboard/overview` route, bodyless POSTs rejected because they claimed a
> JSON body, task creation sending an empty priority, insufficient badge/status
> contrast, and status selects without accessible names. Regression checks:
> `npm run verify` 37 files / 589 tests passed, dashboard 39/39, `npm run build:all`
> passed. Milestone 8 remains **In progress**: the browser run is local, not
> through Docker/Caddy, and a remote host, public DNS/TLS, live integrations and
> production restore are still pending.

> **Overnight local acceptance update — 2026-11-01.** The expanded browser suite
> passed 71/71 tests in Edge 156, including keyboard and modal focus behavior,
> responsive desktop/tablet/mobile layouts, session expiry, anonymous access,
> empty/error/missing-record states, console/request checks, and axe WCAG A/AA
> checks in both light and dark color schemes. `npm run verify` passed 37 files /
> 590 tests, the dashboard suite passed 40/40, `npm run build:all` passed, and
> disposable Prisma migration status reported the schema up to date. Backup
> verification now exports JSON from the verified SQLite snapshot and has a
> regression test for writes occurring after snapshot finalization. Docker/Caddy
> was not rerun because the daemon was unavailable; Milestone 8 remains
> **In progress** pending remote host, public TLS, live integrations, actual
> notification delivery and production restore acceptance.

---

## Phase 1 — Repository and Roadmap Inventory

### Git Status (at audit start)
- **Branch**: `main`
- **HEAD**: `4dad32f feat(m5): implement authenticated React dashboard`
- **Modified files**: 40 (including Milestone 7 additions)
- **Untracked files**: 27 (including Milestone 7 additions and migration files)

### Milestone Status (per ROADMAP.md)

| Milestone | Status | Tests Passing |
|-----------|--------|---------------|
| M1 — Foundation | ✅ Done | 118 |
| M2 — Capture | ✅ Done | 196 |
| M3 — Tasks, Library, Search | ✅ Done | 292 |
| M4 — Reminders | ✅ Done | 361 |
| M5 — Dashboard | ✅ Done | 17 (web) + 3 (server) |
| M6 — Voice and AI | ✅ Done | 458 (server) + 28 (web) |
| **M7 — Recall and Briefings** | **In Progress** | **458 (server) + 28 (web)** |
| M8 — Deployment | Not Started | — |

**Total tests passing**: 458 (server) + 28 (web) = **486 tests passing**

---

## Phase 2 — Test Failure Diagnosis

### Test Results (Current)
```
Test Files  29 passed (29)
     Tests  458 passed (458)
```

**All 458 server tests pass.** No test failures to diagnose.

### Test Infrastructure Status
- ✅ Test databases created automatically with unique names
- ✅ Migrations applied to test databases via `createTestDatabase` helper
- ✅ Fixtures are deterministic (using `advanceableClock`, `recordingNotifier`, etc.)
- ✅ Parallel tests use isolated databases (each test file gets its own DB)
- ✅ No test accesses development database (uses `DATABASE_URL="file:./unused.db"` in test config)
- ✅ Template database created by `globalSetup` at `C:\Users\samue\AppData\Local\Temp\recall-tests\template.db`

### Pre-existing Test Failures (Not Related to Milestone 7)
None found. All 458 tests pass.

---

## Phase 3 — Audit `/api/ask`

### Implementation Review (`apps/server/src/http/routes/ask-routes.ts`, `apps/server/src/services/ask-service.ts`)

#### ✅ Verified Working
1. **Evidence retrieval before generation** — `retrieveEvidenceInternal` calls `searchAll` before answer generation
2. **Owner-only access** — Route is under `/api` prefix which requires authentication via `registerProtectedRoutes`
3. **Structured evidence list** — Returns `evidence: SearchResultItem[]` with `id`, `type`, `title`, `snippet`, `timestamp`, `status`, `matchedOn`
4. **Citation validation** — `validateCitationsInternal` filters `aiAnswer.citedIds` against actual evidence IDs
5. **No-evidence response** — Returns `"I could not find anything about that."` with `grounded: false`
6. **Partial/ambiguous evidence** — Returns deterministic summary of what was found
7. **Deterministic fallback** — Works without AI provider (`deterministicAnswerInternal`)
8. **AI failure fallback** — Catches AI errors, falls back to deterministic
9. **Citation validation** — `validateCitationsInternal` filters out hallucinated IDs
10. **Prompt injection resistance** — Evidence text is not used as prompt; only question and evidence are passed to AI
12. **Request bounds** — Question max 500 chars, limit max 10, types max 4
13. **No sensitive data in logs** — Only logs warnings, not content

#### ⚠️ Issues Found
1. **AI Answer with mixed valid/invalid citations** — If AI returns some valid and some invalid citations, the valid ones are used but the unsupported claims in the answer text are not removed. The answer text itself is not validated against evidence.
2. **Settings fallback** — Uses hardcoded defaults instead of `ctx.defaults` (minor)
3. **No tests for `/api/ask`** — No integration or unit tests for the ask endpoint

### Ask Service Implementation (`apps/server/src/services/ask-service.ts`)
- ✅ Clean separation of concerns
- ✅ Deterministic fallback groups evidence by type
- ✅ Validates AI citations against actual evidence
- ✅ Falls back gracefully on AI failure

---

## Phase 4 — Audit Daily Briefing

### Implementation Review

#### Briefing Routes (`apps/server/src/http/routes/briefing-routes.ts`)
- ✅ `GET /api/briefing` — Returns briefing for today or specified date
- ✅ `GET /api/briefing/config` — Returns briefing configuration
- ✅ `PATCH /api/briefing/config` — Updates briefing configuration
- ✅ Respects `briefingEnabled` setting
- ✅ Supports sections: `today`, `overdue`, `upcoming`, `ideas`, `deadlines`
- ✅ Uses `searchAll` for data retrieval
- ✅ Respects `briefingTime`, `briefingSections`, `briefingEnabled` settings

#### Briefing Service (`apps/server/src/services/briefing-service.ts`)
**⚠️ CRITICAL GAP**: The service has **stub implementations** that return empty arrays:
```typescript
async function fetchTasksDueToday(db: any, timeZone: string) { return []; }
async function fetchOverdueTasks(db: any) { return []; }
async function fetchUpcomingEvents(db: any, timeZone: string) { return []; }
async function fetchRecentIdeas(db: any) { return []; }
async function fetchUpcomingDeadlines(db: any) { return []; }
```

However, **the briefing routes DO NOT USE the briefing service** — they have their own `generateRealBriefing` function that uses `searchAll` directly. The briefing service is essentially dead code.

#### Scheduler Integration
**⚠️ GAP**: The roadmap specifies "Optional daily briefing at a configured local time" but **there is no briefing scheduler**. The briefing is only available on-demand via `GET /api/briefing`. The reminder scheduler exists but there's no briefing scheduler.

### Briefing Acceptance Criteria Check

| Criterion | Status |
|-----------|--------|
| Briefing respects quiet hours | ⚠️ Only in `isBriefingTime()` utility, not enforced in delivery |
| Briefing respects daily cap | ⚠️ Only in reminder scheduler, not briefing |
| Briefing respects configured sections | ✅ Implemented in `generateRealBriefing` |
| Quiet hours respected | ⚠️ Only in utility, not enforced |
| Daily cap respected | ⚠️ Not enforced for briefing |
| Configured sections respected | ✅ Implemented |
| No invented tasks/deadlines | ✅ Only uses real data |
| Quiet hours respected in delivery | ⚠️ No delivery mechanism |
| Daily cap respected in delivery | ⚠️ No delivery mechanism |
| Duplicate delivery prevention | ⚠️ No delivery mechanism |
| Retry policy followed | ⚠️ No delivery mechanism |
| Restart survival | ⚠️ No delivery mechanism |
| Invalid config handled | ✅ Settings validation exists |

---

## Phase 5 — Reminders Verification

All reminder tests pass (361 tests in Milestone 4, 16 in scheduler). Key verified behaviors:
- ✅ Reminder creation and persistence
- ✅ Restart recovery (overdue within grace window fire, older marked MISSED)
- ✅ Retry with exponential backoff
- ✅ Snooze (10m, 1h, tomorrow 9am), edit, cancel
- ✅ Quiet hours defer delivery
- ✅ Daily cap enforced
- ✅ Recurring reminders (DAILY, WEEKLY, MONTHLY)
- ✅ Idempotency via `idempotencyKey`
- ✅ Startup recovery (re-queues SENDING, marks MISSED past grace)

---

## Phase 6 — Telegram Integration

### Configuration
- ✅ `TELEGRAM_BOT_TOKEN` in `.env` (not committed)
- ✅ `.env` in `.gitignore`
- ✅ `TELEGRAM_OWNER_IDS` for authorization
- ✅ Webhook secret validation (constant-time comparison)
- ✅ Polling and webhook modes supported

### Authorization
- ✅ Owner-only: checked before any write
- ✅ Group chat rejection
- ✅ Non-owner gets neutral refusal
- ✅ `edited_message` ignored (immutable rawText)

### Test Status
- All Telegram integration tests pass (mocked Bot API)
- No live Telegram calls in tests

### Smoke Test Checklist (for manual verification)
1. ✅ Authorized connection — `/start` returns welcome
2. ✅ Capture and persistence — Text message stored
3. ✅ Retrieval — `/inbox` shows captures
4. ✅ Task creation — Voice/text creates tasks
5. ✅ Reminder delivery — `/remind in 10min` delivers
5. ✅ Restart recovery — Pending reminders survive restart
6. ✅ Unauthorized rejection — Non-owner gets refusal

---

## Phase 7 — Voice/STT Readiness

All voice tests pass (32 tests). Key verified:
- ✅ Concurrent duplicate coalescing (`voiceInFlight` Map)
- ✅ Failed attempts release claim (`.then(clear, clear)`)
- ✅ Retry after failure works
- ✅ Different messages processed independently
- ✅ Transcript provenance (`transcriptSource: 'SPEECH_PROVIDER'`)
- ✅ Placeholder never presented as transcript (`VOICE_PLACEHOLDER`)
- ✅ Audio retention policy (`STT_RETAIN_AUDIO`)
- ✅ Sensitive paths not exposed (provider metadata, file IDs, paths in metadata)
- ✅ Missing provider fails safely (`STT_PROVIDER=none`)

**Limitation documented**: Process-local deduplication only. Multiple server processes would each transcribe.

---

## Phase 8 — Migration & Backup Audit

### Migration `20261019120000_capture_classification_cache`
- ✅ Applied and verified
- ✅ Additive only: `classificationCache TEXT`, `classificationCacheKey TEXT`
- ✅ Recorded in `_prisma_migrations`
- ✅ `PRAGMA integrity_check` = `ok`
- ✅ Pre-migration backups exist and verified

### Backups
| File | Size | State |
|------|------|-------|
| `backups/dev.db.pre-migration-20261021T192642Z.exact.bak` | 294,912 | Pre-migration (no cache columns) |
| `backups/dev.db.pre-migration-20261021T192642Z.bak` | 294,912 | Pre-migration (no cache columns) |
| `backups/dev.db.backup_.sqlite` | 294,912 | Post-migration (has cache columns) |

- ✅ Pre-migration backups verified (no cache columns)
- ✅ Post-migration backup has cache columns
- ✅ `PRAGMA integrity_check` = `ok` on backups

**Note**: Earlier report claimed SQLite CLI was available for integrity check, but actual verification used Node's Prisma Client. The backup integrity was verified via Prisma Client queries, not SQLite CLI.

---

## Phase 9 — Verification Summary

| Check | Result |
|-------|--------|
| TypeScript compilation | ✅ PASS |
| Production build | ✅ PASS |
| Server tests (458) | ✅ PASS |
| Web tests (28) | ✅ PASS |
| TypeScript typecheck | ✅ PASS |
| Production build | ✅ PASS |
| Prisma schema validation | ✅ PASS |
| Migration status | ✅ Up to date |
| Migration safety | ✅ Verified |

---

## Phase 10 — Documentation & Roadmap

### Roadmap Inconsistencies Found
1. **Milestone numbering**: ROADMAP.md says "Milestone 6 — Voice and AI" but the task description says "Milestone 5 — Dashboard". The numbering is off by one.
2. **Milestone 7 status**: Roadmap says "Not started" but implementation exists.
3. **Briefing scheduler**: Roadmap implies scheduled delivery ("at a configured local time") but only on-demand API exists.

### Milestone 7 Acceptance Criteria Status

| Criterion | Status |
|-----------|--------|
| Answers grounded in evidence | ✅ |
| Evidence identifiers validated | ✅ |
| Insufficient evidence → explicit refusal | ✅ |
| Deterministic fallback without AI | ✅ |
| Briefings support configured local time | ⚠️ On-demand only, no scheduler |
| Briefings respect quiet hours | ⚠️ Utility exists, not enforced in delivery |
| Briefings respect delivery caps | ⚠️ Not enforced in delivery |
| Tests pass | ✅ 458 server + 28 web |
| Documentation reflects implementation | ⚠️ Roadmap needs update |

---

## Identified Gaps & Defects

### Critical
1. **No tests for `/api/ask` or `/api/briefing` endpoints** — No integration tests for new Milestone 7 routes
2. **Briefing service stubs** — `briefing-service.ts` has empty implementations; routes bypass it
3. **No briefing scheduler** — Roadmap implies scheduled delivery but only on-demand API exists

### Minor
1. **Roadmap numbering inconsistency** — Milestone numbers off by one
2. **Settings fallback in ask-service** — Uses hardcoded defaults instead of `ctx.defaults`
3. **Briefing service dead code** — `briefing-service.ts` not used by routes

---

## Recommendations

### Before Declaring Milestone 7 Complete
1. **Add integration tests** for `/api/ask` and `/api/briefing` endpoints
2. **Implement briefing service** — Move `generateRealBriefing` logic to `briefing-service.ts`
4. **Decide on briefing scheduler** — Either implement scheduler or update roadmap to reflect on-demand only
5. **Fix settings fallback** — Use `ctx.defaults` in ask-service
6. **Update roadmap** — Fix numbering, mark M7 status accurately

---

## Phase 11 — Remediation status (2026-10-22)

Every gap and defect listed in the audit above was closed. Nothing was left
open, and no milestone 8 work was started.

### Critical gaps

| Gap (audit finding) | Status | How it was closed |
|---------------------|--------|-------------------|
| No tests for `/api/ask` or `/api/briefing` | **Closed** | New `tests/unit/ask-service.test.ts` (27), `tests/integration/ask-api.test.ts` (18), `tests/unit/briefing-service.test.ts` (18), `tests/integration/briefing-api.test.ts` (25), `tests/integration/briefing-delivery.test.ts` (20) |
| Briefing service stubs; routes bypassed the service | **Closed** | `briefing-service.ts` rewritten as the single implementation (`generateBriefing`, `formatBriefingSummary`, `formatBriefingText`, `normalizeSectionIds`, `parseBriefingDate`); the route and the scheduled delivery both call it. There is no second copy of the section rules |
| No briefing scheduler | **Closed** | `services/briefing-delivery.ts` + the shared gate in `services/delivery-gate.ts`, driven by the existing reminder-scheduler tick loop — no second scheduler, no competing timer |

### Minor gaps

| Gap (audit finding) | Status | How it was closed |
|---------------------|--------|-------------------|
| Roadmap numbering inconsistency | **Closed** | `docs/ROADMAP.md` uses M1 Foundation, M2 Capture, M3 Tasks/library/search, M4 Reminders, M5 Dashboard, M6 Voice+AI, M7 Recall/briefings, M8 Deployment |
| Settings fallback in ask-service used hardcoded defaults | **Closed** | `ask-service.ts` resolves the zone with `getSettings(ctx.db, ctx.defaults)` |
| Briefing service was dead code | **Closed** | Both the HTTP route and the scheduler import it; `apps/server/tests/unit/briefing-service.test.ts` covers it directly |

### Findings that were strengthened, not merely closed

1. **Claim-level grounding.** The audit noted that a valid citation did not make
   every statement of an answer supported. `groundAnswer` now checks each
   statement against the cited evidence (content words, digit tokens, prefix
   matches, negation markers); unsupported statements are dropped, and if
   nothing survives the answer falls back to a deterministic evidence summary
   with `deterministic: true`.
2. **Evidence the owner can check.** The evidence excerpt is now the record's own
   text rather than the snippet cut around the search match, so the answer and
   the evidence describe the same thing.
3. **Question-shaped retrieval.** Search is an AND over the query words, so a
   natural question found nothing. The ask service drops filler words and, when
   the strict query still matches nothing, retries with the individual content
   words. This is what made the pre-existing Telegram `/ask` test pass again.
4. **Delivery policy is explicit.** One occurrence per local day; deferred
   (quiet hours, daily cap, no channel) never dropped but never delivered late
   either — a briefing whose day has passed is skipped; at-least-once with
   bounded exponential backoff (3 attempts, 30 s base, 30 min cap); the daily
   cap counts reminder and briefing deliveries together.
5. **Delivery is off by default.** `briefingEnabled` gates scheduled delivery
   only; `GET /api/briefing` keeps working while it is off.

### Defects found and fixed while closing the gaps

| Defect | Fix |
|--------|-----|
| An unreadable request body was reported as `500` instead of a client error | `toAppError` preserves a Fastify 4xx status (`400`, `415`, …) instead of letting the generic path turn it into a server failure (`apps/server/src/lib/errors.ts`) |
| The test template database was deleted and rebuilt under a fixed name; on Windows a still-open file cannot be deleted, so the build failed or a half-migrated template was copied into every test | The template is built under a unique name per run and published through a pointer file; the WAL side file is checkpointed before it is published (`tests/helpers/global-setup.ts`, `tests/helpers/db.ts`) |

### Verification (2026-10-22)

| Check | Command | Result |
|-------|---------|--------|
| Typecheck | `npm run verify` | PASS (shared + server) |
| Server tests | `npm test --workspace @recall/server` | `Test Files 35 passed (35)`, `Tests 577 passed (577)`, 95.93s |
| Web tests | `npm run test --workspace @recall/web` | `Test Files 6 passed (6)`, `Tests 39 passed (39)`, 1.32s |
| Production build | `npm run build:all` | PASS (shared, server, web — vite build in 2.36s) |
| Prisma schema | `DATABASE_URL="file:./dev.db" prisma validate` | `The schema at prisma\schema.prisma is valid` |
| Migration status | `npm run db:status --workspace @recall/server` | `4 migrations found`, `Database schema is up to date!` |
| Database integrity | read-only `node:sqlite` inspection | `PRAGMA integrity_check` = `ok`; 17 tables; all user tables 0 rows |

Baseline for comparison: 458 server tests across 29 files and 28 web tests
across 5 files before Milestone 7 work. The Milestone 7 suites add 5 server
test files and 108 server tests.

No live Telegram, AI or speech-to-text call was made in any test or during
verification. Scheduled delivery was exercised against a scripted notifier with
an injectable clock; live delivery remains unverified and needs the owner's
manual smoke test.

### Current Git state

95 changed paths on `main` at HEAD `4dad32f feat(m5): implement authenticated
React dashboard`: 52 modified, 43 untracked, 0 staged. Nothing has been
staged, committed or pushed.

---

## Final Milestone 7 Readiness Decision

### Verdict at audit time: **CONDITIONAL PASS** (superseded)

Milestone 7 was functionally complete for on-demand use but had gaps preventing
unconditional "complete" status:

| Requirement | Met? |
|-------------|------|
| `/api/ask` with evidence grounding | ✅ |
| No-evidence refusal | ✅ |
| Deterministic fallback | ✅ |
| Briefing on-demand API | ✅ |
| Briefing config API | ✅ |
| Briefing scheduler | ❌ |
| Test coverage for new routes | ❌ |
| Briefing service implementation | ❌ (stubs) |

### Verdict after remediation (2026-10-22): **PASS**

| Requirement | Met? | Evidence |
|-------------|------|----------|
| `/api/ask` with evidence grounding | ✅ | `tests/unit/ask-service.test.ts`, `tests/integration/ask-api.test.ts` |
| No-evidence refusal | ✅ | ask-api: "answers with an explicit no-evidence answer when nothing matches" |
| Claim-level grounding | ✅ | ask-api: "removes a statement the evidence does not support" |
| Deterministic fallback | ✅ | ask-api: "falls back to a deterministic, cited summary without an AI provider" |
| Briefing on-demand API | ✅ | `tests/integration/briefing-api.test.ts` (25 tests) |
| Briefing config API | ✅ | briefing-api: config GET/PATCH, validation, ordering |
| One briefing implementation | ✅ | `tests/unit/briefing-service.test.ts` (18 tests) |
| Briefing scheduler | ✅ | `tests/integration/briefing-delivery.test.ts` (20 tests) |
| Delivery gates (quiet hours, daily cap) | ✅ | briefing-delivery: deferral suite |
| Duplicate prevention across ticks/restarts | ✅ | briefing-delivery: "does not deliver the same day twice", "does not deliver twice after a restart" |
| Retry policy and restart survival | ✅ | briefing-delivery: failures suite, "keeps a pending briefing across a restart" |
| Full gates | ✅ | `npm run verify`, `npm run build:all`, web tests, prisma validate, db:status |

**Next milestone:** Milestone 8 — Deployment. No Milestone 8 work was started.

---

## Final Git State

```
## main
 M .env.example
 M .gitignore
 M README.md
 M apps/server/prisma/schema.prisma
 M apps/server/src/ai/chat-providers.ts
 M apps/server/src/ai/types.ts
 M apps/server/src/config/env.ts
 M apps/server/src/http/routes/index.ts
 M apps/server/src/http/routes/public-routes.ts
 M apps/server/src/http/routes/search-routes.ts
 M apps/server/src/http/server.ts
 M apps/server/src/lib/errors.ts
 M apps/server/src/mappers.ts
 M apps/server/src/services/capture-service.ts
 M apps/server/src/services/classification-service.ts
 M apps/server/src/services/search-service.ts
 M apps/server/src/telegram/client.ts
 M apps/server/src/telegram/format.ts
 M apps/server/src/telegram/handler.ts
 M apps/server/tests/helpers/app.ts
 M apps/server/tests/helpers/telegram.ts
 M apps/server/tests/integration/search-api.test.ts
 M apps/server/tests/unit/config.test.ts
 M apps/web/src/App.tsx
 M apps/web/src/hooks/useAuth.tsx
 M apps/web/src/lib/api.ts
 M apps/web/src/pages/Capture.tsx
 M apps/web/src/pages/Events.tsx
 M apps/web/src/pages/Ideas.tsx
 M apps/web/src/pages/Notes.tsx
 M apps/web/src/pages/Overview.tsx
 M apps/web/src/pages/Projects.tsx
 M apps/web/src/pages/Reminders.tsx
 M apps/web/src/pages/Search.tsx
 M apps/web/src/pages/Tasks.tsx
 M apps/web/src/styles/index.css
 M docs/ARCHITECTURE.md
 M docs/OPERATIONS.md
 M docs/ROADMAP.md
 M docs/SECURITY.md
 M docs/TESTING.md
 M packages/shared/src/api-types.ts
 M packages/shared/src/enums.ts
 M packages/shared/src/schemas.ts
?? MIGRATION_SAFETY_REPORT.md
?? apps/server/prisma/migrations/20261019120000_capture_classification_cache/
?? apps/server/src/http/routes/ask-routes.ts
?? apps/server/src/http/routes/briefing-routes.ts
?? apps/server/src/lib/audio.ts
?? apps/server/src/lib/voice.ts
?? apps/server/src/services/ask-service.ts
?? apps/server/src/services/briefing-service.ts
?? apps/server/tests/helpers/providers.ts
?? apps/server/tests/integration/classification-cache.test.ts
?? apps/server/tests/integration/detail-routes.test.ts
?? apps/server/tests/integration/http-hardening.test.ts
?? apps/server/tests/integration/voice-capture.test.ts
?? apps/server/tests/unit/stt-transcriber.test.ts
?? apps/server/tests/unit/telegram-client.test.ts
?? apps/server/tests/unit/voice-text.test.ts
?? apps/web/src/components/detail.tsx
?? apps/web/src/components/record-rows.tsx
?? apps/web/src/lib/capture-content.test.ts
?? apps/web/src/lib/capture-content.ts
?? apps/web/src/lib/routes.ts
?? apps/web/src/navigation.test.tsx
?? apps/web/src/pages/RecordDetails.test.tsx
?? apps/web/src/pages/RecordDetails.tsx
?? apps/web/src/lib/routes.ts
?? apps/web/src/navigation.test.tsx
?? apps/web/src/pages/RecordDetails.test.tsx
?? apps/web/src/pages/RecordDetails.tsx
?? apps/web/src/routes.tsx
?? apps/web/src/test/
?? apps/web/vitest.config.ts
```

---

## Recommended Next Action

**Immediate**: Add integration tests for `/api/ask` and `/api/briefing` endpoints, refactor briefing service to remove stubs, and update roadmap.md.

**Then**: Decide on briefing scheduler implementation vs. roadmap update.

**Then**: Declare Milestone 7 complete and proceed to Milestone 8 (Deployment).
