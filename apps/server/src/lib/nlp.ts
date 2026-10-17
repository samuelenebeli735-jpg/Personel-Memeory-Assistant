/**
 * Deterministic natural-language date/time understanding.
 *
 * Design decisions:
 *  - `chrono-node` does the heavy lifting, but every result is filtered through a
 *    temporal-anchor allowlist so that words like "may" or "march" used as verbs
 *    do not silently create deadlines.
 *  - Vague expressions ("tomorrow morning", "tonight") are resolved with the
 *    owner's configured defaults, and the assumption is reported back to the user
 *    rather than being hidden.
 *  - If nothing temporal is present the result is `found: false`; we never invent
 *    a date.
 */
import type { ReminderRecurrence } from '@recall/shared';

import * as chronoModule from 'chrono-node';

import { localDateTimeToUtc, localDateKey, parseHhMm, toLocal } from './time.js';

// chrono-node ships CommonJS; normalise both interop shapes.
const chrono = ((chronoModule as unknown as { default?: typeof chronoModule }).default ??
  chronoModule) as typeof chronoModule;

export type TemporalCertainty = 'high' | 'medium' | 'low';

export interface ParseTemporalOptions {
  timeZone: string;
  /** Reference instant. Defaults to now. */
  reference?: Date;
  /** Local HH:MM used for "morning"/"tonight" style expressions. */
  morningTime?: string;
  eveningTime?: string;
  /** Prefer the next matching instant instead of the last one. Defaults true. */
  forwardDate?: boolean;
}

export interface ParsedTemporal {
  found: boolean;
  /** Absolute UTC instant, or null when no usable expression was found. */
  instant: Date | null;
  certainty: TemporalCertainty;
  matchedText: string | null;
  /** True when only a date was given and the hour had to be supplied. */
  usedDefaultTime: boolean;
  /** True when the user gave a date but no time of day at all. */
  dateOnly: boolean;
  recurrence: ReminderRecurrence | null;
  /** Short, user-facing explanation of any assumption that was made. */
  assumption: string | null;
}

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

const WEEKDAY_NAMES = Object.keys(WEEKDAYS).join('|');

/**
 * Words that justify treating a chrono match as a real date reference.
 *
 * Ambiguous English words are deliberately excluded: "may" and "march" are also
 * verbs, and short weekday forms ("sat", "wed", "sun") appear in ordinary prose.
 * Month names only count when followed by a day number ("May 5"); weekday names
 * only in full ("friday"), or with a preposition / relative word ("next fri").
 */
const ANCHOR_PATTERN = new RegExp(
  [
    '\\b(am|pm)\\b',
    '\\b(today|tonight|tomorrow|tmrw|yesterday|now)\\b',
    '\\b(this|next|last|coming|following)\\b',
    '\\b(morning|afternoon|evening|night|noon|midday|midnight|weekend)\\b',
    '\\b(day|days|week|weeks|month|months|year|years|hour|hours|min|mins|minute|minutes)\\b',
    '(?:^|\\s)(?:at|by|before|after|on|in|around|about|from|until|till|til|every)(?:\\s|$)',
    '\\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\\b',
    '\\b\\d{1,2}:\\d{2}\\b',
    "\\bo'?clock\\b",
    '\\b\\d{4}\\b',
    '\\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\s+\\d{1,2}\\b',
  ].join('|'),
  'i',
);

function hasTemporalAnchor(text: string): boolean {
  return ANCHOR_PATTERN.test(text);
}

/** "4pm" / "9:30 am" / "16:00" – a clearly stated clock time. */
function looksLikeClockTime(text: string): boolean {
  return /\b\d{1,2}(?::\d{2})?\s*(am|pm)\b|\b\d{1,2}:\d{2}\b|\bo'?clock\b/i.test(text);
}

