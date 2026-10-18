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
import type { Classification, CaptureKind } from '@recall/shared';

import type { AppContext } from '../context.js';
import { ProviderError } from '../lib/errors.js';
import { formatLocalHuman } from '../lib/time.js';
import { getSettings } from './settings-service.js';

export interface ClassifyInput {
  text: string;
  capturedAt: Date;
  hintKind?: CaptureKind | null;
  knownProjects?: string[];
  /** Skip the AI provider even when it is configured. */
  forceRules?: boolean;
}

export interface ClassifyOutcome {
  classification: Classification;
  /** 'rules' or the provider name that produced the accepted result. */
  provider: string;
  /** Set when an AI attempt was made and failed or was rejected. */
  aiError: string | null;
  aiAttempted: boolean;
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
  const now = ctx.clock.now();

  const request = {
    text: input.text,
    capturedAt: input.capturedAt,
    referenceNow: now,
    timeZone: settings.timeZone,
    morningDefaultTime: settings.morningDefaultTime,
    eveningDefaultTime: settings.eveningDefaultTime,
    hintKind: input.hintKind ?? null,
    knownProjects: input.knownProjects ?? [],
  };

  const useAi = ctx.ai !== null && settings.aiEnabled && input.forceRules !== true;
  if (useAi && ctx.ai) {
    try {
      const classification = await ctx.ai.classify(request);
      const sanitised = sanitiseClassification(classification, {
        now,
        timeZone: settings.timeZone,
      });
      return {
        classification: sanitised.classification,
        provider: ctx.ai.name,
        aiError: null,
        aiAttempted: true,
      };
    } catch (error) {
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
      const sanitised = sanitiseClassification(fallback, { now, timeZone: settings.timeZone });
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
      };
    }
  }

  const fallback = ctx.rules.classify(request);
  const sanitised = sanitiseClassification(fallback, { now, timeZone: settings.timeZone });
  return {
    classification: sanitised.classification,
    provider: 'rules',
    aiError: null,
    aiAttempted: false,
  };
}
