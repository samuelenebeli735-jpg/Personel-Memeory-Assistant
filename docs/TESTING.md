# Recall — Testing

## Philosophy

- Tests are written alongside the feature, not after it.
- Nothing is reported as passing unless it was actually executed. The results
  table below is a real recording.
- Tests are **not** weakened to get a green run. When a test and the code
  disagreed, the disagreement was resolved on its merits and the decision
  recorded (see "Decisions forced by tests").
- A mocked test is labelled as mocked. No test claims to have exercised a live
  external service — none has, because no provider credentials exist in this
  environment.
- Timing logic is tested with an injectable clock and an injectable `sleep`. No
  test sleeps for real wall-clock time.

## Commands

```bash
npm test                                        # server suite
npm run test:unit --workspace @recall/server     # server unit tests
npm run test:integration --workspace @recall/server
npm run test --workspace @recall/web             # dashboard component/navigation tests
npm run test:e2e                                 # Edge browser E2E + axe accessibility
npm run verify                                   # shared/server typecheck + server tests
npm run build:all                                # shared, server and web builds
```

Inside `apps/server`:

```bash
npx vitest run tests/unit/time.test.ts           # a single file
npx vitest                                       # watch mode
npx vitest run --coverage                        # with coverage
```

Inside `apps/web`:

```bash
npx vitest run src/navigation.test.tsx           # route/link regression
npx vitest                                       # watch mode
```

The web tests use Vitest's Node environment plus React server rendering. They do
not add jsdom, Testing Library or a browser dependency. That keeps the suite light
and still exercises the real row and detail components; it is not a browser-level
end-to-end test.

`npm run test:e2e` is the browser-level layer. It runs Microsoft Edge through
Playwright's `msedge` channel (no Chromium download), builds the production
dashboard bundle, starts the real Fastify API and serves the bundle with
`vite preview`, then drives the real login and dashboard workflows. The run uses a
disposable migrated SQLite database under the git-ignored `apps/web/e2e/.tmp`
directory and random per-run credentials; it never reads or writes the owner's
`apps/server/prisma/dev.db`. A setup project logs in through the real form and
saves the session for the workflow project. Axe is run with the `wcag2a` and
`wcag2aa` tags against the login screen and six authenticated pages in the default
light color scheme.

Useful focused commands:

```bash
node apps/web/e2e/prepare.mjs                         # reset DB + rebuild dashboard
npx playwright test apps/web/e2e/auth.spec.ts --project=edge
npx playwright test apps/web/e2e/accessibility.spec.ts --project=edge
npx playwright test --ui                              # after prepare.mjs has run
```

The browser suite is not a substitute for the Docker/Caddy deployment check: it
runs against a local production bundle and a local API, not against the public
host or a publicly trusted TLS certificate.

## Layout

```
apps/server/tests/
├── helpers/
│   ├── global-setup.ts   builds a migrated template SQLite database once
│   ├── db.ts             copies the template into an isolated database per file
│   ├── app.ts            test configuration, context, logger, notifier, HTTP app
│   ├── providers.ts      fake AI provider and fake transcriber (call-counting)
│   └── telegram.ts       fake Bot API, update builders, adapter factory
├── unit/
│   ├── config.test.ts              environment schema, hardening, failure messages
│   ├── time.test.ts                zone conversion, DST, local days, quiet hours
│   ├── nlp.test.ts                 natural-language dates, ambiguity guards, recurrence
│   ├── rules-classifier.test.ts    deterministic classification and extraction
│   ├── retry.test.ts               backoff, caps, jitter, retry policy
│   ├── auth.test.ts                session signing, tampering, expiry, log redaction
│   ├── telegram-format.test.ts     commands, confirmations, keyboards, callback data
│   ├── telegram-notifier.test.ts   proactive delivery, failure classification, sound vs silent
│   ├── telegram-polling.test.ts    offset, backoff, stop, bad token, failed-update retry and
│   │                               dead letter, webhook and poller 409s, start-up retries,
│   │                               status codes, no token in logs
│   ├── telegram-client.test.ts     bounded file stream, Content-Length, cancel on cap
│   ├── chat-providers.test.ts      provider request shape and response parsing
│   ├── library-format.test.ts      snippets, search type resolution, list formatting
│   ├── voice-text.test.ts          caption/transcript composition, audio guards, cache key
│   ├── stt-transcriber.test.ts     multipart shape, 429/shape/timeout/empty, null factory
│   ├── ask-service.test.ts         claim splitting, citation validation, per-claim support
│   └── briefing-service.test.ts    section order, empty sections, date parsing, summary
└── integration/
    ├── health-and-auth.test.ts     HTTP authorization, health, settings persistence
    ├── http-hardening.test.ts      opt-in proxy trust, login/global/webhook limits and 429 mapping
    ├── telegram-capture.test.ts    owner gate, idempotency, correction, undo, webhook
    ├── voice-capture.test.ts       voice lifecycle, concurrent coalescing, retention
    ├── classification-cache.test.ts cache reuse/invalidation, failures, reprocess guard
    ├── capture-api.test.ts         ingest, pagination, filters, convert, undo, purge
    ├── capture-atomicity.test.ts   injected write failure rolls the derivation back
    ├── library-api.test.ts         task rules, entity separation, projects, tags
    ├── search-api.test.ts          cross-entity matching, filters, pagination
    ├── telegram-library.test.ts    /tasks, /today, /overdue, /search, /ideas, /notes, /projects
    ├── export-restore.test.ts      bundle shape, round trip, dry run, identity reuse
    ├── reminder-scheduler.test.ts  DB-backed tick loop, retries, quiet hours, daily cap, recovery
    ├── reminder-api.test.ts        CRUD, cancel, snooze, delivery history
    ├── telegram-reminders.test.ts  /remind, /reminders, /snooze, /cancel
    ├── telegram-bridge.test.ts     reminders (audible) and briefings (silent) delivered while
    │                               polling is in conflict; polling status in health
    ├── detail-routes.test.ts       dashboard detail API: exact record, 401, non-leaking 404
    ├── ask-api.test.ts             /api/ask: grounding, citations, validation, fallback
    ├── briefing-api.test.ts        /api/briefing: sections, dates, config, disabled flag
    └── briefing-delivery.test.ts   scheduled delivery: once a day, gates, retries, restart
```

```
apps/web/src/
├── lib/
│   ├── capture-content.test.ts   transcript/caption/unavailable presentation
│   ├── date.test.ts              local date and time formatting
│   ├── search-filters.test.ts    search filter serialization
│   └── ...                       (test fixtures live under src/test/)
├── pages/
│   └── RecordDetails.test.tsx    detail views, provenance, safe error states
└── navigation.test.tsx           every visible record-row link vs registered routes
```

