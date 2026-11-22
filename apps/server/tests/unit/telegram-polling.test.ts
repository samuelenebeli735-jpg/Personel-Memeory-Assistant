/**
 * Polling loop behaviour.
 *
 * The loop is driven with an injected sleep and a stub client, so these tests
 * never wait on real time and never touch the network.
 */
import { describe, expect, it } from 'vitest';

import type { AppContext } from '../../src/context.js';
import { testConfig, testLogger } from '../helpers/app.js';
import { createAppContext } from '../../src/context.js';
import { createLogger } from '../../src/lib/logger.js';
import { advanceableClock, type AdvanceableClock } from '../../src/ports.js';
import { TelegramApiError, TelegramClient, type TelegramUpdate } from '../../src/telegram/client.js';
import type { TelegramAdapter } from '../../src/telegram/handler.js';
import {
  pollingErrorCode,
  startTelegramPolling,
  type PollingController,
} from '../../src/telegram/polling.js';
import { createFakeTelegram } from '../helpers/telegram.js';

function stubContext(): AppContext {
  return createAppContext({
    config: testConfig({ TELEGRAM_ENABLED: 'true', TELEGRAM_BOT_TOKEN: '123456:test-token' }),
    db: {} as never,
    logger: testLogger(),
  });
}

function stubAdapter(seen: number[]) {
  return {
    handleUpdate: async (update: TelegramUpdate) => {
      seen.push(update.update_id);
      return { handled: true };
    },
  } as unknown as TelegramAdapter;
}

function update(id: number): TelegramUpdate {
  return { update_id: id } as TelegramUpdate;
}

/** A stub client with no webhook set; tests override only what they exercise. */
function stubClient(overrides: Record<string, unknown>): TelegramClient {
  return {
    getMe: async () => ({ id: 1 }),
    getWebhookInfo: async () => ({ url: '' }),
    deleteWebhook: async () => undefined,
    ...overrides,
  } as unknown as TelegramClient;
}

describe('telegram polling', () => {
  it('advances the offset and processes every update in order', async () => {
    const seen: number[] = [];
    let controller!: PollingController;
    let polls = 0;
    const offsets: (number | undefined)[] = [];

    const client = stubClient({
      getMe: async () => ({ id: 1, username: 'recall_test_bot' }),
      getUpdates: async (options: { offset?: number }) => {
        offsets.push(options.offset);
        polls += 1;
        if (polls === 1) return [update(100), update(101)];
        controller.stop();
        return [];
      },
    });

    controller = startTelegramPolling(stubContext(), client, stubAdapter(seen), {
      sleep: async () => undefined,
    });
    await controller.done;

    expect(seen).toEqual([100, 101]);
    // First poll has no offset, the second asks for one past the last update.
    expect(offsets).toEqual([undefined, 102]);
  });

  it('keeps polling after an error, with exponential backoff', async () => {
    const seen: number[] = [];
    const delays: number[] = [];
    let controller!: PollingController;
    let polls = 0;

    const client = stubClient({
      getMe: async () => ({ id: 1 }),
      getUpdates: async () => {
        polls += 1;
        if (polls === 1) throw new Error('socket hang up');
        if (polls === 2) throw new Error('socket hang up again');
        if (polls === 3) return [update(7)];
        controller.stop();
        return [];
      },
    });

    controller = startTelegramPolling(stubContext(), client, stubAdapter(seen), {
      sleep: async (ms) => {
        delays.push(ms);
      },
      initialBackoffMs: 100,
    });
    await controller.done;

    expect(delays).toEqual([100, 200]);
    // The update arriving after two failures is still handled.
    expect(seen).toEqual([7]);
  });

  it('honours Telegram retry_after instead of its own backoff', async () => {
    const delays: number[] = [];
    const errors: unknown[] = [];
    let controller!: PollingController;
    let polls = 0;

    const client = stubClient({
      getMe: async () => ({ id: 1 }),
      getUpdates: async () => {
        polls += 1;
        if (polls === 1) {
          throw new TelegramApiError('rate limited', { status: 429, retryAfterSeconds: 5 });
        }
        controller.stop();
        return [];
      },
    });

    controller = startTelegramPolling(stubContext(), client, stubAdapter([]), {
      sleep: async (ms) => {
        delays.push(ms);
      },
      initialBackoffMs: 100,
      onError: (error) => errors.push(error),
    });
    await controller.done;

    expect(delays).toEqual([5_000]);
    expect(errors).toHaveLength(1);
  });

  it('stops without polling when the token is rejected', async () => {
    let polls = 0;
    const client = stubClient({
      getMe: async () => {
        throw new TelegramApiError('unauthorized', { status: 401, retryable: false });
      },
      getUpdates: async () => {
        polls += 1;
        return [];
      },
    });

    const controller = startTelegramPolling(stubContext(), client, stubAdapter([]), {
      sleep: async () => undefined,
    });
    await controller.done;

    expect(polls).toBe(0);
    expect(controller.isRunning()).toBe(false);
  });

  it('survives a failure while handling one update', async () => {
    const seen: number[] = [];
    let controller!: PollingController;
    let polls = 0;

    const adapter = {
      handleUpdate: async (item: TelegramUpdate) => {
        if (item.update_id === 2) throw new Error('boom');
        seen.push(item.update_id);
        return { handled: true };
      },
    } as unknown as TelegramAdapter;

    const client = stubClient({
      getMe: async () => ({ id: 1 }),
      getUpdates: async () => {
        polls += 1;
        if (polls === 1) return [update(1), update(2), update(3)];
        controller.stop();
        return [];
      },
    });

    controller = startTelegramPolling(stubContext(), client, adapter, {
      sleep: async () => undefined,
    });
    await controller.done;

    expect(seen).toEqual([1, 3]);
    // The offset still moved past the failed update, so it is not retried forever.
    expect(controller.currentOffset()).toBe(4);
  });

  it('exposes a stop that ends the loop', async () => {
    let controller!: PollingController;
    let polls = 0;
    const client = stubClient({
      getMe: async () => ({ id: 1 }),
      getUpdates: async () => {
        polls += 1;
        if (polls >= 2) controller.stop();
        return [];
      },
    });

    controller = startTelegramPolling(stubContext(), client, stubAdapter([]), {
      sleep: async () => undefined,
    });
    await controller.done;
    expect(controller.isRunning()).toBe(false);
    expect(polls).toBe(2);
  });
});

