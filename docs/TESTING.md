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
npm test                                        # everything
npm run test --workspace @recall/server -- --project unit
npm run test:unit --workspace @recall/server     # in a shell inside apps/server
npm run test:integration --workspace @recall/server
npm run verify                                   # typecheck + tests (run before committing)
```

Inside `apps/server`:

```bash
npx vitest run tests/unit/time.test.ts           # a single file
npx vitest                                       # watch mode
npx vitest run --coverage                        # with coverage
```

## Layout

```
apps/server/tests/
├── helpers/
│   ├── global-setup.ts   builds a migrated template SQLite database once
│   ├── db.ts             copies the template into an isolated database per file
│   ├── app.ts            test configuration, context, logger, notifier, HTTP app
│   └── telegram.ts       fake Bot API, update builders, adapter factory
├── unit/
│   ├── config.test.ts              environment schema, hardening, failure messages
│   ├── time.test.ts                zone conversion, DST, local days, quiet hours
│   ├── nlp.test.ts                 natural-language dates, ambiguity guards, recurrence
│   ├── rules-classifier.test.ts    deterministic classification and extraction
│   ├── retry.test.ts               backoff, caps, jitter, retry policy
│   ├── auth.test.ts                session signing, tampering, expiry, log redaction
│   ├── telegram-format.test.ts     commands, confirmations, keyboards, callback data
│   ├── telegram-notifier.test.ts   proactive delivery, failure classification
│   └── telegram-polling.test.ts    offset, backoff, stop, bad token, bad update
└── integration/
    ├── health-and-auth.test.ts     HTTP authorization, health, settings persistence
    ├── telegram-capture.test.ts    owner gate, idempotency, correction, undo, webhook
    ├── capture-api.test.ts         ingest, pagination, filters, convert, undo, purge
    └── capture-atomicity.test.ts   injected write failure rolls the derivation back
```

### How the database tests work

`globalSetup` runs the **real** `prisma migrate deploy` once against a template
file in the OS temp directory. Each integration test file then copies that file,
so tests exercise the actual version-controlled migrations while staying fast and
independent. The template is rebuilt on every run, so a schema change cannot be
silently ignored.

## Current results

Executed 2026-10-17 on Node v24.17.0, npm 11.13.0, Windows (win32):

```
 Test Files  13 passed (13)
      Tests  196 passed (196)
   Duration  14.14s
