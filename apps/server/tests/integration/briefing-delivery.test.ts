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
import { createLogger, type Logger } from '../../src/lib/logger.js';
import { localDateTimeToUtc } from '../../src/lib/time.js';
import { advanceableClock, type AdvanceableClock } from '../../src/ports.js';
import {
  BRIEFING_LATE_LIMIT_MS,
  BRIEFING_LATE_REASON,
  briefingDeadline,
} from '../../src/services/briefing-delivery.js';
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

// --- R1-06 / D59: a briefing is sent within 2 hours of its window, or skipped ---
//
// The default rig clock is 2026-10-17T10:00Z = 11:00 in Lagos (UTC+1, no DST).

const MINUTE = 60_000;
const TWO_HOURS = 2 * 60 * MINUTE;

async function rowsOf(ctx: AppContext) {
  return ctx.db.briefingDelivery.findMany({ orderBy: [{ occurrenceKey: 'asc' }, { attempt: 'asc' }] });
}

function recordInfoLogs(ctx: AppContext): string[] {
  const lines: string[] = [];
  (ctx as unknown as { logger: Logger }).logger = createLogger({
    level: 'info',
    sink: (line) => lines.push(line),
  });
  return lines;
}

describe('briefing deadline (D59) — the rule itself', () => {
  const noQuiet = { quietHoursStart: null, quietHoursEnd: null };

  it('is exactly 2 hours after the briefing time', () => {
    const at = new Date('2026-10-17T06:30:00.000Z'); // 07:30 Lagos
    expect(BRIEFING_LATE_LIMIT_MS).toBe(TWO_HOURS);
    expect(briefingDeadline(at, noQuiet, 'Africa/Lagos').toISOString()).toBe('2026-10-17T08:30:00.000Z');
  });

  it('opens at the end of quiet hours that contain the briefing time', () => {
    const at = new Date('2026-10-17T05:00:00.000Z'); // 06:00 Lagos, quiet until 09:00
    const deadline = briefingDeadline(at, { quietHoursStart: '22:00', quietHoursEnd: '09:00' }, 'Africa/Lagos');
    expect(deadline.toISOString()).toBe('2026-10-17T10:00:00.000Z'); // 11:00 Lagos
  });

  it('ignores quiet hours that do not contain the briefing time', () => {
    const at = new Date('2026-10-17T06:30:00.000Z'); // 07:30 Lagos; quiet ended at 07:00
    const deadline = briefingDeadline(at, { quietHoursStart: '22:00', quietHoursEnd: '07:00' }, 'Africa/Lagos');
    expect(deadline.toISOString()).toBe('2026-10-17T08:30:00.000Z');
  });

  it('never passes midnight of the briefing day', () => {
    const at = new Date('2026-10-17T22:00:00.000Z'); // 23:00 Lagos
    expect(briefingDeadline(at, noQuiet, 'Africa/Lagos').toISOString()).toBe('2026-10-17T22:59:59.999Z');
    // Quiet hours that end tomorrow cannot reopen today's briefing tomorrow.
    const quiet = { quietHoursStart: '22:00', quietHoursEnd: '07:00' };
    expect(briefingDeadline(at, quiet, 'Africa/Lagos').toISOString()).toBe('2026-10-17T22:59:59.999Z');
  });

  it('measures real time across a DST change (London, clocks back on 25 October 2026)', () => {
    // 01:30 happens twice that night; whichever instant is chosen, the limit is
    // two real hours after it, even though the wall clock moves three.
    const at = localDateTimeToUtc('2026-10-25', '01:30', 'Europe/London')!;
    const deadline = briefingDeadline(at, noQuiet, 'Europe/London');
    expect(deadline.getTime() - at.getTime()).toBe(TWO_HOURS);
  });

  it('uses the DST-correct end of quiet hours (London, clocks forward on 29 March 2026)', () => {
    // Quiet hours 23:00-07:00 start in GMT and end in BST: 07:00 BST = 06:00Z.
    const at = localDateTimeToUtc('2026-03-29', '06:00', 'Europe/London')!; // 05:00Z
    const deadline = briefingDeadline(at, { quietHoursStart: '23:00', quietHoursEnd: '07:00' }, 'Europe/London');
    expect(at.toISOString()).toBe('2026-03-29T05:00:00.000Z');
    expect(deadline.toISOString()).toBe('2026-03-29T08:00:00.000Z');
  });
});

