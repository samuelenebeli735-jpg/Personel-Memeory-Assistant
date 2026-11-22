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

### Voice capture (Milestone 6)

1. The adapter claims `telegram:<chatId>:<messageId>` in an adapter-scoped
   in-flight promise map before any Bot API or provider work. A concurrent
   delivery of the same message joins that promise, so it cannot start a second
   download, transcription or confirmation. The claim is removed when the attempt
   settles, whether it succeeds or fails, so a later retry starts cleanly. This is
   process-local only; it is not a distributed lock. The persistent
   `(source, externalId)` unique constraint remains the final safeguard.
2. The adapter looks the capture up by `(source, externalId)`. A replayed update is
   answered from the stored row — no Bot API call, download or provider call. Only
   a genuinely new update continues.
3. The clip is rejected before download when it exceeds `STT_MAX_AUDIO_SECONDS` or
   its mime type is unsupported. With no transcriber configured the capture is
   still stored, marked `NEEDS_REVIEW`.
4. The file is downloaded through a bounded stream. A declared `Content-Length`
   over `STT_MAX_AUDIO_BYTES` is rejected before the body is read; otherwise each
   chunk is counted and reading is cancelled as soon as the cap is exceeded. The
   bounded bytes are then held in memory for transcription and are written to
   `STT_AUDIO_DIR` only when `STT_RETAIN_AUDIO=true`, with the path stored in
   `mediaRef`. Permanent purge unlinks that file; undo does not, because the
   capture row is retained as a reversible soft delete.
5. The capture is stored **before** classification, exactly as for text:
   `rawText` is the caption (surrounding whitespace trimmed, or
   `VOICE_PLACEHOLDER` when there is none), `transcript` holds the accepted speech
   output, and `transcriptSource` is `SPEECH_PROVIDER`. Provider/model/status live
   in the capture metadata. Provider output over `TRANSCRIPT_MAX_CHARS` (8,000) is
   rejected, not truncated: the capture keeps the caption or placeholder,
   `transcript`/`transcriptSource` stay `null`, metadata status is
   `transcript-too-long`, and the reply reports the limit.
6. Classification reads `composeVoiceText(caption, transcript)`: the caption first,
   then the transcript, with identical or contained content collapsed. A transcript
   is never treated as user-typed text and is never merged into `rawText`.
7. Any transcription failure degrades in place: the capture and its voice metadata
   are stored, the reply names the reason, and nothing is invented from the
   placeholder.

### AI classification and caching (Milestone 6)

1. Classification runs only when `ctx.ai` exists **and** `settings.aiEnabled` is
   true. Otherwise the deterministic rules classifier runs and no provider is
   called.
2. Provider output is validated against `classifyCaptureSchema` at the service
   boundary even though the transport already validates it, then sanitised
   (bounded confidence, no invented dates, `needsReview` for uncertain shapes).
3. A successful, validated result is stored on the capture (`classificationCache`)
   under a key built from: explicit cache version, exact text, hint kind, time
   zone, morning/evening defaults, sorted known projects, provider name, model and
   the **exact reference instant**.
4. Relative dates are resolved against the capture's original `capturedAt`, not
   the processing clock. "Remind me in two hours" therefore keeps the same
   deadline when the capture is reprocessed later, and the cache remains useful
   without becoming stale. The exact reference instant keeps the key deterministic
   for a stored capture and prevents same-day collisions for any caller that ever
   supplies a moving reference. A cache hit is sanitised again against the same
   reference before use, and the 30-day/5-year plausibility bounds use that
   reference too, so an older capture does not lose a valid deadline on reprocess.
5. Failures, timeouts, malformed output and unsupported types are never cached.
   The next attempt asks the provider again.
6. Reprocessing the same capture concurrently in one process is refused
   (`reprocessing` claim set), so two requests cannot write two sets of derived
   records.

### Ask and briefings (Milestone 7)

1. `ask-service.ts` is the single answer path for `POST /api/ask` and Telegram
   `/ask`. It retrieves candidates through the existing search service first,
   replaces each search excerpt with the record's own text, and returns that
   evidence with the answer.
2. Search matches a record only when *every* query word appears in it, so a
   natural question ("what did I say about tiles") would find nothing. The ask
   service therefore drops the question's filler words and, when the strict
   query still matches nothing, retries with the individual content words. The
   strict query always wins when it matches, so a record that matches every
   content word beats a looser match. The search engine itself is unchanged.
