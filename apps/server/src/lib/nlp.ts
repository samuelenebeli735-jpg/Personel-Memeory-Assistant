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
import { DateTime } from 'luxon';

import { localDateTimeToUtc, localDateKey, parseHhMm, toLocal } from './time.js';

// chrono-node ships CommonJS; normalise both interop shapes.
const chrono = ((chronoModule as unknown as { default?: typeof chronoModule }).default ??
  chronoModule) as typeof chronoModule;

/* -------------------------------------------------------------------------- */
/* Time zones                                                                  */
/* -------------------------------------------------------------------------- */
//
// chrono-node's `timezone` option understands only minute offsets and a fixed
// table of abbreviations ("UTC", "EST"). An IANA name such as "Africa/Lagos"
// resolves to nothing, and chrono then silently uses the HOST's offset — so
// the same phrase meant different instants on a Lagos laptop and a UTC server.
//
// The parser therefore never relies on chrono to know the owner's zone:
//
//  1. chrono gets the owner zone's numeric offset *at the reference instant*,
//     so "today", "tomorrow" and "next Monday" are counted on the owner's
//     calendar, whatever the host's zone.
//  2. For a wall-clock phrase ("tomorrow at 9am") only chrono's local fields
//     (date and time) are used; they are converted to UTC with the owner's
//     IANA zone at the TARGET date, so a DST change between now and then is
//     applied correctly.
//  3. When chrono itself fixed the offset — an exact duration ("in 2 hours")
//     or a zone written in the text ("9am UTC") — its instant is kept as is.

/** Minimal view of chrono's parsed components used here. */
interface ChronoComponents {
  get(
    component:
      | 'year'
      | 'month'
      | 'day'
      | 'weekday'
      | 'hour'
      | 'minute'
      | 'second'
      | 'millisecond'
      | 'timezoneOffset',
  ): number | null;
  isCertain(component: 'timezoneOffset' | 'weekday' | 'day' | 'month' | 'year'): boolean;
  date(): Date;
  tags(): Set<string>;
}

/**
 * chrono's casual English parser without its `ForwardDateRefiner`.
 *
 * That refiner (chrono-node 2.10) compares a reference shifted to the HOST's
 * clock with a real instant, so "on friday" could mean last Friday on a host
 * far from the owner's zone. `forwardDate` is still passed to chrono — it also
 * widens what the duration parser accepts — but the forward rules are applied
 * by `forwardIntoFuture` below, on real instants in the owner's zone.
 */
const parser = (() => {
  const custom = chrono.casual.clone();
  const before = custom.refiners.length;
  custom.refiners = custom.refiners.filter((refiner) => refiner.constructor.name !== 'ForwardDateRefiner');
  if (custom.refiners.length !== before - 1) {
    throw new Error('chrono-node no longer has exactly one ForwardDateRefiner; review lib/nlp.ts');
  }
  return custom;
})();

/** The owner zone's offset from UTC at an instant, in minutes (Lagos: 60). */
function zoneOffsetMinutes(at: Date, timeZone: string): number {
  return DateTime.fromJSDate(at, { zone: timeZone }).offset;
}

/** A chrono reference that is independent of the host machine's zone. */
function chronoReference(reference: Date, timeZone: string): { instant: Date; timezone: number } {
  return { instant: reference, timezone: zoneOffsetMinutes(reference, timeZone) };
}

export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second?: number;
  millisecond?: number;
}

export interface ResolvedWallClock {
  instant: Date | null;
  /** Set when the local time did not exist or occurred twice. */
  note: string | null;
}

function sameWallClock(local: DateTime, wall: WallClock): boolean {
  return (
    local.year === wall.year &&
    local.month === wall.month &&
    local.day === wall.day &&
    local.hour === wall.hour &&
    local.minute === wall.minute
  );
}

function hhmmOf(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * Converts a local wall-clock time in `timeZone` to a UTC instant.
 *
 * DST policy, stated so callers can tell the owner:
 *  - a time that does not exist (spring-forward gap) moves forward by the
 *    length of the gap: 02:30 becomes 03:30;
 *  - a time that occurs twice (fall-back overlap) means its FIRST occurrence,
 *    because a reminder an hour early is safer than an hour late.
 */
export function resolveWallClock(wall: WallClock, timeZone: string): ResolvedWallClock {
  const naiveUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second ?? 0,
    wall.millisecond ?? 0,
  );
  if (Number.isNaN(naiveUtc)) return { instant: null, note: null };

  // Every offset the zone uses around this date; a candidate is valid when it
  // reads back as the same wall clock.
  const offsets = new Set<number>();
  for (const hours of [-36, -12, 0, 12, 36]) {
    const probe = DateTime.fromMillis(naiveUtc + hours * 3_600_000, { zone: timeZone });
    if (!probe.isValid) return { instant: null, note: null };
    offsets.add(probe.offset);
  }
  const valid = [...offsets]
    .map((offset) => naiveUtc - offset * 60_000)
    .filter((ms) => sameWallClock(DateTime.fromMillis(ms, { zone: timeZone }), wall))
    .sort((a, b) => a - b);
  const dateLabel = `${wall.year}-${String(wall.month).padStart(2, '0')}-${String(wall.day).padStart(2, '0')}`;
  const asked = hhmmOf(wall.hour, wall.minute);

  if (valid.length > 0) {
    const distinct = [...new Set(valid)];
    return {
      instant: new Date(distinct[0]!),
      note:
        distinct.length > 1
          ? `${asked} occurs twice on ${dateLabel} in ${timeZone}; used the first occurrence`
          : null,
    };
  }

  // Spring-forward gap: Luxon moves a non-existent time forward by the gap.
  const shifted = DateTime.fromObject(
    {
      year: wall.year,
      month: wall.month,
      day: wall.day,
      hour: wall.hour,
      minute: wall.minute,
      second: wall.second ?? 0,
      millisecond: wall.millisecond ?? 0,
    },
    { zone: timeZone },
  );
  if (!shifted.isValid) return { instant: null, note: null };
  return {
    instant: shifted.toUTC().toJSDate(),
    note: `${asked} does not exist on ${dateLabel} in ${timeZone}; used ${hhmmOf(shifted.hour, shifted.minute)}`,
  };
}

