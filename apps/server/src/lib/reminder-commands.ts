/**
 * Parsing for the explicit reminder commands (`/remind`, `/snooze`, `/cancel`).
 *
 * These are pure functions: they take the invocation text and the clock, and
 * return either a decision or a reason to ask the user a question. Keeping them
 * out of the Telegram adapter means the same rules are unit-testable and cannot
 * be bypassed by another entry point.
 *
 * The rules deliberately mirror `lib/nlp.ts` rather than re-implementing date
 * understanding: `/remind` reuses the same parser as capture, so the two cannot
 * drift apart.
 */
import type { ReminderRecurrence } from '@recall/shared';

import { parseRelativeDuration, parseTemporalExpression, stripTemporalPhrase } from './nlp.js';
import { localDateTimeToUtc, toLocal } from './time.js';

export interface RemindParseOptions {
  timeZone: string;
  now: Date;
  morningTime?: string;
  eveningTime?: string;
}

export type RemindParse =
  | {
      ok: true;
      title: string;
      remindAt: Date;
      recurrence: ReminderRecurrence | null;
      /** Set when a vague phrase had to be resolved with a default time. */
      assumption: string | null;
    }
  | { ok: false; reason: 'missing-time' | 'missing-title' }
  | { ok: false; reason: 'ambiguous-time'; matchedText: string | null };

/**
 * Parses `/remind <when> <what>`.
 *
 * A relative duration ("in 10 minutes") is checked first because it is
 * unambiguous, then the shared natural-language parser. A bare date with no time
 * of day is refused rather than guessed: a reminder that fires at an invented
 * hour is worse than a question.
 */
export function parseRemindCommand(args: string, options: RemindParseOptions): RemindParse {
  const text = args.trim();
  if (text.length === 0) return { ok: false, reason: 'missing-time' };

  const relative = parseRelativeDuration(text, options.now);
  if (relative) {
    const title = stripTemporalPhrase(text, relative.matchedText);
    if (title.length === 0) return { ok: false, reason: 'missing-title' };
    return {
      ok: true,
      title,
      remindAt: relative.instant,
      recurrence: null,
      assumption: null,
    };
  }

  const parsed = parseTemporalExpression(text, {
    timeZone: options.timeZone,
    reference: options.now,
    ...(options.morningTime === undefined ? {} : { morningTime: options.morningTime }),
    ...(options.eveningTime === undefined ? {} : { eveningTime: options.eveningTime }),
  });

  if (!parsed.found || !parsed.instant) return { ok: false, reason: 'missing-time' };
  // "on Friday" with no clock time: ask instead of inventing one.
  if (parsed.dateOnly) return { ok: false, reason: 'ambiguous-time', matchedText: parsed.matchedText };

  // Strip both the temporal phrase (from chrono) and the recurrence phrase (from detectRecurrence)
  // from the original text in one pass to avoid index misalignment.
  let title = stripTemporalAndRecurrencePhrases(text, parsed.matchedText, parsed.recurrence);
  if (title.length === 0) return { ok: false, reason: 'missing-title' };

  return {
    ok: true,
    title,
    remindAt: parsed.instant,
    recurrence: parsed.recurrence,
    assumption: parsed.assumption,
  };
}

/**
 * Removes both the temporal phrase (from chrono) and the recurrence phrase (from detectRecurrence)
 * from the original text. Both phrases are removed in a single pass on the original string
 * to avoid index misalignment from sequential stripping.
 */
function stripTemporalAndRecurrencePhrases(
  original: string,
  temporalMatched: string | null,
  recurrence: ReminderRecurrence | null,
): string {
  const lower = original.toLowerCase();
  const toRemove: { index: number; length: number }[] = [];

  if (temporalMatched) {
    const idx = lower.indexOf(temporalMatched.toLowerCase());
    if (idx >= 0) toRemove.push({ index: idx, length: temporalMatched.length });
  }

  if (recurrence) {
    let pattern: string;
    if (recurrence.frequency === 'DAILY') {
      pattern = '\\b(every\\s+day|daily|each\\s+day)\\b';
    } else if (recurrence.frequency === 'MONTHLY') {
      pattern = '\\b(every\\s+month|monthly)\\b';
    } else if (recurrence.frequency === 'WEEKLY') {
      if (recurrence.weekdays.length > 0) {
        // recurrence.weekdays uses 0=Sunday..6=Saturday
        const dayNames = recurrence.weekdays
          .map((d) => ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][d])
          .filter(Boolean)
          .join('|');
        pattern = `\\bevery\\s+(${dayNames})\\b`;
      } else {
        pattern = '\\b(every\\s+week|weekly)\\b';
      }
    } else {
      pattern = '';
    }
    if (pattern) {
      const regex = new RegExp(pattern, 'i');
      const match = lower.match(regex);
      if (match) toRemove.push({ index: match.index!, length: match[0].length });
    }
  }

  if (toRemove.length === 0) return original.trim();

  // Merge overlapping/adjacent ranges and build result by keeping non-removed parts
  toRemove.sort((a, b) => a.index - b.index);
  const merged: { index: number; length: number }[] = [];
  for (const range of toRemove) {
    const last = merged[merged.length - 1];
    if (last && range.index <= last.index + last.length) {
      // Overlapping or adjacent: merge
      last.length = Math.max(last.length, range.index + range.length - last.index);
    } else {
      merged.push({ ...range });
    }
  }

  // Build result by keeping parts outside merged ranges
  let result = '';
  let lastEnd = 0;
  for (const { index, length } of merged) {
    result += original.slice(lastEnd, index);
    lastEnd = index + length;
  }
  result += original.slice(lastEnd);

  return result.replace(/\s+/g, ' ').replace(/\s+([,.!?;:])/g, '$1').trim();
}

