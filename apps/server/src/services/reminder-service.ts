/**
 * Reminders: creation, editing, cancelling, snoozing and recurrence.
 *
 * The schedule lives in the database (`reminders.remind_at`), never in an
 * in-memory timer, so it survives a restart. Delivery bookkeeping lives in
 * `reminder_deliveries` (see `reminder-scheduler.ts`).
 */
import type { ReminderCreateInput, ReminderDto, ReminderUpdateInput, SnoozeInput } from '@recall/shared';

import type { AppContext } from '../context.js';
import { withTransaction, type Db } from '../db/client.js';
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
    orderBy: [{ remindAt: filter.order ?? 'asc' }, { id: filter.order ?? 'asc' }],
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
  if (filter.captureId) where.captureId = filter.captureId;
  if (filter.includeSeriesChildren === false) where.parentId = null;
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
/* Occurrence identity and recurrence advance                                  */
/* -------------------------------------------------------------------------- */

/**
 * Identity of one logical occurrence: `<reminderId>:<scheduledForIso>`.
 *
 * Including the instant is what makes a reschedule safe: snoozing or editing a
 * reminder changes `remindAt`, so the next attempt belongs to a new occurrence
 * namespace and cannot collide with a delivery recorded for the old time.
 */
export function occurrenceKeyFor(reminderId: string, scheduledFor: Date): string {
  return `${reminderId}:${scheduledFor.toISOString()}`;
}

/** HARD bound on how far a series may be advanced in one step. */
export const MAX_RECURRENCE_ADVANCE_STEPS = 1000;

export interface AdvanceRecurrenceResult {
  /** First occurrence strictly after `notBefore`, or null when exhausted. */
  occurrence: Date | null;
  /** Occurrences skipped over (because the service was offline past them). */
  skipped: number;
}

/**
 * Walks a recurrence forward to the first occurrence after `notBefore`.
 *
 * This is what stops a long outage from turning into a burst of notifications:
 * a daily series that has been unreachable for a month advances here instead of
 * generating thirty overlapping occurrences. `until` and `maxOccurrences` still
 * apply, and the loop is hard-capped.
 */
export function advanceRecurrence(input: {
  recurrence: NonNullable<ReminderDto['recurrence']>;
  lastOccurrenceUtc: Date;
  occurrenceCount: number;
  timeZone: string;
  notBefore?: Date;
}): AdvanceRecurrenceResult {
  const { recurrence, timeZone, notBefore } = input;
  let last = input.lastOccurrenceUtc;
  let count = input.occurrenceCount;
  let skipped = 0;

  for (let step = 0; step < MAX_RECURRENCE_ADVANCE_STEPS; step += 1) {
    const candidate = computeNextOccurrence({
      recurrence,
      lastOccurrenceUtc: last,
      occurrenceCount: count,
      timeZone,
    });
    if (!candidate) return { occurrence: null, skipped };
    last = candidate;
    count += 1;
    if (!notBefore || candidate.getTime() > notBefore.getTime()) {
      return { occurrence: candidate, skipped };
    }
    skipped += 1;
  }
  return { occurrence: null, skipped };
}

/** The plain-text body of a due reminder. Channel-neutral: no markup. */
export function formatReminderNotification(reminder: {
  title: string;
  body: string | null;
}): string {
  const title = reminder.title.trim();
  const body = reminder.body?.trim();
  return body ? `Reminder: ${title}\n\n${body}` : `Reminder: ${title}`;
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

  // Changing the schedule (or the rule) invalidates the occurrences already
  // generated from the old definition; they are cancelled, not deleted, so the
  // history stays readable. The series then restarts from this reminder.
  const scheduleChanged = remindAt !== undefined || patch.recurrence !== undefined;
  // One transaction (R3-04): the new schedule, the cancelled old occurrences and
  // the skipped old attempts land together, so an attempt for the old time can
  // never survive a failed edit.
  const row = await withTransaction(db, async (tx) => {
    if (scheduleChanged) {
      const children = await tx.reminder.findMany({
        where: { parentId: id, status: 'SCHEDULED' },
        select: { id: true },
      });
      if (children.length > 0) {
        const ids = children.map((child) => child.id);
        await tx.reminder.updateMany({ where: { id: { in: ids } }, data: { status: 'CANCELLED' } });
        // As cancel does: the old occurrences' armed attempts are skipped too.
        await skipOutstandingDeliveries(tx, ids, 'series rescheduled', ctx.clock.now());
      }
    }

    const updated = await tx.reminder.update({
      where: { id },
      data: {
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.body === undefined ? {} : { body: patch.body ?? null }),
        ...(remindAt === undefined ? {} : { remindAt }),
        ...(patch.recurrence === undefined
          ? {}
          : { recurrence: patch.recurrence ? JSON.stringify(patch.recurrence) : null }),
        // Editing resets a cancelled/failed reminder and, when the schedule moved,
        // restarts the attempt count so a stale failure is not carried forward.
        ...(existing.status === 'CANCELLED' || existing.status === 'FAILED'
          ? { status: 'SCHEDULED', attempts: 0, lastError: null }
          : {}),
        ...(scheduleChanged ? { attempts: 0, lastError: null, deliveredAt: null } : {}),
      },
    });
    if (scheduleChanged) {
      await skipOutstandingDeliveries(tx, [id], 'reminder rescheduled', ctx.clock.now());
    }
    return updated;
  });
  return toReminderDto(row as ReminderRow);
}