/** A Luxon zone name for a fixed offset in minutes, e.g. -300 -> "UTC-05:00". */
function fixedOffsetZone(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

function wallClockOf(components: ChronoComponents): WallClock | null {
  const year = components.get('year');
  const month = components.get('month');
  const day = components.get('day');
  if (year === null || month === null || day === null) return null;
  return {
    year,
    month,
    day,
    hour: components.get('hour') ?? 12,
    minute: components.get('minute') ?? 0,
    second: components.get('second') ?? 0,
    millisecond: components.get('millisecond') ?? 0,
  };
}

function withDate(wall: WallClock, local: DateTime): WallClock {
  return { ...wall, year: local.year, month: local.month, day: local.day };
}

/**
 * chrono's forward-date rules, applied to real instants in `zone`:
 *  - a time with no date that already passed today means tomorrow;
 *  - a weekday with no date that already passed means its next occurrence;
 *  - a month and day with no year that already passed means next year.
 */
function forwardIntoFuture(
  components: ChronoComponents,
  wall: WallClock,
  zone: string,
  reference: Date,
  resolved: ResolvedWallClock,
): ResolvedWallClock {
  if (!resolved.instant || resolved.instant.getTime() >= reference.getTime()) return resolved;
  const certain = (c: 'weekday' | 'day' | 'month' | 'year') => components.isCertain(c);
  const referenceLocal = DateTime.fromJSDate(reference, { zone });

  if (!certain('weekday') && !certain('day') && !certain('month') && !certain('year')) {
    return resolveWallClock(withDate(wall, referenceLocal.plus({ days: 1 })), zone);
  }
  if (certain('weekday') && !certain('day') && !certain('month')) {
    const weekday = components.get('weekday') ?? 0; // 0 = Sunday
    const days = (weekday - (referenceLocal.weekday % 7) + 7) % 7 || 7;
    return resolveWallClock(withDate(wall, referenceLocal.plus({ days })), zone);
  }
  if (certain('month') && !certain('year')) {
    let next = resolved;
    let candidate = wall;
    for (let i = 0; i < 3 && next.instant && next.instant.getTime() < reference.getTime(); i += 1) {
      candidate = { ...candidate, year: candidate.year + 1 };
      next = resolveWallClock(candidate, zone);
    }
    return next;
  }
  return resolved;
}

/**
 * The UTC instant chrono's components describe.
 *
 * Wall-clock phrases are resolved in the owner's zone (or in a zone written in
 * the text, e.g. "9am UTC"); exact durations ("in 2 hours") keep chrono's
 * instant, which is reference + duration.
 */
function componentsToInstant(
  components: ChronoComponents,
  timeZone: string,
  reference: Date,
  forwardDate: boolean,
): ResolvedWallClock {
  if (components.tags().has('result/relativeDate')) {
    // "in 2 hours", "in 3 days": elapsed time from the reference.
    return { instant: components.date(), note: null };
  }
  const offset = components.get('timezoneOffset');
  const zone =
    components.isCertain('timezoneOffset') && offset !== null ? fixedOffsetZone(offset) : timeZone;
  const wall = wallClockOf(components);
  if (!wall) return { instant: null, note: null };
  const resolved = resolveWallClock(wall, zone);
  return forwardDate ? forwardIntoFuture(components, wall, zone, reference, resolved) : resolved;
}

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

  // The owner's zone, as a numeric offset chrono understands (see above).
  const results = parser.parse(text, chronoReference(reference, timeZone), { forwardDate });
  const usable = results.filter((result) => hasTemporalAnchor(result.text));

  // Case 1: chrono found an explicit clock time.
  const withTime = usable.find(
    (result) => result.start.isCertain('hour') || looksLikeClockTime(result.text),
  );
  if (withTime) {
    const certainty: TemporalCertainty = withTime.start.isCertain('day') ? 'high' : 'medium';
    const resolved = componentsToInstant(withTime.start, timeZone, reference, forwardDate);
    if (!resolved.instant) return empty;
    return {
      found: true,
      instant: resolved.instant,
      certainty,
      matchedText: withTime.text,
      usedDefaultTime: false,
      dateOnly: false,
      recurrence,
      assumption: resolved.note,
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
      // The instant is midday on that local date in the owner's zone, so the
      // date survives any zone conversion callers make.
      const dayStart = componentsToInstant(withDate.start, timeZone, reference, forwardDate).instant;
      if (!dayStart) return empty;
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
    const dayPart = componentsToInstant(withDate.start, timeZone, reference, forwardDate).instant;
    const anchorDay = dayPart ? localDateKey(dayPart, timeZone) : localDateKey(reference, timeZone);
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

    const chronoTonight = parser.parse(
      'tonight',
      chronoReference(reference, timeZone),
      { forwardDate },
    )[0];
    const tonight = chronoTonight
      ? componentsToInstant(chronoTonight.start, timeZone, reference, forwardDate).instant
      : null;
    if (chronoTonight && tonight) {
      return {
        found: true,
        instant: tonight,
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