```

| Suite | Tests | Result |
| --- | --- | --- |
| `unit/config.test.ts` | 23 | passed |
| `unit/time.test.ts` | 16 | passed |
| `unit/nlp.test.ts` | 19 | passed |
| `unit/rules-classifier.test.ts` | 20 | passed |
| `unit/retry.test.ts` | 8 | passed |
| `unit/auth.test.ts` | 14 | passed |
| `unit/telegram-format.test.ts` | 21 | passed |
| `unit/telegram-notifier.test.ts` | 8 | passed |
| `unit/telegram-polling.test.ts` | 6 | passed |
| `integration/health-and-auth.test.ts` | 17 | passed |
| `integration/telegram-capture.test.ts` | 27 | passed |
| `integration/capture-api.test.ts` | 14 | passed |
| `integration/capture-atomicity.test.ts` | 3 | passed |
| **Total** | **196** | **all passed** |

`npm run typecheck` (shared + server, `--strict`, `noUncheckedIndexedAccess`)
passes with no errors. `npm run build` (shared + server) also passes.

The CLI was exercised against a throwaway migrated database (not the owner's):
`doctor` reported the real configuration, `capture` stored a task with the correct
local time, and `inbox` read it back.

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
the loop; each retry is reported through `onRetry`.

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
Stickers/documents/photos are acknowledged and ignored. A voice message is stored
with the `[voice message — not transcribed yet]` marker, `UNKNOWN` +
`NEEDS_REVIEW`, provenance metadata, and no fabricated task; a caption is used as
its text. A message with no text asks for words. `/help`, `/inbox`, `/undo`,
`/settings` and unknown commands all answer without creating a capture; a planned
command says which milestone will bring it.

Correction buttons convert a capture's kind, keep `rawText`, and replace the derived
record. `/undo` shows a confirmation and deletes nothing until `U:` is pressed; `K:`
keeps everything; a confirmed undo soft-deletes the capture and removes its records.
Webhook mode rejects a wrong secret (401) and a malformed body (400), accepts a
correctly signed update, refuses to run with no secret (503), and still returns 200
for a non-owner so Telegram does not retry forever.

Reminders are created only when the user asked; a plain deadline produces none.

### Capture API

Every route is `401` without a session. Ingest is verbatim, idempotent on
`externalId` (second call returns `duplicate: true` and one row), rejects blank text,
and `captureOnly` skips classification. Listing paginates with a real `total`,
filters by kind and free text, rejects an unknown status, and `GET /:id` returns
`404` for an unknown id. The inbox returns only review-flagged captures. Conversion
keeps the raw text and creates the new record; `reprocess` classifies a
`RECEIVED` capture. Undo is reversible and the permanent delete requires
`{"force": true}`, otherwise it answers `400` with `requiresConfirmation`.

## Failure tests

Deliberately included as first-class cases, not afterthoughts:

| Failure | Test |
| --- | --- |
| Missing environment variables | `config.test.ts` — every required value, per environment |
| Placeholder credentials | `config.test.ts` — placeholder tokens rejected per feature |
| Database unavailable | `health-and-auth.test.ts` — degraded report, no crash |
| AI provider timeout / network error | `retry.test.ts` (policy); live provider in Milestone 6 |
| Malformed AI output | `parseClassification` unit tests in Milestone 6 |
| Provider unreachable during capture | `telegram-capture.test.ts` — capture stored, rules used, user told |
| Telegram delivery failure | `telegram-notifier.test.ts` — 429 retryable, 4xx permanent, network error never throws |
| Duplicate Telegram updates | `telegram-capture.test.ts` — replay stores one capture |
| Telegram API failure while polling | `telegram-polling.test.ts` — backoff, `retry_after`, bad token stops |
| One bad update in a batch | `telegram-polling.test.ts` — loop continues, offset advances |
| Restart with pending reminders | Milestone 4 |
| Invalid dates and ambiguous times | `nlp.test.ts`, `rules-classifier.test.ts` |
| Unauthorized user access | `health-and-auth.test.ts`; `telegram-capture.test.ts` (message and callback) |
| Secret leakage into logs | `auth.test.ts`; webhook secret compared in constant time |
| Destructive delete by mistake | `capture-api.test.ts` — purge refuses without `force` |
| Converting an edited record | service guard, covered with Milestone 3 service tests |

## Distinguishing mocked from real

- **Real:** every integration test above runs a real Fastify server, real Prisma
  against a real SQLite file, and the real migrations.
- **Real:** the Telegram adapter, its owner gate, idempotency, correction and undo
  paths all run as production code. Only the HTTP transport is faked.
- **Real:** time-zone behaviour uses the platform's IANA database.
- **Injected fakes, no external calls:** the clock (`advanceableClock`), the
  notifier (`recordingNotifier`), `sleep` (`withRetry` and polling), the Telegram
  Bot API (`createFakeTelegram`), and the AI provider in the outage test.
- **Not yet exercised against a live service:** Telegram, any AI provider, any
  speech-to-text provider. No live call has been made and none is claimed. The
  adapter has been verified against the Bot API contract with a fake transport, not
  against api.telegram.org.

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

## Next testing work (per milestone)

- Milestone 2: **done** — duplicate-update idempotency, non-owner refusal, capture
  stored when the AI provider fails, correction buttons, `/undo` with confirmation,
  webhook secret, voice marker, the capture API, and derivation rollback under an
  injected write failure.
- Milestone 3: state-transition enforcement, relationship persistence, search
  filtering and pagination, export/restore round-trip.
- Milestone 4: exactly-once delivery, restart recovery, quiet hours deferral, daily
  cap, snooze, recurrence bounds — all with an injected clock.
- Milestone 5: dashboard interaction tests proving every visible control acts.
- Milestone 6: mocked-provider tests for timeout, 429, malformed JSON, empty
  response, unsupported model and missing credentials.
- Milestone 7: grounded-answer assertions, including an explicit no-evidence case.
- Milestone 8: end-to-end acceptance run against a production-shaped configuration,
  including a deliberate restart with pending reminders and a restore from backup.
