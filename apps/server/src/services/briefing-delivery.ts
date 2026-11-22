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
 *  - **Deferred, never dropped.** Quiet hours and the daily cap push an
 *    attempt to a later time; the pending row survives a restart.
 *  - **A briefing belongs to its own day.** A briefing that could not be
 *    delivered before midnight is skipped rather than delivered the next
 *    morning: a stale briefing is worse than no briefing.
 *  - **At-least-once, with bounded retries.** A transient failure is retried
 *    with exponential backoff; a permanent failure stops retrying and is
 *    recorded.
 */
import type { AppContext } from '../context.js';
import type { Notifier } from '../ports.js';
import { backoffDelay } from '../lib/retry.js';
import { localDateKey, localDateTimeToUtc } from '../lib/time.js';
import { formatBriefingText, generateBriefing } from './briefing-service.js';
import { gateDelivery, NO_CHANNEL_DEFER_MS } from './delivery-gate.js';
import { getSettings, parseBriefingSections, type SettingsRow } from './settings-service.js';

/** Attempts allowed for one briefing occurrence, including the first. */
export const BRIEFING_MAX_ATTEMPTS = 3;
/** First retry delay; each further attempt doubles it. */
export const BRIEFING_RETRY_BASE_MS = 30_000;
/** Ceiling for a single retry delay. */
export const BRIEFING_MAX_BACKOFF_MS = 30 * 60_000;

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

  const ready = await ctx.db.briefingDelivery.findMany({
    where: { status: 'PENDING', occurrenceKey: localDate, nextRetryAt: { lte: now } },
    orderBy: { nextRetryAt: 'asc' },
    take: 10,
  });

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

  attempt.report.attempts += 1;
  const outcome = await attempt.notifier.send({
    text,
    proactive: true,
    // A digest, not an alarm: arrives without sound. Reminders stay audible.
    silent: true,
    idempotencyKey: delivery.idempotencyKey,
  });

  if (outcome.ok) {
    await ctx.db.briefingDelivery.update({
      where: { id: delivery.id },
      data: { status: 'DELIVERED', deliveredAt: now, nextRetryAt: null, error: null },
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
          nextRetryAt: new Date(now.getTime() + waitMs),
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
