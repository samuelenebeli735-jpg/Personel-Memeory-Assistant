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
 * The offset is kept in memory. A restart therefore re-fetches the last few
 * updates from Telegram, which is safe because ingestion is idempotent on
 * `telegram:<chatId>:<messageId>` — the replay finds the existing capture instead
 * of storing a second one.
 */
import type { TelegramPollingStatusDto } from '@recall/shared';

import type { AppContext } from '../context.js';
import { TelegramApiError, type TelegramClient } from './client.js';
import type { TelegramAdapter } from './handler.js';

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

  let running = true;
  let offset: number | undefined;
  let backoff = initialBackoff;
  let lastWebhookClearMs: number | null = null;

  const state: TelegramPollingStatusDto = {
    state: 'starting',
    lastPollAt: null,
    lastErrorAt: null,
    lastErrorCode: null,
    stoppedReason: null,
  };

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
        for (const update of updates) {
          if (!running) break;
          offset = update.update_id + 1;
          try {
            await adapter.handleUpdate(update);
          } catch (error) {
            // One bad update must not stop the loop; the capture may or may not
            // have been written, and Telegram will not resend it once the offset
            // moves past it, so this is logged with the update id for triage.
            ctx.logger.error('failed to handle a telegram update', {
              updateId: update.update_id,
              reason: reasonOf(error),
            });
          }
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
