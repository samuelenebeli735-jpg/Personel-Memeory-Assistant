import { describe, expect, it } from 'vitest';

import {
  addMinutes,
  describeRelative,
  endOfLocalDay,
  formatLocalCompact,
  isSameLocalDay,
  isWithinQuietHours,
  localDateKey,
  localDateTimeToUtc,
  localDayRange,
  localDayRangeOffset,
  localMinutesOfDay,
  nextQuietHoursEnd,
  parseHhMm,
  toLocal,
  toUtcIso,
} from '../../src/lib/time.js';

const LAGOS = 'Africa/Lagos';
const NY = 'America/New_York';

describe('time zone conversion', () => {
  it('converts local wall-clock time to the correct UTC instant', () => {
    expect(localDateTimeToUtc('2026-10-18', '09:00', LAGOS)?.toISOString()).toBe('2026-10-18T08:00:00.000Z');
    expect(localDateTimeToUtc('2026-12-01', '00:30', LAGOS)?.toISOString()).toBe('2026-11-30T23:30:00.000Z');
  });

  it('handles daylight-saving transitions in a DST zone', () => {
    // New York springs forward on 2026-03-08 at 02:00 local.
    expect(localDateTimeToUtc('2026-03-08', '09:00', NY)?.toISOString()).toBe('2026-03-08T13:00:00.000Z');
    // Standard time again: 09:00 EST = 14:00Z.
    expect(localDateTimeToUtc('2026-12-08', '09:00', NY)?.toISOString()).toBe('2026-12-08T14:00:00.000Z');
  });

  it('rejects nonsense local times rather than silently shifting them', () => {
    expect(localDateTimeToUtc('2026-10-18', '99:99', LAGOS)).toBeNull();
  });

  it('computes the local day range as UTC bounds', () => {
    const range = localDayRange(new Date('2026-10-17T23:30:00.000Z'), LAGOS);
    expect(range.localDate).toBe('2026-10-18');
    expect(range.startUtc.toISOString()).toBe('2026-10-17T23:00:00.000Z');
    expect(range.endUtc.toISOString()).toBe('2026-10-18T23:00:00.000Z');
  });

  it('can offset a day range into the past and future', () => {
    const yesterday = localDayRangeOffset(new Date('2026-10-17T10:00:00.000Z'), LAGOS, -1);
    expect(yesterday.localDate).toBe('2026-10-16');
    expect(yesterday.startUtc.toISOString()).toBe('2026-10-15T23:00:00.000Z');
    const tomorrow = localDayRangeOffset(new Date('2026-10-17T10:00:00.000Z'), LAGOS, 1);
    expect(tomorrow.localDate).toBe('2026-10-18');
  });

  it('reports the local calendar date and minutes-of-day', () => {
    const instant = new Date('2026-10-17T23:30:00.000Z');
    expect(localDateKey(instant, LAGOS)).toBe('2026-10-18');
    expect(localMinutesOfDay(instant, LAGOS)).toBe(30);
  });

  it('treats end-of-local-day correctly', () => {
    const instant = new Date('2026-10-18T12:00:00.000Z');
    expect(endOfLocalDay(instant, LAGOS).toISOString()).toBe('2026-10-18T22:59:59.999Z');
  });

  it('compares local days, not UTC days', () => {
    const a = new Date('2026-10-17T22:30:00.000Z'); // 23:30 local 17th
    const b = new Date('2026-10-17T23:30:00.000Z'); // 00:30 local 18th
    expect(isSameLocalDay(a, b, LAGOS)).toBe(false);
    expect(isSameLocalDay(a, new Date('2026-10-17T12:00:00.000Z'), LAGOS)).toBe(true);
  });

  it('formats UTC output consistently', () => {
    expect(toUtcIso(new Date('2026-10-17T10:00:00.000Z'))).toBe('2026-10-17T10:00:00.000Z');
  });

  it('formats a compact local string', () => {
    expect(formatLocalCompact(new Date('2026-10-17T15:00:00.000Z'), LAGOS)).toBe('Sat 17 Oct, 4:00 PM');
  });

  it('describes times relative to a reference', () => {
    const reference = new Date('2026-10-17T10:00:00.000Z');
    expect(describeRelative(addMinutes(reference, 30), reference, LAGOS)).toBe('in 30 min');
    expect(describeRelative(new Date('2026-10-18T08:00:00.000Z'), reference, LAGOS)).toBe('tomorrow at 9:00 AM');
    expect(describeRelative(new Date('2026-10-17T12:00:00.000Z'), reference, LAGOS)).toBe('today at 1:00 PM');
  });
});

describe('quiet hours', () => {
  it('supports a window that wraps past midnight', () => {
    const at = (iso: string) => new Date(iso);
    expect(isWithinQuietHours(at('2026-10-17T21:30:00.000Z'), LAGOS, '22:00', '07:00')).toBe(true); // 22:30 local
    expect(isWithinQuietHours(at('2026-10-17T12:00:00.000Z'), LAGOS, '22:00', '07:00')).toBe(false); // 13:00 local
    expect(isWithinQuietHours(at('2026-10-17T05:59:00.000Z'), LAGOS, '22:00', '07:00')).toBe(true); // 06:59 local
    expect(isWithinQuietHours(at('2026-10-17T06:00:00.000Z'), LAGOS, '22:00', '07:00')).toBe(false); // 07:00 local
  });

  it('supports a same-day window and treats missing bounds as disabled', () => {
    expect(isWithinQuietHours(new Date('2026-10-17T13:00:00.000Z'), LAGOS, '13:00', '15:00')).toBe(true); // 14:00 local
    expect(isWithinQuietHours(new Date('2026-10-17T13:00:00.000Z'), LAGOS, null, null)).toBe(false);
    expect(isWithinQuietHours(new Date('2026-10-17T13:00:00.000Z'), LAGOS, '22:00', '22:00')).toBe(false);
  });

  it('computes when quiet hours end (deferring to the next morning when needed)', () => {
    const inside = new Date('2026-10-17T21:30:00.000Z'); // 22:30 local
    expect(nextQuietHoursEnd(inside, LAGOS, '22:00', '07:00')?.toISOString()).toBe('2026-10-18T06:00:00.000Z');
    expect(nextQuietHoursEnd(new Date('2026-10-17T12:00:00.000Z'), LAGOS, '22:00', '07:00')).toBeNull();
  });
});

describe('hh:mm helpers', () => {
  it('parses valid values and rejects invalid ones', () => {
    expect(parseHhMm('09:30')).toEqual({ hour: 9, minute: 30 });
    expect(parseHhMm('00:00')).toEqual({ hour: 0, minute: 0 });
    expect(() => parseHhMm('24:00')).toThrow();
    expect(() => parseHhMm('9:00')).toThrow();
  });

  it('keeps the instant stable when read back in local time', () => {
    const utc = localDateTimeToUtc('2026-10-18', '09:00', LAGOS)!;
    expect(toLocal(utc, LAGOS).toFormat('yyyy-MM-dd HH:mm')).toBe('2026-10-18 09:00');
  });
});
