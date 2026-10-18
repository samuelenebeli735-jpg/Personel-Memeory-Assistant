/**
 * Reminders: creation, editing, cancelling, snoozing and recurrence.
 *
 * The schedule lives in the database (`reminders.remind_at`), never in an
 * in-memory timer, so it survives a restart. Delivery bookkeeping lives in
 * `reminder_deliveries` (see `reminder-scheduler.ts`).
 */
import type { ReminderCreateInput, ReminderDto, ReminderUpdateInput, SnoozeInput } from '@recall/shared';

import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { addMinutes, formatLocalHuman, toLocal } from '../lib/time.js';
import { parseRecurrence, toReminderDto, toReminderDeliveryDto, type ReminderRow } from '../mappers.js';

export interface ReminderFilter {
  status?: string | string[];
  dueBefore?: Date;
  dueAfter?: Date;
  taskId?: string;
  captureId?: string;
  includeSeriesChildren?: boolean;
  limit?: number;
  offset?: number;
  order?: 'asc' | 'desc';
}

export async function getReminder(db: Db, id: string): Promise<ReminderDto> {
  const row = await db.reminder.findUnique({ where: { id } });
  if (!row) throw new NotFoundError('Reminder', id);
  return toReminderDto(row as ReminderRow);
}

export async function findReminders(db: Db, filter: ReminderFilter = {}): Promise<ReminderDto[]> {
  const where: Record<string, unknown> = {};
  if (filter.status !== undefined) {
    where.status = Array.isArray(filter.status) ? { in: filter.status } : filter.status;
  }
  if (filter.taskId) where.taskId = filter.taskId;
  if (filter.captureId) where.captureId = filter.captureId;
  if (filter.dueBefore || filter.dueAfter) {
    where.remindAt = {
      ...(filter.dueAfter ? { gte: filter.dueAfter } : {}),
      ...(filter.dueBefore ? { lt: filter.dueBefore } : {}),
    };
  }
  if (filter.includeSeriesChildren === false) where.parentId = null;

  const rows = await db.reminder.findMany({
    where,
    orderBy: { remindAt: filter.order ?? 'asc' },
    take: filter.limit ?? 100,
    skip: filter.offset ?? 0,
  });
  return rows.map((row) => toReminderDto(row as ReminderRow));
}

export async function countReminders(db: Db, filter: ReminderFilter = {}): Promise<number> {
  const where: Record<string, unknown> = {};
  if (filter.status !== undefined) {
    where.status = Array.isArray(filter.status) ? { in: filter.status } : filter.status;
  }
  if (filter.taskId) where.taskId = filter.taskId;
  if (filter.dueBefore || filter.dueAfter) {
    where.remindAt = {
      ...(filter.dueAfter ? { gte: filter.dueAfter } : {}),
      ...(filter.dueBefore ? { lt: filter.dueBefore } : {}),
    };
  }
  return db.reminder.count({ where });
}

export async function listDeliveries(db: Db, reminderId: string) {
  const rows = await db.reminderDelivery.findMany({
    where: { reminderId },
    orderBy: { attempt: 'asc' },
  });
  return rows.map(toReminderDeliveryDto);
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                      */
/* -------------------------------------------------------------------------- */

export async function createReminder(
  ctx: AppContext,
  input: ReminderCreateInput,
  options: { db?: Db } = {},
): Promise<ReminderDto> {
  const db = options.db ?? ctx.db;
  const remindAt = new Date(input.remindAt);
  if (Number.isNaN(remindAt.getTime())) throw new ValidationError('remindAt is not a valid date');

  if (input.taskId) {
    const task = await db.task.findUnique({ where: { id: input.taskId } });
    if (!task) throw new NotFoundError('Task', input.taskId);
  }

  const row = await db.reminder.create({
    data: {
      title: input.title,
      body: input.body ?? null,
      remindAt,
      taskId: input.taskId ?? null,
      captureId: input.captureId ?? null,
      recurrence: input.recurrence ? JSON.stringify(input.recurrence) : null,
      status: 'SCHEDULED',
      // Only generated occurrences carry a key; the series head is identified by
      // its own id. SQLite allows several NULLs in a unique index.
      occurrenceKey: null,
    },
  });
  return toReminderDto(row as ReminderRow);
}

export async function updateReminder(
  ctx: AppContext,
  id: string,
  patch: ReminderUpdateInput,
): Promise<ReminderDto> {
  const db = ctx.db;
  const existing = await db.reminder.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Reminder', id);
  if (existing.status === 'SENT') {
    // Editing a delivered reminder would misrepresent history; clone instead.
    throw new ValidationError('This reminder was already delivered. Create a new one instead.');
  }

  const remindAt = patch.remindAt ? new Date(patch.remindAt) : undefined;
  if (remindAt && Number.isNaN(remindAt.getTime())) {
    throw new ValidationError('remindAt is not a valid date');
  }

  const row = await db.reminder.update({
    where: { id },
    data: {
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.body === undefined ? {} : { body: patch.body ?? null }),
      ...(remindAt === undefined ? {} : { remindAt }),
      ...(patch.recurrence === undefined
        ? {}
        : { recurrence: patch.recurrence ? JSON.stringify(patch.recurrence) : null }),
      // Editing resets a cancelled reminder to scheduled, and clears failure state.
      ...(existing.status === 'CANCELLED' || existing.status === 'FAILED'
        ? { status: 'SCHEDULED', attempts: 0, lastError: null }
        : {}),
    },
  });
  if (remindAt !== undefined) {
    await db.reminderDelivery.updateMany({
      where: { reminderId: id, status: 'PENDING' },
      data: { status: 'SKIPPED', error: 'reminder rescheduled', attemptedAt: ctx.clock.now() },
    });
  }
  return toReminderDto(row as ReminderRow);
}

