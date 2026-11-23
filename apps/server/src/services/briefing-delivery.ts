/**
 * Scheduled delivery of the daily briefing.
 *
 * This module owns no timer. The reminder scheduler's tick calls it, so the
 * process has exactly one loop and exactly one set of delivery rules — a
 * briefing can never race a reminder for the same daily notification budget.
 *
 * The delivery policy is stated explicitly, because "a daily briefing" is not
 * a precise instruction:
 *
 *  - **One briefing per local day.** The occurrence is the local calendar date
 *    the briefing covers (`YYYY-MM-DD` in the owner's configured zone).
 *  - **Disabled means no scheduled delivery.** `briefingEnabled` is false by
 *    default. Reading a briefing over HTTP still works either way.
 *  - **Deferred, within a deadline.** Quiet hours and the daily cap push an
 *    attempt to a later time; the pending row survives a restart.
 *  - **Sent within 2 hours, or not at all (D59).** The window opens at the
 *    briefing time — or, when that time falls inside quiet hours, when those
 *    quiet hours end — and closes 2 hours later (`BRIEFING_LATE_LIMIT_MS`, real
 *    time, so DST cannot stretch or shrink it). Only that first quiet-hours
 *    delay moves the window; a missing channel, the daily cap, a failed send or
 *    the server being offline never extend it. The deadline governs the start
 *    of the send: it is checked again on the live clock just before the
 *    notifier is called. A briefing still unsent at the
 *    deadline is recorded as `SKIPPED` ("more than 2 hours late"), logged once,
 *    and never sent later by a retry or a restart.
 *  - **A briefing belongs to its own day.** Midnight is a hard stop: the
 *    deadline is the earlier of the 2-hour mark and the end of the briefing's
 *    local day, and a row left from an earlier day is skipped rather than
 *    delivered the next morning: a stale briefing is worse than no briefing.
 *  - **At-least-once, with bounded retries.** A transient failure is retried
 *    with exponential backoff; a permanent failure stops retrying and is
 *    recorded.
 */
import type { AppContext } from '../context.js';
import type { Notifier } from '../ports.js';
import { backoffDelay } from '../lib/retry.js';
import {
  localDateKey,
  localDateTimeToUtc,
  nextQuietHoursEnd,
  startOfNextLocalDay,
} from '../lib/time.js';
import { formatBriefingText, generateBriefing } from './briefing-service.js';
import { gateDelivery, NO_CHANNEL_DEFER_MS } from './delivery-gate.js';
import { getSettings, parseBriefingSections, type SettingsRow } from './settings-service.js';

/** Attempts allowed for one briefing occurrence, including the first. */
export const BRIEFING_MAX_ATTEMPTS = 3;
/** First retry delay; each further attempt doubles it. */
export const BRIEFING_RETRY_BASE_MS = 30_000;
/** Ceiling for a single retry delay. */
export const BRIEFING_MAX_BACKOFF_MS = 30 * 60_000;
/** A briefing is sent at most this long after its window opens (D59). Fixed by design. */
export const BRIEFING_LATE_LIMIT_MS = 2 * 60 * 60_000;
/** Recorded on a briefing that missed its deadline. */
export const BRIEFING_LATE_REASON = 'more than 2 hours late';

/**
 * The last instant a briefing may still be sent (inclusive).
 *
 * The window opens at `scheduledFor`, or at the end of the quiet hours that
 * contain it, and lasts `BRIEFING_LATE_LIMIT_MS`; it never extends past the end
 * of the briefing's own local day. Quiet hours are those currently configured.
 */
export function briefingDeadline(
  scheduledFor: Date,
  settings: Pick<SettingsRow, 'quietHoursStart' | 'quietHoursEnd'>,
  timeZone: string,
): Date {
  const quietEnd = nextQuietHoursEnd(scheduledFor, timeZone, settings.quietHoursStart, settings.quietHoursEnd);
  const opensAt = quietEnd && quietEnd.getTime() > scheduledFor.getTime() ? quietEnd : scheduledFor;
  const lateLimit = opensAt.getTime() + BRIEFING_LATE_LIMIT_MS;
  const endOfDay = startOfNextLocalDay(scheduledFor, timeZone).getTime();
  // Midnight itself belongs to the next day, so the last valid instant is just before it.
  return new Date(Math.min(lateLimit, endOfDay - 1));
}

