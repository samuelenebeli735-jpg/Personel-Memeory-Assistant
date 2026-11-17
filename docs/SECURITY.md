# Recall — Security and privacy

All stored information is treated as private. This document states the threat
model, what is enforced, and what is not yet done.

## 1. Threat model

| Asset | Threat | Control |
| --- | --- | --- |
| Captured thoughts, transcripts | Unauthorized Telegram user reads or deletes them | Owner-id allow-list enforced in the adapter before any service call |
| Same | Unauthenticated web access | Server-side session check on every `/api` route |
| Same | Someone with the database file | Out of scope for the app: rely on disk encryption and file permissions |
| API keys, bot token, dashboard password | Leaked through logs, errors, git or a bug report | Environment-only, redacting logger, secret-free error messages, `.gitignore` |
| Reminder integrity | Duplicate or lost reminders | Idempotent delivery records; persistent schedule |
| The user's other accounts | Prompt injection from a saved message steering the assistant | Saved content is never executed (see §7) |

**Explicitly out of scope** (and not implemented, by product requirement): covert
recording, continuous microphone monitoring, keystroke logging, screenshots of
user activity, monitoring of other applications.

## 2. Authentication and authorization

### Telegram

- `TELEGRAM_OWNER_IDS` is a comma-separated allow-list of numeric Telegram user
  ids. The check runs in the adapter **before** any service call, for both messages
  and callback-query buttons. Any update from another user id is refused with a
  neutral message; nothing about stored data is disclosed and nothing is written
  (integration test).
- An owner messaging from a group chat is told to use a private chat; group content
  is never stored.
- When `TELEGRAM_ENABLED=true`, startup validation *fails* if no owner id is
  configured. There is no "open bot" mode.
- Webhook mode requires a `secret_token`; the handler compares the
  `X-Telegram-Bot-Api-Secret-Token` header with `timingSafeEqual` and rejects
  mismatches with `401` before the update is processed. With no secret configured
  the endpoint refuses with `503` rather than accepting unauthenticated updates.
- A non-owner gets `200` from the webhook (nothing stored) so Telegram does not
  retry the same refusal indefinitely.
- `edited_message` updates are ignored: stored text is immutable, so a later edit
  cannot rewrite history or invalidate derived records.
- Idempotency on `(source, externalId)` means a replayed update cannot create a
  second capture; a replay returns the existing one.
- A reply that fails to send is logged and swallowed. The capture is already
  committed, and message content is never copied into logs unless
  `LOG_MESSAGE_CONTENT=true`.

### Dashboard

- Login: `POST /api/auth/login` with the owner password. The comparison is a
  constant-time HMAC-free SHA-256 digest compare (`verifyPassword`), so it does
  not leak length or prefix information through timing.
- Session: an HMAC-SHA256 signed, opaque token in an `HttpOnly` `SameSite=Lax`
  cookie (`Secure` when `COOKIE_SECURE=true`). Format
  `v1.<base64url(payload)>.<base64url(signature)>`, verified in constant time with
  an expiry check. Payload: `{sub, iat, exp, nonce}`.
- Tokens are non-deterministic (random nonce per session).
- A `Authorization: Bearer <token>` header is accepted for scripts and tests.
- **Authorization is enforced in a Fastify `preHandler` hook on the whole `/api`
  scope**, not by hiding UI. `GET /api/health` and every personal-data route return
  401 without a valid session. Only `/api/auth/*` and `/api/health/live` are public,
  and they expose no stored data.
- Logout clears the cookie.

### Not yet implemented (tracked in the roadmap)

- Password hashing/rotation (a single shared secret is used; there is no user table).
- Multi-factor authentication.
- Per-device session revocation (changing `SESSION_SECRET` revokes everything).

## 3. Input validation

- Every HTTP body, query and service input is parsed by a Zod schema from
  `packages/shared` before it reaches a service. Unknown fields are stripped;
  invalid values produce `400` with field paths.
- Configuration is validated at startup; invalid configuration exits with code 78.
- AI model output is **untrusted**. It is parsed as JSON and validated against
  `classifyCaptureSchema` before anything is persisted. Missing or malformed
  fields are rejected (`ProviderError`), and the raw capture remains stored.
- SQL is only ever issued through Prisma's parameterised query builder. Raw SQL is
  limited to the PRAGMA statements that configure the SQLite connection
  (`$queryRawUnsafe` with hard-coded text) and the backup snapshot's
  `VACUUM INTO` filename. The backup path is operator-supplied, resolved and
  single-quote-escaped; no record or request content reaches it.
