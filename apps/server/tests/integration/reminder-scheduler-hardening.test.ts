/**
 * Scheduler hardening (R3-02): starvation, recovery while running, restart and
 * duplicate prevention.
 *
 * - Reminders that already have an outstanding attempt (deferred by quiet hours
 *   or the daily cap, or waiting for a retry) must not fill the "queue an
 *   attempt" batch and starve newer due reminders.
 * - An outstanding attempt must never hold a reminder back for ever: a stale
 *   SENDING row is re-queued on every tick, not only at startup.
 * - Deferrals, the grace window, occurrence uniqueness and idempotency hold.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../../src/db/client.js';
import { advanceableClock, type AdvanceableClock, type Notifier } from '../../src/ports.js';
import { createReminderScheduler, DEFAULT_STALE_CLAIM_MS } from '../../src/services/reminder-scheduler.js';
import { createReminder } from '../../src/services/reminder-service.js';
import { updateSettings } from '../../src/services/settings-service.js';
import { createTestContext } from '../helpers/app.js';
import { createTestDatabase, type TestDb } from '../helpers/db.js';
import { scriptedNotifier, type ScriptedNotifier } from '../helpers/notifier.js';

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDatabase('scheduler-hardening');
});

afterAll(async () => {
  await testDb.cleanup();
});

beforeEach(async () => {
  await testDb.reset();
});

const noTimers = { setInterval: () => 0, clearInterval: () => undefined };

function setup(options: { at?: string; db?: Db; notifier?: Notifier; batchSize?: number } = {}) {
  const clock: AdvanceableClock = advanceableClock(options.at ?? '2026-11-27T10:00:00.000Z');
  const notifier = (options.notifier ?? scriptedNotifier({ available: true })) as ScriptedNotifier;
  const { ctx } = createTestContext({ db: options.db ?? testDb.db, clock, notifier });
  const scheduler = () =>
    createReminderScheduler(ctx, { notifier, batchSize: options.batchSize ?? 50, intervalMs: 1000, timers: noTimers });
  return { ctx, clock, notifier, scheduler: scheduler(), newScheduler: scheduler };
}

async function quietHours(ctx: ReturnType<typeof setup>['ctx']) {
  await updateSettings(
    ctx.db,
    { timeZone: 'Africa/Lagos', quietHoursStart: '22:00', quietHoursEnd: '07:00', maxNotificationsPerDay: 0 },
    ctx.defaults,
  );
}

const deliveriesOf = (reminderId: string) =>
  testDb.db.reminderDelivery.findMany({ where: { reminderId }, orderBy: { attempt: 'asc' } });

describe('starvation', () => {
  it('a new due reminder is delivered although 60 older ones are deferred', async () => {
    const { ctx, clock, notifier, scheduler } = setup();
    await updateSettings(ctx.db, { maxNotificationsPerDay: 0 }, ctx.defaults);
    const now = clock.now();
    // 60 older due reminders whose attempts are deferred into the future (as
    // quiet hours or the daily cap leave them): more than one batch of 50.
    for (let i = 0; i < 60; i += 1) {
      const remindAt = new Date(now.getTime() - (120 - i) * 60_000);
      const r = await testDb.db.reminder.create({ data: { title: `Deferred ${i}`, remindAt } });
      const key = `${r.id}:${remindAt.toISOString()}`;
      await testDb.db.reminderDelivery.create({
        data: {
          reminderId: r.id,
          scheduledFor: remindAt,
          occurrenceKey: key,
          idempotencyKey: `${key}:1`,
          nextRetryAt: new Date(now.getTime() + 3 * 3_600_000),
          error: 'deferred: quiet hours',
        },
      });
    }
    const fresh = await createReminder(ctx, { title: 'Fresh one', remindAt: new Date(now.getTime() - 60_000).toISOString() });

    const report = await scheduler.tick();

    expect(report.due).toBe(1);
    expect(notifier.sent.map((m) => m.text).filter((t) => t.includes('Fresh one'))).toHaveLength(1);
    expect((await testDb.db.reminder.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe('SENT');
    // The deferred ones were left exactly as they were.
    expect(await testDb.db.reminderDelivery.count({ where: { status: 'PENDING', error: 'deferred: quiet hours' } })).toBe(60);
  });

  it('during quiet hours, every one of 61 due reminders is queued once and delivered once when they end', async () => {
    const { ctx, clock, notifier, scheduler } = setup({ at: '2026-11-27T22:00:00.000Z' }); // 23:00 Lagos
    await quietHours(ctx);
    const ids: string[] = [];
    for (let i = 0; i < 60; i += 1) {
      const r = await createReminder(ctx, {
        title: `Night ${i}`,
        remindAt: new Date(clock.now().getTime() - (90 - i) * 60_000).toISOString(),
      });
      ids.push(r.id);
    }

    const first = await scheduler.tick();
    const second = await scheduler.tick();
    expect(first.due).toBe(50);
    expect(first.deferred).toBe(50);
    // The 10 that did not fit are queued next, not the same 50 again.
    expect(second.due).toBe(10);
    expect(second.deferred).toBe(10);

    clock.advanceMs(60_000);
    const late = await createReminder(ctx, { title: 'Night late', remindAt: clock.now().toISOString() });
    ids.push(late.id);
    const third = await scheduler.tick();
    expect(third.due).toBe(1);

    // Each reminder has exactly one attempt, deferred to the end of quiet hours.
    const rows = await testDb.db.reminderDelivery.findMany({ where: { reminderId: { in: ids } } });
    expect(rows).toHaveLength(61);
    expect(new Set(rows.map((r) => r.reminderId)).size).toBe(61);
    expect(rows.every((r) => r.status === 'PENDING' && r.nextRetryAt?.toISOString() === '2026-11-28T06:00:00.000Z')).toBe(true);
    expect(notifier.sent).toHaveLength(0);

    // 07:00 Lagos: everything goes out, once each (two batches of up to 50).
    clock.set(new Date('2026-11-28T06:00:00.000Z'));
    await scheduler.tick();
    await scheduler.tick();
    await scheduler.tick();
    expect(notifier.sent).toHaveLength(61);
    expect(new Set(notifier.sent.map((m) => m.idempotencyKey)).size).toBe(61);
    expect(await testDb.db.reminder.count({ where: { id: { in: ids }, status: 'SENT' } })).toBe(61);
  }, 120_000);
});

describe('an outstanding attempt cannot hold a reminder back for ever', () => {
  it('a send that throws leaves the attempt SENDING; it is re-queued once stale, without a restart', async () => {
    const base = scriptedNotifier({ available: true });
    let crash = true;
    const notifier: ScriptedNotifier = {
      ...base,
      async send(message) {
        if (crash) {
          crash = false;
          base.sent.push(message);
          throw new Error('injected: the network stack crashed mid-send');
        }
        return base.send(message);
      },
    };
    const { ctx, clock, scheduler } = setup({ notifier });
    const r = await createReminder(ctx, { title: 'Crashy', remindAt: new Date(clock.now().getTime() - 60_000).toISOString() });

    await scheduler.tick();
    expect((await deliveriesOf(r.id)).map((d) => d.status)).toEqual(['SENDING']);

    // Not stale yet: no second attempt, and no second row for the occurrence.
    clock.advanceMs(60_000);
    const early = await scheduler.tick();
    expect(early.requeued).toBe(0);
    expect(early.due).toBe(0);
    expect(base.sent).toHaveLength(1);
    expect(await deliveriesOf(r.id)).toHaveLength(1);

    // Stale: the same attempt (same idempotency key) is retried and delivered.
    clock.advanceMs(DEFAULT_STALE_CLAIM_MS);
    const later = await scheduler.tick();
    expect(later.requeued).toBe(1);
    expect(later.delivered).toBe(1);
    const rows = await deliveriesOf(r.id);
    expect(rows.map((d) => d.status)).toEqual(['DELIVERED']);
    expect(base.sent.map((m) => m.idempotencyKey)).toEqual([rows[0]!.idempotencyKey, rows[0]!.idempotencyKey]);
    expect((await testDb.db.reminder.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('SENT');
  });

  it('a PENDING attempt without a time is still processed', async () => {
    const { ctx, clock, notifier, scheduler } = setup();
    const r = await createReminder(ctx, { title: 'No time', remindAt: new Date(clock.now().getTime() - 60_000).toISOString() });
    const key = `${r.id}:${new Date(r.remindAt).toISOString()}`;
    await testDb.db.reminderDelivery.create({
      data: { reminderId: r.id, scheduledFor: new Date(r.remindAt), occurrenceKey: key, idempotencyKey: `${key}:1`, nextRetryAt: null },
    });

    const report = await scheduler.tick();

    expect(report.delivered).toBe(1);
    expect(notifier.sent).toHaveLength(1);
    expect((await deliveriesOf(r.id)).map((d) => d.status)).toEqual(['DELIVERED']);
  });
});

/** A db whose next matching write throws once, also inside transactions. */
function flakyDb() {
  const fail = { reminderUpdateMany: false, retryCreate: false };
  const db = (testDb.db as unknown as { $extends: (definition: unknown) => unknown }).$extends({
    query: {
      reminder: {
        updateMany({ args, query }: { args: unknown; query: (a: unknown) => Promise<unknown> }) {
          if (fail.reminderUpdateMany) {
            fail.reminderUpdateMany = false;
            throw new Error('injected: reminder.updateMany failed');
          }
          return query(args);
        },
      },
      reminderDelivery: {
        create({ args, query }: { args: { data: { attempt?: number } }; query: (a: unknown) => Promise<unknown> }) {
          if (fail.retryCreate && (args.data.attempt ?? 1) > 1) {
            fail.retryCreate = false;
            throw new Error('injected: retry create failed');
          }
          return query(args);
        },
      },
    },
  }) as Db;
  return { db, fail };
}