function isPastDeadline(now: Date, deadline: Date): boolean {
  return now.getTime() > deadline.getTime();
}

export interface BriefingDeliveryOptions {
  /** Attempts allowed per occurrence, including the first. */
  maxAttempts?: number;
  /** Base delay of the retry backoff, in milliseconds. */
  retryBaseMs?: number;
  /** Ceiling of a single retry delay, in milliseconds. */
  maxBackoffMs?: number;
  /** Notification channel; defaults to `ctx.notifier`. */
  notifier?: Notifier;
}

export interface BriefingDeliveryReport {
  /** True when scheduled delivery is switched off. */
  disabled: boolean;
  /** Occurrences that were due for delivery. */
  due: number;
  /** Provider calls made. */
  attempts: number;
  delivered: number;
  /** Attempts that failed, retryable or not. */
  failed: number;
  /** Attempts pushed to a later time (quiet hours, daily cap, no channel). */
  deferred: number;
  /** Occurrences dropped because their day had passed. */
  skipped: number;
}

function emptyReport(disabled = false): BriefingDeliveryReport {
  return { disabled, due: 0, attempts: 0, delivered: 0, failed: 0, deferred: 0, skipped: 0 };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof (error as { code?: unknown })?.code === 'string' && (error as { code: string }).code === 'P2002';
}

/**
 * Delivers the briefing of the current local day, if it is due.
 *
 * Safe to call on every tick: the occurrence is created at most once and an
 * attempt is claimed with a conditional update, so two ticks (or two
 * processes) cannot both send it.
 */