```
apps/web/e2e/
├── prepare.mjs          disposable DB, random credentials, production web build
├── helpers.ts           env loading, unique labels, shared auth-state path
├── auth-setup.ts        logs in through the real form and saves the session
├── auth.spec.ts         unauthorised redirect, bad password, logout
├── navigation.spec.ts   overview widgets, every sidebar destination, settings
├── capture.spec.ts      capture → recent list → detail
├── tasks.spec.ts        create task → status transition → detail
├── reminders.spec.ts    create → detail → snooze
├── library.spec.ts      note, idea, event and project create → detail
├── search.spec.ts       create task → dashboard search → detail
└── accessibility.spec.ts axe WCAG A/AA on login and authenticated pages
```

### The host time zone is pinned

`apps/server/vitest.config.ts` sets the test process's own zone to
`Pacific/Kiritimati` (UTC+14, no DST), a zone no test uses as an owner zone.
Recall must read dates in the owner's configured zone, never the host's; on a
machine that happens to share the owner's zone (a laptop in `Africa/Lagos`) a
host-zone bug is invisible, so the suite deliberately runs somewhere else. A
guard test in `tests/unit/nlp.test.ts` fails if the pin is not in effect.

To reproduce the production container, run with the host in UTC:

```bash
RECALL_TEST_HOST_TZ=UTC npm test --workspace @recall/server
```

### How the database tests work

`globalSetup` runs the **real** `prisma migrate deploy` once against a template
file in the OS temp directory. Each integration test file then copies that file,
so tests exercise the actual version-controlled migrations while staying fast and
independent. The template is rebuilt on every run, so a schema change cannot be
silently ignored.

The template is built under a **unique name per run** and published through a
pointer file (`template.json` in the temp directory). A fixed name would have to
be deleted before the build, and on Windows a file that is still open cannot be
deleted — the build would fail, or a half-migrated template would be copied into
every test file and reported as a confusing "table does not exist". The WAL side
file is checkpointed before the template is published, so a plain copy is
complete.

## Current results

Executed 2026-11-22 on Node v24.17.0, npm 11.13.0, Windows (win32), for the
Round 1 integration-readiness review. Round 1 (R1-02 to R1-06) ended at commit
`75ccb0e` with **738 server, 67 dashboard and 80 browser tests** passing; the
follow-up that makes Telegram `/settings` report the AI privacy rule adds 8
server tests (746), and the PR #2 review fixes (Telegram acknowledges an update
only after handling it; the briefing deadline is rechecked before sending) add
6 more (752), and the verification follow-up (dead-letter notice failures,
dead-lettered button presses, a slow briefing send) adds 6 more, giving the 758
below. The server suite passes both with the test
host pinned to `Pacific/Kiritimati` (UTC+14, the default) and with
`RECALL_TEST_HOST_TZ=UTC`.

Server suite (`npm run verify`; Vitest is capped at two workers on Windows):

```
 Test Files  42 passed (42)
      Tests  758 passed (758)
```

Before the Windows worker cap, a default-worker run timed out in four setup hooks
and one reminder setup; the same suites passed individually. A four-worker attempt
then had five restore cases exceed the 30s per-test limit. The two-worker full suite
passes with nothing skipped. On Linux the default worker count is unchanged.

Dashboard suite (`npm run test --workspace @recall/web`):

```
 Test Files  7 passed (7)
      Tests  67 passed (67)
```

The server suite was re-run after the Milestone 7 and Milestone 8 work. It
includes regression tests for captured-at anchoring, same-day reprocessing,
duration/date/clock-time stability, separate same-day cache entries, bounded
streaming, concurrent voice deduplication and failed-attempt retry, oversized
transcripts, untranscribed-voice reprocessing, purge cleanup, detail-route
authorization, opt-in proxy trust, login/global/webhook rate limiting, production
secret validation, provider URL validation, every supported search type and the
429 error mapping. The Milestone 7 suites add claim-level grounding (citation
validation, per-statement support checks, the deterministic fallback), the
briefing sections and their ordering, the briefing HTTP contract (including
invalid dates and the disabled flag), and the scheduled delivery policy (one
occurrence per local day, no double delivery across ticks or restarts, quiet
hours, the daily cap, the retry budget and restart recovery). The dashboard suite
covers transcript provenance, caption-only and untranscribed voice captures, safe
error states, every visible record-row link against the registered route table,
search-filter serialization, local date formatting, and session bootstrap behavior
when only the health probe fails.

Round 1 adds: the Settings form contract (R1-01); one owner time zone, including
the host-zone pin and DST cases (R1-02, R1-02b); date and time questions answered
from timestamps (R1-03, `ask-temporal`); AI transport, configuration and privacy
(R1-04, `ai-transport`, `ai-privacy`); Telegram polling recovery and the
reminder/briefing sound split (R1-05, `telegram-polling`, `telegram-bridge`); and
the 2-hour briefing deadline (R1-06, `briefing-delivery`).

| Suite | Tests | Result |
| --- | --- | --- |
| `unit/config.test.ts` | 33 | passed |
| `unit/time.test.ts` | 16 | passed |
| `unit/nlp.test.ts` | 40 | passed |
| `unit/rules-classifier.test.ts` | 20 | passed |
| `unit/retry.test.ts` | 8 | passed |
| `unit/auth.test.ts` | 14 | passed |
| `unit/telegram-format.test.ts` | 27 | passed |
| `unit/telegram-notifier.test.ts` | 9 | passed |
| `unit/telegram-polling.test.ts` | 24 | passed |
| `unit/telegram-client.test.ts` | 3 | passed |
| `unit/chat-providers.test.ts` | 2 | passed |
| `unit/ai-transport.test.ts` | 25 | passed |
| `unit/library-format.test.ts` | 24 | passed |
| `unit/reminder-commands.test.ts` | 24 | passed |
| `unit/voice-text.test.ts` | 24 | passed |
| `unit/stt-transcriber.test.ts` | 9 | passed |
| `unit/ask-service.test.ts` | 35 | passed |
| `unit/ask-temporal.test.ts` | 17 | passed |
| `unit/briefing-service.test.ts` | 18 | passed |
| `integration/health-and-auth.test.ts` | 18 | passed |
| `integration/telegram-capture.test.ts` | 31 | passed |
| `integration/voice-capture.test.ts` | 32 | passed |
| `integration/classification-cache.test.ts` | 11 | passed |
| `integration/capture-api.test.ts` | 20 | passed |
| `integration/capture-atomicity.test.ts` | 3 | passed |
| `integration/library-api.test.ts` | 22 | passed |
| `integration/search-api.test.ts` | 26 | passed |
| `integration/telegram-library.test.ts` | 16 | passed |
| `integration/export-restore.test.ts` | 13 | passed |
| `integration/backup-service.test.ts` | 6 | passed |
| `integration/reminder-scheduler.test.ts` | 16 | passed |
| `integration/reminder-api.test.ts` | 10 | passed |
| `integration/telegram-reminders.test.ts` | 19 | passed |
| `integration/telegram-bridge.test.ts` | 5 | passed |
| `integration/detail-routes.test.ts` | 3 | passed |
| `integration/http-hardening.test.ts` | 5 | passed |
| `integration/ask-api.test.ts` | 19 | passed |
| `integration/ask-temporal.test.ts` | 21 | passed |
| `integration/ai-privacy.test.ts` | 15 | passed |
| `integration/briefing-api.test.ts` | 26 | passed |
| `integration/briefing-delivery.test.ts` | 47 | passed |
| `integration/dashboard-api.test.ts` | 2 | passed |
| **Total** | **758** | **all passed** |

