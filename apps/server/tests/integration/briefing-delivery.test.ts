/**
 * Scheduled briefing delivery.
 *
 * The delivery policy has to hold across ticks, restarts and failures, so
 * these tests drive the real scheduler against an isolated database and an
 * injectable clock. The notifier is a scripted double: no message ever leaves
 * the process and no live Telegram call is made.
 */
import type { SettingsUpdateInput } from '@recall/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AppContext } from '../../src/context.js';
import { advanceableClock, type AdvanceableClock } from '../../src/ports.js';
import { createReminderScheduler, type ReminderScheduler } from '../../src/services/reminder-scheduler.js';
import { createReminder } from '../../src/services/reminder-service.js';
import { updateSettings } from '../../src/services/settings-service.js';
import { createTestContext } from '../helpers/app.js';
import { createTestDatabase, type TestDb } from '../helpers/db.js';
import { scriptedNotifier, type ScriptedNotifier } from '../helpers/notifier.js';

/** 11:00 in Lagos — the same instant as the default test clock. */
const DUE_AT_11 = '11:00';

interface Rig {
  ctx: AppContext;
  clock: AdvanceableClock;
  notifier: ScriptedNotifier;
  scheduler: ReminderScheduler;
}

/** A scheduler, a clock and a notifier bound to an existing database. */
function attach(testDb: TestDb, start = '2026-10-17T10:00:00.000Z'): Rig {
  const clock = advanceableClock(start);
  const { ctx } = createTestContext({ db: testDb.db, clock });
  const notifier = scriptedNotifier({ available: true });
  ctx.notifier = notifier;
  const scheduler = createReminderScheduler(ctx, { notifier, batchSize: 10, intervalMs: 1000 });
  return { ctx, clock, notifier, scheduler };
}

interface Harness extends Rig {
  testDb: TestDb;
}

async function harness(start = '2026-10-17T10:00:00.000Z'): Promise<Harness> {
  const testDb = await createTestDatabase('briefing-delivery');
  return { testDb, ...attach(testDb, start) };
}

async function configure(ctx: AppContext, patch: SettingsUpdateInput): Promise<void> {
  await updateSettings(ctx.db, patch, ctx.defaults);
}

/** Switches the daily delivery on and puts it at the default test instant. */
async function enableBriefing(
  ctx: AppContext,
  patch: Partial<SettingsUpdateInput> = {},
): Promise<void> {
  await configure(ctx, { briefingEnabled: true, briefingTime: DUE_AT_11, ...patch });
}

describe('scheduled briefing delivery', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await harness();
  });

  afterEach(async () => {
    await h.testDb.cleanup();
  });

  it('delivers nothing while the daily delivery is switched off', async () => {
    const report = await h.scheduler.tick();

    expect(report.briefings.disabled).toBe(true);
    expect(report.briefings.delivered).toBe(0);
    expect(h.notifier.sent).toHaveLength(0);
    const rows = await h.ctx.db.briefingDelivery.findMany();
    expect(rows).toHaveLength(0);
  });

  it('delivers the briefing once it is due', async () => {
    await enableBriefing(h.ctx);

    const report = await h.scheduler.tick();

    expect(report.briefings.disabled).toBe(false);
    expect(report.briefings.delivered).toBe(1);
    expect(h.notifier.sent).toHaveLength(1);
    expect(h.notifier.sent[0]!.text).toContain('Daily briefing');
    expect(h.notifier.sent[0]!.text).toContain('2026-10-17');
  });

  it('does not deliver the briefing before its time', async () => {
    await enableBriefing(h.ctx, { briefingTime: '12:00' });

    const report = await h.scheduler.tick();

    expect(report.briefings.delivered).toBe(0);
    expect(report.briefings.due).toBe(0);
    expect(h.notifier.sent).toHaveLength(0);
  });

  it('delivers the briefing at the configured local time in the owner zone', async () => {
    await enableBriefing(h.ctx, { briefingTime: '07:30' });

    // 06:29 UTC is 07:29 in Lagos — one minute early.
    h.clock.set(new Date('2026-10-17T06:29:00.000Z'));
    await h.scheduler.tick();
    expect(h.notifier.sent).toHaveLength(0);

    h.clock.set(new Date('2026-10-17T06:30:00.000Z'));
    await h.scheduler.tick();
    expect(h.notifier.sent).toHaveLength(1);
  });

  it('does not deliver the same day twice', async () => {
    await enableBriefing(h.ctx);

    await h.scheduler.tick();
    await h.scheduler.tick();
    await h.scheduler.tick();

    expect(h.notifier.sent).toHaveLength(1);
  });

  it('does not deliver twice after a restart', async () => {
    await enableBriefing(h.ctx);
    await h.scheduler.tick();
    expect(h.notifier.sent).toHaveLength(1);

    // A second process, same database, same day.
    const restarted = attach(h.testDb);
    const report = await restarted.scheduler.tick();

    expect(report.briefings.delivered).toBe(0);
    expect(restarted.notifier.sent).toHaveLength(0);
    expect(h.notifier.sent).toHaveLength(1);
  });

  it('reports the briefing as delivered in the tick report', async () => {
    await enableBriefing(h.ctx);

    const report = await h.scheduler.tick();

    expect(report.briefings.due).toBe(1);
    expect(report.briefings.attempts).toBe(1);
    expect(report.briefings.delivered).toBe(1);
    expect(report.briefings.failed).toBe(0);
    expect(report.briefings.deferred).toBe(0);
  });

  it('uses the scheduler notifier rather than the context fallback', async () => {
    const contextNotifier = scriptedNotifier({ available: true });
    h.ctx.notifier = contextNotifier;
    await enableBriefing(h.ctx);

    await h.scheduler.tick();

    expect(h.notifier.sent).toHaveLength(1);
    expect(contextNotifier.sent).toHaveLength(0);
  });

  it('sends only records that exist', async () => {
    await enableBriefing(h.ctx);
    await h.ctx.db.task.create({
      data: {
        title: 'Pay the rent',
        dueAt: new Date('2026-10-17T09:00:00.000Z'),
      },
    });

    await h.scheduler.tick();

    const text = h.notifier.sent[0]!.text;
    expect(text).toContain('Pay the rent');
    expect(text).not.toContain('Ideas');
  });
});