// --- R1-05: recovery (webhook and poller conflicts, start-up retries, status) ---

/** Telegram's real 409 descriptions for the two different conflicts. */
const WEBHOOK_ACTIVE =
  "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first";
const OTHER_POLLER =
  'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running';

function conflict(description: string): TelegramApiError {
  return new TelegramApiError(`Telegram getUpdates failed: ${description}`, {
    status: 409,
    description,
    retryable: false,
  });
}

const TOKEN = '123456:SECRET-TOKEN-VALUE';

function recordingContext(clock?: AdvanceableClock) {
  const lines: { level: string; line: string }[] = [];
  const ctx = createAppContext({
    config: testConfig({ TELEGRAM_ENABLED: 'true', TELEGRAM_BOT_TOKEN: TOKEN }),
    db: {} as never,
    logger: createLogger({ level: 'debug', sink: (line, level) => lines.push({ level, line }) }),
    ...(clock ? { clock } : {}),
  });
  const text = () => lines.map((entry) => entry.line).join('\n');
  const at = (level: string) => lines.filter((entry) => entry.level === level).map((entry) => entry.line);
  return { ctx, lines, text, at };
}

describe('telegram polling recovery', () => {
  it('removes an existing webhook before the first poll and keeps pending updates', async () => {
    let controller!: PollingController;
    const fake = createFakeTelegram({
      onCall: (method) => {
        if (method === 'getWebhookInfo') {
          return {
            status: 200,
            body: {
              ok: true,
              result: { url: 'https://old.example.com/api/telegram/webhook', pending_update_count: 3 },
            },
          };
        }
        if (method === 'getUpdates') controller.stop();
        return undefined;
      },
    });
    const client = new TelegramClient({ token: TOKEN, fetchImpl: fake.fetchImpl });
    const { ctx, text } = recordingContext();

    controller = startTelegramPolling(ctx, client, stubAdapter([]), { sleep: async () => undefined });
    await controller.done;

    expect(fake.methods()).toEqual(['getMe', 'getWebhookInfo', 'deleteWebhook', 'getUpdates']);
    expect(fake.callsTo('deleteWebhook')[0]?.payload).toEqual({ drop_pending_updates: false });
    // The log names the old host only: no path, no token.
    expect(text()).toContain('old.example.com');
    expect(text()).not.toContain('/api/telegram/webhook');
    expect(text()).not.toContain('SECRET-TOKEN');
  });

  it('leaves Telegram alone when no webhook is set', async () => {
    let controller!: PollingController;
    const fake = createFakeTelegram({
      onCall: (method) => {
        if (method === 'getUpdates') controller.stop();
        return undefined;
      },
    });
    const client = new TelegramClient({ token: TOKEN, fetchImpl: fake.fetchImpl });

    controller = startTelegramPolling(recordingContext().ctx, client, stubAdapter([]), {
      sleep: async () => undefined,
    });
    await controller.done;

    expect(fake.methods()).toEqual(['getMe', 'getWebhookInfo', 'getUpdates']);
  });

  it('still polls when the webhook check itself fails', async () => {
    let controller!: PollingController;
    let polls = 0;
    const client = stubClient({
      getWebhookInfo: async () => {
        throw new TelegramApiError('Telegram getWebhookInfo failed', {});
      },
      getUpdates: async () => {
        polls += 1;
        controller.stop();
        return [];
      },
    });

    controller = startTelegramPolling(recordingContext().ctx, client, stubAdapter([]), {
      sleep: async () => undefined,
    });
    await controller.done;
    expect(polls).toBe(1);
  });

  it('removes a webhook that appears mid-run and resumes at once', async () => {
    const seen: number[] = [];
    const delays: number[] = [];
    const snapshots: ReturnType<PollingController['status']>[] = [];
    let controller!: PollingController;
    let polls = 0;
    let deletes = 0;
    const client = stubClient({
      deleteWebhook: async () => {
        deletes += 1;
      },
      getUpdates: async () => {
        polls += 1;
        if (polls === 1) return [update(1)];
        if (polls === 2) throw conflict(WEBHOOK_ACTIVE);
        snapshots.push(controller.status());
        if (polls === 3) return [update(2)];
        controller.stop();
        return [];
      },
    });
    const { ctx, at } = recordingContext();

    controller = startTelegramPolling(ctx, client, stubAdapter(seen), {
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    await controller.done;

    expect(deletes).toBe(1);
    expect(delays).toEqual([]); // no waiting once the webhook is gone
    expect(seen).toEqual([1, 2]); // updates before and after the conflict are handled
    expect(snapshots[0]).toMatchObject({ state: 'retrying', lastErrorCode: 'webhook_conflict' });
    expect(snapshots[1]).toMatchObject({ state: 'running', lastErrorCode: 'webhook_conflict' });
    expect(snapshots[1]?.lastPollAt).not.toBeNull();
    expect(controller.status()).toMatchObject({ state: 'stopped', stoppedReason: 'shutdown' });
    expect(at('warn').join('\n')).toContain('webhook is active');
  });

  it('removes a returning webhook at most once per window', async () => {
    const clock = advanceableClock('2026-11-22T10:00:00.000Z');
    const delays: number[] = [];
    let controller!: PollingController;
    let polls = 0;
    let deletes = 0;
    const client = stubClient({
      deleteWebhook: async () => {
        deletes += 1;
      },
      getUpdates: async () => {
        polls += 1;
        if (polls <= 3) throw conflict(WEBHOOK_ACTIVE);
        if (polls === 4) {
          clock.advanceMs(10 * 60_000);
          throw conflict(WEBHOOK_ACTIVE);
        }
        controller.stop();
        return [];
      },
    });
    const { ctx, at } = recordingContext(clock);

    controller = startTelegramPolling(ctx, client, stubAdapter([]), {
      sleep: async (ms) => {
        delays.push(ms);
      },
      initialBackoffMs: 100,
    });
    await controller.done;

    // Poll 1 clears it; polls 2-3 are inside the window and back off; poll 4 is
    // after the window, so the webhook is removed once more.
    expect(deletes).toBe(2);
    expect(delays).toEqual([100, 200]);
    expect(at('error').join('\n')).toContain('another deployment may be using this bot token');
  });

  it('waits out another poller without deleting anything, with capped backoff', async () => {
    const seen: number[] = [];
    const delays: number[] = [];
    const snapshots: ReturnType<PollingController['status']>[] = [];
    let controller!: PollingController;
    let polls = 0;
    let deletes = 0;
    const client = stubClient({
      deleteWebhook: async () => {
        deletes += 1;
      },
      getUpdates: async () => {
        polls += 1;
        if (polls <= 4) throw conflict(OTHER_POLLER);
        if (polls === 5) return [update(9)];
        snapshots.push(controller.status());
        controller.stop();
        return [];
      },
    });
    const { ctx, at } = recordingContext();

    controller = startTelegramPolling(ctx, client, stubAdapter(seen), {
      sleep: async (ms) => {
        delays.push(ms);
      },
      initialBackoffMs: 100,
      maxBackoffMs: 400,
    });
    await controller.done;

    expect(deletes).toBe(0);
    expect(delays).toEqual([100, 200, 400, 400]);
    expect(seen).toEqual([9]); // polling resumed by itself once the other copy stopped
    expect(snapshots[0]).toMatchObject({ state: 'running', lastErrorCode: 'poller_conflict' });
    expect(at('error').join('\n')).toContain('another copy of Recall is polling with this bot token');
  });

  it('retries a start-up failure until the network is ready', async () => {
    const delays: number[] = [];
    let duringStartup: ReturnType<PollingController['status']> | undefined;
    let controller!: PollingController;
    let attempts = 0;
    let polls = 0;
    const client = stubClient({
      getMe: async () => {
        attempts += 1;
        if (attempts === 1) throw new TelegramApiError('Telegram getMe failed', {});
        if (attempts === 2) throw new TelegramApiError('Telegram getMe timed out', { timedOut: true });
        duringStartup = controller.status();
        return { id: 1 };
      },
      getUpdates: async () => {
        polls += 1;
        controller.stop();
        return [];
      },
    });

    controller = startTelegramPolling(recordingContext().ctx, client, stubAdapter([]), {
      sleep: async (ms) => {
        delays.push(ms);
      },
      initialBackoffMs: 100,
    });
    await controller.done;

    expect(attempts).toBe(3);
    expect(delays).toEqual([100, 200]);
    expect(polls).toBe(1);
    expect(duringStartup).toMatchObject({ state: 'starting', lastErrorCode: 'timeout' });
  });

  it('reports a rejected token at start-up as stopped, without checking the webhook', async () => {
    let webhookChecks = 0;
    const client = stubClient({
      getMe: async () => {
        throw new TelegramApiError('Telegram getMe failed: Unauthorized', { status: 401, retryable: false });
      },
      getWebhookInfo: async () => {
        webhookChecks += 1;
        return { url: '' };
      },
    });

    const controller = startTelegramPolling(recordingContext().ctx, client, stubAdapter([]), {
      sleep: async () => undefined,
    });
    await controller.done;

    expect(webhookChecks).toBe(0);
    expect(controller.status()).toMatchObject({
      state: 'stopped',
      stoppedReason: 'token_rejected',
      lastErrorCode: 'http_401',
    });
  });

  it('stops when the token is revoked while polling', async () => {
    let polls = 0;
    const client = stubClient({
      getUpdates: async () => {
        polls += 1;
        if (polls === 1) return [];
        throw new TelegramApiError('Telegram getUpdates failed: Unauthorized', { status: 401, retryable: false });
      },
    });

    const controller = startTelegramPolling(recordingContext().ctx, client, stubAdapter([]), {
      sleep: async () => undefined,
    });
    await controller.done;

    expect(polls).toBe(2);
    expect(controller.isRunning()).toBe(false);
    expect(controller.status()).toMatchObject({ state: 'stopped', stoppedReason: 'token_rejected' });
  });

  it('keeps the token and messages out of logs and status on a real client failure', async () => {
    let controller!: PollingController;
    let polls = 0;
    const fake = createFakeTelegram({
      onCall: (method) => {
        if (method !== 'getUpdates') return undefined;
        polls += 1;
        if (polls === 1) {
          return { status: 502, body: { ok: false, error_code: 502, description: 'Bad Gateway' } };
        }
        controller.stop();
        return undefined;
      },
    });
    const client = new TelegramClient({ token: TOKEN, fetchImpl: fake.fetchImpl });
    const { ctx, text } = recordingContext();
    let failed: ReturnType<PollingController['status']> | undefined;

    controller = startTelegramPolling(ctx, client, stubAdapter([]), {
      sleep: async () => {
        failed = controller.status();
      },
    });
    await controller.done;

    expect(failed).toMatchObject({ state: 'retrying', lastErrorCode: 'http_502' });
    expect(JSON.stringify(failed)).not.toContain('Bad Gateway');
    expect(text()).not.toContain('SECRET-TOKEN');
  });

  it('maps errors to short codes', () => {
    expect(pollingErrorCode(conflict(WEBHOOK_ACTIVE))).toBe('webhook_conflict');
    expect(pollingErrorCode(conflict(OTHER_POLLER))).toBe('poller_conflict');
    expect(pollingErrorCode(new TelegramApiError('x', { status: 502 }))).toBe('http_502');
    expect(pollingErrorCode(new TelegramApiError('x', { timedOut: true }))).toBe('timeout');
    expect(pollingErrorCode(new TelegramApiError('x', {}))).toBe('network');
    expect(pollingErrorCode(new Error('socket hang up'))).toBe('unexpected');
  });
});
