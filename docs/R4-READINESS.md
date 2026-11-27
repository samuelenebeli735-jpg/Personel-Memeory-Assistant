# Recall Round 4: deployment-readiness checklist

Prepared on 2026-11-27 (R4-prep), from `main` at `6ae758c` (Round 3 merged) plus
the R4-prep branch. Round 4 has **not started**. This file says what must be true
before Recall can be called deployed. It does not claim any of it is done.

Each item is labelled by who can complete it:
- **Repo**: can be done in this repository with no external accounts;
- **Owner**: needs something only the owner can provide (a host, an account, a
  credential, a decision);
- **Both**: the owner provides something, then the repository work follows.

No secret belongs in this file, in a commit, in Crosswalk or in chat. Credentials go
only into `.env.production` on the host.

## Where things stand (verified on 2026-11-27)

- **Rounds 1–3 are merged.** CI is green.
- **Locally:** the R3 migration was applied to the owner's `dev.db` and verified. A
  local Docker drill passed real-header, log-redaction, spoofed-`X-Forwarded-For`,
  restart, backup and fresh-volume restore checks (OPERATIONS, "Round 3 Docker
  drill").
- **Not yet exercised:**
  - a public host;
  - trusted TLS;
  - live Telegram, AI and STT;
  - off-host backups;
  - external monitoring.

## Current blockers (all Owner)

| Blocker | Needed for | Status |
| --- | --- | --- |
| An always-on Linux host with Docker Engine and Compose | R4-01 and everything after it | **Missing** |
| A domain name with an A/AAAA record pointing at that host; inbound TCP 80/443 and UDP 443 | R4-01 | **Missing** |
| A Telegram bot token for this deployment (one bot per deployment, decision D58) and the owner's numeric Telegram user id | R4-02 | **Missing** |
| An AI provider key and model choice, and the decision to allow personal text (`AI_ALLOW_RAW_TEXT`) | R4-03 | **Missing** (owner deferred it; AI stays off until then) |
| An OpenAI key for speech-to-text, if voice notes are wanted | R4-03 | **Missing** (optional) |
| An off-host backup destination and an encryption key or passphrase held by the owner | R4-04 | **Missing** |
| A monitoring endpoint or service, and where alerts should go | R4-04 | **Missing** |

## R4-01: host, domain and trusted TLS

**Repo:**
- [ ] Migrate `zod` 3 → 4 (≥ 4.6.7) with the full suites, **before** any public
      exposure. The open high advisory GHSA-mrhx-c7xc-m3w5 is reachable today only
      by a signed-in owner (SECURITY §11), but it should be gone before the
      service faces the internet.
- [ ] Keep the documented first-deployment steps in OPERATIONS §10 current, and
      check them once more against the final compose file.

**Owner:**
- [ ] Provide the host and the domain (see blockers).
- [ ] Set the production values in `.env.production` on the host: `RECALL_DOMAIN`,
      `CORS_ORIGINS`, a long `DASHBOARD_PASSWORD` and a ≥ 32-character random
      `SESSION_SECRET`. The process refuses placeholders.
- [ ] Decide on session hardening before exposure:
      - keep the single password, or add MFA later;
      - keep the 7-day session lifetime, or shorten it.

**Evidence and acceptance:**
- [ ] `https://<domain>/` loads with a publicly trusted certificate (not Caddy's
      local CA), and plain HTTP redirects to HTTPS.
- [ ] Real responses carry `DASHBOARD_CSP` on pages and the API policy on `/api/*`,
      plus HSTS, `nosniff` and `X-Frame-Options: DENY`.
- [ ] The app port is not reachable from outside. Only Caddy publishes 80/443.
- [ ] The container reports healthy on `/api/health/scheduler`.
- [ ] A spoofed `X-Forwarded-For` cannot dodge the login limit. Repeat the drill
      check on the host.

## R4-02: live Telegram

**Owner:** create the bot, then set `TELEGRAM_ENABLED=true`, the token,
`TELEGRAM_OWNER_IDS`, `TELEGRAM_MODE=webhook`, `TELEGRAM_WEBHOOK_URL` and a
random `TELEGRAM_WEBHOOK_SECRET`.

**Both:** run the live checks below together.

**Evidence and acceptance:**
- [ ] A text capture from the owner arrives once and is classified.
- [ ] A message from a non-owner account is refused and nothing is stored.
- [ ] The webhook rejects a wrong secret with 401.
- [ ] A due reminder is delivered **once** to Telegram.
- [ ] Deferrals hold back delivery as configured:
      - a reminder in quiet hours is delivered when they end;
      - a reminder over the daily cap is delivered the next day.
- [ ] A reminder that was pending when the container restarted is delivered
      exactly once.
- [ ] The daily briefing arrives silently at the configured time.

**Known limit to record:** Telegram retry and dead-letter state lives in memory
(Round 1). It stays the temporary bridge until native ALIVE notifications exist
(D58).

## R4-03: live AI and speech-to-text

**Owner:** decide the provider and model, and whether personal text may be sent.
Without `AI_ALLOW_RAW_TEXT=true` **and** the Settings switch on, nothing leaves
the host.

**Both:** add the key on the host only, never in chat, and set a spend limit at the
provider.

**Evidence and acceptance:**
- **Privacy gate:**
  - [ ] With either switch off, no request reaches the provider. Check the
        provider dashboard and the app health status.
  - [ ] With both on, classification and Ask work.
- **Prompt injection:**
  - [ ] Capture text containing instructions ("ignore previous instructions…")
        is stored as data.
  - [ ] Ask still cites only real records, and invented citations are dropped.
- **Failure handling:**
  - [ ] A wrong key or a provider outage degrades to the rule-based behaviour.
  - [ ] The error shows in `/api/health` without exposing the key.
- **Speech-to-text, if enabled:**
  - [ ] A Telegram voice note is transcribed once.
  - [ ] A replayed voice update creates no second transcription.

## R4-04: backups, restore and monitoring

**Repo:**
- [ ] Decide how backups are encrypted before they leave the host, then document
      it or implement it. Recall's backups are plain SQLite plus JSON today; the
      runbook only says to encrypt copies that leave the host. Options: an
      encrypting copy tool on the host, or encryption added to the `backup`
      command. Owner decision needed.
- [ ] Add a scheduled-backup procedure that is tested end to end. The cron example
      already exists in OPERATIONS.
- [ ] Define the stall and down alerts from the existing probes:
      - `/api/health/live` (the process answers);
      - `/api/health/scheduler` (public, one word, 503 when stopped or stalled).

**Owner:**
- [ ] Provide the off-host destination and keep the encryption key or passphrase
      somewhere other than the host.
- [ ] Provide the monitoring service and where its alerts go.

**Evidence and acceptance:**
- [ ] A scheduled backup runs unattended and passes `verify-backup`.
- [ ] An encrypted copy lands off-host.
- [ ] A **restore drill on the host** from the off-host copy into a fresh volume
      passes `verify-backup` and leaves counts unchanged. This follows the Round 3
      drill.
- [ ] Stopping the app, or simulating a stall, raises an alert within the agreed
      time, and recovery clears it.
- [ ] Container logs rotate, and no query strings or secrets appear in them.

## R4-05: docs and release

**Repo:**
- [ ] Reconcile ROADMAP, README, OPERATIONS, SECURITY and TESTING with what R4-01
      to R4-04 actually proved, including the date and evidence of each.
- [ ] Move the historical root reports (`AUDIT_REPORT.md`,
      `MIGRATION_SAFETY_REPORT.md`, `RECALL_MILESTONE8_RELEASE_ASSESSMENT.md`,
      `docs/OVERNIGHT_PROGRESS.md`) to `docs/history/` with a "historical" note.
      Needs owner approval.
- [ ] Record the release notes. There is no CHANGELOG yet; the ROADMAP serves as
      the record.

**Owner:**
- [ ] Approve the release, then tag it (for example `v1.0.0`) on the merged
      commit.

**Evidence and acceptance:**
- [ ] CI is green on the tagged commit.
- [ ] Every master-checklist box in ROADMAP is ticked with evidence, or carries an
      explicit, dated, owner-accepted exception.

## Go / no-go gate

Recall may be declared **deployed** (Round 4 done) only when **all** of these hold.

**GO when:**
1. R4-01 acceptance passes on the real host with a trusted certificate.
2. The zod 4 migration is merged, and `npm audit --omit=dev` shows no high
   runtime finding (tooling-only findings may be accepted in writing).
3. R4-02 passes live, including exactly-once delivery across a restart.
4. R4-03 passes, **or** the owner explicitly keeps AI and STT off for the release,
   with that recorded.
5. R4-04 passes: an unattended encrypted off-host backup, a restore drill on the
   host, and a working alert.
6. R4-05 passes: docs match the evidence, the release is approved and tagged.

**NO-GO if any of these is true:**
- any item above is unproven;
- a secret has appeared in the repository, a log, Crosswalk or chat;
- the backup cannot be restored on the host.

ALIVE Phase 2 starts only after this gate is passed (owner rule: Recall R1–R4
first).
