# Recall — Architecture

## 1. Goals and constraints

- **Effortless capture.** One message in Telegram is enough. Capture must never
  depend on the AI provider being reachable.
- **Durable.** The original words are stored before anything is inferred from them.
- **Single owner.** One person, one SQLite file, one process. No microservices, no
  Kubernetes, no vector database, no agent framework.
- **Replaceable boundaries.** AI, speech-to-text and notification delivery are
  interfaces with real implementations plus explicit "unavailable" states.
- **Works offline of any cloud.** With no API keys, capture, classification,
  storage, search and reminders all still function.

## 2. Components

```
                    ┌──────────────────────────┐
   Telegram  ──────▶│  telegram adapter        │──┐
   (polling/webhook)│  (auth, idempotency,     │  │
                    │   command routing)       │  │
                    └──────────────────────────┘  │
                                                  ▼
   Browser  ──────▶ ┌──────────────────────────┐  ┌──────────────────────────┐
   (dashboard)      │  http api (Fastify)      │─▶│  application services    │
                    │  session auth, cors,     │  │  capture, task, library, │
                    │  rate limits, dto mapping│  │  reminder, search,       │
                    └──────────────────────────┘  │  export, recall, briefing│
                                                  └───────┬──────────┬───────┘
                                                          │          │
                       ┌──────────────────────────────────┘          │
                       ▼                                             ▼
            ┌──────────────────────┐                    ┌────────────────────────┐
            │  providers (ports)   │                    │  data access (Prisma)  │
            │  ai | stt | notifier │                    │  SQLite, transactions  │
            └──────────┬───────────┘                    └───────────┬────────────┘
                       │                                            │
              ┌────────┴─────────┐                        ┌─────────┴─────────┐
              │ external         │                        │ recall.db (WAL)   │
              │ providers        │                        └───────────────────┘
              │ (optional)       │
              └──────────────────┘

            ┌──────────────────────────────────────────────────────────────┐
            │  scheduler: DB-backed tick loop -> reminder service ->        │
            │  notifier, with ReminderDelivery rows for every attempt       │
            └──────────────────────────────────────────────────────────────┘
```

### Layers

| Layer | Location | Responsibility |
| --- | --- | --- |
| Contracts | `packages/shared` | Zod schemas + DTO types. Single source of truth for vocabulary, validated on both sides. |
| Adapters | `src/telegram`, `src/http`, `src/ai`, `src/stt` | Translate an external protocol into a service call. No business rules. |
| Services | `src/services` | Business rules, transactions, state transitions. |
| Data access | `src/db`, `src/mappers.ts` | Prisma client, pragmas, transactions, row→DTO mapping. No business rules. |
| Infrastructure | `src/lib` | Time/zone maths, NLP date extraction, retry, text helpers, errors, logging. |
| Composition | `src/context.ts`, `src/index.ts` | Build the dependency bag, boot in a fixed order, shut down cleanly. |

The dependency rule is one-directional: adapters → services → data access →
infrastructure. Services never import Fastify or Telegram types.

## 3. Request and data flows

### Capture (Milestone 2 target)

1. Telegram delivers an update (poll or webhook, `secret_token` verified).
2. Adapter checks the sender id against `TELEGRAM_OWNER_IDS`. Not the owner → a
   neutral refusal, nothing written, no information about stored data.
3. The adapter builds a **stable external id** `telegram:<chatId>:<messageId>`.
4. `captureService.ingest` runs in a single transaction:
   - insert `Capture` (raw text verbatim, `source`, `externalId`, `capturedAt`);
   - the `(source, externalId)` unique constraint makes a replay fail cleanly and
     return the *existing* capture instead of duplicating it.
5. Classification runs **after** the capture is committed, via the rules
   classifier or the configured AI provider (validated against
   `classifyCaptureSchema`).
6. The structured record (task/note/idea/event) is written in a second
   transaction together with the capture's `kind`, `confidence`, tags and
   `status`. If this step fails, the capture stays with `status = RECEIVED` and is
   retried — the user's words are never lost.