describe('recording an outcome is atomic', () => {
  it('a failed "delivered" record leaves the attempt SENDING, never a SCHEDULED reminder with a DELIVERED attempt', async () => {
    const { db, fail } = flakyDb();
    const { ctx, clock, notifier, scheduler } = setup({ db });
    const r = await createReminder(ctx, { title: 'Record me', remindAt: new Date(clock.now().getTime() - 60_000).toISOString() });

    fail.reminderUpdateMany = true;
    await scheduler.tick();
    expect(notifier.sent).toHaveLength(1);
    expect((await deliveriesOf(r.id)).map((d) => d.status)).toEqual(['SENDING']);
    expect((await testDb.db.reminder.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('SCHEDULED');

    // At-least-once: once stale it is sent again and recorded properly.
    clock.advanceMs(DEFAULT_STALE_CLAIM_MS + 1000);
    await scheduler.tick();
    expect(notifier.sent).toHaveLength(2);
    expect((await deliveriesOf(r.id)).map((d) => d.status)).toEqual(['DELIVERED']);
    expect((await testDb.db.reminder.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('SENT');
  });

  it('a failed "failed + retry" record leaves the attempt SENDING, never a SCHEDULED reminder with only a FAILED attempt', async () => {
    const { db, fail } = flakyDb();
    const notifier = scriptedNotifier({ available: true, outcomes: [{ ok: false, retryable: true, error: 'timeout' }, { ok: true }] });
    const { ctx, clock, scheduler } = setup({ db, notifier });
    const r = await createReminder(ctx, { title: 'Retry me', remindAt: new Date(clock.now().getTime() - 60_000).toISOString() });

    fail.retryCreate = true;
    await scheduler.tick();
    expect((await deliveriesOf(r.id)).map((d) => d.status)).toEqual(['SENDING']);
    const unchanged = await testDb.db.reminder.findUniqueOrThrow({ where: { id: r.id } });
    expect(unchanged.status).toBe('SCHEDULED');
    expect(unchanged.attempts).toBe(0);

    clock.advanceMs(DEFAULT_STALE_CLAIM_MS + 1000);
    await scheduler.tick();
    expect((await deliveriesOf(r.id)).map((d) => d.status)).toEqual(['DELIVERED']);
    expect((await testDb.db.reminder.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('SENT');
  });

  it('a normal retryable failure still records FAILED plus exactly one next attempt', async () => {
    const notifier = scriptedNotifier({ available: true, outcomes: [{ ok: false, retryable: true, error: 'timeout' }] });
    const { ctx, clock, scheduler } = setup({ notifier });
    const r = await createReminder(ctx, { title: 'Retry normal', remindAt: new Date(clock.now().getTime() - 60_000).toISOString() });

    await scheduler.tick();

    const rows = await deliveriesOf(r.id);
    expect(rows.map((d) => [d.attempt, d.status])).toEqual([
      [1, 'FAILED'],
      [2, 'PENDING'],
    ]);
    expect(rows[1]!.idempotencyKey).toBe(rows[0]!.idempotencyKey.replace(/:1$/, ':2'));
    const after = await testDb.db.reminder.findUniqueOrThrow({ where: { id: r.id } });
    expect(after.status).toBe('SCHEDULED');
    expect(after.attempts).toBe(1);
  });
});

describe('restart and duplicate prevention', () => {
  it('a restart during quiet hours keeps each deferral as it was and creates no second attempt', async () => {
    const { ctx, clock, notifier, scheduler, newScheduler } = setup({ at: '2026-11-27T22:00:00.000Z' });
    await quietHours(ctx);
    for (let i = 0; i < 5; i += 1) {
      await createReminder(ctx, { title: `Quiet ${i}`, remindAt: new Date(clock.now().getTime() - i * 60_000).toISOString() });
    }
    await scheduler.tick();
    const before = await testDb.db.reminderDelivery.findMany({ orderBy: { id: 'asc' } });
    expect(before).toHaveLength(5);

    // "Restart": a fresh scheduler runs startup recovery and its first tick.
    clock.advanceMs(10 * 60_000);
    const restarted = newScheduler();
    const recovery = await restarted.recover();
    await restarted.tick();
    expect(recovery).toEqual({ missed: 0, requeued: 0, briefingsRequeued: 0 });
    const after = await testDb.db.reminderDelivery.findMany({ orderBy: { id: 'asc' } });
    expect(after.map((d) => [d.id, d.status, d.nextRetryAt?.toISOString()])).toEqual(
      before.map((d) => [d.id, d.status, d.nextRetryAt?.toISOString()]),
    );
    expect(notifier.sent).toHaveLength(0);

    clock.set(new Date('2026-11-28T06:00:00.000Z'));
    await restarted.tick();
    expect(notifier.sent).toHaveLength(5);
  });

  it('a restart re-queues an attempt interrupted mid-send and delivers it once', async () => {
    const { ctx, clock, notifier, newScheduler } = setup();
    const r = await createReminder(ctx, { title: 'Interrupted', remindAt: new Date(clock.now().getTime() - 60_000).toISOString() });
    const key = `${r.id}:${new Date(r.remindAt).toISOString()}`;
    await testDb.db.reminderDelivery.create({
      data: {
        reminderId: r.id,
        status: 'SENDING',
        scheduledFor: new Date(r.remindAt),
        occurrenceKey: key,
        idempotencyKey: `${key}:1`,
        attemptedAt: new Date(clock.now().getTime() - DEFAULT_STALE_CLAIM_MS - 1000),
        nextRetryAt: null,
      },
    });

    const restarted = newScheduler();
    expect((await restarted.recover()).requeued).toBe(1);
    await restarted.tick();
    await restarted.tick();

    expect(notifier.sent).toHaveLength(1);
    expect((await deliveriesOf(r.id)).map((d) => d.status)).toEqual(['DELIVERED']);
  });

  it('two schedulers ticking at once send each occurrence exactly once', async () => {
    const { ctx, clock, notifier, scheduler, newScheduler } = setup();
    const ids: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      const r = await createReminder(ctx, { title: `Race ${i}`, remindAt: new Date(clock.now().getTime() - i * 60_000).toISOString() });
      ids.push(r.id);
    }
    const other = newScheduler();

    await Promise.all([scheduler.tick(), other.tick(), scheduler.tick(), other.tick()]);
    await Promise.all([scheduler.tick(), other.tick()]);

    expect(notifier.sent).toHaveLength(8);
    expect(new Set(notifier.sent.map((m) => m.idempotencyKey)).size).toBe(8);
    for (const id of ids) expect(await deliveriesOf(id)).toHaveLength(1);
  });
});