Dashboard suite:

| Suite | Tests | Result |
| --- | --- | --- |
| `lib/capture-content.test.ts` | 6 | passed |
| `lib/search-filters.test.ts` | 7 | passed |
| `lib/date.test.ts` | 18 | passed |
| `lib/settings-form.test.ts` | 17 | passed |
| `hooks/session-bootstrap.test.ts` | 7 | passed |
| `pages/RecordDetails.test.tsx` | 9 | passed |
| `navigation.test.tsx` | 3 | passed |
| **Total** | **67** | **all passed** |

Browser E2E (`npm run test:e2e`, Microsoft Edge 156 headless), run at `75ccb0e`:

```
 80 passed (5.1m)
```

The 80 Playwright tests comprise 79 browser workflow/accessibility checks plus the
login setup project: the 71 of Milestone 8 plus the Settings specs (R1-01) and
the time-zone specs (R1-02). The run used a disposable database, the production dashboard
bundle and the real Fastify API. It covered login/logout, bad-password rejection,
session expiry, anonymous access, keyboard navigation, modal focus trapping,
responsive desktop/tablet/mobile layouts, empty and failed-request states, missing
records, task edit/delete, reminder snooze, library creation/detail flows, search,
console errors, failed application requests, and axe WCAG 2.0/2.1 A/AA checks on
the login page and six authenticated pages in both light and dark color schemes.
No axe violations were reported in either color scheme. The browser suite found
and the fixes closed these real defects:

1. The Overview page called `/api/dashboard/overview`, which did not exist. The
   route and its integration test were added.
2. Bodyless POSTs (logout, reprocess, undo) sent `Content-Type: application/json`
   with no body; Fastify rejected them with `400`. The API client now sets the JSON
   content type only when a body is present.
3. Creating a task with the default “None” priority sent `priority: ""`, which the
   shared schema rejected. The form now sends `null`.
4. Small badge text, muted text and the green status text failed WCAG AA contrast.
   Dedicated badge foreground tokens and stronger muted/success colours were added
   for both light and dark themes.
5. Task-row status selects had no accessible name. Each now has
   `aria-label="Status for <task title>"`.
6. Task status-update failures were only logged to the console. The dashboard now
   presents an accessible error toast.
7. Project pagination ignored its offset, preventing reliable empty-page behavior.
   The API and service now honor the offset.
8. The JSON backup companion could describe a later live-database state than the
   SQLite snapshot. JSON export now reads from the verified snapshot, with a
   regression test covering a write after snapshot finalization.
9. Empty-state titles were generic `div` elements. They are now semantic headings,
   and task detail pages expose tested edit/delete confirmation workflows.

These are automated browser and axe results. No manual screen-reader or assistive
technology review was performed in this environment.

`npm run typecheck` (shared + server, `--strict`, `noUncheckedIndexedAccess`) and
`npm run typecheck --workspace @recall/web` pass with no errors. `npm run build`
(shared + server) and `npm run build --workspace @recall/web` also pass.

`export-restore.test.ts` is the slowest file (~30–120s depending on machine load): each case seeds a database,
exports it, wipes it and restores it row by row through real Prisma calls. That is
the cost of testing restore against real constraints rather than a mock, and it is
kept because restore is the one operation that can bulk-write.

