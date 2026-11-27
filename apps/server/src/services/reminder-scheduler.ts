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
 * a stale `SENDING` row is re-queued rather than dropped, at startup and on
 * every tick (R3-02), so an interrupted attempt never waits for a restart.
 *
 * Starvation (R3-02): a due reminder that already has an outstanding attempt
 * (`PENDING` or `SENDING`) is left out of the "queue an attempt" batch, so
 * reminders deferred by quiet hours or the daily cap can never crowd newer due
 * reminders out of it. An outstanding attempt cannot hold a reminder back for
 * ever: a `PENDING` row is always picked up once its time comes, and a
 * `SENDING` row is re-queued once it is stale.
 *
 * Grace window (R3-02): an occurrence more than `reminderOverdueGraceHours`
 * late is marked `MISSED` instead of fired, at startup *and* on every tick, so a
 * machine that slept (or a scheduler that stalled) never releases a burst of
 * stale notifications. An attempt held back by quiet hours or the daily cap is
 * the owner's own choice: its grace window runs from the time it is released.
 *
 * Liveness (N14): `status().stalled` is true when the loop is running but no
 * tick has finished within `stallLimitMs` (a tick that hangs). The public
 * `/api/health/scheduler` probe turns that into HTTP 503 for the supervisor.
 */
import type { ReminderRecurrence } from '@recall/shared';

import type { AppContext } from '../context.js';
import { withTransaction } from '../db/client.js';
import { backoffDelay } from '../lib/retry.js';
import { parseRecurrence } from '../mappers.js';
import type { Notifier } from '../ports.js';
import {
  advanceRecurrence,
  formatReminderNotification,
  occurrenceKeyFor,
  skipOutstandingDeliveries,
} from './reminder-service.js';
import { getSettings, type SettingsRow } from './settings-service.js';
import {
  DAILY_CAP_REASON_PREFIX,
  gateDelivery,
  NO_CHANNEL_DEFER_MS,
  QUIET_HOURS_REASON,
  type DeliveryGate,
} from './delivery-gate.js';
import { deliverDueBriefing, recoverBriefingDeliveries, type BriefingDeliveryReport } from './briefing-delivery.js';

export const DEFAULT_BATCH_SIZE = 50;
/** Ceiling for reminder retry backoff (individual attempts grow ×2 up to this). */
export const DEFAULT_MAX_BACKOFF_MS = 30 * 60_000;
/** A `SENDING` row older than this is treated as interrupted and re-queued. */
export const DEFAULT_STALE_CLAIM_MS = 5 * 60_000;
/** A running loop with no finished tick for this long is stalled (at least). */
export const MIN_STALL_LIMIT_MS = 5 * 60_000;
/** ... or for this many tick intervals, whichever is longer. */
export const STALL_LIMIT_INTERVALS = 10;
/** Prefix of the error recorded on an attempt that a gate held back. */
const DEFERRED_PREFIX = 'deferred: ';
/** Deferrals the owner's settings asked for (not a missing channel). */
const SETTINGS_DEFERRALS = [QUIET_HOURS_REASON, DAILY_CAP_REASON_PREFIX].map((reason) => DEFERRED_PREFIX + reason);

export interface SchedulerStatusSnapshot {
  running: boolean;
  lastTickAt: string | null;
  dueNow: number;
  scheduledTotal: number;
  /** Running, but no tick has finished within `stallLimitSeconds`. */
  stalled: boolean;
  stallLimitSeconds: number;
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
  /** Occurrences marked MISSED because they are past the grace window. */
  missed: number;
  /** Interrupted (stale `SENDING`) reminder attempts re-queued by this tick. */
  requeued: number;
  /** Next occurrences generated for recurring series. */
  advanced: number;
  /** What the daily briefing did during this tick. */
  briefings: BriefingDeliveryReport;
}