/**
 * Cancels a reminder. Cancelling a series head cancels the occurrences generated
 * from it too, because "cancel the daily one" must not leave tomorrow's copy
 * armed. The reminder itself is kept (status `CANCELLED`) rather than deleted.
 *
 * One transaction (R3-04): a failure part-way can never leave a cancelled
 * reminder with deliveries still armed, or a half-cancelled series.
 */
export async function cancelReminder(ctx: AppContext, id: string): Promise<ReminderDto> {
  const existing = await ctx.db.reminder.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Reminder', id);

  const now = ctx.clock.now();
  const row = await withTransaction(ctx.db, async (tx) => {
    const cancelled = await tx.reminder.update({ where: { id }, data: { status: 'CANCELLED' } });
    await skipOutstandingDeliveries(tx, [id], 'reminder cancelled', now);

    const children = await tx.reminder.findMany({
      where: { parentId: id, status: 'SCHEDULED' },
      select: { id: true },
    });
    if (children.length > 0) {
      const ids = children.map((child) => child.id);
      await tx.reminder.updateMany({ where: { id: { in: ids } }, data: { status: 'CANCELLED' } });
      await skipOutstandingDeliveries(tx, ids, 'series cancelled', now);
    }
    return cancelled;
  });
  return toReminderDto(row as ReminderRow);
}

/**
 * Snooze moves the reminder forward. The original delivery attempt is marked
 * SKIPPED so a retry cannot fire at the old time.
 *
 * A cancelled reminder is not snoozed: reviving it silently would resurrect
 * something the owner explicitly stopped.
 */
export async function snoozeReminder(
  ctx: AppContext,
  id: string,
  input: SnoozeInput,
): Promise<ReminderDto> {
  const db = ctx.db;
  const existing = await db.reminder.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Reminder', id);
  if (existing.status === 'CANCELLED') {
    throw new ValidationError('That reminder was cancelled. Create a new one instead.');
  }

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

  // One transaction (R3-04): the new time and the skipped old attempts land
  // together, so a retry can never fire at the old time after a failed snooze.
  const row = await withTransaction(db, async (tx) => {
    const snoozed = await tx.reminder.update({
      where: { id },
      data: { remindAt: target, status: 'SCHEDULED', attempts: 0, lastError: null, deliveredAt: null },
    });
    await skipOutstandingDeliveries(tx, [id], 'snoozed', ctx.clock.now(), ['PENDING', 'SENDING', 'FAILED']);
    return snoozed;
  });
  return toReminderDto(row as ReminderRow);
}

/** Deletes a reminder and the pending occurrences generated from it. */
export async function deleteReminder(db: Db, id: string): Promise<void> {
  const existing = await db.reminder.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Reminder', id);
  await db.reminder.deleteMany({ where: { parentId: id } });
  await db.reminder.delete({ where: { id } });
}

/** Marks outstanding delivery attempts as skipped (never sent). */
export async function skipOutstandingDeliveries(
  db: Db,
  reminderIds: string[],
  reason: string,
  now: Date,
  statuses: readonly string[] = ['PENDING', 'SENDING'],
): Promise<void> {
  await db.reminderDelivery.updateMany({
    where: { reminderId: { in: reminderIds }, status: { in: [...statuses] } },
    data: { status: 'SKIPPED', error: reason, attemptedAt: now, nextRetryAt: null },
  });
}

/* -------------------------------------------------------------------------- */
/* Queries used by the Telegram commands and the dashboard                     */
/* -------------------------------------------------------------------------- */

/**
 * Upcoming reminders, plus ones that already failed or passed their time without
 * being resolved — those are the ones a user most needs to see.
 */
export async function findUpcomingReminders(
  db: Db,
  options: { limit?: number; includeFailed?: boolean } = {},
): Promise<ReminderDto[]> {
  const rows = await db.reminder.findMany({
    where: { status: { in: options.includeFailed === false ? ['SCHEDULED'] : ['SCHEDULED', 'FAILED'] } },
    orderBy: { remindAt: 'asc' },
    take: options.limit ?? 20,
  });
  return rows.map((row) => toReminderDto(row as ReminderRow));
}

export interface ReminderMatch {
  reminder: ReminderDto | null;
  /** True when the prefix matched more than one reminder. */
  ambiguous: boolean;
}

/** Resolves the short `#abc123` id shown in a list back to a reminder. */
export async function matchReminderByIdPrefix(db: Db, prefix: string): Promise<ReminderMatch> {
  const cleaned = prefix.replace(/^#/, '').trim();
  if (cleaned.length === 0) return { reminder: null, ambiguous: false };
  const rows = await db.reminder.findMany({
    where: { id: { startsWith: cleaned } },
    orderBy: { createdAt: 'desc' },
    take: 2,
  });
  if (rows.length === 0) return { reminder: null, ambiguous: false };
  if (rows.length > 1) return { reminder: null, ambiguous: true };
  return { reminder: toReminderDto(rows[0] as ReminderRow), ambiguous: false };
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
