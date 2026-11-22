/**
 * Telegram long polling.
 *
 * Telegram is a temporary bridge (D58): it carries reminders, briefings and
 * captures until ALIVE's native Windows and Android notifications exist. This
 * loop is kept reliable, not extended.
 *
 * Used for local development and anywhere a public HTTPS endpoint is not
 * available. Production prefers the webhook (see `handler.ts`), but both feed the
 * same `handleUpdate`, so behaviour cannot drift between them.
 *
 * Recovery rules:
 * - The start-up token check retries temporary failures (network not ready yet,
 *   timeouts, 429/5xx). Only a rejected token (401/403/404) stops polling.
 * - Polling and a webhook are mutually exclusive at Telegram. Before the first
 *   poll an existing webhook is removed, keeping pending updates. A later
 *   "webhook is active" 409 removes it again, at most once per
 *   `webhookClearWindowMs`, so two deployments cannot flip the bot back and
 *   forth quickly.
 * - A 409 caused by another `getUpdates` consumer (a second copy of Recall with
 *   the same token) is never "fixed" by deleting anything: it is logged plainly
 *   and retried with the normal capped backoff, so polling resumes by itself
 *   once the other copy stops.
 *
 * Outbound delivery (reminders, briefings) uses `sendMessage` directly and does
 * not depend on this loop.
 *
 * Acknowledgement: an update is acknowledged (the offset moves past it) only
 * after it was handled. If handling throws, the rest of the batch is left
 * alone, the next poll asks for the failed update again after the normal
 * backoff, and nothing after it is acknowledged first — the same contract as
 * webhook mode, where a failure returns 500 and Telegram redelivers. An update
 * that cannot succeed is dead-lettered instead of blocking the bot forever:
 * at once for a permanent failure (invalid input), otherwise after
 * `TELEGRAM_UPDATE_MAX_ATTEMPTS`. Dead-lettering is visible: an error log, a
 * health counter, and a message asking the owner to resend.
 *
 * The offset is kept in memory. A restart therefore re-fetches the last few
 * updates from Telegram, which is safe because ingestion is idempotent on
 * `telegram:<chatId>:<messageId>` — the replay finds the existing capture instead
 * of storing a second one. The same idempotency makes retrying a failed update
 * safe.
 */
import type { TelegramPollingStatusDto } from '@recall/shared';

import type { AppContext } from '../context.js';
import { AppError } from '../lib/errors.js';
import { TelegramApiError, type TelegramClient, type TelegramUpdate } from './client.js';
import type { TelegramAdapter } from './handler.js';

/**
 * Attempts for one update before it is dead-lettered. With the capped backoff
 * this is roughly four minutes, enough to ride out a short database outage.
 */
export const TELEGRAM_UPDATE_MAX_ATTEMPTS = 10;

export interface PollingOptions {
  /** How long Telegram may hold the request open, in seconds. */
  pollTimeoutSeconds?: number;
  /** Injectable sleep so tests never wait on real time. */
  sleep?: (ms: number) => Promise<void>;
  /** Called with every polling error, after it has been logged. */
  onError?: (error: unknown) => void;
  /** First retry delay, doubling up to `maxBackoffMs`. */
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /** Minimum time between two webhook removals triggered by a 409. */
  webhookClearWindowMs?: number;
  /** Attempts for one update before it is dead-lettered. */
  maxUpdateAttempts?: number;
}

export interface PollingController {
  /** Requests the loop to stop; the in-flight poll finishes first. */
  stop(): void;
  /** Resolves once the loop has exited. */
  done: Promise<void>;
  isRunning(): boolean;
  /** The next update id to ask for, exposed for diagnostics and tests. */
  currentOffset(): number | undefined;
  /** Sanitised state for health: times and a short code, never messages or tokens. */
  status(): TelegramPollingStatusDto;
}

type ConflictKind = 'webhook' | 'poller';

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 401/403/404 mean the token is wrong or revoked: retrying cannot help. */
function isTokenRejected(error: unknown): boolean {
  return (
    error instanceof TelegramApiError &&
    (error.status === 401 || error.status === 403 || error.status === 404)
  );
}

function conflictKind(error: unknown): ConflictKind | null {
  if (!(error instanceof TelegramApiError) || error.status !== 409) return null;
  return /webhook/i.test(error.description ?? error.message) ? 'webhook' : 'poller';
}

/** A short, content-free code for health. */
export function pollingErrorCode(error: unknown): string {
  const conflict = conflictKind(error);
  if (conflict === 'webhook') return 'webhook_conflict';
  if (conflict === 'poller') return 'poller_conflict';
  if (error instanceof TelegramApiError) {
    if (error.status !== undefined) return `http_${error.status}`;
    return error.timedOut ? 'timeout' : 'network';
  }
  return 'unexpected';
}

/**
 * A failure that a retry cannot fix (invalid input, a missing record): an
 * application error with a 4xx status other than 408/429. Anything else (a
 * database outage, a provider error, a bug) is presumed temporary.
 */