7. The adapter replies with a confirmation that states what Recall understood.

**Invariant:** the capture row is never rewritten by classification. Editing a
task changes the task; it never changes what the user originally sent.

### Search (Milestone 3)

1. The query is validated against the shared `searchQuerySchema`; a type-specific
   filter implies its type (`status`/`priority` → tasks, `kind` → captures), and a
   `types` list narrows to those types.
2. The query is split into words. Every word must appear in one of the type's
   searched fields, but not necessarily in the same field; the SQL (`AND` of `OR`s)
   and the in-application `matchedOn` computation apply the same rule, so a result
   can never claim a match the database did not agree with.
3. Each type is fetched into a bounded window and the windows are merged and sorted
   once, so `limit`/`offset` paginate a single deterministic order. `total` comes
   from real `count` queries, so it is accurate even beyond the window.
4. A result carries `matchedOn` (the fields that matched) and a `snippet` centred on
   the match, so the UI can explain it rather than guess.

### Export and restore (Milestone 3)

1. `GET /api/export` reads every table into a versioned bundle (`schemaVersion`) and
   reports the row counts. The bundle is the backup format; it is deliberately plain
   JSON so it can be read without Recall.
2. `POST /api/restore` validates the bundle, rejects a newer `schemaVersion`, and
   walks tables parent-first. Each row is matched against the database by primary
   key and then by natural identity (tag name, `(source, externalId)`,
   reminder `occurrenceKey`); an existing row is skipped and its id mapped, so links
   that follow point at the row that actually exists.
3. Nothing is deleted, updated or overwritten, and the default is a **dry run**.
   A row that cannot be written is reported with its table and id; the rest still
   loads, and re-running after a fix is safe.

### Reminder delivery (Milestone 4 target)

1. `Reminder` rows are the schedule. The scheduler polls them; nothing lives only
   in memory.
2. Each tick claims due reminders by creating a `ReminderDelivery` row whose
   `idempotencyKey` is unique (`<reminderId>:<scheduledForIso>:<attempt>`), which
   makes a double send impossible even with two processes.
3. Delivery attempts record the outcome. Failures retry with bounded exponential
   backoff up to `REMINDER_MAX_ATTEMPTS`.
4. Quiet hours defer to the end of the window; the daily cap defers to the next day.
5. On startup, missed reminders inside `REMINDER_OVERDUE_GRACE_HOURS` fire once;
   older ones are marked `MISSED` so a returning user is not flooded.

## 4. Data model

All timestamps are UTC `DateTime` columns. Enum-like columns are `String` because
SQLite has no native enums; the allowed values live in `packages/shared/src/enums.ts`
and are enforced by Zod on every write path.

| Entity | Purpose | Key relationships |
| --- | --- | --- |
| `UserSettings` | Singleton owner preferences (zone, quiet hours, briefing, caps). | `id = "singleton"` |
| `Capture` | The literal record of what was sent. Never rewritten. | `1—N` Task/Note/Idea/Event/Reminder, `N—N` Tag via `CaptureTag` |
| `Task` | Something to do. | `N—1` Project, `N—1` Capture, `1—N` Reminder |
| `Note` | Information or a saved reference (optional `url`). | `N—1` Project, `N—1` Capture |
| `Idea` | A thought to keep. Explicitly not an obligation. | `N—1` Project, `N—1` Capture |
| `Event` | A scheduled happening (`startsAt`, optional `endsAt`). | `N—1` Project, `N—1` Capture |
| `Project` | Groups tasks, ideas, notes and events. | `1—N` the four above |
| `Tag` + `CaptureTag`/`TaskTag`/`NoteTag`/`IdeaTag` | Free-form labels. | `N—N` |
| `CaptureRelation` | Links captures to each other (`DUPLICATE_OF`, `RELATED_TO`, `FOLLOW_UP_OF`). | self-referencing |
| `Reminder` | One scheduled occurrence, with optional recurrence and series parent. | `N—1` Task/Capture, `1—N` ReminderDelivery |
| `ReminderDelivery` | One delivery attempt, uniquely keyed to prevent duplicates. | `N—1` Reminder |