The CLI was exercised against a throwaway migrated database (not the owner's):
`doctor` reported the real configuration, `capture` stored a task with the correct
local time, and `inbox` read it back. The M8 backup drill then captured a task,
created a `VACUUM INTO` snapshot and JSON export, copied the snapshot to a
standalone restore file, and verified both the original backup and the restored
copy: integrity `ok`, zero foreign-key violations, four applied migrations and
matching row counts.

## What is covered

### Unit

**Capture validation / configuration** — complete config accepted; boolean parsing
(`"false"` is not truthy, `1`/`yes`/`on`/`0`/`off`, absent → default); list
splitting with blanks removed; non-numeric port rejected; unknown providers
rejected rather than ignored; placeholder tokens rejected; owner ids required when
the bot is enabled; unknown IANA zone rejected; `HH:MM` validated; quiet hours must
be paired; API key required when a provider is chosen; production requires a
password, a >= 32-char session secret, secure cookies, and an https webhook URL with
a secret; `ConfigError` messages never echo secret values.

**Date and time parsing** — "at 4 PM" → the correct UTC instant; "in 10 minutes";
"tomorrow at 9 AM"; "next Friday at 4 PM" (correct local weekday and hour);
"tomorrow morning" uses the configured 09:00 default *and* reports the assumption;
a date with no time is marked `dateOnly` instead of inventing an hour; genuinely
dateless text yields `found: false`; the verbs "may" and "sat" are not read as
dates; "May 5" still parses; a time already past rolls forward; the matched phrase
is reported so a clean title can be derived; daily/weekly/monthly and specific
weekday recurrence; relative durations in minutes/hours/days/weeks; questions
recognised so they are not stored as tasks.

**Time-zone conversion** — local→UTC in a UTC+1 zone including a date rollover;
DST-correct conversion on a spring-forward day and back in standard time; invalid
wall-clock rejected (`null`) rather than silently shifted; local day range as UTC
bounds; day-range offsets; calendar date and minutes-of-day; end-of-local-day;
local-day comparison across a UTC midnight boundary; compact local formatting;
relative descriptions ("in 30 min", "tomorrow at 9:00 AM"); quiet hours with a
wrap past midnight, a same-day window, a disabled window (missing bounds, or equal
bounds), and the computed end-of-quiet-hours instant.

**Classification mapping** — every example from the product brief maps to the
expected kind (task/idea/note/event/other), including a bare URL as a note; a
question becomes `UNKNOWN` + `needsReview` and gets no date; an explicit command
hint overrides detection; a date-only deadline resolves to the end of the named
local day; a reminder is created only when the user asked for one; no date is
invented when none was given; inline tags are extracted and stripped from the
title; priority words detected; URLs kept in the note description; the applied
assumption is reported; low-confidence input is flagged for review; a title is
never empty.

**Task state transitions** — the transition table is defined in
`packages/shared/src/enums.ts` and consumed by the task service (service tests
arrive with Milestone 3).

**Reminder scheduling / retry logic** — success returns without sleeping; retries
use exponential backoff (100/200/400); the delay is capped; jitter stays within
bounds and is not constant; a permanent error stops retrying immediately; a
transient failure recovers and reports the attempt count; a total-time budget stops
the loop; each retry is reported through `onRetry`. The full DB-backed scheduler
is covered by integration tests with an injectable clock (no real sleeps).

**Voice text and speech transport** — caption + transcript composition keeps the
caption first, collapses identical or contained content and never drops either
source; the voice
placeholder is ignored when a transcript exists; supported audio mime types are
accepted and unsupported ones rejected before download; the AI cache key is stable
for equal inputs (including project order) and changes with text, hint, zone,
defaults, projects, provider, model and the exact reference instant (including
within one local day); a transcript without provenance
is rejected by `captureInputSchema`. The Whisper transport is exercised with an
injected `fetch`: multipart shape and model field, trimmed output, empty output
rejected without retry, 400 not retried, 429 retried then succeeds, 5xx retried to
the limit, timeout reported as retryable, non-JSON rejected, and the factory
returns `null` when unconfigured.

**Authorization** — a signed session round-trips with the right expiry; a tampered
payload is rejected; a token signed with another secret is rejected; malformed
tokens never throw; expired sessions are rejected; tokens are non-deterministic;
password comparison is exact; bearer tokens take precedence over cookies; cookie
parsing handles multiple cookies and url-encoding; cookie options are hardened
(`HttpOnly`, `SameSite`, `Secure`); the logger redacts secrets and message content
including nested objects, and content logging only happens when explicitly opted in.

### Integration (real Fastify app, real SQLite, real migrations)

Liveness without credentials; `401` on the detailed health endpoint and on settings
without a session; wrong password rejected without echoing it; malformed login body
rejected; correct password issues an `HttpOnly; SameSite=Lax` cookie; a tampered
cookie is rejected; session state endpoint for dashboard bootstrap; logout clears the
cookie; a complete authenticated health report with provider status and counts;
**degraded (HTTP 200, `database.connected: false`) when the database is
unreachable** rather than a crash; structured `404`; the settings singleton is
created from configuration on first read; settings update and persist; an invalid
time zone produces a field-level `400`; a half-configured quiet-hours window is
rejected; an unknown field never reaches the response.

### Dashboard detail API

The detail endpoints used by the dashboard return the exact record requested for
captures, tasks, reminders, notes, ideas, events and projects. An anonymous request
to any of them is a `401` and its body does not contain the seeded record text. An
authenticated request for a missing id is a `404` with a generic error and no record
content. The capture DTO reports `isVoice` for audio captures and `false` for a
typed capture. Search result projection is covered too: a caption is used when
present, otherwise the transcript, and a placeholder-only voice capture is titled
"Voice capture — transcript unavailable"; neither its title nor snippet contains
the internal marker.

### Dashboard components and navigation

The capture presentation helper is tested directly: provider speech output is
labelled "Speech-to-text transcript", a manual transcript is labelled separately,
a user caption is labelled "Caption", a caption-only voice note shows the caption
plus "Transcript unavailable", and an untranscribed voice note never renders the
stored `[voice message — not transcribed yet]` placeholder as content. A typed
capture is labelled "Captured text", not as a caption.

The detail views are rendered through React server rendering in Node. The capture
view is checked with transcribed, caption-only and untranscribed fixtures; the task
and reminder views are checked against their requested records. A capture fixture
carrying extra `metadata`, `mediaRef`, `classificationCache`,
`classificationCacheKey` and `sourceRef` values proves those private fields are not
rendered. Error-state tests prove a `401` and a `404` produce generic messages, and
children containing record contents are not rendered when loading fails.

The navigation regression renders every visible row type (capture, task, reminder,
note, idea, event, project), extracts the internal `href` values, and matches each
against the same route patterns the app registers. It also checks that every
top-level navigation path and every `detailPath` output is registered. This is a
component/navigation test; the separate Playwright suite performs the real-browser
click-throughs and accessibility audit.

### Atomicity of derivation

A database-level write failure is injected in the middle of a capture's derivation
(after the task row exists, when the reminder write fails). The test asserts that
**no** task, reminder, tag or tag link survives, that the capture ends `RECEIVED`
with `kind = UNKNOWN`, and that the original text is still stored. This is the only
test that proves rollback rather than a code path that merely avoids writing; the
injected failure is a real Prisma client extension, so the rollback is SQLite's.

### Telegram capture (real adapter, real database, fake Bot API)

An owner message creates exactly one capture with the text byte-for-byte intact and
a confirmation that names the interpreted kind and the local time; the reply carries
one callback per kind plus undo. Replaying the same update stores nothing and says
"Already saved"; a new message id is a new capture. A non-owner gets a neutral
refusal, no capture, no callback edits, and no owner id in the reply. An owner
messaging from a group is told to use a private chat. An edited Telegram message is
ignored so stored text cannot be rewritten.

With an AI provider that throws, the capture is still stored, classified by the
deterministic rules, and the reply is explicit that the provider was unavailable.
Stickers/documents/photos are acknowledged and ignored. With no transcriber
configured, a voice message is stored with the `[voice message — not transcribed
yet]` marker, `UNKNOWN` + `NEEDS_REVIEW`, provenance metadata, and no fabricated
task; a caption is used as its text. A message with no text asks for words.
`/help`, `/inbox`, `/undo`, `/settings` and unknown commands all answer without
creating a capture; a planned command says which milestone will bring it.

Correction buttons convert a capture's kind, keep `rawText`, and replace the derived
record. `/undo` shows a confirmation and deletes nothing until `U:` is pressed; `K:`
keeps everything; a confirmed undo soft-deletes the capture and removes its records.
Webhook mode rejects a wrong secret (401) and a malformed body (400), accepts a
correctly signed update, refuses to run with no secret (503), and still returns 200
for a non-owner so Telegram does not retry forever.

Reminders are created only when the user asked; a plain deadline produces none.

### Voice capture (real adapter, real database, fake Bot API, injected transcriber)

A voice note is downloaded, transcribed and classified; `rawText` keeps the
placeholder (or the caption verbatim), `transcript` holds the speech output and
`transcriptSource` is `SPEECH_PROVIDER`; metadata records the provider, model and
status. The transcript is shown in the confirmation and the derived task is built
from the transcript, not the placeholder. With a caption, both sources are kept and
the classifier sees caption + transcript (a date that exists only in the transcript
is resolved).

A replay returns "Already saved" with **no** `getFile` call and **no** second
transcription. Concurrent duplicates are gated deterministically with a fake
transcriber: the second delivery joins the first attempt, one `getFile` and one
transcription occur, and only one confirmation is sent. A database trigger forces
the first attempt to fail after transcription; both concurrent callers see the
failure, the claim is released, and a later retry succeeds. Different message ids
transcribe independently, and a direct concurrent `ingestCapture` check proves the
unique `(source, externalId)` constraint still returns one capture.

Disabled STT, provider failure, empty output, duration over the limit, unsupported
mime and a download stopped at the streaming byte cap each store the capture with a
specific reason; caption-only classification still works when the audio fails.
Audio is not written to disk by default; with `STT_RETAIN_AUDIO=true` exactly one
file lands in the configured directory and `mediaRef` points at it. Permanent purge
unlinks that file, undo leaves it in place, a missing file is a no-op, and paths
outside `STT_AUDIO_DIR` (including traversal) are rejected before deletion. Other
filesystem errors roll the purge back.

### AI classification cache

A successful, validated classification is written to the capture and reused by a
reprocess (provider call count stays at one). Relative dates are anchored to the
capture's original `capturedAt`: a provider request and a rules classification
both keep "in two hours", a date-only expression and a clock-time expression on
the same instants after the wall clock advances, including a capture reprocessed
more than 30 days later. The entry is invalidated by a
different model, text, configuration or reference instant. Two captures made at
different times on the same local day get different keys, so the second cannot
inherit a relative time computed for the first. A transient failure writes no
cache and the next attempt calls the provider again; malformed output is rejected
at the service boundary, falls back to rules, and is not cached. Two concurrent
reprocesses of the same capture: the second is refused while the first runs.

### Capture API

Every route is `401` without a session. Ingest is verbatim, idempotent on
`externalId` (second call returns `duplicate: true` and one row), rejects blank text,
and `captureOnly` skips classification. Listing paginates with a real `total`,
filters by kind and free text, rejects an unknown status, and `GET /:id` returns
`404` for an unknown id. The inbox returns only review-flagged captures. Conversion
keeps the raw text and creates the new record; `reprocess` classifies a
`RECEIVED` capture. Undo is reversible and the permanent delete requires
`{"force": true}`, otherwise it answers `400` with `requiresConfirmation`. Converting
a capture whose derived record has since been edited is refused with
`requiresConfirmation` and the affected ids, and only proceeds with `force: true`;
undo applies the same rule so an edited record is never discarded by accident.

### Library API (real app, real database)

Every library route is `401` without a session. A task gets the documented
defaults (`PENDING`, no priority, no deadline, `isOverdue: false`); a blank title is
rejected with `VALIDATION_ERROR`. The state machine is enforced: `PENDING →
IN_PROGRESS → COMPLETED` records `completedAt`; `COMPLETED → IN_PROGRESS` is rejected
with both states named; `COMPLETED → PENDING` (reopen) is allowed and clears
`completedAt`; a completed task cannot be cancelled. Editing a title leaves the task
`PENDING` — discussing work never completes it. Listing filters by status, priority,
open-only, project, tag and free text, sorts, and paginates with a real `total`; an
unknown status filter is a readable `400` rather than an empty list. `/tasks/today`
and `/tasks/overdue` are computed against the owner's local day from the injected
clock, and `/tasks/counts` agrees with them. A create that references a missing
project answers `400` (`A referenced record does not exist`) instead of a `500`,
because Prisma constraint failures are mapped to safe client errors centrally.

Notes, ideas, events and projects are proved distinct: a note keeps its URL, an idea
with no body has `body: null`, an event with no end has `endsAt: null`, and none of
them appears in the task collection. An idea becomes a task only via
`POST /ideas/:id/promote`, the promoted task carries the idea's tags, and the idea
still exists afterwards. A malformed URL is rejected, an event without `startsAt` is
rejected, and `?withUrlOnly=true` returns only linked notes. Deleting a project
detaches its members (`detached: 3`) and leaves the tasks, notes and ideas intact. A
duplicate project name is a `409 CONFLICT`. Tags report a per-kind breakdown, and
`/tags/prune` removes only tags whose joins are already empty.

### Search

One row of every type (task, note, idea, event, project, capture, reminder) that
mentions "boiler" is returned in a single query, and each row states the field it
matched (`matchedOn: ['title', 'description']`) with a snippet containing the match.
Matching is word-based and field-independent: `ada invoice` finds a task titled
"Call Ada" whose description mentions the invoice. Case is ignored. An unmatched
term returns an empty list with `total: 0`, not an error. The snippet is centred on
the match, marks both truncated ends, and collapses newlines. Relevance puts a title
match ahead of a body-only match, and two identical queries return an identical
order (deterministic tie-break by type then id).

Filters narrow the search: a task `status` or `priority` searches tasks only, a
capture `kind` searches captures only, an explicit `types` list restricts to those
types, and `projectId`, `tag`, `from`/`to` (applied to each type's own timestamp) and
`includeDeleted` all apply. An undone capture is excluded unless
`includeDeleted=true`. An unknown type is a `400`, never a silent no-op. Pagination
reports an accurate `total` and pages through the merged result set without repeats,
and the response echoes the effective query so a client can explain it.

### Export and restore

`GET /api/export` returns `schemaVersion: 1`, every table (including the tag join
tables, reminder deliveries and capture relations), a `counts` map that agrees with
the arrays, and the settings row. Two exports of an unchanged database are identical
apart from `exportedAt`.

The round trip is the criterion: a database containing a project, a tagged task with
a reminder and a failed delivery attempt, a note, an idea, an event, two captures and
a capture relation is exported, wiped, and restored. The task comes back with the
same id, priority, deadline, project, capture link and tags; the delivery keeps its
attempt time and error; and a fresh export of the restored database matches the
original bundle (only `settings.updatedAt` differs, because the settings row is
created now). A second restore inserts nothing and reports every row as skipped.
A dry run reports what it *would* insert while writing nothing, and a missing
`dryRun` defaults to the dry run. Identity reuse is proven for both natural keys: a
tag that already exists by name is reused, so the restored task's tag link points at
the existing tag row and no duplicate is created; a capture that already exists by
`(source, externalId)` is reused, so the restored task's `captureId` points at it.
The existing settings row is never overwritten.

Failures are reported, not hidden: a row with no title is listed as
`tasks[0]: missing required column "title"`, the rows that depended on it report
their own foreign-key failures, and everything independent of the broken row still
loads. A bundle from a newer schema version is a `400` naming both versions; a file
that is not a bundle is a `400`; and a table larger than `maxRowsPerTable` is skipped
with an explicit message.

### Telegram library commands (real adapter, real database, fake Bot API)

`/help` advertises exactly the commands that exist. `/tasks` lists open tasks and
hides finished ones until `/tasks all`; an empty list says so plainly. `/today` uses
the owner's local day (a task due at 23:30 Lagos time on the clock's date is "today",
one due the next local day is not). `/overdue` shows only past-due open tasks and
marks them `OVERDUE`. `/search` finds rows across kinds, names the matched field, and
explains its usage when given no words; `/find` is an alias. `/ideas`, `/notes` and
`/projects` list their own entities with their own details (a note's saved link, a
project's open-task count) and never mix an idea into the task list. `/remind`
creates a reminder only when it recognises an explicit time; `/ask` answers from
stored records and lists its sources. A non-owner sending `/tasks` gets the
neutral refusal and creates nothing.

### Ask: `/api/ask` and Telegram `/ask`

The HTTP and Telegram surfaces call the same service, so the tests cover the rules
once at the service/API boundary and again through the Telegram adapter. Evidence
is retrieved before any provider call, the response carries the exact evidence
used, invented citations are dropped, unsupported statements are removed, and a
question with no matching records returns the explicit no-evidence answer. A
provider failure, an absent provider, and `settings.aiEnabled = false` all fall
back to the deterministic cited summary; the disabled case also asserts that the
provider was never called. A prompt-construction test proves that record text and
the question are delimited and labelled as untrusted data, so an instruction
stored in a record is not promoted to a system instruction.

### Daily briefing: API and scheduled delivery

`briefing-service.test.ts` pins section normalisation, owner-zone date resolution
(including invalid and non-existent dates), summaries, and rendered text.
`briefing-api.test.ts` drives the real HTTP routes: configured order, empty
sections, owner-zone "today", completed-task exclusion, disabled delivery still
allowing on-demand reads, and validation of times, sections and bodies.
`briefing-delivery.test.ts` drives the real scheduler with an injectable clock and
a scripted notifier: one delivery per local day, no second delivery after a
restart, quiet-hours deferral, daily-cap deferral, missing-channel deferral,
stale-day skipping, transient retry with backoff, permanent failure, exhausted
attempt budget, interrupted-send recovery, disabled delivery, and configured
sections.

## Failure tests

Deliberately included as first-class cases, not afterthoughts:

| Failure | Test |
| --- | --- |
| Missing environment variables | `config.test.ts` — every required value, per environment |
| Placeholder credentials | `config.test.ts` — placeholder tokens rejected per feature |
| Unsafe provider endpoint | `config.test.ts` — non-HTTP(S), embedded credentials and fragments rejected |
| Spoofed forwarded address | `http-hardening.test.ts` — `X-Forwarded-For` ignored unless `TRUST_PROXY` is set |
| Webhook flood | `http-hardening.test.ts` — 121st request in a minute returns `429`, handler called 120 times |
| Database unavailable | `health-and-auth.test.ts` — degraded report, no crash |
| AI provider timeout / network error | `stt-transcriber.test.ts` and `classification-cache.test.ts` (mocked transport); `retry.test.ts` (policy) |
| Malformed AI output | `classification-cache.test.ts` — rejected at the service boundary, rules used, nothing cached |
| Provider unreachable during capture | `telegram-capture.test.ts` — capture stored, rules used, user told |
| AI failure replay | `classification-cache.test.ts` — failures are not cached; retry asks again |
| Speech provider failure / timeout / empty output | `voice-capture.test.ts`, `stt-transcriber.test.ts` — capture stored, reason reported |
| Voice replay | `voice-capture.test.ts` — no second download or transcription |
| Concurrent voice duplicate | `voice-capture.test.ts` — gated fake proves one download/STT/capture; webhook retries both return 200; failure releases the claim for a retry |
| Cross-message concurrency | `voice-capture.test.ts` — different message ids transcribe in parallel without blocking each other |
| Unsupported / oversized voice | `voice-capture.test.ts` — unsupported/duration cases refused before download; byte-cap download cancelled while streaming; capture kept. `telegram-client.test.ts` asserts early `Content-Length` rejection and no full-body drain. |
| Retained audio cleanup | `voice-capture.test.ts` — purge unlinks inside the storage directory only; undo keeps it; missing files are a no-op; unsafe paths and unexpected filesystem errors roll the purge back |
| Concurrent reprocess | `classification-cache.test.ts` — second request refused |
| Telegram delivery failure | `telegram-notifier.test.ts` — 429 retryable, 4xx permanent, network error never throws |
| Duplicate Telegram updates | `telegram-capture.test.ts` — replay stores one capture |
| Telegram API failure while polling | `telegram-polling.test.ts` — backoff, `retry_after`, bad token stops |
| Webhook left over when switching to polling | `telegram-polling.test.ts` — removed before the first poll (pending updates kept); removed again on a mid-run 409, at most once per window |
| Two copies polling with one token | `telegram-polling.test.ts` — nothing deleted, capped backoff, recovers by itself |
| Network not ready at start-up | `telegram-polling.test.ts` — token check retries, then polling starts |
| Polling down while reminders are due | `telegram-bridge.test.ts` — reminder and briefing still delivered |
| One bad update in a batch | `telegram-polling.test.ts` — the failed update is fetched again and later updates are not acknowledged ahead of it; one that keeps failing (or is invalid) is dead-lettered visibly and the owner is asked to resend |
| Dead-letter notice fails, or a button press is dead-lettered | `telegram-polling.test.ts` — the dead letter stands, the update is acknowledged only after it completes, the failure is logged and counted; a button press gets a notice that never claims the action happened. `telegram-bridge.test.ts` — with the real adapter and a failing capture write: no "Saved" confirmation, no capture row, the owner is told it may not have been saved |
| Briefing send starting after its deadline | `briefing-delivery.test.ts` — the deadline is rechecked on the live clock before sending; a send that started in time but finished after the deadline is delivered; `deliveredAt` is when the send finished |
| Restart with pending reminders | `reminder-scheduler.test.ts` and `briefing-delivery.test.ts` |
| Invalid dates and ambiguous times | `nlp.test.ts`, `rules-classifier.test.ts`, `briefing-service.test.ts`, `briefing-api.test.ts` |
| Unsupported answer claim | `ask-service.test.ts` and `ask-api.test.ts` — statement removed; deterministic fallback |
| Ask with no evidence | `ask-api.test.ts` — explicit no-evidence answer, empty evidence |
| AI disabled or unavailable for ask | `ask-api.test.ts`, `telegram-capture.test.ts` — provider not called; cited deterministic answer |
| Prompt injection in a record or question | `chat-providers.test.ts` — delimited untrusted data and explicit no-follow rule |
| Duplicate briefing delivery | `briefing-delivery.test.ts` — one send per local day, including across a restart |
| Briefing provider failure | `briefing-delivery.test.ts` — bounded retry, permanent failure, interrupted-send recovery |
| Unauthorized user access | `health-and-auth.test.ts`; `telegram-capture.test.ts` (message and callback) |
| Anonymous detail request | `detail-routes.test.ts` — `401` without record content |
| Missing detail record | `detail-routes.test.ts`; `RecordDetails.test.tsx` — non-leaking `404` state |
| Detail link to an unregistered route | `navigation.test.tsx` — every visible row href must match a registered pattern |
| Secret leakage into logs | `auth.test.ts`; webhook secret compared in constant time |
| Destructive delete by mistake | `capture-api.test.ts` — purge refuses without `force` |
| Invalid task state transition | `library-api.test.ts` — rejected with both states named |
| Deleting a project with members | `library-api.test.ts` — members detached, not deleted |
| Dangling foreign key on create | `library-api.test.ts` — `400` via the Prisma error mapping, not a `500` |
| Unknown search type or status filter | `search-api.test.ts`, `library-api.test.ts` — readable `400` |
| Restoring a corrupt bundle | `export-restore.test.ts` — per-row errors, the rest still loads |
| Restoring from a newer version | `export-restore.test.ts` — `400` naming both schema versions |
| Unbounded bulk write | `export-restore.test.ts` — `maxRowsPerTable` stops a runaway table |
| A broken bundle row with dependents | `export-restore.test.ts` — each dependent failure reported |
| Converting or undoing an edited record | `capture-api.test.ts` — refused unless `force: true` |

## Distinguishing mocked from real

- **Real:** every integration test above runs a real Fastify server, real Prisma
  against a real SQLite file, and the real migrations.
- **Real:** the Telegram adapter, its owner gate, idempotency, correction and undo
  paths all run as production code. Only the HTTP transport is faked.
- **Real:** time-zone behaviour uses the platform's IANA database.
- **Injected fakes, no external calls:** the clock (`advanceableClock`), the
  notifier (`recordingNotifier`), `sleep` (`withRetry` and polling), the Telegram
  Bot API (`createFakeTelegram`), the AI provider (`fakeAiProvider`) and the
  transcriber (`fakeTranscriber`). The Whisper transport in
  `stt-transcriber.test.ts` runs the real `OpenAiTranscriber` against a mocked
  `fetch`, so multipart construction and retry policy are production code.
- **Not yet exercised against a live service:** Telegram, any AI provider, any
  speech-to-text provider. No live call has been made and none is claimed. The
  adapter has been verified against the Bot API contract with a fake transport, not
  against api.telegram.org; the speech and language providers likewise have no live
  credential in this environment.

## Decisions forced by tests

1. **`PRAGMA journal_mode = WAL` must use a query, not an execute.** Prisma's
   `$executeRawUnsafe` rejects statements that return rows. Caught by the
   integration setup; fixed in `src/db/client.ts` (this would have broken
   production startup too).
2. **Time-zone validation must use the platform database.** A hand-written regex
   accepted `Mars/Olympus`. Replaced with an `Intl.DateTimeFormat` probe and
   covered by a test.
3. **A `PORT` of `0` is legitimate** (OS-assigned) and is now allowed by the schema.
4. **Certainty is `medium`, not `high`, for a time-only expression** such as "at
   4 PM", because the *day* was implied rather than stated. The implementation was
   right and the test expectation was wrong; the test now asserts `medium` and a
   separate case covers an explicit day *and* time.
5. **Deterministic classification needed an imperative-verb rule.** "Take the bins
   out tomorrow morning" has no explicit task marker but is plainly a task, so
   imperative sentence-opening verbs now contribute to the task score. Plain
   "I should <verb>" was added as a cue as well.
6. **The test-database reset helper used Prisma model names as raw SQL table
   names.** `DELETE FROM "reminderDeliveries"` failed with "no such table" because
   the migration maps to snake_case (`reminder_deliveries`). The helper had never
   been exercised because the first integration file did not reset between tests.
   Fixed by deleting through the typed Prisma delegates in foreign-key order.
7. **A polling stop is immediate, not "after the current batch".** One test expected
   an update in the same batch as a `stop()` to still be handled. The loop's
   behaviour (stop before processing the next item) is the safer reading, so the
   test expectation was corrected, not the loop.
8. **`Saved as a idea` was wrong.** Confirmation wording is user-facing, so the
   article is now chosen from the kind, and `UNKNOWN` says "Saved this:" instead of
   inventing a label.
9. **Classification was not actually atomic.** The documentation claimed one
   transaction; the code wrote the derived records and the capture's classification
   state with separate awaits. Found by review rather than by a failing test, which
   was itself the problem — nothing asserted it. `ingest`, `convert`, `reprocess`,
   `undo` and `purge` now wrap their writes in `withTransaction`, and
   `capture-atomicity.test.ts` injects a real database-level write failure part-way
   through the derivation (after the task row exists) and asserts nothing survives
   and the capture is reprocessable. Without that test the fix would have been
   unverified.
10. **A completed task *can* be reopened.** A test written from the roadmap's
    `PENDING → IN_PROGRESS → COMPLETED` sketch asserted that `COMPLETED → PENDING`
    was rejected. The transition table deliberately allows it (as it allows
    `CANCELLED → PENDING`): a mistaken completion must be undoable. The test was
    wrong, not the table; it now asserts that an invalid transition
    (`COMPLETED → IN_PROGRESS`) is refused, that reopening clears `completedAt`, and
    that a completed task cannot be cancelled.
11. **Sorting tasks by deadline put undated tasks first.** SQLite orders `NULL`
    *before* values in an ascending sort, so "sorted by due date" opened with the
    tasks that have no deadline at all — the opposite of useful for a "what is due"
    list, and precisely the bug a paginated API hides. Prisma cannot express
    `NULLS LAST` on SQLite, so `findTasks` fetches a bounded window and finishes the
    `dueAt`/`priority` ordering in application code, with `null` always last. The
    window cap (500 rows) is documented with the decision.
12. **The export's blanket `orderBy` broke on the tag join tables.** Exports order
    by `createdAt` for stable output, but `capture_tags`, `task_tags`, `note_tags`
    and `idea_tags` have no such column, so the first `GET /api/export` was a `500`.
    The export now orders only by columns that exist. A round-trip test could not
    have passed before this fix.
13. **The shared `searchQuerySchema` is a JSON contract, and query strings are not
    JSON.** `?types=TASK&limit=5` arrived as the strings `"TASK"` and `"5"`, so the
    route validated an array and a number and returned `400` for a valid request.
    The route now coerces the querystring and then validates the result against the
    same shared schema, so a JSON client and a querystring client are held to one
    contract.
14. **`captureOnly` with `forcedKind` silently dropped the user's own statement.**
    `captureOnly` returned before `forcedKind` was ever read. The two are not
    contradictory once separated: `captureOnly` means "do not interpret this" and
    `forcedKind` means "I am telling you what it is", so the explicit kind now wins
    and no classifier runs. Both behaviours are asserted.
15. **A broken export row legitimately produces more than one error.** A test
    expected a single error for a task row with no title; the rows that depended on
    that task (its tag links, the reminder, the delivery) each failed their own
    foreign-key check. Reporting only the first would have hidden the consequences,
    so the test now asserts that every dependent failure is reported *and* that the
    independent tables still load.
16. **Exporting the tag join tables was not optional.** The wire type originally
    omitted them, which would have made a restore silently lose every tag link
    while reporting success — the most dangerous shape a bug can take in a backup
    feature. `ExportBundleDto.data` now includes `captureTags`, `taskTags`,
    `noteTags` and `ideaTags`, and the round-trip test compares them.

## Next testing work (per milestone)

- Milestone 2: **done** — duplicate-update idempotency, non-owner refusal, capture
  stored when the AI provider fails, correction buttons, `/undo` with confirmation,
  webhook secret, voice marker, the capture API, and derivation rollback under an
  injected write failure.
- Milestone 3: **done** — the guarded task state machine (including reopen),
  entity separation and explicit promotion, project detach-not-delete, cross-entity
  search with matched-field reporting, filters and merged pagination, the library
  API, the Telegram library commands, the edited-record conversion/undo guards, and
  a full export → wipe → restore → re-export round trip including identity reuse.
- Milestone 4: **done** — exactly-once delivery, restart recovery, quiet hours deferral, daily
  cap, snooze, recurrence bounds — all with an injected clock. Covered by
  `reminder-scheduler.test.ts` (16), `reminder-api.test.ts` (10), `telegram-reminders.test.ts` (19),
  and `reminder-commands.test.ts` (24) — 69 new tests with an injectable clock, no real sleeps.
- Milestone 5: **done** — the dashboard builds and its API contract is covered by
  the server suite. The real-browser Playwright suite now covers the login,
  navigation, capture/task/reminder/library/search workflows and axe WCAG 2.0/2.1
  A/AA checks in light and dark schemes, plus keyboard, responsive, error-state
  and console/request checks; 71/71 passed on 2026-11-01.
- Milestone 6: **done** — `voice-text.test.ts` (24), `stt-transcriber.test.ts` (9),
  `telegram-client.test.ts` (3), `voice-capture.test.ts` (32) and
  `classification-cache.test.ts` (11): composition, audio guards, bounded streaming
  downloads with early `Content-Length` rejection, multipart transport,
  429/5xx/timeout/empty/non-JSON, transcript provenance and retention, caption
  fallback, concurrent voice-delivery coalescing and failure retry, cache
  reuse/invalidation, capture-time anchoring for duration/date/clock expressions,
  distinct same-day reference instants, uncached failures, malformed output, the
  concurrent-reprocess guard, transcript-overflow handling and retained-audio
  purge cleanup. All providers are mocked or injected; no live call is made.
- Audit follow-up: HTTP boundary hardening is covered by `config.test.ts` (30) and
  `http-hardening.test.ts` (5): provider URL validation, production secret
  validation, opt-in proxy trust, login/global/webhook rate limiting and the `429`
  error mapping.
- Milestone 7: **done** — `ask-service.test.ts`, `ask-api.test.ts`,
  `telegram-capture.test.ts` (`/ask` cases), `chat-providers.test.ts`,
  `briefing-service.test.ts`, `briefing-api.test.ts` and
  `briefing-delivery.test.ts`: citation and claim grounding, explicit
  no-evidence handling, disabled/failed provider fallback, prompt-injection
  delimiting, owner-zone dates (including a DST boundary) and invalid dates,
  configured sections, quiet
  hours, shared daily cap, bounded retries, stale-day skipping, duplicate
  prevention and restart recovery.
 - Milestone 8: **in progress** — `backup-service.test.ts` (6) covers a consistent
   `VACUUM INTO` snapshot, JSON export, standalone restore verification, retention,
   missing-file handling and foreign-key verification. A populated CLI drill against
   a throwaway migrated database also snapshotted, copied and verified a capture and
   task (`integrity ok`, 0 foreign-key violations, 4 migrations, matching rows).
   `docker compose --env-file .env.production config --quiet` passed for the default
   stack and the `backup` profile. The full server suite (590), dashboard suite
   (40) and browser suite (71) pass, and `npm run build:all` succeeds.

   The 2026-11-01 follow-up also verified disposable Prisma migration status and
   added a regression test proving that the JSON companion is exported from the
   verified SQLite snapshot, not from a later live-database state. The Docker daemon
   was unavailable for a new stack run (`failed to connect to the docker API at
   npipe:////./pipe/dockerDesktopLinuxEngine`), and no `.env.production` was
   created. `docker compose --env-file .env.production.example config --quiet`
   therefore stopped with `env file ...\.env.production not found`; a fresh
   compose config check against production variables was not executed.

  A disposable local Docker stack was then built and run with `RECALL_DOMAIN=localhost`,
  generated secrets, and Telegram/AI/STT disabled. `migrate` exited 0 with four
  migrations; `app` reached Docker health `healthy`; `recall-app:latest` was built
  after removing the unused `# syntax=docker/dockerfile:1.7` directive that caused
  BuildKit frontend failures on this host. Caddy served the dashboard and
  `/api/health/live` over HTTPS, redirected plain HTTP with 308, proxied login
  (200), session (200), captures (201) and reminders (201), and did not expose port
  4000 on the host. Dashboard JS/CSS assets returned 200, the `/reminders` SPA
  fallback returned the dashboard, and an unknown `/api/*` path returned 404 JSON.
  Both services use `restart: unless-stopped`; the app has a Docker healthcheck. A
  Caddy container restart returned 200 for the dashboard and health endpoint and
  reused its persisted local CA certificate.
  The `backup` profile reported integrity `ok`, zero foreign-key
  violations, four migrations and matching counts; standalone `verify-backup`
  agreed. The verified snapshot was restored onto the disposable deployment volume
  after stopping `app` and clearing WAL/SHM files; restart preserved health, login
  session, capture and reminder counts.

  A due reminder was deferred as one `PENDING` delivery because the stack had no
  notification channel. A deliberate `docker restart recall-app-1` preserved the
  reminder and its single delivery row and created no duplicate. Actual delivery
  could not be tested without a channel.

  A migration rerun while `app` was live failed with `SQLite database error:
  database is locked`. With `app` stopped, the same `migrate` run exited 0 and
  reported no pending migrations; app health and row counts remained intact after
  restart. This confirms the stop-before-migrate ordering in the restore runbook.

  Browser/accessibility validation was then performed locally on 2026-10-29:
  `npm run test:e2e` passed 17/17 in Edge, including axe WCAG 2.0/2.1 A/AA checks
  on the login screen and six authenticated pages. That run used the production
  dashboard bundle and a disposable database, not the Docker/Caddy stack.

  **Not performed:** a remote always-on host, public DNS/publicly trusted TLS, live
  Telegram/AI/STT calls, real notification delivery and exactly-once delivery with a
  reachable channel, and restore of the owner's production backup. A fresh rebuild
  from the edited repository Dockerfile had not finished its `npm prune` stage when
  this record was written. These remain the M8 acceptance gaps.