export interface SnoozeParseOptions {
  timeZone: string;
  now: Date;
  /** Local HH:MM used for a bare "tomorrow". Defaults to 09:00. */
  morningTime?: string;
}

export type SnoozeParse =
  | { ok: true; minutes: number; label: string }
  | { ok: true; until: Date; label: string }
  | { ok: false; reason: 'missing' | 'unsupported' };

const RELATIVE_MINUTES = /^(\d{1,4})\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/i;
const HOUR_MINUTE = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i;

/** "9am" / "9:30" / "21:00" → "09:00"/"09:30"/"21:00", or null. */
export function parseClockToHhMm(text: string): string | null {
  const match = HOUR_MINUTE.exec(text.trim());
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  const meridiem = (match[3] ?? '').toLowerCase();
  if (minute > 59) return null;
  if (meridiem === 'am') {
    if (hour > 12) return null;
    if (hour === 12) hour = 0;
  } else if (meridiem === 'pm') {
    if (hour > 12) return null;
    if (hour !== 12) hour += 12;
  } else if (hour > 23) {
    return null;
  }
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * Parses a snooze argument. The supported forms are deliberately few and
 * explicit: an unsupported interval is a question, not a guess.
 */
export function parseSnoozeCommand(args: string, options: SnoozeParseOptions): SnoozeParse {
  const text = args.trim().toLowerCase();
  if (text.length === 0) return { ok: false, reason: 'missing' };

  const relative = RELATIVE_MINUTES.exec(text);
  if (relative) {
    const amount = Number(relative[1]);
    if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: 'unsupported' };
    const unit = (relative[2] ?? '').toLowerCase();
    const minutes = unit.startsWith('h') ? amount * 60 : amount;
    return { ok: true, minutes, label: formatMinutes(minutes) };
  }

  if (text === 'tomorrow' || text.startsWith('tomorrow ')) {
    const rest = text.replace(/^tomorrow\s*/, '').replace(/^at\s+/, '');
    const hhmm = rest.length === 0 ? (options.morningTime ?? '09:00') : parseClockToHhMm(rest);
    if (!hhmm) return { ok: false, reason: 'unsupported' };
    const tomorrow = toLocal(options.now, options.timeZone).plus({ days: 1 }).toFormat('yyyy-MM-dd');
    const until = localDateTimeToUtc(tomorrow, hhmm, options.timeZone);
    if (!until) return { ok: false, reason: 'unsupported' };
    return { ok: true, until, label: `tomorrow at ${hhmm}` };
  }

  return { ok: false, reason: 'unsupported' };
}

function formatMinutes(minutes: number): string {
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/**
 * Splits `/snooze <interval> [#id]` (in either order) into its two parts.
 *
 * Only an explicit `#id` token — or an unambiguous long alphanumeric token that
 * is not itself an interval — is treated as an id, so "10m" is never mistaken
 * for one.
 */
export function splitSnoozeTarget(args: string): { interval: string; id: string | null } {
  const tokens = args
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  let id: string | null = null;
  const rest: string[] = [];
  for (const token of tokens) {
    const isExplicitId = token.startsWith('#');
    const isBareId = /^[a-z0-9]{6,}$/i.test(token) && !RELATIVE_MINUTES.test(token) && !/^tomorrow$/i.test(token);
    if (id === null && (isExplicitId || isBareId)) {
      id = token;
      continue;
    }
    rest.push(token);
  }
  return { interval: rest.join(' '), id };
}