export async function deliverDueBriefing(
  ctx: AppContext,
  now: Date,
  options: BriefingDeliveryOptions = {},
): Promise<BriefingDeliveryReport> {
  const report = emptyReport();
  const settings = await getSettings(ctx.db, ctx.defaults);

  // Disabling the briefing stops the *scheduled* delivery. On-demand retrieval
  // over HTTP is unaffected.
  if (!settings.briefingEnabled) {
    return emptyReport(true);
  }

  const maxAttempts = options.maxAttempts ?? BRIEFING_MAX_ATTEMPTS;
  const retryBaseMs = options.retryBaseMs ?? BRIEFING_RETRY_BASE_MS;
  const maxBackoffMs = options.maxBackoffMs ?? BRIEFING_MAX_BACKOFF_MS;
  const notifier = options.notifier ?? ctx.notifier;
  const timeZone = settings.timeZone;
  const localDate = localDateKey(now, timeZone);

  // A pending briefing from an earlier day is dropped: it belongs to a day
  // that has passed and would only confuse the owner.
  const stale = await ctx.db.briefingDelivery.updateMany({
    where: { status: 'PENDING', occurrenceKey: { not: localDate } },
    data: { status: 'SKIPPED', nextRetryAt: null, error: 'the briefing day had passed' },
  });
  report.skipped += stale.count;

  const scheduledFor = localDateTimeToUtc(localDate, settings.briefingTime, timeZone);
  if (!scheduledFor) {
    ctx.logger.warn('could not resolve the briefing time', { timeZone });
    return report;
  }

  // The occurrence row is the record that "today's briefing" exists and has
  // been handled. Its presence is what stops a second occurrence.
  const existing = await ctx.db.briefingDelivery.findFirst({
    where: { occurrenceKey: localDate },
    select: { id: true, status: true },
  });

  if (!existing) {
    if (now.getTime() < scheduledFor.getTime()) {
      // Not due yet.
      return report;
    }
    if (isPastDeadline(now, briefingDeadline(scheduledFor, settings, timeZone))) {
      // The server was off, or the briefing was switched on, too long after its
      // time. The SKIPPED row takes today's unique key (`<date>:1`), so nothing
      // can send today's briefing afterwards.
      try {
        await ctx.db.briefingDelivery.create({
          data: {
            occurrenceKey: localDate,
            attempt: 1,
            status: 'SKIPPED',
            channel: notifier.channel,
            scheduledFor,
            nextRetryAt: null,
            error: BRIEFING_LATE_REASON,
            idempotencyKey: `${localDate}:1`,
          },
        });
        report.skipped += 1;
        logLateSkip(ctx, localDate, scheduledFor, now);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
      return report;
    }
    try {
      await ctx.db.briefingDelivery.create({
        data: {
          occurrenceKey: localDate,
          attempt: 1,
          status: 'PENDING',
          channel: notifier.channel,
          scheduledFor,
          nextRetryAt: now,
          idempotencyKey: `${localDate}:1`,
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
    report.due += 1;
  } else {
    report.due += 1;
  }

  // Every waiting row of today, due or not: a row deferred past the deadline
  // (daily cap, missing channel, retry backoff, recovered send) is skipped as
  // soon as the deadline passes, not when its own retry time comes.
  const pending = await ctx.db.briefingDelivery.findMany({
    where: { status: 'PENDING', occurrenceKey: localDate },
    orderBy: { nextRetryAt: 'asc' },
    take: 10,
  });

  const ready: typeof pending = [];
  for (const row of pending) {
    if (isPastDeadline(now, briefingDeadline(row.scheduledFor, settings, timeZone))) {
      // Conditional on PENDING: a row another process has already claimed is left alone.
      const skipped = await ctx.db.briefingDelivery.updateMany({
        where: { id: row.id, status: 'PENDING' },
        data: { status: 'SKIPPED', nextRetryAt: null, attemptedAt: null, error: BRIEFING_LATE_REASON },
      });
      if (skipped.count > 0) {
        report.skipped += 1;
        logLateSkip(ctx, row.occurrenceKey, row.scheduledFor, now);
      }
    } else if (row.nextRetryAt !== null && row.nextRetryAt.getTime() <= now.getTime()) {
      ready.push(row);
    }
  }

  for (const attempt of ready) {
    try {
      await attemptDelivery(ctx, attempt, now, settings, timeZone, {
        maxAttempts,
        retryBaseMs,
        maxBackoffMs,
        notifier,
        report,
      });
    } catch (error) {
      report.failed += 1;
      ctx.logger.error('briefing delivery attempt failed unexpectedly', {
        deliveryId: attempt.id,
        reason: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  return report;
}

function logLateSkip(ctx: AppContext, occurrenceKey: string, scheduledFor: Date, now: Date): void {
  ctx.logger.info('daily briefing skipped: more than 2 hours late', {
    occurrenceKey,
    scheduledFor: scheduledFor.toISOString(),
    lateByMinutes: Math.round((now.getTime() - scheduledFor.getTime()) / 60_000),
  });
}

interface AttemptContext {
  maxAttempts: number;
  retryBaseMs: number;
  maxBackoffMs: number;
  notifier: Notifier;
  report: BriefingDeliveryReport;
}

/** One delivery attempt: claim, re-check the gates, send, record. */
async function attemptDelivery(
  ctx: AppContext,
  delivery: { id: string; occurrenceKey: string; attempt: number; scheduledFor: Date; idempotencyKey: string },
  now: Date,
  settings: SettingsRow,
  timeZone: string,
  attempt: AttemptContext,
): Promise<void> {
  // Claim: only the caller that flips PENDING → SENDING may send.
  const claimed = await ctx.db.briefingDelivery.updateMany({
    where: { id: delivery.id, status: 'PENDING' },
    data: { status: 'SENDING', attemptedAt: now },
  });
  if (claimed.count === 0) return;

  const gate = await gateDelivery(ctx, now, settings, timeZone);
  if (gate) {
    // Nothing was sent, so the attempt budget is untouched.
    await ctx.db.briefingDelivery.update({
      where: { id: delivery.id },
      data: {
        status: 'PENDING',
        attemptedAt: null,
        nextRetryAt: gate.deferUntil,
        error: `deferred: ${gate.reason}`,
      },
    });
    attempt.report.deferred += 1;
    return;
  }

  if (!attempt.notifier.isAvailable()) {
    // A missing channel is a deployment gap, not a failure of this briefing.
    await ctx.db.briefingDelivery.update({
      where: { id: delivery.id },
      data: {
        status: 'PENDING',
        attemptedAt: null,
        nextRetryAt: new Date(now.getTime() + NO_CHANNEL_DEFER_MS),
        error: 'deferred: no delivery channel is configured',
      },
    });
    attempt.report.deferred += 1;
    return;
  }

  // The content belongs to the occurrence's own local day, not to the instant
  // the attempt happens: an occurrence row and the message it produces can
  // never disagree about which day they describe.
  const occurrenceDay = localDateTimeToUtc(delivery.occurrenceKey, '00:00', timeZone);
  const briefing = await generateBriefing(ctx.db, {
    timeZone,
    sections: parseBriefingSections(settings.briefingSections),
    referenceDate: occurrenceDay ?? now,
  });
  const text = formatBriefingText(briefing);

  // The deadline governs the START of the send. The tick's `now` may be
  // seconds old by here (gates, generation), so the check is repeated on the
  // live clock right before the request; a request that starts in time is not
  // cancelled if Telegram is slow to answer.
  const sendStartsAt = ctx.clock.now();
  if (isPastDeadline(sendStartsAt, briefingDeadline(delivery.scheduledFor, settings, timeZone))) {
    await ctx.db.briefingDelivery.update({
      where: { id: delivery.id },
      data: { status: 'SKIPPED', attemptedAt: null, nextRetryAt: null, error: BRIEFING_LATE_REASON },
    });
    attempt.report.skipped += 1;
    logLateSkip(ctx, delivery.occurrenceKey, delivery.scheduledFor, sendStartsAt);
    return;
  }

  attempt.report.attempts += 1;
  const outcome = await attempt.notifier.send({
    text,
    proactive: true,
    // A digest, not an alarm: arrives without sound. Reminders stay audible.
    silent: true,
    idempotencyKey: delivery.idempotencyKey,
  });
  // Recorded times describe when the send actually finished, not when the tick began.
  const finishedAt = ctx.clock.now();

  if (outcome.ok) {
    await ctx.db.briefingDelivery.update({
      where: { id: delivery.id },
      data: { status: 'DELIVERED', deliveredAt: finishedAt, nextRetryAt: null, error: null },
    });
    attempt.report.delivered += 1;
    return;
  }

  const error = outcome.error ?? 'delivery failed';
  const retryable = outcome.retryable === true;
  await ctx.db.briefingDelivery.update({
    where: { id: delivery.id },
    data: { status: 'FAILED', error, nextRetryAt: null },
  });
  attempt.report.failed += 1;

  const canRetry = retryable && delivery.attempt < attempt.maxAttempts;
  if (canRetry) {
    const waitMs = Math.max(
      backoffDelay(delivery.attempt, attempt.retryBaseMs, attempt.maxBackoffMs, false),
      outcome.retryAfterMs ?? 0,
    );
    const nextAttempt = delivery.attempt + 1;
    try {
      await ctx.db.briefingDelivery.create({
        data: {
          occurrenceKey: delivery.occurrenceKey,
          attempt: nextAttempt,
          status: 'PENDING',
          channel: attempt.notifier.channel,
          scheduledFor: delivery.scheduledFor,
          nextRetryAt: new Date(finishedAt.getTime() + waitMs),
          error: `retry ${nextAttempt} after: ${error}`,
          idempotencyKey: `${delivery.occurrenceKey}:${nextAttempt}`,
        },
      });
    } catch (createError) {
      if (!isUniqueViolation(createError)) throw createError;
    }
  } else {
    ctx.logger.warn('briefing delivery permanently failed', {
      occurrenceKey: delivery.occurrenceKey,
      attempts: delivery.attempt,
      reason: error,
      retryable,
    });
  }
}

/**
 * Re-queues a delivery that was interrupted mid-send.
 *
 * Called on startup so a crash between the send and the local write does not
 * lose the briefing.
 */
export async function recoverBriefingDeliveries(
  ctx: AppContext,
  now: Date,
  staleClaimMs: number,
): Promise<number> {
  const stale = await ctx.db.briefingDelivery.updateMany({
    where: { status: 'SENDING', attemptedAt: { lt: new Date(now.getTime() - staleClaimMs) } },
    data: {
      status: 'PENDING',
      nextRetryAt: now,
      error: 'recovered after an interrupted delivery',
    },
  });
  return stale.count;
}