describe('scheduled briefing delivery — deferral', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await harness();
  });

  afterEach(async () => {
    await h.testDb.cleanup();
  });

  it('defers the briefing while the quiet hours are open', async () => {
    await enableBriefing(h.ctx, {
      quietHoursStart: '22:00',
      quietHoursEnd: '07:00',
      briefingTime: '23:00',
    });
    // 23:00 in Lagos, inside the quiet window.
    h.clock.set(new Date('2026-10-17T22:00:00.000Z'));

    const report = await h.scheduler.tick();

    expect(report.briefings.deferred).toBe(1);
    expect(report.briefings.delivered).toBe(0);
    expect(h.notifier.sent).toHaveLength(0);

    const rows = await h.ctx.db.briefingDelivery.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('PENDING');
    // Deferred to the end of the quiet window: 07:00 Lagos = 06:00 UTC.
    expect(rows[0]!.nextRetryAt!.toISOString()).toBe('2026-10-18T06:00:00.000Z');
  });

  it('does not deliver a briefing whose day has passed', async () => {
    await enableBriefing(h.ctx, {
      quietHoursStart: '22:00',
      quietHoursEnd: '07:00',
      briefingTime: '23:00',
    });
    h.clock.set(new Date('2026-10-17T22:00:00.000Z'));
    await h.scheduler.tick();

    // The next morning the briefing belongs to the previous day and is stale.
    h.clock.set(new Date('2026-10-18T06:30:00.000Z'));
    const report = await h.scheduler.tick();

    expect(report.briefings.skipped).toBe(1);
    expect(h.notifier.sent).toHaveLength(0);
    const rows = await h.ctx.db.briefingDelivery.findMany();
    expect(rows[0]!.status).toBe('SKIPPED');
  });

  it('defers the briefing when the daily notification cap is reached', async () => {
    await enableBriefing(h.ctx, { maxNotificationsPerDay: 1 });
    // One reminder takes the only slot of the day.
    await createReminder(h.ctx, {
      title: 'Call Ada',
      remindAt: new Date(h.clock.now().getTime() - 60_000).toISOString(),
    });

    const report = await h.scheduler.tick();

    expect(report.briefings.deferred).toBe(1);
    expect(report.briefings.delivered).toBe(0);
    // Only the reminder was sent.
    expect(h.notifier.sent).toHaveLength(1);
    expect(h.notifier.sent[0]!.text).toContain('Call Ada');
  });

  it('defers the briefing while no delivery channel is configured', async () => {
    await enableBriefing(h.ctx);
    h.notifier.setAvailable(false);

    const report = await h.scheduler.tick();

    expect(report.briefings.deferred).toBe(1);
    expect(report.briefings.attempts).toBe(0);
    expect(h.notifier.sent).toHaveLength(0);
    const rows = await h.ctx.db.briefingDelivery.findMany();
    expect(rows[0]!.status).toBe('PENDING');
    expect(rows[0]!.attempt).toBe(1);
  });

  it('delivers a deferred briefing once the channel is back', async () => {
    await enableBriefing(h.ctx);
    h.notifier.setAvailable(false);
    await h.scheduler.tick();
    expect(h.notifier.sent).toHaveLength(0);

    h.notifier.setAvailable(true);
    h.clock.advanceMs(16 * 60_000);
    const report = await h.scheduler.tick();

    expect(report.briefings.delivered).toBe(1);
    expect(h.notifier.sent).toHaveLength(1);
  });

  it('keeps a pending briefing across a restart', async () => {
    await enableBriefing(h.ctx);
    h.notifier.setAvailable(false);
    await h.scheduler.tick();

    // A new process, same database, same day.
    const restarted = attach(h.testDb, '2026-10-17T10:20:00.000Z');
    const report = await restarted.scheduler.tick();

    expect(report.briefings.delivered).toBe(1);
    expect(restarted.notifier.sent).toHaveLength(1);
  });
});