**Deletion rules.** Deleting a `Capture` sets the `captureId` of derived records to
`NULL` (`SetNull`), so history survives. Deleting a `Project` nulls the `projectId`
on its members rather than destroying them. Tag joins and delivery attempts cascade,
because a join row or an attempt record has no meaning without its parent.

**Indexes** exist for the access patterns that matter: due reminders
(`status, remindAt`), open tasks by due date (`status, dueAt`), the capture inbox
(`status, createdAt`), search by kind, dedupe by `dedupeHash`, and tag lookups.

**Transactions.** Saving a capture and its derived records happens in a
transaction (`withTransaction`, bounded timeouts). A partial write would mean
"the user's note exists but its task does not", which is worse than retrying.

## 5. Decisions

| # | Decision | Rationale |
| --- | --- | --- |
| D1 | npm workspaces, not a single package | The dashboard and API genuinely share contracts; a `packages/shared` boundary keeps Zod schemas authoritative on both sides without a build tool. |
| D2 | SQLite + Prisma | Single owner, no ops burden, real migrations, a clear path to Postgres later (the schema is already normalised and uses no SQLite-only features except the absence of enums). |
| D3 | Enum columns as validated strings | SQLite has no enums. Zod at the boundary plus TypeScript unions at compile time gives the same safety without a Postgres dependency. |
| D4 | UTC storage, zone only for interpretation/display | An unambiguous instant on disk; the owner's zone is applied exactly where it matters — parsing "tomorrow" and formatting a reminder. |
| D5 | Date-only deadlines resolve to the **end** of the named local day | "Finish the docs tomorrow" must not become overdue at 00:01. Recorded here so display code can render it as date-only. |
| D6 | A reminder is created only when the user asked for one | Tasks already carry `dueAt`. Auto-creating reminders for every task with a date would produce notification spam, which the brief explicitly forbids. |
| D7 | Rules classifier is the baseline, AI is an upgrade | Satisfies "must work without an AI provider" and provides the fallback when a provider fails or returns junk. |
| D8 | Classification runs after the capture is committed | A provider outage can never lose the user's words. |
| D9 | Temporal-anchor allow-list before trusting chrono | `chrono-node` will happily read "may" and "march" as months and "sat"/"wed" as weekdays. False deadlines are worse than a missed parse, so ambiguous words are excluded and the omission is documented. |
| D10 | Vague times use configured defaults and are reported back | "tomorrow morning" has no defined hour; the owner's `DEFAULT_MORNING_TIME` is applied *and* stated in the confirmation, so a wrong assumption is visible rather than silent. |
| D11 | Session cookie signed with HMAC-SHA256, not JWT | No dependency, no algorithm confusion, constant-time verification, and an opaque token that does not carry data the client could tamper with. |
| D12 | Provider factories return `null` when unconfigured | Callers must explicitly take the degraded path. There is no object pretending to work. |
| D13 | Injectable `Clock` everywhere | Reminder and briefing timing is the riskiest logic in the product; it must be testable without sleeping. |
| D14 | `ReminderDelivery.idempotencyKey` is unique | The only reliable way to guarantee exactly-once delivery across restarts and concurrent ticks. |
| D15 | Structured JSON logs with a redaction allow-list | Debuggable in production without ever writing a private thought or a token to disk. |
| D16 | Tests copy a migrated template database | Exercises the real migrations while keeping each test file fast and isolated. |
| D17 | No FTS5 or vector search yet | SQLite `LIKE`-based search over a personal dataset is fast and predictable. Full-text or semantic search is deferred until a real retrieval need is demonstrated (backlog item). |
| D18 | A failed reply is logged, never thrown | The capture is already committed. Turning a Telegram send failure into an exception would either lose the acknowledgement or trigger a retry that produces a confusing "Already saved" instead of the real confirmation. The capture matters more than the reply. |
| D19 | Polling offset lives in memory | No new table for one integer. A restart re-fetches recent updates, and `(source, externalId)` idempotency makes the replay a no-op. Documented as a known limitation rather than hidden. |
| D20 | `edited_message` is ignored | `rawText` is the immutable record of what the user said. Accepting edits would silently rewrite history and invalidate derived records. A correction is an explicit action with its own record of who changed what. |
| D21 | Voice is stored with a marker, not transcribed early | The brief requires voice to be accepted in Milestone 2 but real transcription in Milestone 6. A placeholder row with provenance metadata and `NEEDS_REVIEW` preserves the message without pretending to understand it. |
| D22 | Unsupported media is acknowledged, not stored | A sticker has no text to keep. Silently dropping it looks like a bug; a short note explains the limitation. |
| D23 | Commands from later milestones answer "not yet" | `/tasks` can exist in the UI as a plan without being a working feature. Pretending otherwise (or silently ignoring the command) would break the "no decorative buttons" rule. |
| D24 | The webhook secret is compared with `timingSafeEqual` | A plain string comparison leaks length and prefix timing. The hook is public by necessity, so it is the one place that needs this care. |
| D25 | Undo is soft; purge is explicit | `undo` sets `deletedAt` and keeps the audit trail; permanent deletion requires `{"force": true}`. Destructive actions should need a deliberate second intent. |
| D26 | The capture and its derivation are two transactions, not one | Committing the capture first means a provider outage cannot lose the user's words (D8), and the second transaction keeps the derived records and the capture's classification state consistent. The alternative — one transaction — would roll the raw text back on a classification failure, which is the one thing that must never happen. The second transaction's rollback is proven by an injected write failure (`capture-atomicity.test.ts`). |
| D27 | No fallback between polling and webhook mode | A deployment that silently switches transports hides a misconfiguration and can double-deliver. The mode is explicit and startup fails if its requirements are unmet. |
| D28 | Search is `LIKE` over a bounded window, not full-text | A personal database is small, and `LIKE` needs no schema, no index maintenance and no tokenizer to explain itself. The per-type window (`SEARCH_WINDOW_CAP = 200`) bounds the work; `total` is still exact because it comes from `count`. Honest limits beat a half-configured FTS table. Replacing this with SQLite FTS5 is a backlog item, and `search-service.ts` is the only module that would change. |
| D29 | Restore is additive, dry-run by default, and reports every row it cannot write | A backup feature that can destroy the live database is worse than none. Restore never deletes or overwrites, so a mistaken call is survivable; the dry run is the default because bulk writes should be asked for. Identity reuse (tag name, `(source, externalId)`, `occurrenceKey`) makes a restore onto a partly-populated database correct instead of conflicting, and rows are written one at a time so one bad row cannot take the transaction with it — the cost is a truthful `errors` list the caller must read. |
| D30 | `dueAt`/`priority` sorts finish in application code over a bounded window | SQLite sorts `NULL` first on ascending and Prisma cannot express `NULLS LAST`, so an undated task would head a "what is due" list. Rather than pretend, the window is capped (500 rows) and the cap is documented. |
| D31 | The export bundle includes the tag join tables | A bundle without them would restore every entity and silently drop every tag link while reporting success. `schemaVersion` guards the contract so a future change is detectable rather than assumed. |

## 6. Extension points

- **New AI provider:** implement `AiProvider` in `src/ai`, add it to the factory.
  Nothing else changes.
- **New capture channel** (CLI, email, web form): build a `CaptureInput` and call
  `captureService`. The Telegram adapter is not special.
- **New notification channel:** implement `Notifier` (`src/ports.ts`).
- **New structured type:** add the Prisma model, a Zod schema in
  `packages/shared`, a DTO and a mapper. Capture-to-record linking is generic.
- **Database migration:** `npm run db:migrate` creates versioned SQL; production
  applies it with `npm run db:deploy`. The production database is never recreated
  to apply a schema change.