export function detectRecurrence(text: string, timeZone: string, reference: Date): ReminderRecurrence | null {
  const lower = text.toLowerCase();

  if (/\bevery\s+day\b|\bdaily\b|\beach\s+day\b/.test(lower)) {
    return { frequency: 'DAILY', weekdays: [], until: null, maxOccurrences: 52 };
  }
  if (/\bevery\s+month\b|\bmonthly\b/.test(lower)) {
    return { frequency: 'MONTHLY', weekdays: [], until: null, maxOccurrences: 24 };
  }

  const weekdayMatches = [...lower.matchAll(new RegExp(`\\bevery\\s+(${WEEKDAY_NAMES})\\b`, 'g'))]
    .map((m) => WEEKDAYS[m[1] ?? ''])
    .filter((v): v is number => typeof v === 'number');

  if (weekdayMatches.length > 0) {
    const unique = [...new Set(weekdayMatches)].sort((a, b) => a - b);
    return { frequency: 'WEEKLY', weekdays: unique, until: null, maxOccurrences: 52 };
  }
  if (/\bevery\s+week\b|\bweekly\b/.test(lower)) {
    const local = toLocal(reference, timeZone);
    const weekday = local.weekday % 7; // luxon: 1..7 with 7 = Sunday
    return { frequency: 'WEEKLY', weekdays: [weekday], until: null, maxOccurrences: 52 };
  }
  return null;
}

/**
 * Removes the temporal phrase from a sentence so the remainder can be used as a
 * task title. Only used for *display* text; the original capture is preserved
 * verbatim elsewhere.
 */
export function stripTemporalPhrase(text: string, matched: string | null): string {
  if (!matched) return text.trim();
  const index = text.toLowerCase().indexOf(matched.toLowerCase());
  if (index < 0) return text.trim();
  const before = text.slice(0, index);
  const after = text.slice(index + matched.length);
  return `${before} ${after}`.replace(/\s+/g, ' ').replace(/\s+([,.!?;:])/g, '$1').trim();
}

interface VaguePeriod {
  key: 'morning' | 'afternoon' | 'evening' | 'night' | 'noon';
  hhmm: string | null;
  label: string;
}

function detectVaguePeriod(text: string, options: ParseTemporalOptions): VaguePeriod | null {
  const lower = text.toLowerCase();
  if (/\b(noon|midday)\b/.test(lower)) return { key: 'noon', hhmm: '12:00', label: '12:00' };
  if (/\bmidnight\b/.test(lower)) return { key: 'night', hhmm: '00:00', label: '00:00' };
  if (/\bmorning\b/.test(lower)) {
    return { key: 'morning', hhmm: options.morningTime ?? '09:00', label: options.morningTime ?? '09:00' };
  }
  if (/\bafternoon\b/.test(lower)) return { key: 'afternoon', hhmm: '14:00', label: '14:00' };
  if (/\b(tonight|this\s+evening|evening)\b/.test(lower)) {
    return { key: 'evening', hhmm: options.eveningTime ?? '19:00', label: options.eveningTime ?? '19:00' };
  }
  if (/\bnight\b/.test(lower)) return { key: 'night', hhmm: '21:00', label: '21:00' };
  return null;
}

/**
 * Parses the first usable temporal expression in `text`.
 */