describe('scheduled briefing delivery — failures', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await harness();
  });

  afterEach(async () => {
    await h.testDb.cleanup();
  });

  it('retries a transient failure with a backoff', async () => {
    await enableBriefing(h.ctx);
    h.notifier.setNext({ ok: false, retryable: true, error: 'network hiccup' }, { ok: true });

    const first = await h.scheduler.tick();

    expect(first.briefings.failed).toBe(1);
    expect(first.briefings.delivered).toBe(0);
    expect(h.notifier.sent).toHaveLength(1);

    const rows = await h.ctx.db.briefingDelivery.findMany({ orderBy: { attempt: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.status).toBe('FAILED');
    expect(rows[1]!.status).toBe('PENDING');
    expect(rows[1]!.attempt).toBe(2);
    // The first retry waits 30 seconds.
    expect(rows[1]!.nextRetryAt!.getTime()).toBe(h.clock.now().getTime() + 30_000);

    h.clock.advanceMs(31_000);
    const second = await h.scheduler.tick();

    expect(second.briefings.delivered).toBe(1);
    expect(h.notifier.sent).toHaveLength(2);
  });

  it('does not retry a permanent failure', async () => {
    await enableBriefing(h.ctx);
    h.notifier.setNext({ ok: false, retryable: false, error: 'blocked by the user' });

    const report = await h.scheduler.tick();

    expect(report.briefings.failed).toBe(1);
    expect(report.briefings.delivered).toBe(0);

    h.clock.advanceMs(60 * 60_000);
    const second = await h.scheduler.tick();

    expect(second.briefings.attempts).toBe(0);
    expect(h.notifier.sent).toHaveLength(1);
    const rows = await h.ctx.db.briefingDelivery.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('FAILED');
  });

  it('gives up after the attempt budget is spent', async () => {
    await enableBriefing(h.ctx);
    h.notifier.setNext({ ok: false, retryable: true, error: 'still failing' });

    await h.scheduler.tick();
    h.clock.advanceMs(31_000);
    await h.scheduler.tick();
    h.clock.advanceMs(61_000);
    const last = await h.scheduler.tick();

    expect(last.briefings.failed).toBe(1);
    expect(h.notifier.sent).toHaveLength(3);

    h.clock.advanceMs(61_000);
    const after = await h.scheduler.tick();

    expect(after.briefings.attempts).toBe(0);
    expect(h.notifier.sent).toHaveLength(3);
  });

  it('recovers an interrupted delivery on startup', async () => {
    await enableBriefing(h.ctx);
    await h.ctx.db.briefingDelivery.create({
      data: {
        occurrenceKey: '2026-10-17',
        attempt: 1,
        status: 'SENDING',
        channel: 'test',
        scheduledFor: new Date('2026-10-17T10:00:00.000Z'),
        nextRetryAt: h.clock.now(),
        attemptedAt: new Date(h.clock.now().getTime() - 10 * 60_000),
        idempotencyKey: '2026-10-17:1',
      },
    });

    const recovery = await h.scheduler.recover();
    expect(recovery.briefingsRequeued).toBe(1);

    const report = await h.scheduler.tick();
    expect(report.briefings.delivered).toBe(1);
    expect(h.notifier.sent).toHaveLength(1);
  });
});

describe('scheduled briefing delivery — configuration', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await harness();
  });

  afterEach(async () => {
    await h.testDb.cleanup();
  });

  it('stops the scheduled delivery when briefings are switched off again', async () => {
    await enableBriefing(h.ctx);
    await h.scheduler.tick();
    expect(h.notifier.sent).toHaveLength(1);

    await configure(h.ctx, { briefingEnabled: false });
    const report = await h.scheduler.tick();

    expect(report.briefings.disabled).toBe(true);
    expect(h.notifier.sent).toHaveLength(1);
  });

  it('sends the sections the owner configured', async () => {
    await enableBriefing(h.ctx, { briefingSections: ['ideas'] });
    await h.ctx.db.idea.create({ data: { title: 'Build a rocket' } });

    await h.scheduler.tick();

    const text = h.notifier.sent[0]!.text;
    expect(text).toContain('Ideas');
    expect(text).toContain('Build a rocket');
    expect(text).not.toContain('Overdue');
  });
});
