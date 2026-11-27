/**
 * Scheduler liveness (N14): a loop that is running but has not finished a tick
 * within the stall limit is reported as stalled, the public probe returns 503,
 * and the detailed health report is degraded. The probe carries no data.
 */
import type { HealthDto } from '@recall/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeliveryOutcome, Notifier, OutboundMessage } from '../../src/ports.js';
import {
  createReminderScheduler,
  MIN_STALL_LIMIT_MS,
  type ReminderScheduler,
} from '../../src/services/reminder-scheduler.js';
import { createReminder } from '../../src/services/reminder-service.js';
import { createTestApp, type TestApp } from '../helpers/app.js';
import { createTestDatabase, type TestDb } from '../helpers/db.js';

let testDb: TestDb;
let app: TestApp;

beforeAll(async () => {
  testDb = await createTestDatabase('scheduler-liveness');
  app = await createTestApp(testDb.db);
});

afterAll(async () => {
  await app.close();
  await testDb.cleanup();
});

beforeEach(async () => {
  await testDb.reset();
  app.clock.set(new Date('2026-11-27T10:00:00.000Z'));
});

/** A notifier whose sends hang until released: a tick that never finishes. */
function hangingNotifier() {
  const waiting: Array<(outcome: DeliveryOutcome) => void> = [];
  const notifier: Notifier = {
    channel: 'test',
    isAvailable: () => true,
    send: (_message: OutboundMessage) => new Promise<DeliveryOutcome>((resolve) => waiting.push(resolve)),
  };
  return {
    notifier,
    waiting,
    releaseAll() {
      for (const resolve of waiting.splice(0)) resolve({ ok: true, messageId: 'm' });
    },
  };
}

/** Real scheduler on the test app, with the interval captured instead of run. */
async function startScheduler(notifier: Notifier) {
  let fire: (() => void) | null = null;
  const errors: Array<{ message: string; meta: unknown }> = [];
  const logger = {
    ...app.ctx.logger,
    error: (message: string, meta?: unknown) => errors.push({ message, meta }),
  };
  const scheduler: ReminderScheduler = createReminderScheduler(
    { ...app.ctx, logger } as typeof app.ctx,
    {
      notifier,
      intervalMs: 20_000,
      timers: {
        setInterval: (fn) => {
          fire = fn;
          return 1;
        },
        clearInterval: () => undefined,
      },
    },
  );
  app.runtime.schedulerStatus = () => scheduler.status();
  await scheduler.start();
  return { scheduler, errors, fire: () => fire?.() };
}

const probe = async () => {
  const response = await app.app.inject({ method: 'GET', url: '/api/health/scheduler' });
  return { code: response.statusCode, body: response.json() as Record<string, unknown> };
};

describe('scheduler liveness', () => {
  it('reports "stopped" (503) before the loop starts and after it stops', async () => {
    const notStarted = createReminderScheduler(app.ctx, { notifier: hangingNotifier().notifier });
    app.runtime.schedulerStatus = () => notStarted.status();
    expect(await probe()).toEqual({ code: 503, body: { status: 'stopped' } });

    const { scheduler } = await startScheduler(hangingNotifier().notifier);
    expect(await probe()).toEqual({ code: 200, body: { status: 'ok' } });
    scheduler.stop();
    expect(await probe()).toEqual({ code: 503, body: { status: 'stopped' } });
  });

  it('a healthy loop stays "ok" however long it runs, as long as ticks finish', async () => {
    const { scheduler, fire } = await startScheduler(hangingNotifier().notifier);
    for (let i = 0; i < 30; i += 1) {
      app.clock.advanceMs(20_000);
      fire();
      // Let the (empty) tick finish before the next one.
      const before = scheduler.status().lastTickAt;
      await vi.waitFor(() => expect(scheduler.status().lastTickAt).not.toBe(before), { timeout: 10_000 });
    }
    expect(scheduler.status().stalled).toBe(false);
    expect((await probe()).code).toBe(200);
    scheduler.stop();
  });

  it('a hung tick is reported as stalled after the limit, logged once, and clears when it finishes', async () => {
    const hang = hangingNotifier();
    const { scheduler, errors, fire } = await startScheduler(hang.notifier);
    expect(scheduler.status().stallLimitSeconds).toBe(MIN_STALL_LIMIT_MS / 1000);

    await createReminder(app.ctx, { title: 'Stuck send', remindAt: new Date(app.clock.now().getTime() - 60_000).toISOString() });
    app.clock.advanceMs(20_000);
    fire(); // this tick hangs inside the send
    await vi.waitFor(() => expect(hang.waiting).toHaveLength(1), { timeout: 10_000 });

    // Inside the limit: still ok.
    app.clock.advanceMs(MIN_STALL_LIMIT_MS - 60_000);
    expect(scheduler.status().stalled).toBe(false);
    expect((await probe()).code).toBe(200);

    // Past the limit: stalled, 503, detailed health degraded.
    app.clock.advanceMs(2 * 60_000);
    expect(scheduler.status().stalled).toBe(true);
    expect(await probe()).toEqual({ code: 503, body: { status: 'stalled' } });
    const cookie = await app.login();
    const health = await app.app.inject({ method: 'GET', url: '/api/health', headers: { cookie } });
    const dto = health.json() as HealthDto;
    expect(dto.status).toBe('degraded');
    expect(dto.scheduler).toMatchObject({ running: true, stalled: true });

    // The interval keeps firing; the stall is logged once, not every time.
    fire();
    fire();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(errors.filter((e) => e.message.includes('stalled'))).toHaveLength(1);

    // The send finally returns: the tick finishes and the loop is healthy again.
    hang.releaseAll();
    await vi.waitFor(() => expect(scheduler.status().stalled).toBe(false), { timeout: 10_000 });
    expect((await probe()).code).toBe(200);
    scheduler.stop();
  });

  it('the probe is public and carries no data', async () => {
    await startScheduler(hangingNotifier().notifier);
    const response = await app.app.inject({ method: 'GET', url: '/api/health/scheduler' });
    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json() as object)).toEqual(['status']);
  });
});