export interface RecoveryReport {
  /** Occurrences past the grace window, marked MISSED instead of fired. */
  missed: number;
  /** Interrupted deliveries re-queued for a retry. */
  requeued: number;
  /** Interrupted briefing deliveries re-queued for a retry. */
  briefingsRequeued: number;
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
  /** How long a running loop may go without a finished tick before it is stalled. */
  stallLimitMs?: number;
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
  const stallLimitMs = options.stallLimitMs ?? Math.max(MIN_STALL_LIMIT_MS, STALL_LIMIT_INTERVALS * intervalMs);
  const timers: SchedulerTimers = options.timers ?? {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
  };

  let handle: unknown = null;
  let ticking = false;
  let lastTickAt: string | null = null;
  /** When the loop started, or the last tick finished: the stall clock. */
  let livenessSince: number | null = null;
  let tickStartedAt: number | null = null;
  let stallReported = false;
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
      requeued: 0,
      advanced: 0,
      briefings: {
        disabled: false,
        due: 0,
        attempts: 0,
        delivered: 0,
        failed: 0,
        deferred: 0,
        skipped: 0,
      },
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
   *
   * The rule itself lives in `delivery-gate.ts` so the daily briefing obeys
   * exactly the same quiet hours and daily cap as a reminder.
   */
  async function gateFor(now: Date, settings: SettingsRow, timeZone: string): Promise<DeliveryGate | null> {
    return gateDelivery(ctx, now, settings, timeZone);
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
          ...(gate ? { error: `${DEFERRED_PREFIX}${gate.reason}` } : {}),
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
          error: `${DEFERRED_PREFIX}${gate.reason}`,
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
      // One transaction: a delivered attempt and a SENT reminder land together.
      // If this write fails the row stays SENDING and is re-queued once stale
      // (at-least-once), instead of leaving a SCHEDULED reminder whose only
      // attempt is DELIVERED, which would never be queued again.
      const marked = await withTransaction(ctx.db, async (tx) => {
        await tx.reminderDelivery.update({
          where: { id: delivery.id },
          data: { status: 'DELIVERED', deliveredAt: now, nextRetryAt: null, error: null },
        });
        // Guarded update: a cancel that raced the send is not overwritten.
        return tx.reminder.updateMany({
          where: { id: reminder.id, status: 'SCHEDULED' },
          data: { status: 'SENT', deliveredAt: now, attempts: delivery.attempt, lastError: null },
        });
      });
      report.delivered += 1;
      if (marked.count > 0) report.advanced += await advanceSeries(reminder, now, settings.timeZone);
      return;
    }

    const error = outcome.error ?? 'delivery failed';
    const retryable = outcome.retryable === true;
    const canRetry = retryable && delivery.attempt < maxAttempts;
    const nextAttempt = delivery.attempt + 1;
    const occurrenceKey = delivery.occurrenceKey ?? occurrenceKeyFor(reminder.id, delivery.scheduledFor);
    const nextKey = `${occurrenceKey}:${nextAttempt}`;

