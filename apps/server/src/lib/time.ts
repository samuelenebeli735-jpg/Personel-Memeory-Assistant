/**
 * Time handling.
 *
 * Invariants enforced here:
 *  - Every timestamp is persisted and passed around as a UTC `Date`.
 *  - Local time only ever exists for *interpretation* (parsing user input) and
 *    *display* (formatting for a human). The configured IANA zone is the single
 *    source for "what day is it for the user".
 *  - Day boundaries, quiet hours and "today" all resolve in the user's zone,
 *    never in the server's zone.
 */
import { DateTime, IANAZone } from 'luxon';

export type TimeZone = string;

export interface LocalDayRange {
  /** Inclusive start of the local day, as a UTC instant. */
  startUtc: Date;
  /** Exclusive end of the local day, as a UTC instant. */
  endUtc: Date;
  /** Local calendar date, YYYY-MM-DD. */
  localDate: string;
}

export function isValidTimeZone(timeZone: string): boolean {
  return IANAZone.isValidZone(timeZone);
}

export function requireTimeZone(timeZone: string): TimeZone {
  if (!isValidTimeZone(timeZone)) {
    throw new Error(`Unknown IANA time zone: ${timeZone}`);
  }
  return timeZone;
}

/** Current instant. Isolated so tests can stub a clock where useful. */
export function nowUtc(): Date {
  return new Date();
}

export function toLocal(date: Date, timeZone: TimeZone): DateTime {
  requireTimeZone(timeZone);
  return DateTime.fromJSDate(date, { zone: timeZone });
}

export function fromUtcIso(iso: string, timeZone: TimeZone = 'UTC'): Date {
  const dt = DateTime.fromISO(iso, { zone: timeZone, setZone: true });
  if (!dt.isValid) {
    throw new Error(`Invalid ISO date: ${iso}`);
  }
  return dt.toUTC().toJSDate();
}

export function toUtcIso(date: Date): string {
  return DateTime.fromJSDate(date, { zone: 'utc' }).toISO({ suppressMilliseconds: false })!;
}

/** `YYYY-MM-DD` in the configured zone. */
export function localDateKey(date: Date, timeZone: TimeZone): string {
  return toLocal(date, timeZone).toFormat('yyyy-MM-dd');
}

/** Local day boundaries for the day containing `date`. */
export function localDayRange(date: Date, timeZone: TimeZone): LocalDayRange {
  const local = toLocal(date, timeZone).startOf('day');
  return {
    startUtc: local.toUTC().toJSDate(),
    endUtc: local.plus({ days: 1 }).toUTC().toJSDate(),
    localDate: local.toFormat('yyyy-MM-dd'),
  };
}

/** Local day boundaries shifted by N days (negative = past). */
export function localDayRangeOffset(date: Date, timeZone: TimeZone, dayOffset: number): LocalDayRange {
  const local = toLocal(date, timeZone).startOf('day').plus({ days: dayOffset });
  return {
    startUtc: local.toUTC().toJSDate(),
    endUtc: local.plus({ days: 1 }).toUTC().toJSDate(),
    localDate: local.toFormat('yyyy-MM-dd'),
  };
}

/**
 * Builds a UTC instant from a local calendar date + wall-clock time (HH:MM).
 * Used when a user says "tomorrow at 9am" in a specific zone.
 */
export function localDateTimeToUtc(
  localDate: string,
  hhmm: string,
  timeZone: TimeZone,
): Date | null {
  const dt = DateTime.fromISO(`${localDate}T${hhmm}:00`, { zone: timeZone });
  if (!dt.isValid) return null;
  return dt.toUTC().toJSDate();
}

/** Converts a local wall-clock combination on `date`'s local day to UTC. */
export function atLocalTime(date: Date, hhmm: string, timeZone: TimeZone): Date | null {
  return localDateTimeToUtc(localDateKey(date, timeZone), hhmm, timeZone);
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

export function diffMinutes(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / 60_000);
}

export function startOfLocalDay(date: Date, timeZone: TimeZone): Date {
  return toLocal(date, timeZone).startOf('day').toUTC().toJSDate();
}

/** Local wall-clock minutes since midnight (0..1439). */
export function localMinutesOfDay(date: Date, timeZone: TimeZone): number {
  const local = toLocal(date, timeZone);
  return local.hour * 60 + local.minute;
}