3. A provider answer is accepted only when every cited id is in the evidence and
   every statement is supported by the cited records' words and numbers.
   Unsupported statements are removed; if none survive, the deterministic
   summary is returned. The deterministic summary is also the answer when AI is
   absent, disabled (`settings.aiEnabled = false`), fails, or finds no records.
4. Prompt construction delimits the records and the question and labels both as
   untrusted data. Text such as "ignore previous instructions" inside a record is
   data; it is never appended as a sibling instruction.
5. `briefing-service.ts` is the single briefing implementation for the HTTP
   routes and scheduled delivery. It resolves the reference day in the owner's
   IANA zone, returns configured sections in order, and reports empty sections
   instead of inventing content. The `upcoming` window is seven local days, so a
   DST transition cannot move its boundary by an hour.
6. `briefing-delivery.ts` rides the reminder scheduler's one tick. A
   `briefing_deliveries` row is the durable occurrence; its unique
   idempotency key (`<localDate>:<attempt>`) prevents a duplicate send across
   ticks or processes. Quiet hours and the shared daily cap defer an attempt;
   transient failures retry with backoff, permanent failures stop, a stale day is
   skipped, and startup recovery re-queues a send interrupted mid-flight.
7. The scheduler's daily cap counts both delivered reminders and delivered
   briefings, because both consume the same notification budget the owner set.

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

### Deployment and backup (Milestone 8)

1. The production image is built in stages: workspace install, `build:all`, a
   pruned runtime copy, and a separate Caddy stage containing the static
   dashboard. The server container is never published to the host; Caddy is the
   only public process.
2. `compose.yaml` applies migrations with a one-shot service before starting the
   app, keeps SQLite on a named volume and uses restart-on-failure plus a
   `/api/health/live` healthcheck. A normal app restart cannot race a schema
   change.
3. `backup-service.ts` uses SQLite `VACUUM INTO` for a consistent snapshot while
   the service is running, exports the JSON companion from that verified snapshot
   so concurrent live writes cannot make the pair describe different points in
   time, verifies integrity, foreign keys, migration state and row counts, and
   prunes only timestamped managed files. A snapshot is self-contained; stale
   `-wal`/`-shm` files are removed if it is restored over a live database.