- A restore bundle is untrusted input: it is validated row by row against Zod before
  anything is written, rejected if it declares a newer `schemaVersion`, and capped
  per table so a wrong file cannot turn into an unbounded write.

## 4. Transport and browser policy

- Production requires HTTPS: `COOKIE_SECURE` must be `true`, and webhook URLs must
  be `https://`. The process refuses to start otherwise.
- The provided deployment publishes only Caddy's 80/443 ports. Caddy obtains a
  certificate for `RECALL_DOMAIN`, serves the static dashboard and proxies only
  `/api/*` to the unpublished app container; it also sets HSTS and common browser
  hardening headers. Plain `:80` is for a local smoke test, not production.
- CORS is restricted to `CORS_ORIGINS`, with credentials enabled and an explicit
  method allow-list. If no origin is configured, CORS is disabled entirely.
- Rate limiting: 240 requests/minute per IP overall, 10/minute on login, and
  120/minute on the public Telegram webhook.
- Proxy trust is opt-in. `TRUST_PROXY` defaults to `false`; enabling it without a
  trusted reverse proxy would let a client choose its own `X-Forwarded-For` and
  bypass the per-IP limiter. A configured value is passed to Fastify/proxy-addr.
- Provider base URLs must be `http(s)` and must not embed credentials or a
  fragment. Outside development, plain `http://` is accepted only for loopback
  hosts (`localhost`, `127.0.0.0/8`, `::1`) so a self-hosted model can run
  locally; remote providers must use HTTPS. The operator still chooses and
  trusts the endpoint.
- Body size limit: 2 MB.
- Error responses contain a code and a human message. Stack traces, provider
  response bodies and internal messages are never sent to the client; they go to
  the server log at most at debug level.

## 5. Secrets

- All credentials come from environment variables. Nothing is hard-coded.
- `.env.example` and `.env.production.example` contain placeholders only. `.env`,
  `.env.production`, `*.db`, `logs/`, `backups/` and `exports/` are git-ignored.
- Production `.env.production` must be mode `0600` on the host. The Docker stack
  passes secrets only to the app and one-shot backup services; Caddy receives only
  `RECALL_DOMAIN`.
- Backups contain every saved message and are written with owner-only permissions
  where the filesystem supports it. Copy them off-host, encrypt them, and protect
  the destination as strictly as the live database.
- Placeholder-shaped values (`""`, `changeme`, `password`, repeated single
  characters) are rejected when the owning feature is enabled. In production,
  `DASHBOARD_PASSWORD` must also be at least 12 characters and `SESSION_SECRET`
  must be at least 32 random characters; `TELEGRAM_OWNER_IDS` rejects documented
  example ids when Telegram is enabled.
- **Never commit a real token, password or API key.** If one is exposed, rotate it
  at the provider and in `.env`; nothing in the repository needs changing.
- Losing `SESSION_SECRET` only signs everyone out. Losing
  `DASHBOARD_PASSWORD` is fixed by setting a new one.

## 6. Logging and data minimisation

- The logger redacts `rawText`, `transcript`, `body`, `text`, `password`, `token`,
  `botToken`, `apiKey`, `secret`, `sessionSecret`, `authorization` and `cookie` by
  default. `LOG_MESSAGE_CONTENT=true` is for local development only.
- HTTP request logs contain the method, the path *without* the query string, and
  the status code. Query strings can contain search terms, so they are excluded.
- `Error` objects are logged as `{name, message}` — never with captured payloads.
- Capture text is only sent to an AI provider when a provider is configured **and**
  `AI_ALLOW_RAW_TEXT=true`. With the default `AI_PROVIDER=none`, nothing leaves the
  machine at all. `AI_ALLOW_RAW_TEXT` defaults to `true`: enabling an AI provider
  therefore enables raw-text sharing unless the operator explicitly sets
  `AI_ALLOW_RAW_TEXT=false`. This is a privacy decision the operator must make
  before enabling AI.
- **Voice:** the download is read as a bounded stream. A declared `Content-Length`
  over `STT_MAX_AUDIO_BYTES` is rejected before the body is read, and the reader
  cancels as soon as the running total exceeds the cap, so an oversized or endless
  response cannot be buffered in full. The bounded audio is held in memory for the
  duration of one request. With `STT_RETAIN_AUDIO=false` (the default) it is never
  written to disk, so there is no temporary file, no cleanup window and nothing for
  a later process to recover. Only the transcript is persisted.