export function isPermanentFailure(error: unknown): boolean {
  if (!(error instanceof AppError)) return false;
  const status = error.httpStatus;
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** Tells the owner which message was not processed, so they can send it again. */
export function deadLetterNotice(message: NonNullable<TelegramUpdate['message']>): string {
  const what =
    typeof message.text === 'string' && message.text.trim().length > 0
      ? `your message "${message.text.trim().length > 60 ? `${message.text.trim().slice(0, 60)}…` : message.text.trim()}"`
      : message.voice
        ? 'your voice note'
        : 'one of your messages';
  return `Sorry, I could not process ${what}, even after retrying. It may not have been saved. Please check the dashboard or send it again.`;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Logs only the host of a webhook URL; the path may carry a secret-looking route. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '(unparseable)';
  }
}

/**
 * Starts the polling loop. It never rejects: poll failures are logged and
 * retried with bounded exponential backoff, and a bad token stops the loop
 * instead of hammering Telegram forever.
 */
export function startTelegramPolling(
  ctx: AppContext,
  client: TelegramClient,
  adapter: TelegramAdapter,
  options: PollingOptions = {},
): PollingController {
  const sleep = options.sleep ?? defaultSleep;
  const initialBackoff = options.initialBackoffMs ?? 1_000;
  const maxBackoff = options.maxBackoffMs ?? 30_000;
  const pollTimeoutSeconds = options.pollTimeoutSeconds ?? ctx.config.telegram.pollTimeoutSeconds;
  const webhookClearWindowMs = options.webhookClearWindowMs ?? 10 * 60_000;
  const nowMs = () => ctx.clock.now().getTime();

  const maxUpdateAttempts = options.maxUpdateAttempts ?? TELEGRAM_UPDATE_MAX_ATTEMPTS;

  let running = true;
  let offset: number | undefined;
  let backoff = initialBackoff;
  let lastWebhookClearMs: number | null = null;
  /** The update currently being retried, if one failed. */
  let failing: { updateId: number; attempts: number } | null = null;

  const state: TelegramPollingStatusDto = {
    state: 'starting',
    lastPollAt: null,
    lastErrorAt: null,
    lastErrorCode: null,
    stoppedReason: null,
    retryingUpdateId: null,
    deadLetteredUpdates: 0,
    lastDeadLetterAt: null,
  };

  /**
   * Gives up on one update, visibly: an error log (ids and the reason, never
   * the text), a health counter, and a message asking the owner to resend.
   */
  async function deadLetter(update: TelegramUpdate, error: unknown, attempts: number): Promise<void> {
    state.deadLetteredUpdates += 1;
    state.lastDeadLetterAt = ctx.clock.now().toISOString();
    state.lastErrorAt = state.lastDeadLetterAt;
    state.lastErrorCode = 'update_dead_lettered';
    ctx.logger.error('telegram update dead-lettered: not processed and will not be retried', {
      updateId: update.update_id,
      kind: update.callback_query ? 'callback_query' : update.message ? 'message' : 'other',
      attempts,
      permanent: isPermanentFailure(error),
      reason: reasonOf(error),
    });
    const message = update.message;
    if (!message) return;
    try {
      await adapter.sendText(message.chat.id, deadLetterNotice(message));
    } catch (notifyError) {
      ctx.logger.warn('could not tell the owner about a dead-lettered update', {
        updateId: update.update_id,
        reason: reasonOf(notifyError),
      });
    }
  }

  function recordError(error: unknown): void {
    state.lastErrorAt = ctx.clock.now().toISOString();
    state.lastErrorCode = pollingErrorCode(error);
    if (state.state !== 'starting') state.state = 'retrying';
  }

  function stopForToken(error: unknown, during: string): void {
    recordError(error);
    ctx.logger.error(`telegram rejected the bot token during ${during} - polling stopped`, {
      status: error instanceof TelegramApiError ? error.status : undefined,
    });
    running = false;
    state.state = 'stopped';
    state.stoppedReason = 'token_rejected';
  }

  /** Waits before the next attempt, honouring Telegram's `retry_after`. */
  async function backOff(error: unknown, message: string, level: 'warn' | 'error' = 'warn'): Promise<void> {
    const hinted = error instanceof TelegramApiError ? error.retryAfterSeconds : undefined;
    const delay = hinted !== undefined ? hinted * 1_000 : backoff;
    ctx.logger[level](message, {
      reason: reasonOf(error),
      code: pollingErrorCode(error),
      retryInMs: delay,
    });
    options.onError?.(error);
    if (hinted === undefined) backoff = Math.min(backoff * 2, maxBackoff);
    await sleep(delay);
  }

  /** Token check; retries temporary failures. Returns false when polling must not start. */
  async function connect(): Promise<boolean> {
    while (running) {
      try {
        const me = await client.getMe();
        ctx.logger.info('telegram bot connected', { username: me.username ?? '(unnamed)' });
        backoff = initialBackoff;
        return true;
      } catch (error) {
        if (isTokenRejected(error)) {
          stopForToken(error, 'start-up');
          return false;
        }
        recordError(error);
        await backOff(error, 'telegram getMe failed - retrying before polling starts');
      }
    }
    return false;
  }

  /**
   * Removes a webhook left from webhook mode so `getUpdates` is allowed.
   * Best effort: if Telegram cannot be asked now, the first poll's 409 triggers it.
   */
  async function clearWebhookAtStartup(): Promise<void> {
    try {
      const info = await client.getWebhookInfo();
      if (!info.url) return;
      ctx.logger.warn('telegram webhook is set - removing it so polling can start', {
        webhookHost: hostOf(info.url),
        pendingUpdates: info.pending_update_count ?? null,
      });
      await client.deleteWebhook();
      lastWebhookClearMs = nowMs();
      ctx.logger.info('telegram webhook removed; pending updates kept');
    } catch (error) {
      if (isTokenRejected(error)) {
        stopForToken(error, 'webhook check');
        return;
      }
      ctx.logger.warn('could not check for a telegram webhook - continuing', {
        reason: reasonOf(error),
        code: pollingErrorCode(error),
      });
    }
  }

  /** Returns true when the webhook was removed and polling may retry at once. */
  async function clearWebhookAfterConflict(): Promise<boolean> {
    const now = nowMs();
    if (lastWebhookClearMs !== null && now - lastWebhookClearMs < webhookClearWindowMs) return false;
    ctx.logger.warn('telegram webhook is active - removing it so polling can resume');
    try {
      await client.deleteWebhook();
      lastWebhookClearMs = now;
      ctx.logger.info('telegram webhook removed; pending updates kept');
      return true;
    } catch (error) {
      if (isTokenRejected(error)) stopForToken(error, 'webhook removal');
      else
        ctx.logger.warn('could not remove the telegram webhook', {
          reason: reasonOf(error),
          code: pollingErrorCode(error),
        });
      return false;
    }
  }

  const done = (async () => {
    if (!(await connect())) return;
    await clearWebhookAtStartup();

    while (running) {
      try {
        const updates = await client.getUpdates({ offset, timeoutSeconds: pollTimeoutSeconds });
        state.state = 'running';
        state.lastPollAt = ctx.clock.now().toISOString();
        let retryAfterFailure: unknown = null;
        for (const update of updates) {
          if (!running) break;
          try {
            await adapter.handleUpdate(update);
            // Acknowledge only after success: the next poll's offset tells
            // Telegram this update is done.
            offset = update.update_id + 1;
            if (failing?.updateId === update.update_id) failing = null;
            state.retryingUpdateId = null;
          } catch (error) {
            const previous: { updateId: number; attempts: number } | null = failing;
            const attempts: number = previous?.updateId === update.update_id ? previous.attempts + 1 : 1;
            if (isPermanentFailure(error) || attempts >= maxUpdateAttempts) {
              await deadLetter(update, error, attempts);
              offset = update.update_id + 1;
              failing = null;
              state.retryingUpdateId = null;
              continue;
            }
            // Keep it: the next poll asks for this update again, and nothing
            // after it is acknowledged first.
            failing = { updateId: update.update_id, attempts };
            offset = update.update_id;
            state.retryingUpdateId = update.update_id;
            retryAfterFailure = error;
            break;
          }
        }
        if (retryAfterFailure !== null) {
          state.state = 'retrying';
          state.lastErrorAt = ctx.clock.now().toISOString();
          state.lastErrorCode = 'update_failed';
          await backOff(
            retryAfterFailure,
            `failed to handle telegram update ${failing?.updateId} (attempt ${failing?.attempts} of ${maxUpdateAttempts}) - it will be retried`,
          );
          continue;
        }
        backoff = initialBackoff;
      } catch (error) {
        if (!running) break;
        if (isTokenRejected(error)) {
          stopForToken(error, 'polling');
          break;
        }
        state.state = 'retrying';
        recordError(error);
        const conflict = conflictKind(error);
        if (conflict === 'webhook') {
          if (await clearWebhookAfterConflict()) {
            options.onError?.(error);
            continue;
          }
          if (!running) break;
          await backOff(
            error,
            'telegram webhook keeps returning - another deployment may be using this bot token in webhook mode',
            'error',
          );
        } else if (conflict === 'poller') {
          await backOff(
            error,
            'another copy of Recall is polling with this bot token - waiting for it to stop',
            'error',
          );
        } else {
          await backOff(error, 'telegram polling failed - retrying');
        }
      }
    }
    if (state.state !== 'stopped') {
      state.state = 'stopped';
      state.stoppedReason = 'shutdown';
    }
  })();

  return {
    stop() {
      running = false;
    },
    done,
    isRunning: () => running,
    currentOffset: () => offset,
    status: () => ({ ...state }),
  };
}
