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
import { TelegramApiError, type TelegramClient, type TelegramUpdate } from '../../src/telegram/client.js';
import type { TelegramAdapter } from '../../src/telegram/handler.js';
import { startTelegramPolling, type PollingController } from '../../src/telegram/polling.js';

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

describe('telegram polling', () => {
  it('advances the offset and processes every update in order', async () => {
    const seen: number[] = [];
    let controller!: PollingController;
    let polls = 0;
    const offsets: (number | undefined)[] = [];

    const client = {
      getMe: async () => ({ id: 1, username: 'recall_test_bot' }),
      getUpdates: async (options: { offset?: number }) => {
        offsets.push(options.offset);
        polls += 1;
        if (polls === 1) return [update(100), update(101)];
        controller.stop();
        return [];
      },
    } as unknown as TelegramClient;

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

    const client = {
      getMe: async () => ({ id: 1 }),
      getUpdates: async () => {
        polls += 1;
        if (polls === 1) throw new Error('socket hang up');
        if (polls === 2) throw new Error('socket hang up again');
        if (polls === 3) return [update(7)];
        controller.stop();
        return [];
      },
    } as unknown as TelegramClient;

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

    const client = {
      getMe: async () => ({ id: 1 }),
      getUpdates: async () => {
        polls += 1;
        if (polls === 1) {
          throw new TelegramApiError('rate limited', { status: 429, retryAfterSeconds: 5 });
        }
        controller.stop();
        return [];
      },
    } as unknown as TelegramClient;

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
    const client = {
      getMe: async () => {
        throw new TelegramApiError('unauthorized', { status: 401, retryable: false });
      },
      getUpdates: async () => {
        polls += 1;
        return [];
      },
    } as unknown as TelegramClient;

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

    const client = {
      getMe: async () => ({ id: 1 }),
      getUpdates: async () => {
        polls += 1;
        if (polls === 1) return [update(1), update(2), update(3)];
        controller.stop();
        return [];
      },
    } as unknown as TelegramClient;

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
    const client = {
      getMe: async () => ({ id: 1 }),
      getUpdates: async () => {
        polls += 1;
        if (polls >= 2) controller.stop();
        return [];
      },
    } as unknown as TelegramClient;

    controller = startTelegramPolling(stubContext(), client, stubAdapter([]), {
      sleep: async () => undefined,
    });
    await controller.done;
    expect(controller.isRunning()).toBe(false);
    expect(polls).toBe(2);
  });
});
