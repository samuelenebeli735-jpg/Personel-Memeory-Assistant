/**
 * Database-backed reminder scheduler.
 *
 * Design rules, in order of importance:
 *
 *  1. **The database is the schedule.** Nothing that must happen survives only in
 *     a timer. The tick loop only *looks*; `reminders.remind_at` and
 *     `reminder_deliveries` hold the truth, so a restart loses nothing.
 *  2. **Every attempt is a row.** A delivery attempt is claimed by moving a
 *     `PENDING` row to `SENDING` with a conditional update, so two processes (or
 *     two ticks) cannot both send the same occurrence. The unique
 *     `idempotencyKey` (`<reminderId>:<scheduledForIso>:<attempt>`) makes the row
 *     impossible to duplicate.
 *  3. **Never lose a reminder.** Quiet hours, the daily cap and a missing channel
 *     *defer* a delivery (the row stays `PENDING` with a future `nextRetryAt`);
 *     they never consume an attempt and never mark the reminder failed.
 *  4. **Failures are bounded and honest.** A transient failure creates the next
 *     attempt with exponential backoff (and honours the provider's `retry_after`).
 *     Running out of attempts — or a permanent failure — marks the reminder
 *     `FAILED` and leaves it visible.
 *  5. **One bad reminder cannot stop the rest.** Every reminder and every
 *     delivery is processed inside its own try/catch.
 *
 * Delivery guarantee: **at-least-once**. The provider call and the local write
 * cannot share a transaction, so a crash between a successful send and the
 * `DELIVERED` write can repeat one message. Losing a message is not possible;
 * `recover()` re-queues a stale `SENDING` row rather than dropping it.
 */
import type { ReminderRecurrence } from '@recall/shared';

import type { AppContext } from '../context.js';
import { backoffDelay } from '../lib/retry.js';
import {
  isWithinQuietHours,
  nextQuietHoursEnd,
  startOfLocalDay,
  startOfNextLocalDay,
} from '../lib/time.js';
import { parseRecurrence } from '../mappers.js';
import type { Notifier } from '../ports.js';
import {
  advanceRecurrence,
  formatReminderNotification,
  occurrenceKeyFor,
  skipOutstandingDeliveries,
} from './reminder-service.js';
import { getSettings, type SettingsRow } from './settings-service.js';

export const DEFAULT_BATCH_SIZE = 50;
/** Ceiling for reminder retry backoff (individual attempts grow ×2 up to this). */
export const DEFAULT_MAX_BACKOFF_MS = 30 * 60_000;
/** A `SENDING` row older than this is treated as interrupted and re-queued. */
export const DEFAULT_STALE_CLAIM_MS = 5 * 60_000;
/** How long a reminder waits when there is no delivery channel at all. */
export const NO_CHANNEL_DEFER_MS = 15 * 60_000;

export interface SchedulerStatusSnapshot {
  running: boolean;
  lastTickAt: string | null;
  dueNow: number;
  scheduledTotal: number;
}

export interface TickReport {
  /** True when a tick was already running and this call did nothing. */
  skipped: boolean;
  /** Due occurrences examined. */
  due: number;
  /** Provider calls made. */
  attempts: number;
  delivered: number;
  /** Attempts that failed, retryable or not. */
  failed: number;
  /** Pushed to a later time (quiet hours, daily cap, no channel). */
  deferred: number;
  /** Attempts abandoned because the reminder changed state first. */
  abandoned: number;
  /** Occurrences marked MISSED during startup recovery. */
  missed: number;
  /** Next occurrences generated for recurring series. */
  advanced: number;
}

export interface RecoveryReport {
  /** Occurrences past the grace window, marked MISSED instead of fired. */
  missed: number;
  /** Interrupted deliveries re-queued for a retry. */
  requeued: number;
}