- **Retention opt-in:** with `STT_RETAIN_AUDIO=true`, one file per downloaded clip
  is written under `STT_AUDIO_DIR` (git-ignored) and its path is stored in
  `Capture.mediaRef`. That directory must be included in your own access controls
  and backups; it is not served by the API and not part of the JSON export.
  Permanent purge unlinks the file; undo keeps it because the capture row is
  soft-deleted. Deletion accepts only a direct child of `STT_AUDIO_DIR`, rejects
  traversal/outside paths, and propagates unexpected filesystem errors so the
  purge transaction rolls back. There is no automatic age-based retention. If
  `STT_AUDIO_DIR` changes, old references are refused rather than guessed at.
- **Classification cache:** a cached AI result is stored on the capture row. It
  contains the validated classification (title, dates, tags, rationale), not the
  prompt, not the audio and not provider credentials. The key includes the exact
  reference instant (the capture's original `capturedAt`) so a moving clock cannot
  reuse a stale relative date. A key change makes the old entry unusable; the row
  is overwritten on the next successful AI classification, not proactively erased.
  The cache never contains a provider failure.
- **Dashboard exposure:** `CaptureDto` carries only a safe `isVoice` boolean for
  presentation. The adapter `metadata` blob (provider names, file ids, model),
  `mediaRef`, `classificationCache` and `classificationCacheKey` are never mapped
  into the response. The internal voice placeholder is not rendered as content:
  the capture page, list rows and search results show an honest "transcript
  unavailable" state instead. Detail errors for missing or unauthenticated records
  are generic and contain no record fields.

## 7. Untrusted content (prompt injection)

Saved messages are data, never instructions. Recall does not execute, schedule, or
shell out to anything derived from saved text:

- No `eval`, no dynamic `require`/`import` of user content, no command execution
  from message text.
- AI prompts wrap the capture between explicit markers and instruct the model to
  extract only; the model cannot cause a record to be created beyond the fields
  validated against the schema. This reduces model-level prompt injection but does
  not make a hostile transcript trustworthy: it can still influence the
  classification fields within the schema's bounds.
- A **transcript** is treated exactly like typed content: it is untrusted input,
  never an instruction. Caption and transcript are combined only as text, and
  every resulting field is schema-validated before storage.
- A malformed or hostile provider response is rejected at the service boundary
  (`classifyCaptureSchema`) as well as in the transport; it can never be applied
  partially.
- Recall answers about saved data are grounded in retrieved rows and cite record
  ids, so manipulated text cannot make the assistant assert an unfounded "memory".

## 8. External providers — exactly what they receive

| Provider | When | Data sent | Retention |
| --- | --- | --- | --- |
| Telegram | Always when enabled | The message you send (that is the transport) | Per Telegram's policy |
| AI classification (`openai`, `openai-compatible`, `anthropic`) | Only if `AI_PROVIDER` is not `none` and `AI_ALLOW_RAW_TEXT=true` | The capture text verbatim, the local time and time zone, your existing project names, and any explicit kind hint. No ids, no history, no settings. | Per the provider's policy |
| AI recall (`answer`) | Only on an explicit recall request | The question plus the retrieved evidence rows (titles, snippets, timestamps, statuses) — not the whole database | Per the provider's policy |
| Speech-to-text (`openai`) | Only if `STT_PROVIDER=openai`, on a voice message | The audio bytes, the declared mime type and a generated filename, plus the duration. No caption, no chat id, no owner id. | Per the provider's policy; Recall does not keep the audio unless `STT_RETAIN_AUDIO=true` |

With the default configuration (`AI_PROVIDER=none`, `STT_PROVIDER=none`) the only
external service that receives anything is Telegram, when the bot is enabled.

## 9. Data ownership

- The whole database is a single local file you control.
- JSON export and restore are built in (`GET /api/export`, `POST /api/restore`).
  Export contains **everything**, including private text, so an exported bundle is
  as sensitive as the database file itself and is git-ignored by default.
- Restore is the one route that can bulk-write, so it is defensive by design: it
  never deletes, never updates and never overwrites; it **defaults to a dry run**
  unless the caller passes `{"dryRun": false}`; it refuses a bundle written by a
  newer schema version; it caps how many rows it will take per table
  (`maxRowsPerTable`); and it reuses a row that already exists by id or by its
  natural key (a tag name, a capture's `(source, externalId)`) instead of colliding
  with it. Every row it could not write is reported in the response.
- Deletion semantics: deleting a task removes the task; the original capture
  survives (that is the point of keeping it). Deleting a capture nulls the link on
  derived records rather than destroying them. Deleting a project detaches its
  members. `/undo` in Telegram removes a capture together with the records it
  produced, after an explicit confirmation, and refuses if you have since edited one
  of those records unless you force it.
- Destructive actions require confirmation.

## 10. Local development is not production

The local configuration is deliberately *not* production-shaped. Running with
`NODE_ENV=development` allows a short session secret, non-secure cookies and plain
HTTP; with `NODE_ENV=production` the process refuses to start unless the hardening
requirements in §4 are met. Health and documentation both state which mode is
active.

## 11. Known advisories

`npm audit` reports a **dev-toolchain-only** advisory chain:
`prisma` → `@prisma/config` → `deepmerge-ts` (stack exhaustion when merging
recursive object graphs). It affects only the Prisma CLI, which runs at migrate and
generate time and is not part of the deployed runtime. It is tracked here rather
than fixed by a Prisma major upgrade that would change the generator contract
mid-project. All runtime dependencies are clean (`npm audit` reports no findings
for the server or web dependency trees other than that chain).

## 12. Verification checklist

- [x] Unauthenticated `GET /api/health` returns 401 (integration test).
- [x] Unauthenticated `GET /api/settings` returns 401 (integration test).
- [x] Wrong password rejected; correct password sets an `HttpOnly` cookie.
- [x] Tampered session cookie rejected.
- [x] Expired session rejected.
- [x] Logs never contain secrets, capture text or transcripts (unit test).
- [x] Invalid configuration fails fast without echoing secret values.
- [x] Telegram non-owner refusal, for messages and for callback buttons
      (`telegram-capture.test.ts`).
- [x] Webhook secret verification: wrong secret → 401 and nothing stored; missing
      secret → 503; malformed body → 400 (`telegram-capture.test.ts`).
- [x] Replayed Telegram update creates no second capture (integration test).
- [x] A replayed voice update performs no second download or transcription for a
      sequential replay (`voice-capture.test.ts`).
- [x] Concurrent duplicate deliveries of the same voice message are coalesced by
      an adapter-local in-flight promise: one download, one transcription, one
      confirmation, one capture (`voice-capture.test.ts`). The claim is released on
      failure so a retry can proceed. This is process-local; a second process does
      not share it, and the unique `(source, externalId)` constraint remains the
      final persistence safeguard.
- [x] Voice downloads are bounded while streaming: an oversized declared
      `Content-Length` is rejected before the body, and the reader cancels as soon
      as the byte cap is crossed (`telegram-client.test.ts`,
      `voice-capture.test.ts`).
- [x] Voice audio is not written to disk by default; retention writes only inside
      the configured directory when explicitly enabled (`voice-capture.test.ts`).
- [x] Initial classification of a failed transcription stores the capture and never
      fabricates a task from the placeholder (`voice-capture.test.ts`).
- [x] Reprocessing an untranscribed voice capture keeps it in `NEEDS_REVIEW`
      without calling the classifier or creating a task (`voice-capture.test.ts`).
- [x] An oversized transcript is rejected without losing the capture; the caption
      or placeholder is preserved and the reply names the limit
      (`voice-capture.test.ts`).
- [x] Permanent purge removes retained audio inside `STT_AUDIO_DIR`; undo keeps it
      by design. Missing files are a no-op, and traversal/outside paths are
      rejected (`voice-capture.test.ts`).
- [x] Malformed AI output is rejected and not cached
      (`classification-cache.test.ts`).
- [x] Provider failures are never cached, so a later attempt retries
      (`classification-cache.test.ts`).
- [x] A permanent delete requires `{"force": true}`; the softer `undo` is separate
      (`capture-api.test.ts`).
- [x] `X-Forwarded-For` is ignored unless `TRUST_PROXY` is enabled; a trusted
      proxy's header is used for the client IP (`http-hardening.test.ts`).
- [x] The public Telegram webhook is rate-limited and an exceeded limit returns
      `429`, not `500` (`http-hardening.test.ts`).
- [x] Provider base URLs reject non-HTTP(S) schemes, embedded credentials and
      fragments (`config.test.ts`).
- [x] Prompt-injection hardening of the recall path: records and the question are
      delimited and labelled untrusted, and the output is still citation/claim
      checked (`chat-providers.test.ts`, `ask-api.test.ts`, `ask-service.test.ts`).
- [x] Ask grounding: invented citations are dropped, unsupported statements are
      removed, and the provider is not called when AI is disabled (`ask-api.test.ts`).
- [x] Briefing delivery idempotency and restart recovery (`briefing-delivery.test.ts`).
- [x] Reminder delivery idempotency: `idempotencyKey` uniqueness prevents duplicate sends (integration test).
- [x] Reminder startup recovery: grace window enforced, no notification storm (integration test).
- [x] Quiet hours and daily cap: deferral without data loss (integration test).
- [x] Reminder cancellation: pending deliveries skipped, series children cancelled (integration test).
- [x] Reminder API authorization: all routes require owner session (integration test).
