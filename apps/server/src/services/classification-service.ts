/**
 * Classification orchestration.
 *
 * Contract:
 *  - The deterministic rules classifier is always available.
 *  - The AI provider is used only when configured *and* enabled in settings.
 *  - Any AI failure (timeout, rate limit, malformed JSON, schema violation,
 *    outage) degrades to the rules classifier. The caller is told what happened
 *    so it can be transparent with the user; the capture is never lost.
 *  - Every classification, from either source, passes through
 *    `sanitiseClassification` before it can influence stored data.
 */
import { classifyCaptureSchema, type Classification, type CaptureKind } from '@recall/shared';

import { aiForPersonalText } from '../ai/access.js';
import type { AppContext } from '../context.js';
import { ProviderError } from '../lib/errors.js';
import { sha256Hex } from '../lib/hash.js';
import { formatLocalHuman } from '../lib/time.js';
import { getSettings } from './settings-service.js';

export interface ClassifyInput {
  text: string;
  capturedAt: Date;
  hintKind?: CaptureKind | null;
  knownProjects?: string[];
  /** Skip the AI provider even when it is configured. */
  forceRules?: boolean;
  /**
   * Capture the result belongs to. When supplied, a validated AI result is
   * cached on that capture so reprocessing does not pay for the same call twice.
   */
  captureId?: string;
}

export interface ClassifyOutcome {
  classification: Classification;
  /** 'rules' or the provider name that produced the accepted result. */
  provider: string;
  /** Set when an AI attempt was made and failed or was rejected. */
  aiError: string | null;
  aiAttempted: boolean;
  /** True when the AI result came from the per-capture cache. */
  cached: boolean;
}

/** Bump when the cache payload shape or prompt semantics change. */
const CACHE_VERSION = 2;

/**
 * Cache key for an AI classification.
 *
 * The key includes everything that can change the answer: the exact text, the
 * hint, the date-resolution settings, the project vocabulary, the provider and
 * model, and the exact reference instant. `classifyCaptureText` supplies the
 * capture's original `capturedAt` as that reference, so relative dates do not
 * move when a capture is reprocessed later.
 *
 * The exact instant also prevents collisions if another caller ever supplies a
 * moving reference: two runs on the same local day must not share an answer.
 */
export function classificationCacheKey(input: {
  text: string;
  hintKind: CaptureKind | null;
  timeZone: string;
  morningDefaultTime: string;
  eveningDefaultTime: string;
  knownProjects: string[];
  provider: string;
  model: string;
  referenceNow: Date;
}): string {
  return sha256Hex(
    JSON.stringify({
      v: CACHE_VERSION,
      text: input.text,
      hintKind: input.hintKind,
      timeZone: input.timeZone,
      morning: input.morningDefaultTime,
      evening: input.eveningDefaultTime,
      projects: [...input.knownProjects].sort(),
      provider: input.provider,
      model: input.model,
      referenceAt: input.referenceNow.toISOString(),
    }),
  );
}

interface CachedClassification {
  key: string;
  provider: string;
  model: string | null;
  classification: Classification;
}

function readCachedClassification(
  raw: string | null,
  key: string,
): Classification | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CachedClassification>;
    if (!parsed || parsed.key !== key || typeof parsed.provider !== 'string') return null;
    // Defence in depth: never trust stored JSON more than provider output.
    const validated = classifyCaptureSchema.safeParse(parsed.classification);
    return validated.success ? validated.data : null;
  } catch {
    return null;
  }
}

/** Hard bounds used to reject absurd model output. */
const MAX_FUTURE_MS = 5 * 365 * 86_400_000;
const MAX_PAST_MS = 30 * 86_400_000;

export interface SanitiseResult {
  classification: Classification;
  adjustments: string[];
}

/**
 * Defensive pass applied to any classification (rules or AI).
 *
 * This is the last line of defence against a hallucinated deadline: an
 * implausible timestamp is dropped and the item is flagged for human review
 * rather than trusted.
 */
export function sanitiseClassification(
  classification: Classification,
  context: { now: Date; timeZone: string },
): SanitiseResult {
  const adjustments: string[] = [];
  let needsReview = classification.needsReview;
  let confidence = classification.confidence;
  let dueAt = classification.dueAt;
  let remindAt = classification.remindAt;

  const check = (value: string | null, label: 'dueAt' | 'remindAt'): string | null => {
    if (value === null) return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      adjustments.push(`discarded an unreadable ${label}`);
      needsReview = true;
      return null;
    }
    const delta = parsed.getTime() - context.now.getTime();
    if (delta > MAX_FUTURE_MS || delta < -MAX_PAST_MS) {
      adjustments.push(
        `discarded an implausible ${label} (${formatLocalHuman(parsed, context.timeZone)})`,
      );
      needsReview = true;
      confidence = Math.min(confidence, 0.4);
      return null;
    }
    return parsed.toISOString();
  };

  dueAt = check(dueAt, 'dueAt');
  remindAt = check(remindAt, 'remindAt');

  // An event needs a start time; without one there is nothing to create.
  if (classification.kind === 'EVENT' && dueAt === null) {
    adjustments.push('no date was found for this event');
    needsReview = true;
    confidence = Math.min(confidence, 0.5);
  }

  // A reminder cannot precede its own capture by design.
  if (remindAt !== null && dueAt === null) {
    dueAt = remindAt;
  }

  const title = classification.title && classification.title.trim().length > 0
    ? classification.title.trim()
    : null;
  if (title === null && (classification.kind === 'TASK' || classification.kind === 'IDEA')) {
    needsReview = true;
  }

  const rationaleParts = [classification.rationale, ...adjustments].filter(
    (part): part is string => Boolean(part && part.length > 0),
  );

  return {
    classification: {
      ...classification,
      title,
      dueAt,
      remindAt,
      confidence: Math.round(confidence * 100) / 100,
      needsReview,
      rationale: rationaleParts.length > 0 ? rationaleParts.join('; ') : null,
    },
    adjustments,
  };
}