/** Injectable timers so tests never rely on a real interval. */
export interface SchedulerTimers {
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

export interface ReminderSchedulerOptions {
  notifier?: Notifier;
  batchSize?: number;
  intervalMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  maxBackoffMs?: number;
  staleClaimMs?: number;
  timers?: SchedulerTimers;
}

export interface ReminderScheduler {
  /** Startup recovery, an immediate tick, then the interval loop. */
  start(): Promise<void>;
  stop(): void;
  /** One pass. Public so tests and the CLI can drive it deterministically. */
  tick(): Promise<TickReport>;
  /** Re-queues interrupted deliveries and misses anything past the grace window. */
  recover(): Promise<RecoveryReport>;
  status(): SchedulerStatusSnapshot;
}

interface Gate {
  reason: string;
  deferUntil: Date;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUniqueViolation(error: unknown): boolean {
  return typeof (error as { code?: unknown })?.code === 'string' && (error as { code: string }).code === 'P2002';
}

export function createReminderScheduler(
  ctx: AppContext,
  options: ReminderSchedulerOptions = {},
): ReminderScheduler {
  const notifier = options.notifier ?? ctx.notifier;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const intervalMs = options.intervalMs ?? ctx.config.locale.schedulerIntervalSeconds * 1000;
  const maxAttempts = options.maxAttempts ?? ctx.config.locale.reminderMaxAttempts;
  const retryBaseMs = options.retryBaseMs ?? ctx.config.locale.reminderRetryBaseSeconds * 1000;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const staleClaimMs = options.staleClaimMs ?? DEFAULT_STALE_CLAIM_MS;
  const timers: SchedulerTimers = options.timers ?? {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
  };

  let handle: unknown = null;
  let ticking = false;
  let lastTickAt: string | null = null;
  let dueNow = 0;
  let scheduledTotal = 0;

  function emptyReport(): TickReport {
    return {
      skipped: false,
      due: 0,
      attempts: 0,
      delivered: 0,
      failed: 0,
      deferred: 0,
      abandoned: 0,
      missed: 0,
      advanced: 0,
    };
  }

  /** Counts shown by the health endpoint, refreshed after every tick. */
  async function refreshCounts(now: Date): Promise<void> {
    try {
      const [due, future] = await Promise.all([
        ctx.db.reminder.count({ where: { status: 'SCHEDULED', remindAt: { lte: now } } }),
        ctx.db.reminder.count({ where: { status: 'SCHEDULED', remindAt: { gt: now } } }),
      ]);
      dueNow = due;
      scheduledTotal = future;
    } catch (error) {
      ctx.logger.warn('could not refresh reminder counts', { reason: reasonOf(error) });
    }
  }

  /**
   * Decides whether a notification may go out now. A result means "not yet":
   * quiet hours end, or the next local day when the cap is reached.
   */
  async function gateFor(now: Date, settings: SettingsRow, timeZone: string): Promise<Gate | null> {
    if (isWithinQuietHours(now, timeZone, settings.quietHoursStart, settings.quietHoursEnd)) {
      const end = nextQuietHoursEnd(now, timeZone, settings.quietHoursStart, settings.quietHoursEnd);
      if (end) return { reason: 'quiet hours', deferUntil: end };
    }
    const cap = settings.maxNotificationsPerDay;
    if (cap > 0) {
      const deliveredToday = await ctx.db.reminderDelivery.count({
        where: {
          status: 'DELIVERED',
          deliveredAt: {
            gte: startOfLocalDay(now, timeZone),
            lt: startOfNextLocalDay(now, timeZone),
          },
        },
      });
      if (deliveredToday >= cap) {
        return {
          reason: `daily notification cap of ${cap} reached`,
          deferUntil: startOfNextLocalDay(now, timeZone),
        };
      }
    }
    return null;
  }

  /**
   * Makes sure a due occurrence has exactly one queued attempt.
   *
   * The existence check is on the occurrence key, so a reminder deferred by quiet
   * hours (which keeps its `SCHEDULED` status and stays due) is not re-queued on
   * every tick.
   */
  async function queueAttempt(
    reminder: { id: string; remindAt: Date; attempts: number },
    now: Date,
    settings: SettingsRow,
    report: TickReport,
  ): Promise<void> {
    const occurrenceKey = occurrenceKeyFor(reminder.id, reminder.remindAt);
    const existing = await ctx.db.reminderDelivery.findFirst({
      where: { reminderId: reminder.id, occurrenceKey },
      select: { id: true },
    });
    if (existing) return;

    const gate = await gateFor(now, settings, settings.timeZone);
    const attempt = Math.max(1, reminder.attempts + 1);
    try {
      await ctx.db.reminderDelivery.create({
        data: {
          reminderId: reminder.id,
          attempt,
          status: 'PENDING',
          channel: notifier.channel,
          scheduledFor: reminder.remindAt,
          occurrenceKey,
          idempotencyKey: `${occurrenceKey}:${attempt}`,
          nextRetryAt: gate ? gate.deferUntil : now,
          ...(gate ? { error: `deferred: ${gate.reason}` } : {}),
        },
      });
      if (gate) report.deferred += 1;
    } catch (error) {
      // Another process queued it between our check and our create.
      if (!isUniqueViolation(error)) throw error;
    }
  }

  /**
   * Generates the next occurrence of a series, if the rule still allows one.
   * Occurrences are created one at a time (bounded), and the unique
   * `occurrenceKey` makes a restart unable to generate a duplicate.
   */
  async function advanceSeries(
    reminder: { id: string; parentId: string | null; remindAt: Date },
    now: Date,
    timeZone: string,
  ): Promise<number> {
    const head = reminder.parentId
      ? await ctx.db.reminder.findUnique({ where: { id: reminder.parentId } })
      : await ctx.db.reminder.findUnique({ where: { id: reminder.id } });
    if (!head) return 0;
    const recurrence: ReminderRecurrence | null = parseRecurrence(head.recurrence);
    if (!recurrence) return 0;

    const children = await ctx.db.reminder.count({ where: { parentId: head.id } });
    const { occurrence } = advanceRecurrence({
      recurrence,
      lastOccurrenceUtc: reminder.remindAt,
      // Occurrences already materialised: the head itself plus every child.
      occurrenceCount: 1 + children,
      timeZone,
      notBefore: now,
    });
    if (!occurrence) return 0;

    const occurrenceKey = `${head.id}:${occurrence.toISOString()}`;
    try {
      await ctx.db.reminder.create({
        data: {
          title: head.title,
          body: head.body,
          remindAt: occurrence,
          status: 'SCHEDULED',
          taskId: head.taskId,
          captureId: head.captureId,
          parentId: head.id,
          occurrenceKey,
          recurrence: null,
        },
      });
      return 1;
    } catch (error) {
      if (isUniqueViolation(error)) return 0;
      throw error;
    }
  }

  /** One delivery attempt: claim, re-check, send, record. */
  async function attemptDelivery(
    delivery: {
      id: string;
      reminderId: string;
      attempt: number;
      occurrenceKey: string | null;
      scheduledFor: Date;
      idempotencyKey: string;
      reminder: { id: string; title: string; body: string | null; status: string; remindAt: Date; parentId: string | null; attempts: number };
    },
    now: Date,
    settings: SettingsRow,
    report: TickReport,
  ): Promise<void> {
    // Claim: only the process that flips PENDING → SENDING may send.
    const claimed = await ctx.db.reminderDelivery.updateMany({
      where: { id: delivery.id, status: 'PENDING' },
      data: { status: 'SENDING', attemptedAt: now },
    });
    if (claimed.count === 0) return;

    const reminder = delivery.reminder;

    // Cancellation (or a completion) always wins over a queued attempt.
    if (reminder.status !== 'SCHEDULED') {
      await ctx.db.reminderDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'SKIPPED',
          error: `reminder is ${reminder.status.toLowerCase()}`,
          nextRetryAt: null,
        },
      });
      report.abandoned += 1;
      return;
    }

