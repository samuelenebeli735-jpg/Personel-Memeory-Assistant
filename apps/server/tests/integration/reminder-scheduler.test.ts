import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { advanceableClock } from '../../src/ports.js';
import { createReminderScheduler } from '../../src/services/reminder-scheduler.js';
import { createTestContext } from '../helpers/app.js';
import { createTestDatabase } from '../helpers/db.js';
import { scriptedNotifier } from '../helpers/notifier.js';
import { createReminder, findReminders, findUpcomingReminders, skipOutstandingDeliveries } from '../../src/services/reminder-service.js';

const LAGOS = 'Africa/Lagos';

async function setup() {
  const testDb = await createTestDatabase('scheduler');
  console.log('DEBUG: testDb created, file:', testDb.filePath);
  const clock = advanceableClock('2026-10-17T10:00:00.000Z');
  const { ctx, notifier } = createTestContext({ db: testDb.db, clock });
  console.log('DEBUG: ctx.db is testDb.db:', ctx.db === testDb.db);
  const tables = await testDb.db.$queryRaw`SELECT name FROM sqlite_master WHERE type='table'`;
  console.log('DEBUG: Tables in test db:', tables.map(x => x.name).sort());
  const notifierSpy = scriptedNotifier({ available: true });
  ctx.notifier = notifierSpy;
  const scheduler = createReminderScheduler(ctx, {
    notifier: notifierSpy,
    batchSize: 10,
    intervalMs: 1000,
  });
  return { testDb, ctx, clock, notifierSpy, scheduler };
}