export async function classifyCaptureText(
  ctx: AppContext,
  input: ClassifyInput,
): Promise<ClassifyOutcome> {
  const settings = await getSettings(ctx.db, ctx.defaults);
  // Relative phrases belong to the moment the user captured them. Using the
  // original capturedAt keeps a reprocess deterministic and makes the cache
  // result reusable instead of silently moving "in two hours" to a later time.
  const referenceNow = input.capturedAt;
  // Plausibility bounds use the same reference. A legitimate deadline on an
  // older capture must not be discarded merely because the reprocess happens
  // more than 30 days later.
  const sanitiseContext = { now: referenceNow, timeZone: settings.timeZone };

  const request = {
    text: input.text,
    capturedAt: input.capturedAt,
    referenceNow,
    timeZone: settings.timeZone,
    morningDefaultTime: settings.morningDefaultTime,
    eveningDefaultTime: settings.eveningDefaultTime,
    hintKind: input.hintKind ?? null,
    knownProjects: input.knownProjects ?? [],
  };

  // The capture text is personal: it goes to the provider only when the owner
  // enabled AI in Settings AND the server allows personal text to leave
  // (AI_ALLOW_RAW_TEXT). Otherwise the rules classify it, without a warning.
  const access = aiForPersonalText(ctx, settings);
  if (access.provider && input.forceRules !== true) {
    const provider = access.provider;
    const cacheKey = input.captureId
      ? classificationCacheKey({
          text: request.text,
          hintKind: request.hintKind ?? null,
          timeZone: settings.timeZone,
          morningDefaultTime: settings.morningDefaultTime,
          eveningDefaultTime: settings.eveningDefaultTime,
          knownProjects: request.knownProjects ?? [],
          provider: provider.name,
          model: provider.model ?? '',
          referenceNow,
        })
      : null;

    if (input.captureId && cacheKey) {
      const row = await ctx.db.capture.findUnique({
        where: { id: input.captureId },
        select: { classificationCache: true, classificationCacheKey: true },
      });
      const cached =
        row && row.classificationCacheKey === cacheKey
          ? readCachedClassification(row.classificationCache, cacheKey)
          : null;
      if (cached) {
        // Cache hits are still sanitised, against the same capture reference, so
        // the result does not change as the wall clock advances.
        const sanitised = sanitiseClassification(cached, sanitiseContext);
        ctx.logger.debug('reused cached ai classification', { captureId: input.captureId });
        return {
          classification: sanitised.classification,
          provider: provider.name,
          aiError: null,
          aiAttempted: true,
          cached: true,
        };
      }
    }

    try {
      const raw = await provider.classify(request);
      // The provider interface is a trust boundary: validate again so a broken
      // or malicious implementation cannot smuggle an unsupported shape through.
      const validated = classifyCaptureSchema.safeParse(raw);
      if (!validated.success) {
        throw new ProviderError('ai', 'Classification failed schema validation', {
          retryable: false,
          details: {
            reason: 'schema',
            issues: validated.error.issues.slice(0, 8).map((i) => `${i.path.join('.')}: ${i.message}`),
          },
        });
      }
      const sanitised = sanitiseClassification(validated.data, sanitiseContext);

      if (input.captureId && cacheKey) {
        const payload: CachedClassification = {
          key: cacheKey,
          provider: provider.name,
          model: provider.model,
          classification: sanitised.classification,
        };
        try {
          await ctx.db.capture.update({
            where: { id: input.captureId },
            data: {
              classificationCache: JSON.stringify(payload),
              classificationCacheKey: cacheKey,
            },
          });
        } catch (error) {
          // A cache write must never turn a successful classification into a
          // failure; the derived records still land.
          ctx.logger.warn('failed to cache ai classification', {
            captureId: input.captureId,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return {
        classification: sanitised.classification,
        provider: provider.name,
        aiError: null,
        aiAttempted: true,
        cached: false,
      };
    } catch (error) {
      // Transient failures are deliberately not cached: the next attempt asks
      // the provider again instead of replaying a failure.
      const message =
        error instanceof ProviderError
          ? `${error.provider}: ${error.message}`
          : error instanceof Error
            ? error.message
            : 'unknown provider error';
      ctx.logger.warn('ai classification failed, falling back to deterministic rules', {
        reason: message,
      });
      const fallback = ctx.rules.classify(request);
      const sanitised = sanitiseClassification(fallback, sanitiseContext);
      return {
        classification: {
          ...sanitised.classification,
          rationale: [sanitised.classification.rationale, 'classified without AI assistance']
            .filter(Boolean)
            .join('; '),
        },
        provider: 'rules',
        aiError: message,
        aiAttempted: true,
        cached: false,
      };
    }
  }

  const fallback = ctx.rules.classify(request);
  const sanitised = sanitiseClassification(fallback, sanitiseContext);
  return {
    classification: sanitised.classification,
    provider: 'rules',
    aiError: null,
    aiAttempted: false,
    cached: false,
  };
}
