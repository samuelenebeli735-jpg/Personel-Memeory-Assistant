/**
 * Atomicity of reminder cancel and snooze (R3-04).
 *
 * Cancel and snooze each change the reminder *and* its outstanding delivery
 * attempts. A failure part-way must leave nothing half-done: never a cancelled
 * reminder with an attempt still armed, a half-cancelled series, or a snoozed
 * reminder whose old attempt can still fire at the old time.
 *
 * The failure is injected through a Prisma client extension, which applies
 * inside transactions too, so the rollback exercised here is SQLite's own.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAppContext, type AppContext } from '../../src/context.js';
import type { Db } from '../../src/db/client.js';
import { advanceableClock } from '../../src/ports.js';
import { cancelReminder, snoozeReminder } from '../../src/services/reminder-service.js';
import { testConfig, testLogger } from '../helpers/app.js';
import { createTestDatabase, type TestDb } from '../helpers/db.js';

const NOW = '2026-11-27T10:00:00.000Z';
let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDatabase('reminder-atomicity');
});

afterAll(async () => {
  await testDb.cleanup();
});

beforeEach(async () => {
  await testDb.reset();
});

function context(db: Db): AppContext {
  return createAppContext({
    config: testConfig(),
    db,
    clock: advanceableClock(NOW),
    logger: testLogger(),
    ai: null,
    stt: null,
  });
}

/** A db whose `<model>.updateMany` throws, also inside transactions. */
function failing(model: 'reminder' | 'reminderDelivery'): Db {
  return (testDb.db as unknown as { $extends: (definition: unknown) => unknown }).$extends({
    query: {
      [model]: {
        updateMany() {
          throw new Error(`injected: ${model}.updateMany failed`);
        },
      },
    },
  }) as Db;
}

async function reminderWithPendingAttempt(title: string, parentId?: string) {
  const remindAt = new Date('2026-11-27T09:55:00.000Z');
  const reminder = await testDb.db.reminder.create({
    data: { title, remindAt, ...(parentId ? { parentId, occurrenceKey: `${parentId}:${title}` } : {}) },
  });
  const occurrenceKey = `${reminder.id}:${remindAt.toISOString()}`;
  await testDb.db.reminderDelivery.create({
    data: {
      reminderId: reminder.id,
      scheduledFor: remindAt,
      occurrenceKey,
      idempotencyKey: `${occurrenceKey}:1`,
      // Deferred (e.g. quiet hours): due again later.
      nextRetryAt: new Date('2026-11-27T11:00:00.000Z'),
    },
  });
  return reminder;
}

const statusOf = async (id: string) => (await testDb.db.reminder.findUniqueOrThrow({ where: { id } })).status;
const deliveryStatuses = async (reminderId: string) =>
  (await testDb.db.reminderDelivery.findMany({ where: { reminderId } })).map((d) => d.status);

describe('cancel is atomic', () => {
  it('rolls the cancellation back when skipping the armed attempt fails', async () => {
    const reminder = await reminderWithPendingAttempt('Call the bank');

    await expect(cancelReminder(context(failing('reminderDelivery')), reminder.id)).rejects.toThrow(/injected/);

    expect(await statusOf(reminder.id)).toBe('SCHEDULED');
    expect(await deliveryStatuses(reminder.id)).toEqual(['PENDING']);
  });

  it('rolls back the head and its attempt when cancelling the series children fails', async () => {
    const head = await reminderWithPendingAttempt('Water plants');
    const child = await reminderWithPendingAttempt('Water plants (next)', head.id);

    await expect(cancelReminder(context(failing('reminder')), head.id)).rejects.toThrow(/injected/);

    expect(await statusOf(head.id)).toBe('SCHEDULED');
    expect(await deliveryStatuses(head.id)).toEqual(['PENDING']);
    expect(await statusOf(child.id)).toBe('SCHEDULED');
    expect(await deliveryStatuses(child.id)).toEqual(['PENDING']);
  });

  it('without a failure, cancels the head, the series and every armed attempt together', async () => {
    const head = await reminderWithPendingAttempt('Water plants');
    const child = await reminderWithPendingAttempt('Water plants (next)', head.id);

    const dto = await cancelReminder(context(testDb.db), head.id);

    expect(dto.status).toBe('CANCELLED');
    expect(await statusOf(head.id)).toBe('CANCELLED');
    expect(await statusOf(child.id)).toBe('CANCELLED');
    expect(await deliveryStatuses(head.id)).toEqual(['SKIPPED']);
    expect(await deliveryStatuses(child.id)).toEqual(['SKIPPED']);
  });
});

describe('snooze is atomic', () => {
  it('keeps the old time and the old attempt when skipping that attempt fails', async () => {
    const reminder = await reminderWithPendingAttempt('Take medicine');

    await expect(
      snoozeReminder(context(failing('reminderDelivery')), reminder.id, { minutes: 30 }),
    ).rejects.toThrow(/injected/);

    const after = await testDb.db.reminder.findUniqueOrThrow({ where: { id: reminder.id } });
    expect(after.remindAt.toISOString()).toBe(reminder.remindAt.toISOString());
    expect(await deliveryStatuses(reminder.id)).toEqual(['PENDING']);
  });

  it('without a failure, moves the time and skips the old attempt together', async () => {
    const reminder = await reminderWithPendingAttempt('Take medicine');

    const dto = await snoozeReminder(context(testDb.db), reminder.id, { minutes: 30 });

    expect(dto.remindAt).toBe('2026-11-27T10:30:00.000Z');
    expect(dto.status).toBe('SCHEDULED');
    expect(await deliveryStatuses(reminder.id)).toEqual(['SKIPPED']);
  });
});