    // One transaction: the failed attempt, the next attempt and the reminder's
    // state land together. A partial write could otherwise leave a SCHEDULED
    // reminder whose only attempt is FAILED, which would never be queued again;
    // if this write fails the row stays SENDING and is re-queued once stale.
    await withTransaction(ctx.db, async (tx) => {
      await tx.reminderDelivery.update({
        where: { id: delivery.id },
        data: { status: 'FAILED', error, nextRetryAt: null },
      });
      if (canRetry) {
        const backoff = backoffDelay(delivery.attempt, retryBaseMs, maxBackoffMs, false);
        // The provider's own guidance (Telegram `retry_after`) wins when it is longer.
        const waitMs = Math.max(backoff, outcome.retryAfterMs ?? 0);
        // The idempotency key is unique, so a retry another process already
        // created is never created twice. Checked rather than caught, because a
        // failed statement would abort the transaction.
        const already = await tx.reminderDelivery.findUnique({
          where: { idempotencyKey: nextKey },
          select: { id: true },
        });
        if (!already) {
          await tx.reminderDelivery.create({
            data: {
              reminderId: reminder.id,
              attempt: nextAttempt,
              status: 'PENDING',
              channel: notifier.channel,
              scheduledFor: delivery.scheduledFor,
              occurrenceKey,
              idempotencyKey: nextKey,
              nextRetryAt: new Date(now.getTime() + waitMs),
              error: `retry ${nextAttempt} after: ${error}`,
            },
          });
        }
      }
      await tx.reminder.update({
        where: { id: reminder.id },
        data: canRetry
          ? { attempts: delivery.attempt, lastError: error }
          : { status: 'FAILED', attempts: delivery.attempt, lastError: error },
      });
    });
    report.failed += 1;
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
      // The interval fired while the previous tick is still running. Say so once
      // when that tick has run past the stall limit (N14).
      const runningForMs = tickStartedAt === null ? 0 : ctx.clock.now().getTime() - tickStartedAt;
      if (runningForMs > stallLimitMs && !stallReported) {
        stallReported = true;
        ctx.logger.error('reminder scheduler stalled: a tick has not finished', {
          runningForSeconds: Math.round(runningForMs / 1000),
          stallLimitSeconds: Math.round(stallLimitMs / 1000),
        });
      }
      return report;
    }
    ticking = true;
    const now = ctx.clock.now();
    tickStartedAt = now.getTime();
    try {
      const settings = await getSettings(ctx.db, ctx.defaults);

      // 0. An attempt interrupted mid-send (the send or its record threw) is
      //    re-queued once stale, so it never waits for a restart. Ticks never
      //    overlap within a process, so a stale claim is not one in flight here.
      try {
        report.requeued = (await requeueStaleClaims(now)).reminders;
      } catch (error) {
        ctx.logger.error('could not re-queue interrupted deliveries', { reason: reasonOf(error) });
      }

      // 0b. Anything past the grace window is marked missed before step 1 can
      //     queue it, so a late wake-up never sends stale notifications.
      try {
        const swept = await sweepMissed(now, settings, 'missed: not delivered within the grace window');
        report.missed = swept.missed;
        report.advanced += swept.advanced;
      } catch (error) {
        ctx.logger.error('could not mark overdue reminders as missed', { reason: reasonOf(error) });
      }

      // 1. Queue an attempt for every due occurrence that does not have one.
      //    Reminders that already have an outstanding attempt (deferred by quiet
      //    hours or the daily cap, waiting for a retry, or mid-send) are left
      //    out, so they cannot fill the batch and starve newer due reminders.
      const due = await ctx.db.reminder.findMany({
        where: {
          status: 'SCHEDULED',
          remindAt: { lte: now },
          deliveries: { none: { status: { in: ['PENDING', 'SENDING'] } } },
        },
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
      //    A PENDING row without a time is treated as due, so it can never sit
      //    unprocessed (and hold its reminder back) for ever.
      const ready = await ctx.db.reminderDelivery.findMany({
        where: { status: 'PENDING', OR: [{ nextRetryAt: { lte: now } }, { nextRetryAt: null }] },
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

      // 3. The daily briefing rides the same loop, so there is one scheduler.
      try {
        report.briefings = await deliverDueBriefing(ctx, now, { notifier });
      } catch (error) {
        report.briefings = {
          disabled: false,
          due: 0,
          attempts: 0,
          delivered: 0,
          failed: 0,
          deferred: 0,
          skipped: 0,
        };
        ctx.logger.error('briefing delivery failed unexpectedly', {
          reason: reasonOf(error),
        });
      }
    } finally {
      ticking = false;
      tickStartedAt = null;
      lastTickAt = now.toISOString();
      // Measured from when the tick finished, so a slow tick does not count twice.
      livenessSince = ctx.clock.now().getTime();
      if (stallReported) {
        stallReported = false;
        ctx.logger.info('reminder scheduler recovered from a stall', {});
      }
      await refreshCounts(now);
    }
    return report;
  }

  /**
   * Re-queues reminder and briefing attempts left in `SENDING` for longer than
   * `staleClaimMs` (a crash, or a send whose record failed): retried, never
   * dropped. A claim always records `attemptedAt`; one without it is stale too.
   */
  async function requeueStaleClaims(now: Date): Promise<{ reminders: number; briefings: number }> {
    const stale = await ctx.db.reminderDelivery.updateMany({
      where: {
        status: 'SENDING',
        OR: [{ attemptedAt: { lt: new Date(now.getTime() - staleClaimMs) } }, { attemptedAt: null }],
      },
      data: {
        status: 'PENDING',
        nextRetryAt: now,
        error: 'recovered after an interrupted delivery',
      },
    });
    const briefings = await recoverBriefingDeliveries(ctx, now, staleClaimMs);
    return { reminders: stale.count, briefings };
  }

  /**
   * Marks SCHEDULED occurrences past the grace window MISSED (one bounded
   * batch), skips their outstanding attempts and advances their series.
   *
   * Left alone: an occurrence with an attempt in flight, and one whose attempt
   * quiet hours or the daily cap is holding back, while that attempt is not
   * itself more than the grace window past its release. A "no channel"
   * deferral does not protect an occurrence: when a channel appears, a day of
   * stale reminders must not arrive at once.
   */
  async function sweepMissed(
    now: Date,
    settings: SettingsRow,
    lastError: string,
  ): Promise<{ missed: number; advanced: number }> {
    const graceCutoff = new Date(now.getTime() - settings.reminderOverdueGraceHours * 3_600_000);
    const overdue = await ctx.db.reminder.findMany({
      where: {
        status: 'SCHEDULED',
        remindAt: { lt: graceCutoff },
        deliveries: {
          none: {
            OR: [
              { status: 'SENDING' },
              {
                status: 'PENDING',
                nextRetryAt: { gte: graceCutoff },
                OR: SETTINGS_DEFERRALS.map((prefix) => ({ error: { startsWith: prefix } })),
              },
            ],
          },
        },
      },
      orderBy: { remindAt: 'asc' },
      take: batchSize,
    });
    const result = { missed: 0, advanced: 0 };
    for (const reminder of overdue) {
      try {
        // The MISSED state and the skipped attempts land together.
        const marked = await withTransaction(ctx.db, async (tx) => {
          const updated = await tx.reminder.updateMany({
            where: { id: reminder.id, status: 'SCHEDULED' },
            data: { status: 'MISSED', lastError },
          });
          if (updated.count === 0) return false;
          await skipOutstandingDeliveries(tx, [reminder.id], 'missed', now);
          return true;
        });
        if (!marked) continue;
        result.missed += 1;
        result.advanced += await advanceSeries(reminder, now, settings.timeZone);
      } catch (error) {
        ctx.logger.error('could not mark an overdue reminder as missed', {
          reminderId: reminder.id,
          reason: reasonOf(error),
        });
      }
    }
    if (result.missed > 0) ctx.logger.info('reminders past the grace window marked missed', { ...result });
    return result;
  }

  async function recover(): Promise<RecoveryReport> {
    const now = ctx.clock.now();
    const settings = await getSettings(ctx.db, ctx.defaults);
    const report: RecoveryReport = { missed: 0, requeued: 0, briefingsRequeued: 0 };

    // A delivery left mid-send by a crash is retried, never dropped. The same
    // rule applies to a briefing that was interrupted mid-send.
    const requeued = await requeueStaleClaims(now);
    report.requeued = requeued.reminders;
    report.briefingsRequeued = requeued.briefings;

    // Anything past the grace window is marked missed, so a returning owner gets
    // one "these were missed" state instead of a burst of late notifications.
    // More than one batch is finished by the ticks that follow.
    report.missed = (await sweepMissed(now, settings, 'missed while the service was offline')).missed;

    if (report.requeued > 0 || report.missed > 0) {
      ctx.logger.info('reminder recovery finished', { ...report });
    }
    return report;
  }

  async function start(): Promise<void> {
    if (handle !== null) return;
    livenessSince = ctx.clock.now().getTime();
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
    livenessSince = null;
    ctx.logger.info('reminder scheduler stopped', {});
  }

  return {
    start,
    stop,
    tick,
    recover,
    status: () => {
      const running = handle !== null;
      const since = livenessSince ?? ctx.clock.now().getTime();
      return {
        running,
        lastTickAt,
        dueNow,
        scheduledTotal,
        stalled: running && ctx.clock.now().getTime() - since > stallLimitMs,
        stallLimitSeconds: Math.round(stallLimitMs / 1000),
      };
    },
  };
}