4. Deployment and restore procedures live in `docs/OPERATIONS.md`; local
   validation does not substitute for a remote host, public TLS, live Telegram
   delivery or the owner's populated backup drill.

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
| `Capture` | The literal record of what was sent. Never rewritten. `rawText` is user-authored; `transcript`/`transcriptSource` carry speech provenance; `classificationCache` is a validated AI result. | `1—N` Task/Note/Idea/Event/Reminder, `N—N` Tag via `CaptureTag` |
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
because a join row or an attempt record has no meaning without its parent. A
permanent capture purge also unlinks its retained audio from `STT_AUDIO_DIR`;
undo is a soft delete and keeps the file for the retained audit row.

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
| D25 | Undo is soft; purge is explicit | `undo` sets `deletedAt`, removes derived records and keeps the capture/audit trail (including retained audio); permanent deletion requires `{"force": true}` and unlinks retained audio before the transaction commits. Destructive actions should need a deliberate second intent. |
| D26 | The capture and its derivation are two transactions, not one | Committing the capture first means a provider outage cannot lose the user's words (D8), and the second transaction keeps the derived records and the capture's classification state consistent. The alternative — one transaction — would roll the raw text back on a classification failure, which is the one thing that must never happen. The second transaction's rollback is proven by an injected write failure (`capture-atomicity.test.ts`). |
| D27 | No fallback between polling and webhook mode | A deployment that silently switches transports hides a misconfiguration and can double-deliver. The mode is explicit and startup fails if its requirements are unmet. |
| D28 | Search is `LIKE` over a bounded window, not full-text | A personal database is small, and `LIKE` needs no schema, no index maintenance and no tokenizer to explain itself. The per-type window (`SEARCH_WINDOW_CAP = 200`) bounds the work; `total` is still exact because it comes from `count`. Honest limits beat a half-configured FTS table. Replacing this with SQLite FTS5 is a backlog item, and `search-service.ts` is the only module that would change. |
| D29 | Restore is additive, dry-run by default, and reports every row it cannot write | A backup feature that can destroy the live database is worse than none. Restore never deletes or overwrites, so a mistaken call is survivable; the dry run is the default because bulk writes should be asked for. Identity reuse (tag name, `(source, externalId)`, `occurrenceKey`) makes a restore onto a partly-populated database correct instead of conflicting, and rows are written one at a time so one bad row cannot take the transaction with it — the cost is a truthful `errors` list the caller must read. |
| D30 | `dueAt`/`priority` sorts finish in application code over a bounded window | SQLite sorts `NULL` first on ascending and Prisma cannot express `NULLS LAST`, so an undated task would head a "what is due" list. Rather than pretend, the window is capped (500 rows) and the cap is documented. |
| D31 | The export bundle includes the tag join tables | A bundle without them would restore every entity and silently drop every tag link while reporting success. `schemaVersion` guards the contract so a future change is detectable rather than assumed. |
| D32 | Reminder schedule lives in the database, not in memory | A restart must not lose pending reminders. The `reminders` table with `remindAt` is the single source of truth; the scheduler only polls it. |
| D33 | Every delivery attempt is a `ReminderDelivery` row with a unique `idempotencyKey` | The key format `<reminderId>:<scheduledForIso>:<attempt>` makes a double send impossible even with concurrent processes or a crash mid-send. The `SENDING` status provides a claim mechanism for multi-process safety. |
| D34 | Quiet hours and daily cap defer, never drop | A deferred delivery stays `PENDING` with a future `nextRetryAt`; it is retried when the window ends or the next day begins. The attempt budget is untouched. |
| D35 | Startup recovery uses a grace window | On boot, overdue reminders inside `REMINDER_OVERDUE_GRACE_HOURS` fire once; older ones are marked `MISSED` and their series advances to the next future occurrence. This prevents a notification storm after prolonged downtime. |
| D36 | Recurrence generates occurrences one at a time, bounded | Each series head generates its next occurrence on successful delivery (or when a missed one is skipped). The unique `occurrenceKey` prevents duplicates after a restart. `maxOccurrences` and `until` bound the series. |
| D37 | Delivery guarantee is at-least-once, documented | The external API call and the local `DELIVERED` write cannot be atomic. A crash between a successful send and the write can repeat one message; losing a message is not possible because a stale `SENDING` row is re-queued by recovery. |
| D38 | Reminder API and Telegram commands share the same service layer | `createReminder`, `snoozeReminder`, `cancelReminder` enforce rules once (what may be snoozed, series cancellation semantics). No business logic lives in the adapters. |
| D39 | Voice uses check-before-download ordering and a bounded stream | A replay must not pay for a second download or transcription. The existence check is the cheapest gate, duration/mime checks come before the download, and the byte cap is enforced while reading the response: a declared oversized `Content-Length` is rejected before the body, and the reader cancels on the first chunk that crosses the cap. Nothing can buffer an unbounded response. |
| D40 | `transcript` is stored separately from `rawText` | The owner's caption is user-authored and trustworthy; speech output is untrusted. Keeping them in separate columns with `transcriptSource` makes provenance visible in the API, the Telegram confirmation and the dashboard, and means a bad transcript can be replaced without rewriting what the user actually typed. The dashboard labels provider speech output and manual transcripts separately from the caption, and never renders the internal voice placeholder as content. |
| D41 | Classification sees caption + transcript, caption first | Neither source is discarded when both exist. The caption carries the owner's framing; the transcript carries detail. Identical or contained content is collapsed so the provider is not asked to parse the same words twice. |
| D42 | Relative dates resolve against `capturedAt`, and the AI cache key includes that exact instant | A capture belongs to the moment it was made. Reinterpreting "in two hours" from a later reprocess would silently move the owner's reminder, so the reference is the immutable `capturedAt`. That makes reprocessing deterministic and lets the cache remain valid instead of expiring at midnight. The key still includes the exact reference instant (plus text, configuration, provider and model) so a caller using a moving reference cannot collide within a local day. A version bump invalidates entries written under the old policy. Failures are never written. |
| D43 | Reprocess concurrency is guarded in-process, not with a lock table | Recall is a single-owner, single-process server. A claim set is enough to stop two dashboard requests racing, has no schema cost, and cannot deadlock. Multi-process deployment is explicitly out of scope; the same guarantee would then need a DB claim column. |
| D44 | Audio is in memory unless retention is explicitly enabled | Speech providers accept a request body, so no temporary file is needed at all. `STT_RETAIN_AUDIO=false` therefore means no audio ever reaches disk, and there is nothing to clean up. Opting in writes one file per capture directly under `STT_AUDIO_DIR`. Permanent purge unlinks that direct child only; undo retains it because undo is reversible. Paths are resolved and rejected if they contain `..`, escape the directory, or name a nested entry. |
| D45 | Concurrent voice deliveries are coalesced by an adapter-local in-flight promise, not a distributed lock | Telegram retries at least once, and two deliveries can pass the persistent duplicate check together. A promise map keyed by the same `telegram:<chatId>:<messageId>` identity as the uniqueness constraint makes the second delivery wait for the first, so only one download and STT call occurs. The entry is removed on success and failure, allowing a later retry. Recall is a single-server deployment; a second process or adapter instance would not share this map, and the database unique constraint still prevents a second capture. Adding a distributed claim would require a schema change and is out of scope. |
| D46 | The dashboard sees `isVoice`, never the adapter metadata | A caption-only voice note must be presented differently from a typed Telegram message, but provider names, file ids, model names, retained-audio paths and classification-cache fields are not presentation data. The server derives one boolean from the stored metadata and puts only that flag in `CaptureDto`; the web never receives the blob. Detail URLs come from one route registry used by both the router and every visible row, so a row cannot link to a path the app does not register. |
| D47 | Proxy trust is opt-in; the public webhook has its own rate limit | Unconditionally trusting `X-Forwarded-For` lets any direct client choose its own rate-limit bucket. `TRUST_PROXY` therefore defaults to `false` and accepts a trusted address/CIDR list only when the deployment is actually behind a proxy. Login (10/min) and the Telegram webhook (120/min) have tighter route-level limits than the 240/min global bucket, and a rate-limit rejection is normalised to `429` rather than falling through the generic error path as `500`. |
| D48 | Provider endpoints are validated at startup | A base URL is operator-controlled, but accepting `file:`/`ftp:` or embedded credentials turns a typo into an unexpected transport or a secret in a URL. Validation requires `http(s)` with no credentials or fragment. Outside development, plain `http://` is limited to loopback hosts (`localhost`, `127.0.0.0/8`, `::1`) for self-hosted model servers; remote providers must use HTTPS. The destination is not blocked by IP range, because local model servers are a supported deployment. |
| D49 | A valid citation is not proof that an answer is supported | A model can cite one real record and then assert anything at all. Each statement is therefore checked against the cited evidence on its own (content words, digit tokens, prefix matches, negation markers); unsupported statements are removed, and if none survive the answer falls back to a deterministic summary of the evidence. Trusting the citation instead of the statement would make the citation list decorative. |
| D50 | The evidence excerpt is the record's own text | A search snippet is cut around the match, so it shows *why* a record was found but not what it says. The answer is only allowed to assert things that appear in the evidence the owner also receives, so the evidence has to carry the record's text — otherwise a correct answer would be discarded for not repeating the snippet. Only the excerpt changes; title, timestamp, status and `matchedOn` stay as the search produced them. |
| D51 | The briefing rides the reminder scheduler's tick | One loop, one set of delivery rules. A second scheduler would mean two quiet-hours rules, two daily caps and two chances to race for the same notification budget. The shared gate (`delivery-gate.ts`) is what makes that impossible, and the briefing's own durable table (`briefing_deliveries`) keeps its occurrences independent of the reminder rows. |
| D52 | A briefing belongs to its own day | A briefing deferred past midnight (quiet hours, an exhausted daily cap) is skipped rather than delivered the next morning: a stale briefing is worse than no briefing, and the next day's briefing covers the next day. The attempt is recorded as `SKIPPED` so the owner can see that it was not sent. |
| D53 | The daily delivery is off by default and gates only scheduled delivery | The owner decides when to be spoken to. Reading a briefing is an on-demand retrieval and keeps working while the delivery is off, so a disabled briefing is never a lost briefing. |
| D54 | One time zone: the owner's `UserSettings.timeZone` | Every surface uses the same zone: reminders, briefings, Telegram replies, capture confirmations and the dashboard. `DEFAULT_TIME_ZONE` only seeds the settings row the first time. The dashboard loads the zone once after sign-in (`TimeZoneProvider` / `useTimeZone()`), renders nothing date-related until it is known, updates it as soon as Settings are saved, and converts every `datetime-local` value with `localDateTimeToUtcIso(value, zone)`, which is DST-aware and refuses times that do not exist. The browser's own zone is never used for a stored value; it is only a visible fallback when Settings cannot be read. Relative labels ("tomorrow", weekday names) compare local calendar dates, not 24-hour periods. |
| D55 | Parsed dates are converted with the owner's IANA zone, never chrono's | chrono-node accepts only minute offsets and a fixed abbreviation table; an IANA name such as `Africa/Lagos` silently falls back to the HOST's zone, so "tomorrow at 9am" meant 09:00 UTC on the production container. `lib/nlp.ts` gives chrono the owner zone's offset at the reference instant (so "today"/"tomorrow"/"next Monday" are counted on the owner's calendar), takes only the parsed local date and time, and converts them with Luxon in the owner zone at the *target* date, so a DST change in between is applied. Exact durations ("in 2 hours") keep chrono's instant; a zone written in the text ("9am UTC") is honoured. chrono's `ForwardDateRefiner` is removed from a private parser copy because it compares a host-shifted reference with a real instant; its three rules (passed time → tomorrow, passed weekday → next one, passed month/day → next year) are reapplied on real instants. DST policy: a non-existent local time moves forward by the gap (02:30 → 03:30); a repeated one means its first occurrence; both are reported in `assumption`. The test suite pins its own host zone to `Pacific/Kiritimati` so this cannot regress unnoticed. |
| D56 | Questions about time are answered from timestamps, by code | Word search cannot answer "What do I have tomorrow?": no record contains the word "tomorrow". `services/ask-temporal.ts` reads a question's time intent in the owner's Settings zone — a day ("today", "last Friday", "25 December"), a Monday–Sunday week, a month, "next/last <type>", or "how many days until …" — and retrieves by each record's own timestamp: open tasks by `dueAt`, events by `startsAt`, scheduled reminders by `remindAt`; "what happened" means captures by `capturedAt`, events that took place and tasks completed then. Types stay labelled and separate; "next reminder" never returns a task. Answers are written by code (no model call), counts are calendar days in the owner zone, an empty period gets a plain answer with `grounded: false`, and a period that cannot be resolved gets a request to rephrase rather than a guess. `AskResponse.period` (optional) tells any client which period was answered without parsing text. Other questions still use word search; there, evidence carries its owner-local time to the model and into grounding, and a clock time in an answer must match a time the cited record actually states, compared as one value (not digit by digit). |
| D57 | AI providers: official SDK for Anthropic, explicit models, privacy by default | The Anthropic provider uses the official `@anthropic-ai/sdk` (pinned 1.7.0): the SDK owns the wire format, the API version (2026-10-21) and authentication, while Recall keeps one retry policy for every provider (SDK retries off). No sampling parameters are sent (2026-10-21 rejects them). A configured base URL with or without `/v1` reaches `/v1/messages` once; empty means each provider's own endpoint, and an OpenAI address left from an old template is ignored for Anthropic. `AI_MODEL` is required with any provider, so a retired built-in default can never break AI silently. Output ceilings are 4096 tokens; a cut-off (`max_tokens`) or a refusal is reported as such and never retried; 400-class errors are not retried, 408/409/429/5xx are. Personal text reaches a provider only when it is configured, `aiEnabled` is on and `AI_ALLOW_RAW_TEXT=true` (default `false`): one rule (`ai/access.ts`) for classification and Ask, a second refusal inside the provider, and no per-call warning when the policy says no. Health reports `rawTextAllowed`, the model, and the last success and failure as a time and a sanitised code only, kept in memory (reset on restart; no migration). |
| D58 | Telegram is a temporary bridge; polling recovers on its own | Telegram stays the delivery channel for reminders and briefings, and an input channel, only until ALIVE's native Windows and Android notifications exist; it is kept reliable but not extended, and it is retired only after native notifications are implemented, tested and confirmed reliable. Outbound delivery (`sendMessage` via the notifier) never depends on polling. Polling recovers without a restart: the start-up token check retries temporary failures and stops only on 401/403/404; a webhook left from webhook mode is removed before the first poll with `drop_pending_updates: false`, and again on a "webhook is active" 409 at most once per 10 minutes; a 409 from another `getUpdates` consumer is never answered by deleting anything, only logged plainly and retried with the normal backoff (capped at 30 s). This does not weaken D27: the mode is still explicit, and polling mode only clears what makes polling impossible. Health reports the polling state, last successful poll and last error as a time and a short code (never a message or the token), in memory. Reminders are sent with sound; the daily briefing silently (`OutboundMessage.silent`); quiet hours gate both. Each deployment should use its own bot token. |

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
