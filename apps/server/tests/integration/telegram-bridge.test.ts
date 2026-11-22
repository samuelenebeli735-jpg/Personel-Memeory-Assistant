/**
 * Telegram as a temporary bridge (D58): outbound delivery must not depend on
 * polling, reminders must alert with sound, briefings must arrive silently, and
 * health must report the polling state without content.
 *
 * Everything runs against the in-process fake Bot API; no live Telegram call.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AppContext } from '../../src/context.js';
import { advanceableClock, type AdvanceableClock } from '../../src/ports.js';
import { createReminderScheduler } from '../../src/services/reminder-scheduler.js';
import { createReminder } from '../../src/services/reminder-service.js';
import { updateSettings } from '../../src/services/settings-service.js';
import { TelegramApiError, TelegramClient } from '../../src/telegram/client.js';
import type { TelegramAdapter } from '../../src/telegram/handler.js';
import { createTelegramNotifier } from '../../src/telegram/notifier.js';
import { startTelegramPolling, type PollingController } from '../../src/telegram/polling.js';
import { createTestApp, createTestContext } from '../helpers/app.js';
import { createTestDatabase, type TestDb } from '../helpers/db.js';
import { createFakeTelegram, type FakeTelegram } from '../helpers/telegram.js';

const OTHER_POLLER =
  'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running';

const noUpdates = { handleUpdate: async () => ({ handled: true }) } as unknown as TelegramAdapter;

interface Rig {
  testDb: TestDb;
  ctx: AppContext;
  clock: AdvanceableClock;
  fake: FakeTelegram;
  client: TelegramClient;
}

async function rig(): Promise<Rig> {
  const testDb = await createTestDatabase('telegram-bridge');
  const clock = advanceableClock('2026-10-17T10:00:00.000Z');
  const { ctx } = createTestContext({ db: testDb.db, clock });
  // getUpdates always fails as if a second copy of Recall were polling.
  const fake = createFakeTelegram({
    onCall: (method) =>
      method === 'getUpdates'
        ? { status: 409, body: { ok: false, error_code: 409, description: OTHER_POLLER } }
        : undefined,
  });
  const client = new TelegramClient({ token: '123456:test-token', fetchImpl: fake.fetchImpl });
  return { testDb, ctx, clock, fake, client };
}

/** Starts polling and parks it in its first backoff wait, i.e. "in conflict". */
async function brokenPolling(r: Rig): Promise<{ controller: PollingController; release: () => void }> {
  let release!: () => void;
  const parked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let waiting!: () => void;
  const reachedWait = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  const controller = startTelegramPolling(r.ctx, r.client, noUpdates, {
    sleep: async () => {
      waiting();
      await parked;
    },
  });
  await reachedWait;
  return { controller, release };
}

describe('telegram bridge: delivery does not depend on polling', () => {
  let r: Rig;

  beforeEach(async () => {
    r = await rig();
  });

  afterEach(async () => {
    await r.testDb.cleanup();
  });

  it('delivers a due reminder, with sound, while polling is in conflict', async () => {
    const { controller, release } = await brokenPolling(r);
    expect(controller.status()).toMatchObject({ state: 'retrying', lastErrorCode: 'poller_conflict' });

    const notifier = createTelegramNotifier({ client: r.client, ownerIds: ['555000111'] });
    const scheduler = createReminderScheduler(r.ctx, { notifier, batchSize: 10, intervalMs: 1000 });
    await createReminder(r.ctx, {
      title: 'Call Ada',
      remindAt: new Date(r.clock.now().getTime() - 60_000).toISOString(),
    });

    const report = await scheduler.tick();

    expect(report.delivered).toBe(1);
    const sent = r.fake.callsTo('sendMessage');
    expect(sent).toHaveLength(1);
    expect(String(sent[0]?.payload.text)).toContain('Call Ada');
    expect(sent[0]?.payload).not.toHaveProperty('disable_notification');

    controller.stop();
    release();
    await controller.done;
  });

  it('delivers the daily briefing silently while polling is in conflict', async () => {
    const { controller, release } = await brokenPolling(r);

    const notifier = createTelegramNotifier({ client: r.client, ownerIds: ['555000111'] });
    const scheduler = createReminderScheduler(r.ctx, { notifier, batchSize: 10, intervalMs: 1000 });
    // 11:00 in Lagos is the rig's start instant.
    await updateSettings(r.ctx.db, { briefingEnabled: true, briefingTime: '11:00' }, r.ctx.defaults);

    const report = await scheduler.tick();

    expect(report.briefings.delivered).toBe(1);
    const sent = r.fake.callsTo('sendMessage');
    expect(sent).toHaveLength(1);
    expect(String(sent[0]?.payload.text)).toContain('Daily briefing');
    expect(sent[0]?.payload.disable_notification).toBe(true);

    controller.stop();
    release();
    await controller.done;
  });
});

describe('telegram bridge: health', () => {
  let testDb: TestDb;

  beforeEach(async () => {
    testDb = await createTestDatabase('telegram-bridge-health');
  });

  afterEach(async () => {
    await testDb.cleanup();
  });

  it('reports the polling state and code, never the error message', async () => {
    const test = await createTestApp(testDb.db);
    try {
      let polls = 0;
      let controller!: PollingController;
      const client = {
        getMe: async () => ({ id: 1 }),
        getWebhookInfo: async () => ({ url: '' }),
        deleteWebhook: async () => undefined,
        getUpdates: async () => {
          polls += 1;
          if (polls === 1) {
            throw new TelegramApiError(`Telegram getUpdates failed: ${OTHER_POLLER}`, {
              status: 409,
              description: OTHER_POLLER,
            });
          }
          controller.stop();
          return [];
        },
      } as unknown as TelegramClient;
      controller = startTelegramPolling(test.ctx, client, noUpdates, { sleep: async () => undefined });
      await controller.done;

      const base = test.runtime.telegramStatus();
      test.runtime.telegramStatus = () => ({ ...base, polling: controller.status() });

      // Provider details are shown to the signed-in owner only.
      const cookie = await test.login();
      const response = await test.app.inject({ method: 'GET', url: '/api/health', headers: { cookie } });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { providers: { telegram: { polling: Record<string, unknown> } } };
      expect(body.providers.telegram.polling).toMatchObject({
        state: 'stopped',
        stoppedReason: 'shutdown',
        lastErrorCode: 'poller_conflict',
      });
      expect(typeof body.providers.telegram.polling.lastPollAt).toBe('string');
      expect(response.body).not.toContain('terminated by other getUpdates');
    } finally {
      await test.close();
    }
  });
});