describe('reminder scheduler', () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let ctx: Awaited<ReturnType<typeof createTestContext>>['ctx'];
  let clock: ReturnType<typeof advanceableClock>;
  let notifierSpy: ReturnType<typeof scriptedNotifier>;
  let scheduler: Awaited<ReturnType<typeof createReminderScheduler>>;

  beforeEach(async () => {
    const s = await setup();
    testDb = s.testDb;
    ctx = s.ctx;
    clock = s.clock;
    notifierSpy = s.notifierSpy;
    scheduler = s.scheduler;
    // Do NOT run recover here; each test controls when it runs.
  });

  afterEach(async () => {
    await testDb.cleanup();
  });

  it('delivers a single due reminder', async () => {
    const now = clock.now();
    const due = new Date(now.getTime() - 60_000);
    await createReminder(ctx, { title: 'Call Ada', remindAt: due.toISOString() });

    const report = await scheduler.tick();

    expect(report.due).toBe(1);
    expect(report.attempts).toBe(1);
    expect(report.delivered).toBe(1);
    expect(notifierSpy.sent).toHaveLength(1);
    expect(notifierSpy.sent[0].text).toContain('Call Ada');
  });

  it('does not deliver future reminders', async () => {
    const now = clock.now();
    const future = new Date(now.getTime() + 3600_000);
    await createReminder(ctx, { title: 'Future call', remindAt: future.toISOString() });

    const report = await scheduler.tick();

    expect(report.due).toBe(0);
    expect(report.attempts).toBe(0);
    expect(notifierSpy.sent).toHaveLength(0);
  });

  it('does not duplicate on repeated ticks', async () => {
    const now = clock.now();
    const due = new Date(now.getTime() - 60_000);
    await createReminder(ctx, { title: 'Once only', remindAt: due.toISOString() });

    await scheduler.tick();
    const firstSendCount = notifierSpy.sent.length;
    await scheduler.tick();
    const secondSendCount = notifierSpy.sent.length;

    expect(secondSendCount).toBe(firstSendCount);
  });

  it('processes reminders in bounded batches', async () => {
    const now = clock.now();
    for (let i = 0; i < 120; i++) {
      await createReminder(ctx, { title: `Batch ${i}`, remindAt: new Date(now.getTime() - i * 1000).toISOString() });
    }

    const report = await scheduler.tick();

    expect(report.due).toBeLessThanOrEqual(50);
    expect(report.attempts).toBeLessThanOrEqual(50);
  });

  it('retries on transient failure with exponential backoff', async () => {
    const now = clock.now();
    const due = new Date(now.getTime() - 60_000);
    await createReminder(ctx, { title: 'Retry me', remindAt: due.toISOString() });

    // First attempt fails
    notifierSpy.setNext({ ok: false, retryable: true, error: 'network hiccup' });
    await scheduler.tick();
    expect(notifierSpy.sent).toHaveLength(1);

    // Advance clock past backoff
    clock.advanceMs(40_000);
    // Second attempt succeeds
    notifierSpy.setNext({ ok: true });
    await scheduler.tick();
    expect(notifierSpy.sent).toHaveLength(2);
  });

  it('gives up after max attempts and marks reminder FAILED', async () => {
    const now = clock.now();
    const due = new Date(now.getTime() - 60_000);
    await createReminder(ctx, { title: 'Will fail', remindAt: due.toISOString() });

    // Use a fast-retrying scheduler for this test
    const fastScheduler = createReminderScheduler(ctx, {
      notifier: notifierSpy,
      batchSize: 10,
      intervalMs: 1000,
      retryBaseMs: 1000, // 1 second base for fast test
      maxBackoffMs: 5000,
    });

    // Fail 5 times (default maxAttempts = 5)
    notifierSpy.setNext({ ok: false, retryable: true, error: 'permanent' });
    for (let i = 0; i < 5; i++) {
      await fastScheduler.tick();
      clock.advanceMs(5000); // Advance past max backoff
    }

    const reminder = await findUpcomingReminders(ctx.db, { limit: 10, includeFailed: true });
    expect(reminder[0].status).toBe('FAILED');
  });

  it('respects quiet hours by deferring', async () => {
    // Set quiet hours 22:00–07:00 Lagos
    const settings = await ctx.db.userSettings.findUnique({ where: { id: 'singleton' } });
    if (!settings) {
      await ctx.db.userSettings.create({
        data: {
          id: 'singleton',
          timeZone: 'Africa/Lagos',
          morningDefaultTime: '09:00',
          eveningDefaultTime: '19:00',
          quietHoursStart: '22:00',
          quietHoursEnd: '07:00',
          maxNotificationsPerDay: 0,
          briefingEnabled: false,
          briefingTime: '09:00',
          briefingSections: JSON.stringify(['today', 'overdue', 'upcoming']),
          reminderOverdueGraceHours: 12,
          locale: 'en',
        },
      });
    } else {
      await ctx.db.userSettings.update({ where: { id: 'singleton' }, data: { quietHoursStart: '22:00', quietHoursEnd: '07:00' } });
    }

    // Quiet hours 22:00–07:00 Lagos. Test clock is 10:00 UTC = 11:00 local (outside).
    // Advance to 23:00 local = 22:00 UTC.
    clock.set(new Date('2026-10-17T22:00:00.000Z'));
    const due = new Date(clock.now().getTime() - 60_000);
    await createReminder(ctx, { title: 'Quiet call', remindAt: due.toISOString() });

    const report = await scheduler.tick();

    expect(report.deferred).toBe(1);
    expect(report.attempts).toBe(0);
    expect(notifierSpy.sent).toHaveLength(0);
  });

  it('releases deferred reminder after quiet hours end', async () => {
    // Set quiet hours 22:00–07:00 Lagos
    const settings = await ctx.db.userSettings.findUnique({ where: { id: 'singleton' } });
    if (!settings) {
      await ctx.db.userSettings.create({
        data: {
          id: 'singleton',
          timeZone: 'Africa/Lagos',
          morningDefaultTime: '09:00',
          eveningDefaultTime: '19:00',
          quietHoursStart: '22:00',
          quietHoursEnd: '07:00',
          maxNotificationsPerDay: 0,
          briefingEnabled: false,
          briefingTime: '09:00',
          briefingSections: JSON.stringify(['today', 'overdue', 'upcoming']),
          reminderOverdueGraceHours: 12,
          locale: 'en',
        },
      });
    } else {
      await ctx.db.userSettings.update({ where: { id: 'singleton' }, data: { quietHoursStart: '22:00', quietHoursEnd: '07:00' } });
    }

    clock.set(new Date('2026-10-17T22:00:00.000Z'));
    const due = new Date(clock.now().getTime() - 60_000);
    await createReminder(ctx, { title: 'Released later', remindAt: due.toISOString() });

    await scheduler.tick(); // deferred
    expect(notifierSpy.sent).toHaveLength(0);

    // Advance to 07:00 local = 06:00 UTC next day (quiet hours end)
    clock.set(new Date('2026-10-18T06:00:00.000Z'));
    await scheduler.tick();
    expect(notifierSpy.sent).toHaveLength(1);
  });

  it('respects daily notification cap', async () => {
    const settings = await ctx.db.userSettings.findUnique({ where: { id: 'singleton' } });
    if (!settings) {
      await ctx.db.userSettings.create({
        data: {
          id: 'singleton',
          timeZone: 'Africa/Lagos',
          morningDefaultTime: '09:00',
          eveningDefaultTime: '19:00',
          maxNotificationsPerDay: 0,
          briefingEnabled: false,
          briefingTime: '09:00',
          briefingSections: JSON.stringify(['today', 'overdue', 'upcoming']),
          reminderOverdueGraceHours: 12,
          locale: 'en',
        },
      });
    }
    await ctx.db.userSettings.update({ where: { id: 'singleton' }, data: { maxNotificationsPerDay: 2 } });

    const now = clock.now();
    // Deliver 2 reminders
    for (let i = 0; i < 2; i++) {
      await createReminder(ctx, { title: `Cap ${i}`, remindAt: new Date(now.getTime() - 60_000).toISOString() });
    }
    await scheduler.tick();
    await scheduler.tick();
    expect(notifierSpy.sent).toHaveLength(2);

    // Third reminder should be deferred to next day
    await createReminder(ctx, { title: 'Cap exceeded', remindAt: new Date(now.getTime() - 60_000).toISOString() });
    await scheduler.tick();
    expect(notifierSpy.sent).toHaveLength(2); // still 2, third was deferred
  });

  it('marks overdue reminders as MISSED beyond grace window', async () => {
    const settings = await ctx.db.userSettings.findUnique({ where: { id: 'singleton' } });
    if (!settings) {
      await ctx.db.userSettings.create({
        data: {
          id: 'singleton',
          timeZone: 'Africa/Lagos',
          morningDefaultTime: '09:00',
          eveningDefaultTime: '19:00',
          maxNotificationsPerDay: 0,
          briefingEnabled: false,
          briefingTime: '09:00',
          briefingSections: JSON.stringify(['today', 'overdue', 'upcoming']),
          reminderOverdueGraceHours: 12,
          locale: 'en',
        },
      });
    }
    await ctx.db.userSettings.update({ where: { id: 'singleton' }, data: { reminderOverdueGraceHours: 12 } });

    // Create a reminder 24 hours ago (well past 12h grace)
    const old = new Date('2026-10-16T10:00:00.000Z');
    await createReminder(ctx, { title: 'Ancient', remindAt: old.toISOString() });

    const report = await scheduler.recover();

    expect(report.missed).toBe(1);
    const reminders = await findReminders(ctx.db, { status: 'MISSED', limit: 10 });
    expect(reminders[0].status).toBe('MISSED');
  });

  it('delivers overdue reminders inside grace window', async () => {
    const settings = await ctx.db.userSettings.findUnique({ where: { id: 'singleton' } });
    if (!settings) {
      await ctx.db.userSettings.create({
        data: {
          id: 'singleton',
          timeZone: 'Africa/Lagos',
          morningDefaultTime: '09:00',
          eveningDefaultTime: '19:00',
          maxNotificationsPerDay: 0,
          briefingEnabled: false,
          briefingTime: '09:00',
          briefingSections: JSON.stringify(['today', 'overdue', 'upcoming']),
          reminderOverdueGraceHours: 12,
          locale: 'en',
        },
      });
    }
    await ctx.db.userSettings.update({ where: { id: 'singleton' }, data: { reminderOverdueGraceHours: 12 } });

    // Create a reminder 6 hours ago (inside grace)
    const recent = new Date('2026-10-17T04:00:00.000Z');
    await createReminder(ctx, { title: 'Recent overdue', remindAt: recent.toISOString() });

    await scheduler.recover();
    const report = await scheduler.tick();

    expect(report.delivered).toBe(1);
    expect(notifierSpy.sent).toHaveLength(1);
  });

  it('advances recurrence series after delivery', async () => {
    const now = clock.now();
    const due = new Date(now.getTime() - 60_000);
    const reminder = await createReminder(ctx, {
      title: 'Daily standup',
      remindAt: due.toISOString(),
      recurrence: { frequency: 'DAILY', weekdays: [], until: null, maxOccurrences: 52 },
    });

    await scheduler.tick();
    expect(notifierSpy.sent).toHaveLength(1);

    // The next occurrence should exist
    const all = await findUpcomingReminders(ctx.db, { limit: 10, includeFailed: false });
    expect(all.some((r) => r.parentId === reminder.id)).toBe(true);
  });

  it('skips ahead to future when series was offline for a long time', async () => {
    // Series created 10 days ago, daily, never delivered
    const old = new Date('2026-10-07T10:00:00.000Z');
    await createReminder(ctx, {
      title: 'Long offline',
      remindAt: old.toISOString(),
      recurrence: { frequency: 'DAILY', weekdays: [], until: null, maxOccurrences: 52 },
    });

    const report = await scheduler.recover();
    await scheduler.tick();

    // Should have marked the old one MISSED and advanced to a future occurrence
    expect(report.missed).toBe(1);
    const all = await findUpcomingReminders(ctx.db, { limit: 10, includeFailed: false });
    const future = all.find((r) => r.parentId !== null);
    expect(future).toBeDefined();
    // The next occurrence should be in the future (after the test clock time)
    expect(new Date(future!.remindAt).getTime()).toBeGreaterThan(clock.now().getTime());
  });

  it('cancelling a reminder before delivery stops it', async () => {
    const now = clock.now();
    const due = new Date(now.getTime() - 60_000);
    const reminder = await createReminder(ctx, { title: 'Will cancel', remindAt: due.toISOString() });

    // First tick: queue and attempt fails, so a retry is scheduled
    notifierSpy.setNext({ ok: false, retryable: true, error: 'temporary' });
    await scheduler.tick();
    expect(notifierSpy.sent).toHaveLength(1);

    // Now skip the pending retry delivery (simulating a cancel)
    await skipOutstandingDeliveries(ctx.db, [reminder.id], 'test cancel', now);

    // Second tick: the skipped delivery should not be attempted again
    notifierSpy.setNext({ ok: true });
    const report = await scheduler.tick();
    // The delivery was skipped before being claimed, so it's not counted as "abandoned"
    // (abandoned counts deliveries claimed but then the reminder changed state).
    // Verify no new send happened.
    expect(notifierSpy.sent).toHaveLength(1); // only the failed attempt was sent
    // The reminder should still be SCHEDULED but with a skipped delivery
    const deliveries = await ctx.db.reminderDelivery.findMany({ where: { reminderId: reminder.id } });
    const skipped = deliveries.filter((d) => d.status === 'SKIPPED');
    expect(skipped.length).toBeGreaterThan(0);
  });

  it('recovers interrupted SENDING deliveries on startup', async () => {
    const now = clock.now();
    const due = new Date(now.getTime() - 60_000);
    const reminder = await createReminder(ctx, { title: 'Interrupted', remindAt: due.toISOString() });

    // Manually create a stale SENDING delivery
    await ctx.db.reminderDelivery.create({
      data: {
        reminderId: reminder.id,
        attempt: 1,
        status: 'SENDING',
        channel: 'test',
        scheduledFor: due,
        occurrenceKey: `${reminder.id}:${due.toISOString()}`,
        idempotencyKey: `${reminder.id}:${due.toISOString()}:1`,
        attemptedAt: new Date(now.getTime() - 10_000_000), // older than staleClaimMs
        nextRetryAt: now,
      },
    });

    const report = await scheduler.recover();

    expect(report.requeued).toBe(1);
    await scheduler.tick();
    expect(notifierSpy.sent).toHaveLength(1);
  });

  it('one failed reminder does not stop other reminders', async () => {
    const now = clock.now();
    const due = new Date(now.getTime() - 60_000);

    await createReminder(ctx, { title: 'Will fail', remindAt: due.toISOString() });
    await createReminder(ctx, { title: 'Will succeed', remindAt: due.toISOString() });

    notifierSpy.setNext({ ok: false, retryable: false, error: 'permanent' }, { ok: true });
    await scheduler.tick();

    expect(notifierSpy.sent).toHaveLength(2);
    expect(notifierSpy.sent[1].text).toContain('Will succeed');
  });
});