export function parseTemporalExpression(
  text: string,
  options: ParseTemporalOptions,
): ParsedTemporal {
  const timeZone = options.timeZone;
  const reference = options.reference ?? new Date();
  const forwardDate = options.forwardDate ?? true;
  const recurrence = detectRecurrence(text, timeZone, reference);
  const vague = detectVaguePeriod(text, options);

  const empty: ParsedTemporal = {
    found: false,
    instant: null,
    certainty: 'low',
    matchedText: null,
    usedDefaultTime: false,
    dateOnly: false,
    recurrence,
    assumption: null,
  };

  const referenceInput = { instant: reference, timezone: timeZone };
  const results = chrono.parse(text, referenceInput, { forwardDate });
  const usable = results.filter((result) => hasTemporalAnchor(result.text));

  // Case 1: chrono found an explicit clock time.
  const withTime = usable.find(
    (result) => result.start.isCertain('hour') || looksLikeClockTime(result.text),
  );
  if (withTime) {
    const certainty: TemporalCertainty = withTime.start.isCertain('day') ? 'high' : 'medium';
    return {
      found: true,
      instant: withTime.start.date(),
      certainty,
      matchedText: withTime.text,
      usedDefaultTime: false,
      dateOnly: false,
      recurrence,
      assumption: null,
    };
  }

  // Case 2: chrono found an explicit relative date (with an implied, uncertain hour).
  const withDate = usable.find(
    (result) => result.start.isCertain('day') || result.start.isCertain('weekday'),
  );
  if (withDate) {
    if (!vague) {
      // A bare date such as "on Friday" with no time of day: keep the date and
      // tell the user no time was inferred (callers may ask for clarification).
      const dayStart = withDate.start.date();
      return {
        found: true,
        instant: dayStart,
        certainty: 'medium',
        matchedText: withDate.text,
        usedDefaultTime: false,
        dateOnly: true,
        recurrence,
        assumption: null,
      };
    }
    if (vague.hhmm === null) {
      return { ...empty, matchedText: withDate.text, recurrence, certainty: 'low', found: true, dateOnly: true };
    }
    // Fill the missing hour from the configured (or conventional) default.
    const dayPart = withDate.start.date();
    const dayKey = localDateKey(dayPart, timeZone);
    const local = toLocal(dayPart, timeZone);
    const anchorDay = local.isValid ? dayKey : localDateKey(reference, timeZone);
    let instant = localDateTimeToUtc(anchorDay, vague.hhmm, timeZone);
    if (instant && forwardDate && instant.getTime() < reference.getTime()) {
      // "tomorrow morning" is never in the past; only shift when the day itself
      // was not explicitly given (chrono already handles explicit days).
      const shifted = localDateTimeToUtc(
        localDateKey(new Date(instant.getTime() + 86_400_000), timeZone),
        vague.hhmm,
        timeZone,
      );
      if (shifted) instant = shifted;
    }
    if (!instant) return empty;
    return {
      found: true,
      instant,
      certainty: 'medium',
      matchedText: withDate.text,
      usedDefaultTime: true,
      dateOnly: false,
      recurrence,
      assumption: `no time given, used ${vague.label} for the ${vague.key}`,
    };
  }

  // Case 3: only a vague period was given, with no date at all ("tonight").
  if (vague) {
    const anchor = /\btonight\b/.test(text.toLowerCase()) ? 'today' : null;
    if (!anchor) return { ...empty, recurrence, assumption: null };

    const chronoTonight = chrono.parse(
      'tonight',
      { instant: reference, timezone: timeZone },
      { forwardDate },
    )[0];
    if (chronoTonight) {
      return {
        found: true,
        instant: chronoTonight.start.date(),
        certainty: 'medium',
        matchedText: chronoTonight.text,
        usedDefaultTime: false,
        dateOnly: false,
        recurrence,
        assumption: null,
      };
    }
    return empty;
  }

  return { ...empty, recurrence };
}

/** Parses a duration like "in 10 minutes" / "in 2 hours" / "in 3 days". */
export function parseRelativeDuration(text: string, reference: Date): { instant: Date; matchedText: string } | null {
  const match = /\bin\s+(\d{1,4})\s*(minute|min|hour|hr|day|week)s?\b/i.exec(text);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = (match[2] ?? '').toLowerCase();
  const multiplier = unit.startsWith('min')
    ? 60_000
    : unit.startsWith('hour') || unit === 'hr'
      ? 3_600_000
      : unit.startsWith('day')
        ? 86_400_000
        : 604_800_000;
  return { instant: new Date(reference.getTime() + amount * multiplier), matchedText: match[0] };
}

/** True when the text looks like a question rather than a capture to store. */
export function looksLikeQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (/\?\s*$/.test(trimmed)) return true;
  return /^(what|when|where|who|which|how|why|do i|did i|have i|is there|are there|show|list|find|any)\b/i.test(
    trimmed,
  );
}

export function parseHhMmSafe(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback;
  try {
    parseHhMm(value);
    return value;
  } catch {
    return fallback;
  }
}