    const gate = await gateFor(now, settings, settings.timeZone);
    if (gate) {
      // Nothing was sent, so the attempt budget is untouched.
      await ctx.db.reminderDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'PENDING',
          attemptedAt: null,
          nextRetryAt: gate.deferUntil,
          error: `deferred: ${gate.reason}`,
        },
      });
      report.deferred += 1;
      return;
    }

    if (!notifier.isAvailable()) {
      // A missing channel is a deployment gap, not a failure of this reminder.
      await ctx.db.reminderDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'PENDING',
          attemptedAt: null,
          nextRetryAt: new Date(now.getTime() + NO_CHANNEL_DEFER_MS),
          error: 'deferred: no delivery channel is configured',
        },
      });
      report.deferred += 1;
      return;
    }

    report.attempts += 1;
    const outcome = await notifier.send({
      text: formatReminderNotification(reminder),
      proactive: true,
      idempotencyKey: delivery.idempotencyKey,
    });

    if (outcome.ok) {
      await ctx.db.reminderDelivery.update({
        where: { id: delivery.id },
        data: { status: 'DELIVERED', deliveredAt: now, nextRetryAt: null, error: null },
      });
      // Guarded update: a cancel that raced the send is not overwritten.
      const marked = await ctx.db.reminder.updateMany({
        where: { id: reminder.id, status: 'SCHEDULED' },
        data: { status: 'SENT', deliveredAt: now, attempts: delivery.attempt, lastError: null },
      });
      report.delivered += 1;
      if (marked.count > 0) report.advanced += await advanceSeries(reminder, now, settings.timeZone);
      return;
    }

    const error = outcome.error ?? 'delivery failed';
    const retryable = outcome.retryable === true;
    await ctx.db.reminderDelivery.update({
      where: { id: delivery.id },
      data: { status: 'FAILED', error, nextRetryAt: null },
    });
    report.failed += 1;

    const canRetry = retryable && delivery.attempt < maxAttempts;
    if (canRetry) {
      const backoff = backoffDelay(delivery.attempt, retryBaseMs, maxBackoffMs, false);
      // The provider's own guidance (Telegram `retry_after`) wins when it is longer.
      const waitMs = Math.max(backoff, outcome.retryAfterMs ?? 0);
      const nextAttempt = delivery.attempt + 1;
      const occurrenceKey = delivery.occurrenceKey ?? occurrenceKeyFor(reminder.id, delivery.scheduledFor);
      try {
        await ctx.db.reminderDelivery.create({
          data: {
            reminderId: reminder.id,
            attempt: nextAttempt,
            status: 'PENDING',
            channel: notifier.channel,
            scheduledFor: delivery.scheduledFor,
            occurrenceKey,
            idempotencyKey: `${occurrenceKey}:${nextAttempt}`,
            nextRetryAt: new Date(now.getTime() + waitMs),
            error: `retry ${nextAttempt} after: ${error}`,
          },
        });
      } catch (createError) {
        if (!isUniqueViolation(createError)) throw createError;
      }
    }

    await ctx.db.reminder.update({
      where: { id: reminder.id },
      data: canRetry
        ? { attempts: delivery.attempt, lastError: error }
        : { status: 'FAILED', attempts: delivery.attempt, lastError: error },
    });
    if (!canRetry) {
      ctx.logger.warn('reminder permanently failed', {
        reminderId: reminder.id,
        attempts: delivery.attempt,
        reason: error,
        retryable,
      });
    }
  }

  async function tick(): Promise<TickReport> {
    const report = emptyReport();
    if (ticking) {
      report.skipped = true;
      return report;
    }
    ticking = true;
    const now = ctx.clock.now();
    try {
      const settings = await getSettings(ctx.db, ctx.defaults);

      // 1. Queue an attempt for every due occurrence that does not have one.
      const due = await ctx.db.reminder.findMany({
        where: { status: 'SCHEDULED', remindAt: { lte: now } },
        orderBy: { remindAt: 'asc' },
        take: batchSize,
      });
      report.due = due.length;
      for (const reminder of due) {
        try {
          await queueAttempt(reminder, now, settings, report);
        } catch (error) {
          // A reminder whose queuing failed must not stop the others.
          ctx.logger.error('could not queue a reminder attempt', {
            reminderId: reminder.id,
            reason: reasonOf(error),
          });
        }
      }

      // 2. Attempt everything that is queued and due.
      const ready = await ctx.db.reminderDelivery.findMany({
        where: { status: 'PENDING', nextRetryAt: { lte: now } },
        orderBy: { nextRetryAt: 'asc' },
        take: batchSize,
        include: { reminder: true },
      });
      for (const delivery of ready) {
        try {
          await attemptDelivery(delivery, now, settings, report);
        } catch (error) {
          report.failed += 1;
          ctx.logger.error('reminder delivery attempt failed unexpectedly', {
            deliveryId: delivery.id,
            reminderId: delivery.reminderId,
            reason: reasonOf(error),
          });
        }
      }
    } finally {
      ticking = false;
      lastTickAt = now.toISOString();
      await refreshCounts(now);
    }
    return report;
  }

  async function recover(): Promise<RecoveryReport> {
    const now = ctx.clock.now();
    const settings = await getSettings(ctx.db, ctx.defaults);
    const report: RecoveryReport = { missed: 0, requeued: 0 };

    // A delivery left mid-send by a crash is retried, never dropped.
    const stale = await ctx.db.reminderDelivery.updateMany({
      where: { status: 'SENDING', attemptedAt: { lt: new Date(now.getTime() - staleClaimMs) } },
      data: {
        status: 'PENDING',
        nextRetryAt: now,
        error: 'recovered after an interrupted delivery',
      },
    });
    report.requeued = stale.count;

    // Anything past the grace window is marked missed, so a returning owner gets
    // one "these were missed" state instead of a burst of late notifications.
    const graceCutoff = new Date(now.getTime() - settings.reminderOverdueGraceHours * 3_600_000);
    const overdue = await ctx.db.reminder.findMany({
      where: { status: 'SCHEDULED', remindAt: { lt: graceCutoff } },
      orderBy: { remindAt: 'asc' },
      take: batchSize,
    });
    for (const reminder of overdue) {
      try {
        const updated = await ctx.db.reminder.updateMany({
          where: { id: reminder.id, status: 'SCHEDULED' },
          data: { status: 'MISSED', lastError: 'missed while the service was offline' },
        });
        if (updated.count === 0) continue;
        await skipOutstandingDeliveries(ctx.db, [reminder.id], 'missed', now);
        report.missed += 1;
        await advanceSeries(reminder, now, settings.timeZone);
      } catch (error) {
        ctx.logger.error('could not mark an overdue reminder as missed', {
          reminderId: reminder.id,
          reason: reasonOf(error),
        });
      }
    }

    if (report.requeued > 0 || report.missed > 0) {
      ctx.logger.info('reminder recovery finished', { ...report });
    }
    return report;
  }

  async function start(): Promise<void> {
    if (handle !== null) return;
    const recovery = await recover();
    await tick();
    handle = timers.setInterval(() => {
      void tick().catch((error: unknown) => {
        ctx.logger.error('scheduler tick failed', { reason: reasonOf(error) });
      });
    }, intervalMs);
    ctx.logger.info('reminder scheduler started', {
      intervalMs,
      batchSize,
      maxAttempts,
      channel: notifier.channel,
      channelAvailable: notifier.isAvailable(),
      ...recovery,
    });
  }

  function stop(): void {
    if (handle === null) return;
    timers.clearInterval(handle);
    handle = null;
    ctx.logger.info('reminder scheduler stopped', {});
  }

  return {
    start,
    stop,
    tick,
    recover,
    status: () => ({
      running: handle !== null,
      lastTickAt,
      dueNow,
      scheduledTotal,
    }),
  };
}
