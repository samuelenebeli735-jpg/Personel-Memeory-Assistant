/**
 * Telegram long polling.
 *
 * Used for local development and anywhere a public HTTPS endpoint is not
 * available. Production prefers the webhook (see `handler.ts`), but both feed the
 * same `handleUpdate`, so behaviour cannot drift between them.
 *
 * The offset is kept in memory. A restart therefore re-fetches the last few
 * updates from Telegram, which is safe because ingestion is idempotent on
 * `telegram:<chatId>:<messageId>` — the replay finds the existing capture instead
 * of storing a second one.
 */
import type { AppContext } from '../context.js';
import { ProviderError } from '../lib/errors.js';
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
}

export interface PollingController {
  /** Requests the loop to stop; the in-flight poll finishes first. */
  stop(): void;
  /** Resolves once the loop has exited. */
  done: Promise<void>;
  isRunning(): boolean;
  /** The next update id to ask for, exposed for diagnostics and tests. */
  currentOffset(): number | undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  let running = true;
  let offset: number | undefined;
  let backoff = initialBackoff;

  const done = (async () => {
    // Validates the token once and gives an early, clear failure when it is wrong.
    try {
      const me = await client.getMe();
      ctx.logger.info('telegram bot connected', { username: me.username ?? '(unnamed)' });
    } catch (error) {
      ctx.logger.error('telegram getMe failed - polling not started', {
        reason: error instanceof Error ? error.message : String(error),
      });
      running = false;
      return;
    }

    while (running) {
      try {
        const updates = await client.getUpdates({ offset, timeoutSeconds: pollTimeoutSeconds });
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
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        }
        backoff = initialBackoff;
      } catch (error) {
        if (!running) break;
        if (error instanceof ProviderError && error.provider === 'telegram') {
          const apiError = error as TelegramApiError;
          if (apiError.status === 401 || apiError.status === 403 || apiError.status === 404) {
            ctx.logger.error('telegram rejected the bot token - polling stopped', {
              status: apiError.status,
            });
            running = false;
            break;
          }
        }
        const hinted = error instanceof TelegramApiError ? error.retryAfterSeconds : undefined;
        const delay = hinted !== undefined ? hinted * 1_000 : backoff;
        ctx.logger.warn('telegram polling failed - retrying', {
          reason: error instanceof Error ? error.message : String(error),
          retryInMs: delay,
        });
        options.onError?.(error);
        if (hinted === undefined) backoff = Math.min(backoff * 2, maxBackoff);
        await sleep(delay);
      }
    }
  })();

  return {
    stop() {
      running = false;
    },
    done,
    isRunning: () => running,
    currentOffset: () => offset,
  };
}