describe('scheduled briefing delivery — 2-hour limit (D59)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await harness();
  });

  afterEach(async () => {
    await h.testDb.cleanup();
  });

  it('sends a briefing exactly 2 hours late, once', async () => {
    await enableBriefing(h.ctx, { briefingTime: '09:00' }); // 08:00Z; the clock is at 10:00Z

    const report = await h.scheduler.tick();
    await h.scheduler.tick();

    expect(report.briefings.delivered).toBe(1);
    expect(h.notifier.sent).toHaveLength(1);
  });

  it('skips a briefing 2 hours and 1 minute late, records why and logs once', async () => {
    const logs = recordInfoLogs(h.ctx);
    await enableBriefing(h.ctx, { briefingTime: '08:59' }); // 07:59Z

    const report = await h.scheduler.tick();
    await h.scheduler.tick();

    expect(report.briefings.skipped).toBe(1);
    expect(report.briefings.delivered).toBe(0);
    expect(h.notifier.sent).toHaveLength(0);
    const rows = await rowsOf(h.ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      occurrenceKey: '2026-10-17',
      attempt: 1,
      status: 'SKIPPED',
      error: BRIEFING_LATE_REASON,
      idempotencyKey: '2026-10-17:1',
      nextRetryAt: null,
    });
    expect(logs.filter((line) => line.includes('more than 2 hours late'))).toHaveLength(1);
  });

  it('never sends a skipped briefing later: ticks, restart, or a new briefing time', async () => {
    await enableBriefing(h.ctx, { briefingTime: '07:30' }); // 3.5 hours late
    await h.scheduler.tick();

    await h.scheduler.tick();
    const restarted = attach(h.testDb, '2026-10-17T10:05:00.000Z');
    await restarted.scheduler.recover();
    await restarted.scheduler.tick();
    // Moving today's time to "now" does not reopen today's briefing.
    await configure(restarted.ctx, { briefingTime: '11:05' });
    await restarted.scheduler.tick();

    expect(h.notifier.sent).toHaveLength(0);
    expect(restarted.notifier.sent).toHaveLength(0);
    const rows = await rowsOf(h.ctx);
    expect(rows.map((row) => row.status)).toEqual(['SKIPPED']);
  });

  it('switched on too late: skips today and delivers tomorrow as normal', async () => {
    await enableBriefing(h.ctx, { briefingTime: '07:30' });
    const today = await h.scheduler.tick();
    expect(today.briefings.skipped).toBe(1);

    h.clock.set(new Date('2026-10-18T06:30:00.000Z')); // 07:30 Lagos, next day
    const tomorrow = await h.scheduler.tick();

    expect(tomorrow.briefings.delivered).toBe(1);
    expect(h.notifier.sent).toHaveLength(1);
    expect(h.notifier.sent[0]!.text).toContain('2026-10-18');
  });

  it('server back within 2 hours: sends once', async () => {
    await enableBriefing(h.ctx, { briefingTime: '09:30' }); // the server "was off" since 08:30Z

    await h.scheduler.tick();
    await h.scheduler.tick();

    expect(h.notifier.sent).toHaveLength(1);
  });

  it('a missing channel resolved inside the window still delivers', async () => {
    await enableBriefing(h.ctx);
    h.notifier.setAvailable(false);
    await h.scheduler.tick();

    h.notifier.setAvailable(true);
    h.clock.advanceMs(110 * MINUTE);
    const report = await h.scheduler.tick();

    expect(report.briefings.delivered).toBe(1);
  });

  it('a missing channel does not extend the deadline', async () => {
    await enableBriefing(h.ctx);
    h.notifier.setAvailable(false);
    await h.scheduler.tick();

    h.clock.advanceMs(TWO_HOURS + MINUTE);
    h.notifier.setAvailable(true);
    const report = await h.scheduler.tick();
    await h.scheduler.tick();

    expect(report.briefings.skipped).toBe(1);
    expect(h.notifier.sent).toHaveLength(0);
    const rows = await rowsOf(h.ctx);
    expect(rows[0]).toMatchObject({ status: 'SKIPPED', error: BRIEFING_LATE_REASON });
  });

  it('the daily cap does not extend the deadline: skipped at the deadline, not at midnight', async () => {
    await enableBriefing(h.ctx, { maxNotificationsPerDay: 1 });
    await createReminder(h.ctx, {
      title: 'Call Ada',
      remindAt: new Date(h.clock.now().getTime() - MINUTE).toISOString(),
    });
    const first = await h.scheduler.tick();
    expect(first.briefings.deferred).toBe(1);

    h.clock.advanceMs(TWO_HOURS + MINUTE); // still the same local day
    const report = await h.scheduler.tick();

    expect(report.briefings.skipped).toBe(1);
    const rows = await rowsOf(h.ctx);
    expect(rows[0]).toMatchObject({ status: 'SKIPPED', error: BRIEFING_LATE_REASON });
    // Only the reminder was ever sent.
    expect(h.notifier.sent.map((message) => message.text)).toHaveLength(1);
  });

  it('a retry due after the deadline is skipped, not sent', async () => {
    await enableBriefing(h.ctx);
    h.notifier.setNext(
      { ok: false, retryable: true, error: 'rate limited', retryAfterMs: 3 * 60 * MINUTE },
      { ok: true },
    );
    await h.scheduler.tick(); // attempt 1 fails; attempt 2 waits 3 hours

    h.clock.advanceMs(TWO_HOURS + MINUTE);
    const report = await h.scheduler.tick();
    h.clock.advanceMs(60 * MINUTE); // the retry's own time
    await h.scheduler.tick();

    expect(report.briefings.skipped).toBe(1);
    expect(h.notifier.sent).toHaveLength(1); // the failed first attempt only
    const rows = await rowsOf(h.ctx);
    expect(rows.map((row) => row.status)).toEqual(['FAILED', 'SKIPPED']);
  });

  it('an interrupted send recovered after the deadline is skipped, not resent', async () => {
    await enableBriefing(h.ctx);
    await h.ctx.db.briefingDelivery.create({
      data: {
        occurrenceKey: '2026-10-17',
        attempt: 1,
        status: 'SENDING',
        channel: 'test',
        scheduledFor: new Date('2026-10-17T07:00:00.000Z'), // 3 hours ago
        nextRetryAt: new Date('2026-10-17T07:00:00.000Z'),
        attemptedAt: new Date('2026-10-17T07:00:00.000Z'),
        idempotencyKey: '2026-10-17:1',
      },
    });

    const recovery = await h.scheduler.recover();
    const report = await h.scheduler.tick();

    expect(recovery.briefingsRequeued).toBe(1);
    expect(report.briefings.skipped).toBe(1);
    expect(h.notifier.sent).toHaveLength(0);
  });

  it('rechecks the deadline on the live clock right before sending', async () => {
    // Briefing 09:00 Lagos = 08:00Z; the tick starts at 10:00:00Z, exactly on
    // the deadline. One second passes before the send would start (gates,
    // briefing generation), so the send must not start.
    await enableBriefing(h.ctx, { briefingTime: '09:00' });
    const available = h.notifier.isAvailable.bind(h.notifier);
    h.notifier.isAvailable = () => {
      h.clock.advanceMs(1_000);
      return available();
    };

    const report = await h.scheduler.tick();

    expect(report.briefings.skipped).toBe(1);
    expect(report.briefings.attempts).toBe(0);
    expect(h.notifier.sent).toHaveLength(0);
    const rows = await rowsOf(h.ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'SKIPPED', error: BRIEFING_LATE_REASON, attemptedAt: null });
  });

  it('a send that starts before the deadline and finishes after it is delivered, not skipped', async () => {
    // Briefing 09:00 Lagos = 08:00Z, deadline 10:00:00Z. The tick starts at
    // 09:59:59Z; Telegram holds the request open until 10:00:04Z, then succeeds.
    h.clock.set(new Date('2026-10-17T09:59:59.000Z'));
    await enableBriefing(h.ctx, { briefingTime: '09:00' });
    let releaseSend!: () => void;
    const sendHeld = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    let sendStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      sendStarted = resolve;
    });
    const send = h.notifier.send.bind(h.notifier);
    h.notifier.send = async (message) => {
      sendStarted();
      await sendHeld; // the request is in flight while the deadline passes
      return send(message);
    };

    const tick = h.scheduler.tick();
    await started;
    expect(h.clock.now().toISOString()).toBe('2026-10-17T09:59:59.000Z'); // started in time
    h.clock.set(new Date('2026-10-17T10:00:04.000Z')); // past the deadline
    releaseSend();
    const report = await tick;

    expect(report.briefings.delivered).toBe(1);
    expect(report.briefings.skipped).toBe(0);
    expect(h.notifier.sent).toHaveLength(1);
    const rows = await rowsOf(h.ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('DELIVERED');
    expect(rows[0]!.deliveredAt!.toISOString()).toBe('2026-10-17T10:00:04.000Z');
  });

  it('records the time the send finished, and schedules a retry from it', async () => {
    await enableBriefing(h.ctx);
    const send = h.notifier.send.bind(h.notifier);
    h.notifier.send = async (message) => {
      h.clock.advanceMs(5_000); // a slow provider
      return send(message);
    };
    h.notifier.setNext({ ok: false, retryable: true, error: 'network hiccup' }, { ok: true });

    await h.scheduler.tick(); // fails at 10:00:05Z
    const [failed, retry] = await rowsOf(h.ctx);
    expect(failed!.status).toBe('FAILED');
    expect(retry!.nextRetryAt!.toISOString()).toBe('2026-10-17T10:00:35.000Z'); // 30 s after the send finished

    h.clock.set(new Date('2026-10-17T10:00:40.000Z'));
    await h.scheduler.tick(); // succeeds, finishing at 10:00:45Z
    const delivered = (await rowsOf(h.ctx)).find((row) => row.status === 'DELIVERED');
    expect(delivered!.deliveredAt!.toISOString()).toBe('2026-10-17T10:00:45.000Z');
  });
});

