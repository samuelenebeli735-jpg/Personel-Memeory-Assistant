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
  mismatches with `401` before the body is read. With no secret configured the
  endpoint refuses with `503` rather than accepting unauthenticated updates.
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
- SQL is only ever issued through Prisma's parameterised query builder. The only
  place using raw SQL is the PRAGMA statements that configure the SQLite connection
  (`$queryRawUnsafe` with hard-coded text); no user input reaches them.
- A restore bundle is untrusted input: it is validated row by row against Zod before
  anything is written, rejected if it declares a newer `schemaVersion`, and capped
  per table so a wrong file cannot turn into an unbounded write.

## 4. Transport and browser policy

- Production requires HTTPS: `COOKIE_SECURE` must be `true`, and webhook URLs must
  be `https://`. The process refuses to start otherwise.
- CORS is restricted to `CORS_ORIGINS`, with credentials enabled and an explicit
  method allow-list. If no origin is configured, CORS is disabled entirely.
- Rate limiting: 240 requests/minute per IP overall, 10/minute on login.
- Body size limit: 2 MB.
- Error responses contain a code and a human message. Stack traces, provider
  response bodies and internal messages are never sent to the client; they go to
  the server log at most at debug level.

## 5. Secrets

- All credentials come from environment variables. Nothing is hard-coded.
- `.env.example` contains placeholders only. `.env`, `*.db`, `logs/`, `backups/`
  and `exports/` are git-ignored.
- Placeholder-shaped values (`""`, `changeme`, `password`, repeated single
  characters) are rejected when the owning feature is enabled.
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
  machine at all.

## 7. Untrusted content (prompt injection)

Saved messages are data, never instructions. Recall does not execute, schedule, or
shell out to anything derived from saved text:

- No `eval`, no dynamic `require`/`import` of user content, no command execution
  from message text.
- AI prompts wrap the capture between explicit markers and instruct the model to
  extract only; the model cannot cause a record to be created beyond the fields
  validated against the schema.
- Recall answers about saved data are grounded in retrieved rows and cite record
  ids, so manipulated text cannot make the assistant assert an unfounded "memory".

## 8. External providers — exactly what they receive

| Provider | When | Data sent | Retention |
| --- | --- | --- | --- |
| Telegram | Always when enabled | The message you send (that is the transport) | Per Telegram's policy |
| AI classification (`openai`, `openai-compatible`, `anthropic`) | Only if `AI_PROVIDER` is not `none` and `AI_ALLOW_RAW_TEXT=true` | The capture text verbatim, the local time and time zone, your existing project names, and any explicit kind hint. No ids, no history, no settings. | Per the provider's policy |
| AI recall (`answer`) | Only on an explicit recall request | The question plus the retrieved evidence rows (titles, snippets, timestamps, statuses) — not the whole database | Per the provider's policy |
| Speech-to-text (`openai`) | Only if `STT_PROVIDER=openai`, on a voice message | The audio file and duration | Per the provider's policy; Recall itself does not keep the audio (`STT_RETAIN_AUDIO=false` by default) |

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
- [x] A permanent delete requires `{"force": true}`; the softer `undo` is separate
      (`capture-api.test.ts`).
- [ ] Prompt-injection resistance of the recall path (Milestone 7).
