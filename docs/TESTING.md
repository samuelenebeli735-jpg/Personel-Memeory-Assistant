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
│   ├── telegram-polling.test.ts    offset, backoff, stop, bad token, bad update
│   └── library-format.test.ts      snippets, search type resolution, list formatting
└── integration/
    ├── health-and-auth.test.ts     HTTP authorization, health, settings persistence
    ├── telegram-capture.test.ts    owner gate, idempotency, correction, undo, webhook
    ├── capture-api.test.ts         ingest, pagination, filters, convert, undo, purge
    ├── capture-atomicity.test.ts   injected write failure rolls the derivation back
    ├── library-api.test.ts         task rules, entity separation, projects, tags
    ├── search-api.test.ts          cross-entity matching, filters, pagination
    ├── telegram-library.test.ts    /tasks, /today, /overdue, /search, /ideas, /notes, /projects
    └── export-restore.test.ts      bundle shape, round trip, dry run, identity reuse
```

### How the database tests work

`globalSetup` runs the **real** `prisma migrate deploy` once against a template
file in the OS temp directory. Each integration test file then copies that file,
so tests exercise the actual version-controlled migrations while staying fast and
independent. The template is rebuilt on every run, so a schema change cannot be
silently ignored.

## Current results

Executed 2026-10-18 on Node v24.17.0, npm 11.13.0, Windows (win32):

```
 Test Files  18 passed (18)
      Tests  292 passed (292)
   Duration  37.81s
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
| `unit/library-format.test.ts` | 24 | passed |
| `integration/health-and-auth.test.ts` | 17 | passed |
| `integration/telegram-capture.test.ts` | 28 | passed |
| `integration/capture-api.test.ts` | 17 | passed |
| `integration/capture-atomicity.test.ts` | 3 | passed |
| `integration/library-api.test.ts` | 22 | passed |
| `integration/search-api.test.ts` | 18 | passed |
| `integration/telegram-library.test.ts` | 15 | passed |
| `integration/export-restore.test.ts` | 13 | passed |
| **Total** | **292** | **all passed** |

`npm run typecheck` (shared + server, `--strict`, `noUncheckedIndexedAccess`)
passes with no errors. `npm run build` (shared + server) also passes.

`export-restore.test.ts` is the slowest file (~25s): each case seeds a database,
exports it, wipes it and restores it row by row through real Prisma calls. That is
the cost of testing restore against real constraints rather than a mock, and it is
kept because restore is the one operation that can bulk-write.

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
project's open-task count) and never mix an idea into the task list. `/remind` and
`/ask` still answer with the milestone that will bring them, and a non-owner sending
`/tasks` gets the neutral refusal and creates nothing.

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
- Milestone 4: exactly-once delivery, restart recovery, quiet hours deferral, daily
  cap, snooze, recurrence bounds — all with an injected clock.
- Milestone 5: dashboard interaction tests proving every visible control acts.
- Milestone 6: mocked-provider tests for timeout, 429, malformed JSON, empty
  response, unsupported model and missing credentials.
- Milestone 7: grounded-answer assertions, including an explicit no-evidence case.
- Milestone 8: end-to-end acceptance run against a production-shaped configuration,
  including a deliberate restart with pending reminders and a restore from backup.