describe('scheduled briefing delivery — quiet hours and the 2-hour limit (D59)', () => {
  let h: Harness;

  afterEach(async () => {
    await h.testDb.cleanup();
  });

  // Briefing 06:00 Lagos (05:00Z), quiet hours 22:00-09:00: the window opens at
  // 09:00 Lagos (08:00Z) and closes at 11:00 Lagos (10:00Z).
  const QUIET = { briefingTime: '06:00', quietHoursStart: '22:00', quietHoursEnd: '09:00' };

  it('is sent when quiet hours end', async () => {
    h = await harness('2026-10-17T05:00:00.000Z');
    await enableBriefing(h.ctx, QUIET);
    const early = await h.scheduler.tick();
    expect(early.briefings.deferred).toBe(1);

    h.clock.set(new Date('2026-10-17T08:00:00.000Z'));
    const report = await h.scheduler.tick();

    expect(report.briefings.delivered).toBe(1);
  });

  it('first available at 10:59 Lagos: sent', async () => {
    h = await harness('2026-10-17T09:59:00.000Z');
    await enableBriefing(h.ctx, QUIET);

    const report = await h.scheduler.tick();

    expect(report.briefings.delivered).toBe(1);
  });

  it('first available at 11:01 Lagos: skipped', async () => {
    h = await harness('2026-10-17T10:01:00.000Z');
    await enableBriefing(h.ctx, QUIET);

    const report = await h.scheduler.tick();

    expect(report.briefings.skipped).toBe(1);
    expect(h.notifier.sent).toHaveLength(0);
  });

  it('a missing channel after quiet hours does not extend the adjusted deadline', async () => {
    h = await harness('2026-10-17T05:00:00.000Z');
    await enableBriefing(h.ctx, QUIET);
    await h.scheduler.tick(); // deferred by quiet hours

    h.notifier.setAvailable(false);
    h.clock.set(new Date('2026-10-17T08:00:00.000Z'));
    await h.scheduler.tick(); // deferred: no channel

    h.notifier.setAvailable(true);
    h.clock.set(new Date('2026-10-17T10:01:00.000Z'));
    const report = await h.scheduler.tick();

    expect(report.briefings.skipped).toBe(1);
    expect(h.notifier.sent).toHaveLength(0);
  });

  it('UTC+14 (Kiritimati), quiet hours crossing midnight: window measured on the owner day', async () => {
    // 06:30 on 18 Oct in Kiritimati = 16:30Z on 17 Oct; quiet 22:00-07:00 ends
    // at 07:00 local = 17:00Z, so the deadline is 19:00Z.
    const settings = {
      timeZone: 'Pacific/Kiritimati',
      briefingTime: '06:30',
      quietHoursStart: '22:00',
      quietHoursEnd: '07:00',
    };

    h = await harness('2026-10-17T18:59:00.000Z');
    await enableBriefing(h.ctx, settings);
    const inTime = await h.scheduler.tick();
    expect(inTime.briefings.delivered).toBe(1);
    expect(h.notifier.sent[0]!.text).toContain('2026-10-18');
    await h.testDb.cleanup();

    h = await harness('2026-10-17T19:01:00.000Z');
    await enableBriefing(h.ctx, settings);
    const late = await h.scheduler.tick();
    expect(late.briefings.skipped).toBe(1);
    expect((await rowsOf(h.ctx))[0]).toMatchObject({ occurrenceKey: '2026-10-18', status: 'SKIPPED' });
  });

  it('DST: London on 29 March 2026, quiet hours end in summer time', async () => {
    // Briefing 06:00 BST = 05:00Z; quiet 23:00 GMT - 07:00 BST ends at 06:00Z;
    // deadline 08:00Z. An offset taken before the change would say 09:00Z.
    const settings = {
      timeZone: 'Europe/London',
      briefingTime: '06:00',
      quietHoursStart: '23:00',
      quietHoursEnd: '07:00',
    };

    h = await harness('2026-03-29T07:59:00.000Z');
    await enableBriefing(h.ctx, settings);
    expect((await h.scheduler.tick()).briefings.delivered).toBe(1);
    await h.testDb.cleanup();

    h = await harness('2026-03-29T08:01:00.000Z');
    await enableBriefing(h.ctx, settings);
    expect((await h.scheduler.tick()).briefings.skipped).toBe(1);
  });

  it('midnight is the hard stop for a late-evening briefing', async () => {
    // 23:00 Lagos; the server is back at 23:30 Lagos: sent.
    h = await harness('2026-10-17T22:30:00.000Z');
    await enableBriefing(h.ctx, { briefingTime: '23:00' });
    expect((await h.scheduler.tick()).briefings.delivered).toBe(1);
    await h.testDb.cleanup();

    // Same briefing waiting on a missing channel: at 00:01 it belongs to a day
    // that has passed and is skipped, even though 2 hours have not elapsed.
    h = await harness('2026-10-17T22:00:00.000Z');
    await enableBriefing(h.ctx, { briefingTime: '23:00' });
    h.notifier.setAvailable(false);
    await h.scheduler.tick();
    h.notifier.setAvailable(true);
    h.clock.set(new Date('2026-10-17T23:01:00.000Z'));
    const report = await h.scheduler.tick();

    expect(report.briefings.skipped).toBe(1);
    expect(h.notifier.sent).toHaveLength(0);
  });
});
