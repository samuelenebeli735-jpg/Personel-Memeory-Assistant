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
│   └── app.ts            test configuration, context, logger, notifier, HTTP app
├── unit/
│   ├── config.test.ts            environment schema, hardening, failure messages
│   ├── time.test.ts              zone conversion, DST, local days, quiet hours
│   ├── nlp.test.ts                natural-language dates, ambiguity guards, recurrence
│   ├── rules-classifier.test.ts   deterministic classification and extraction
│   ├── retry.test.ts              backoff, caps, jitter, retry policy
│   └── auth.test.ts               session signing, tampering, expiry, log redaction
└── integration/
    └── health-and-auth.test.ts    HTTP authorization, health, settings persistence
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
 Test Files  7 passed (7)
      Tests  117 passed (117)
   Duration  11.03s
```

| Suite | Tests | Result |
| --- | --- | --- |
| `unit/config.test.ts` | 23 | passed |
| `unit/time.test.ts` | 16 | passed |
| `unit/nlp.test.ts` | 19 | passed |
| `unit/rules-classifier.test.ts` | 20 | passed |
| `unit/retry.test.ts` | 8 | passed |
| `unit/auth.test.ts` | 14 | passed |
| `integration/health-and-auth.test.ts` | 17 | passed |
| **Total** | **117** | **all passed** |

`npm run typecheck` (shared + server, `--strict`, `noUncheckedIndexedAccess`)
passes with no errors.

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

## Failure tests

Deliberately included as first-class cases, not afterthoughts:

| Failure | Test |
| --- | --- |
| Missing environment variables | `config.test.ts` — every required value, per environment |
| Placeholder credentials | `config.test.ts` — placeholder tokens rejected per feature |
| Database unavailable | `health-and-auth.test.ts` — degraded report, no crash |
| AI provider timeout / network error | `retry.test.ts` (policy) + provider unit tests in Milestone 6 |
| Malformed AI output | `parseClassification` unit tests in Milestone 6 |
| Provider unreachable during capture | Milestone 2 acceptance criterion |
| Telegram delivery failure | Milestone 4 |
| Duplicate Telegram updates | Milestone 2 |
| Restart with pending reminders | Milestone 4 |
| Invalid dates and ambiguous times | `nlp.test.ts`, `rules-classifier.test.ts` |
| Unauthorized user access | `health-and-auth.test.ts`; Telegram case in Milestone 2 |
| Secret leakage into logs | `auth.test.ts` |

## Distinguishing mocked from real

- **Real:** every integration test above runs a real Fastify server, real Prisma
  against a real SQLite file, and the real migrations.
- **Real:** time-zone behaviour uses the platform's IANA database.
- **Injected fakes, no external calls:** the clock (`advanceableClock`), the
  notifier (`recordingNotifier`) and `sleep` (`withRetry`).
- **Not yet exercised against a live service:** Telegram, any AI provider, any
  speech-to-text provider. These are implemented behind interfaces with injected
  `fetch` for testing; **no live call has been made and none is claimed.**

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

## Next testing work (per milestone)

- Milestone 2: duplicate-update idempotency, non-owner refusal, capture stored when
  the AI provider fails, `/undo` with confirmation.
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