export async function cancelReminder(ctx: AppContext, id: string): Promise<ReminderDto> {
  const db = ctx.db;
  const existing = await db.reminder.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Reminder', id);

  const row = await db.reminder.update({ where: { id }, data: { status: 'CANCELLED' } });
  await db.reminderDelivery.updateMany({
    where: { reminderId: id, status: 'PENDING' },
    data: { status: 'SKIPPED', error: 'reminder cancelled', attemptedAt: ctx.clock.now() },
  });
  return toReminderDto(row as ReminderRow);
}

/**
 * Snooze moves the reminder forward. The original delivery attempt is marked
 * SKIPPED so a retry cannot fire at the old time.
 */
export async function snoozeReminder(
  ctx: AppContext,
  id: string,
  input: SnoozeInput,
): Promise<ReminderDto> {
  const db = ctx.db;
  const existing = await db.reminder.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Reminder', id);

  if (input.minutes === undefined && input.until === undefined) {
    throw new ValidationError('Provide either minutes or an absolute time to snooze until');
  }
  if (input.minutes !== undefined && input.until !== undefined) {
    throw new ValidationError('Provide either minutes or until, not both');
  }

  const target =
    input.minutes !== undefined
      ? addMinutes(ctx.clock.now(), input.minutes)
      : new Date(input.until as string);
  if (Number.isNaN(target.getTime())) throw new ValidationError('Snooze target is not a valid date');
  if (target.getTime() <= ctx.clock.now().getTime()) {
    throw new ValidationError('Snooze target must be in the future');
  }

  const row = await db.reminder.update({
    where: { id },
    data: { remindAt: target, status: 'SCHEDULED', attempts: 0, lastError: null, deliveredAt: null },
  });
  await db.reminderDelivery.updateMany({
    where: { reminderId: id, status: { in: ['PENDING', 'FAILED'] } },
    data: { status: 'SKIPPED', error: 'snoozed', attemptedAt: ctx.clock.now() },
  });
  return toReminderDto(row as ReminderRow);
}

export async function deleteReminder(db: Db, id: string): Promise<void> {
  const existing = await db.reminder.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Reminder', id);
  await db.reminder.delete({ where: { id } });
}

/* -------------------------------------------------------------------------- */
/* Recurrence                                                                  */
/* -------------------------------------------------------------------------- */

export interface NextOccurrenceInput {
  recurrence: NonNullable<ReminderDto['recurrence']>;
  /** The most recent occurrence's UTC instant (series head or last child). */
  lastOccurrenceUtc: Date;
  /** Number of occurrences already generated, including the head. */
  occurrenceCount: number;
  timeZone: string;
}

/**
 * Computes the next occurrence of a recurring reminder, keeping the local
 * wall-clock time stable across DST changes.
 * Returns null when the series is exhausted.
 */
export function computeNextOccurrence(input: NextOccurrenceInput): Date | null {
  const { recurrence, lastOccurrenceUtc, occurrenceCount, timeZone } = input;
  if (occurrenceCount >= recurrence.maxOccurrences) return null;

  const local = toLocal(lastOccurrenceUtc, timeZone);
  if (!local.isValid) return null;

  let next: typeof local | null = null;
  if (recurrence.frequency === 'DAILY') {
    next = local.plus({ days: 1 });
  } else if (recurrence.frequency === 'MONTHLY') {
    next = local.plus({ months: 1 });
  } else {
    const weekdays = recurrence.weekdays.length > 0 ? recurrence.weekdays : [local.weekday % 7];
    const currentDow = local.weekday % 7; // luxon 1..7 (Mon..Sun) -> 0..6 (Sun..Sat)
    const sorted = [...weekdays].sort((a, b) => a - b);
    const nextDow = sorted.find((d) => d > currentDow);
    const daysAhead = nextDow !== undefined ? nextDow - currentDow : 7 - currentDow + (sorted[0] ?? 0);
    next = local.plus({ days: daysAhead });
  }

  if (!next || !next.isValid) return null;
  const candidate = next.toUTC().toJSDate();
  if (recurrence.until) {
    const until = new Date(recurrence.until);
    if (!Number.isNaN(until.getTime()) && candidate.getTime() > until.getTime()) return null;
  }
  return candidate;
}

export function describeReminder(reminder: ReminderDto, timeZone: string): string {
  const when = formatLocalHuman(new Date(reminder.remindAt), timeZone);
  if (!reminder.recurrence) return when;
  const { frequency, weekdays } = reminder.recurrence;
  if (frequency === 'DAILY') return `${when} (daily)`;
  if (frequency === 'MONTHLY') return `${when} (monthly)`;
  const names = weekdays
    .map((d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d] ?? '')
    .filter(Boolean)
    .join('/');
  return `${when} (weekly${names ? `: ${names}` : ''})`;
}

export { parseRecurrence };
