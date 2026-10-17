/**
 * Deterministic (rules-only) classification.
 *
 * This is the baseline that keeps the product fully usable with no AI provider
 * configured, and it is also the fallback used when an AI provider fails. It
 * only ever extracts what is literally present in the text: it never invents a
 * date, a person, a location or a commitment.
 */
import type { Classification, CaptureKind, Priority } from '@recall/shared';

import { endOfLocalDay, localDateTimeToUtc, localDateKey, toLocal } from '../lib/time.js';
import { deriveTitle, extractInlineTags, extractUrls, isOnlyUrl, normalizeWhitespace, reduceInlineNoise } from '../lib/text.js';
import { looksLikeQuestion, parseTemporalExpression, stripTemporalPhrase } from '../lib/nlp.js';
import type { ClassificationRequest, RuleClassifier } from './types.js';

export type { RuleClassifier };

const TASK_CUES = [
  /\b(remind me|reminder)\b/i,
  /\bi (need|have|must|should|ought|want|gotta|got) to\b/i,
  /\bi (should|must|ought to)\b/i,
  /\b(todo|to-do|to do)\b/i,
  /\b(don'?t forget|remember to|make sure|need to|have to)\b/i,
  /\btask:?\b/i,
  /\b(finish|complete|submit|send|email|pay|buy|call|book|schedule|fix|review|write|prepare|renew|update|clean|plan)\b/i,
];

/**
 * Imperative verbs at the start of a sentence. "Take the bins out tomorrow" has
 * no explicit task marker, but it is unambiguously something to do.
 */
const IMPERATIVE_PATTERN =
  /^(?:please\s+|can you\s+|could you\s+|i need you to\s+)?(?:take|buy|call|email|send|pay|book|schedule|fix|review|write|prepare|renew|update|clean|plan|check|order|pick|drop|bring|get|make|do|finish|complete|submit|draft|read|print|sign|file|cancel|confirm|ask|tell|text|phone|visit|collect|return|deliver|install|upgrade|backup|test|deploy|push|merge|water|feed|walk|cook|wash|tidy|repair|replace|move|store|archive|export|share|follow|contact|message|discuss|research|study|learn|remind|remember|note)\b/i;

const IDEA_CUES = [
  /\bi (have|had|got) an idea\b/i,
  /\bidea\b/i,
  /\bwhat if\b/i,
  /\bwouldn'?t it be (cool|nice|great)\b/i,
  /\bconcept\b/i,
  /\bbrainstorm\b/i,
  /\b(thinking about|thought about) (building|creating|making|starting)\b/i,
];

const EVENT_CUES = [
  /\b(meeting|appointment|interview|standup|stand-up|conference|seminar|workshop|webinar|class|lecture|exam|flight|train|bus|dinner|lunch|breakfast|party|wedding|birthday|funeral|church|service|checkup|check-up|surgery|visit)\b/i,
  /\b(starts?|begins?|scheduled for|is at|at \d{1,2}(:\d{2})?\s*(am|pm))\b/i,
];

const NOTE_CUES = [
  /\b(note|notes|reference|remember that|fyi|for later|read later|bookmark)\b/i,
  /\bsave (this|it)\b/i,
];

const URL_INTENT = /\b(save|bookmark|keep|store|archive)\b/i;

const CATEGORY_KEYWORDS: { category: string; pattern: RegExp }[] = [
  { category: 'work', pattern: /\b(work|office|client|boss|team|standup|deploy|release|sprint|ticket|jira)\b/i },
  { category: 'study', pattern: /\b(study|exam|course|lecture|assignment|thesis|school|university|revision|learn)\b/i },
  { category: 'health', pattern: /\b(doctor|hospital|clinic|dentist|medicine|workout|gym|run|diet|sleep|checkup)\b/i },
  { category: 'finance', pattern: /\b(pay|bill|invoice|rent|tax|bank|budget|salary|subscription|refund)\b/i },
  { category: 'home', pattern: /\b(home|house|kitchen|laundry|repair|plumber|electrician|clean|shopping|groceries)\b/i },
  { category: 'travel', pattern: /\b(travel|flight|trip|hotel|visa|passport|luggage|airport|holiday)\b/i },
  { category: 'code', pattern: /\b(code|bug|refactor|database|api|server|deploy|test|migration|postgres|sqlite)\b/i },
  { category: 'reading', pattern: /\b(book|article|paper|blog|documentation|docs|read)\b/i },
  { category: 'personal', pattern: /\b(family|friend|birthday|anniversary|call|visit|gift)\b/i },
];

const PRIORITY_CUES: { priority: Priority; pattern: RegExp }[] = [
  { priority: 'URGENT', pattern: /\b(urgent|asap|immediately|right away|emergency|critical)\b/i },
  { priority: 'HIGH', pattern: /\b(important|high priority|must|priority|deadline|top priority)\b/i },
  { priority: 'LOW', pattern: /\b(someday|eventually|whenever|low priority|no rush|nice to have|maybe)\b/i },
];

function matchCount(patterns: RegExp[], text: string): number {
  let count = 0;
  for (const pattern of patterns) {
    if (pattern.test(text)) count += 1;
  }
  return count;
}

function detectCategory(text: string): string | null {
  for (const { category, pattern } of CATEGORY_KEYWORDS) {
    if (pattern.test(text)) return category;
  }
  return null;
}

function detectPriority(text: string): Priority | null {
  for (const { priority, pattern } of PRIORITY_CUES) {
    if (pattern.test(text)) return priority;
  }
  return null;
}

/**
 * Decides the capture kind. Order matters: an explicit "remind me" always wins
 * (a reminder is actionable), then events, then ideas, then notes, then tasks.
 */
export function detectKind(text: string): { kind: CaptureKind; confidence: number } {
  const taskScore = matchCount(TASK_CUES, text) + (IMPERATIVE_PATTERN.test(text.trim()) ? 1 : 0);
  const ideaScore = matchCount(IDEA_CUES, text);
  const eventScore = matchCount(EVENT_CUES, text);
  const noteScore = matchCount(NOTE_CUES, text);
  const urls = extractUrls(text);

  if (/\b(remind me|reminder)\b/i.test(text)) return { kind: 'TASK', confidence: 0.92 };
  if (isOnlyUrl(text)) return { kind: 'NOTE', confidence: 0.95 };
  if (urls.length > 0 && URL_INTENT.test(text)) return { kind: 'NOTE', confidence: 0.9 };
  if (/\bnote\b|\bremember that\b/i.test(text) && taskScore === 0) {
    return { kind: 'NOTE', confidence: 0.75 };
  }

  // An idea marker beats a generic event word but not an explicit task.
  if (ideaScore > 0 && taskScore === 0 && eventScore === 0) {
    return { kind: 'IDEA', confidence: ideaScore >= 2 ? 0.85 : 0.7 };
  }
  if (eventScore > 0 && taskScore === 0) {
    return { kind: 'EVENT', confidence: eventScore >= 2 ? 0.8 : 0.65 };
  }
  if (taskScore > 0) {
    return { kind: 'TASK', confidence: taskScore >= 2 ? 0.9 : 0.75 };
  }
  if (noteScore > 0 || urls.length > 0) return { kind: 'NOTE', confidence: 0.6 };
  if (ideaScore > 0) return { kind: 'IDEA', confidence: 0.6 };
  if (eventScore > 0) return { kind: 'EVENT', confidence: 0.55 };

  return { kind: 'OTHER', confidence: 0.25 };
}

export interface RuleClassifierOptions {
  /** Cap on title length. */
  titleMax?: number;
}

export function createRuleClassifier(options: RuleClassifierOptions = {}): RuleClassifier {
  const titleMax = options.titleMax ?? 140;

  return {
    classify(request: ClassificationRequest): Classification {
      const text = request.text;
      const { timeZone, referenceNow } = request;
      const temporal = parseTemporalExpression(text, {
        timeZone,
        reference: referenceNow,
        morningTime: request.morningDefaultTime,
        eveningTime: request.eveningDefaultTime,
      });

      const forced = request.hintKind ?? null;
      const detected = detectKind(text);
      const kind: CaptureKind = forced ?? detected.kind;
      let confidence = forced ? 0.98 : detected.confidence;

      const inlineTags = extractInlineTags(text);
      const urls = extractUrls(text);
      const category = detectCategory(text);
      const priority = detectPriority(text);
      const assumptions: string[] = [];

      // --- dates ------------------------------------------------------------
      let dueAt: string | null = null;
      let remindAt: string | null = null;

      if (temporal.found && temporal.instant) {
        if (temporal.dateOnly) {
          // "finish the docs tomorrow" → due end of that local day.
          dueAt = endOfLocalDay(temporal.instant, timeZone).toISOString();
          assumptions.push('treated as due by the end of that day');
        } else {
          const local = toLocal(temporal.instant, timeZone);
          const iso = temporal.instant.toISOString();
          if (kind === 'EVENT') {
            dueAt = iso;
          } else if (/\b(remind me|reminder)\b/i.test(text)) {
            remindAt = iso;
            dueAt = iso;
          } else {
            dueAt = iso;
          }
          if (temporal.usedDefaultTime && temporal.assumption) {
            assumptions.push(temporal.assumption);
          }
          if (temporal.certainty === 'medium') confidence = Math.min(confidence, 0.7);
          // A time that already passed is suspicious for a *new* capture; flag it.
          if (local.isValid && local.toMillis() < referenceNow.getTime()) {
            assumptions.push('the stated time is already in the past');
            confidence = Math.min(confidence, 0.6);
          }
        }
      }

      // A question is never a task to store; keep it for review instead.
      if (looksLikeQuestion(text)) {
        return {
          kind: 'UNKNOWN',
          title: null,
          description: null,
          category: null,
          tags: inlineTags,
          priority: null,
          dueAt: null,
          remindAt: null,
          projectName: null,
          confidence: 0.2,
          needsReview: true,
          rationale: 'looks like a question rather than a capture to store',
        };
      }

      const title = deriveTitle(reduceInlineNoise(stripTemporalPhrase(text, temporal.matchedText)), titleMax);

      return {
        kind,
        title: title.length > 0 ? title : normalizeWhitespace(text).slice(0, titleMax),
        description:
          kind === 'NOTE' || kind === 'IDEA'
            ? normalizeWhitespace(text).slice(0, 4000)
            : urls.length > 0
              ? urls.join('\n')
              : null,
        category,
        tags: inlineTags,
        priority,
        dueAt,
        remindAt,
        projectName: null,
        confidence: Math.round(confidence * 100) / 100,
        needsReview: kind === 'OTHER' || confidence < 0.45,
        rationale: assumptions.length > 0 ? `Assumed: ${assumptions.join('; ')}` : null,
      };
    },
  };
}

/**
 * Exposed for reuse: resolves a local HH:MM default on a given local date.
 * Returns null when the combination is invalid (e.g. a DST gap).
 */
export function resolveLocalDefault(date: Date, hhmm: string, timeZone: string): Date | null {
  return localDateTimeToUtc(localDateKey(date, timeZone), hhmm, timeZone);
}