export function parseHhMm(hhmm: string): { hour: number; minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!match) throw new Error(`Invalid HH:MM value: ${hhmm}`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

export function formatHhMm(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * Quiet hours may wrap past midnight (e.g. 22:00 → 07:00).
 * Returns false when either bound is missing.
 */
export function isWithinQuietHours(
  date: Date,
  timeZone: TimeZone,
  quietStart: string | null,
  quietEnd: string | null,
): boolean {
  if (!quietStart || !quietEnd) return false;
  const current = localMinutesOfDay(date, timeZone);
  const start = parseHhMm(quietStart);
  const end = parseHhMm(quietEnd);
  const startMinutes = start.hour * 60 + start.minute;
  const endMinutes = end.hour * 60 + end.minute;
  if (startMinutes === endMinutes) return false;
  if (startMinutes < endMinutes) {
    return current >= startMinutes && current < endMinutes;
  }
  return current >= startMinutes || current < endMinutes;
}

/** The next instant at which quiet hours end (i.e. when delivery may resume). */
export function nextQuietHoursEnd(
  date: Date,
  timeZone: TimeZone,
  quietStart: string | null,
  quietEnd: string | null,
): Date | null {
  if (!isWithinQuietHours(date, timeZone, quietStart, quietEnd) || !quietEnd) return null;
  const local = toLocal(date, timeZone);
  const end = parseHhMm(quietEnd);
  let target = local.set({ hour: end.hour, minute: end.minute, second: 0, millisecond: 0 });
  if (target <= local) target = target.plus({ days: 1 });
  return target.toUTC().toJSDate();
}

/* -------------------------------------------------------------------------- */
/* Display helpers                                                             */
/* -------------------------------------------------------------------------- */

/** e.g. "Sat 17 Oct 2026, 16:30" */
export function formatLocalHuman(date: Date, timeZone: TimeZone): string {
  return toLocal(date, timeZone).toFormat('ccc d LLL yyyy, HH:mm');
}

/** e.g. "Sat 17 Oct, 4:30 PM" */
export function formatLocalCompact(date: Date, timeZone: TimeZone): string {
  return toLocal(date, timeZone).toFormat('ccc d LLL, h:mm a');
}

/**
 * Relative description with a bounded vocabulary. Deliberately conservative:
 * when the difference is large it falls back to an absolute date.
 */
export function describeRelative(date: Date, reference: Date, timeZone: TimeZone): string {
  const target = toLocal(date, timeZone);
  const now = toLocal(reference, timeZone);
  const diffMs = target.toMillis() - now.toMillis();
  const minutes = Math.round(diffMs / 60_000);

  if (minutes === 0) return 'now';
  if (minutes > 0 && minutes < 60) return `in ${minutes} min`;
  if (minutes < 0 && minutes > -60) return `${Math.abs(minutes)} min ago`;

  const days = target.startOf('day').diff(now.startOf('day'), 'days').days;
  if (days === 0) return `today at ${target.toFormat('h:mm a')}`;
  if (days === 1) return `tomorrow at ${target.toFormat('h:mm a')}`;
  if (days === -1) return `yesterday at ${target.toFormat('h:mm a')}`;
  if (days > 1 && days < 7) return `${target.toFormat('cccc')} at ${target.toFormat('h:mm a')}`;
  if (days < 0 && days > -7) return `last ${target.toFormat('cccc')} at ${target.toFormat('h:mm a')}`;
  return formatLocalCompact(date, timeZone);
}

/** True when both instants fall on the same local calendar day. */
export function isSameLocalDay(a: Date, b: Date, timeZone: TimeZone): boolean {
  return localDateKey(a, timeZone) === localDateKey(b, timeZone);
}

export function isBefore(a: Date, b: Date): boolean {
  return a.getTime() < b.getTime();
}

/**
 * End of the local day (23:59:59.999 local), as a UTC instant.
 *
 * Convention: a date-only deadline such as "finish the docs tomorrow" is stored
 * as the *end* of that local day, so the task is only reported overdue once the
 * day the user named has actually passed.
 */
export function endOfLocalDay(date: Date, timeZone: TimeZone): Date {
  return toLocal(date, timeZone)
    .endOf('day')
    .toUTC()
    .toJSDate();
}

/** Start of the next local day, as a UTC instant. */
export function startOfNextLocalDay(date: Date, timeZone: TimeZone): Date {
  return toLocal(date, timeZone)
    .startOf('day')
    .plus({ days: 1 })
    .toUTC()
    .toJSDate();
}
