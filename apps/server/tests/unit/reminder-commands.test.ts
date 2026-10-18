import { describe, expect, it } from 'vitest';

import { parseRemindCommand, parseSnoozeCommand, splitSnoozeTarget, parseClockToHhMm } from '../../src/lib/reminder-commands.js';

const LAGOS = 'Africa/Lagos';
const REF = new Date('2026-10-17T10:00:00.000Z'); // 11:00 local Saturday

describe('parseRemindCommand', () => {
  it('parses "in 10 minutes" as relative', () => {
    const parsed = parseRemindCommand('in 10 minutes Review the docs', { timeZone: LAGOS, now: REF });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.title).toBe('Review the docs');
      expect(parsed.remindAt.getTime()).toBe(new Date(REF.getTime() + 10 * 60_000).getTime());
      expect(parsed.assumption).toBeNull();
    }
  });

  it('parses "in 2 hours" as relative', () => {
    const parsed = parseRemindCommand('in 2 hours Call Ada', { timeZone: LAGOS, now: REF });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.remindAt.getTime()).toBe(new Date(REF.getTime() + 2 * 3_600_000).getTime());
  });

  it('parses "tomorrow at 9am" as absolute', () => {
    const parsed = parseRemindCommand('tomorrow at 9am Call the office', {
      timeZone: LAGOS,
      now: REF,
      morningTime: '09:00',
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.title).toBe('Call the office');
      // 2026-10-18 09:00 Africa/Lagos = 2026-10-18T08:00:00.000Z
      expect(parsed.remindAt.toISOString()).toBe('2026-10-18T08:00:00.000Z');
    }
  });

  it('parses "tomorrow at 9am" with recurrence', () => {
    const parsed = parseRemindCommand('every day at 9am Daily standup', {
      timeZone: LAGOS,
      now: REF,
      morningTime: '09:00',
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.recurrence).not.toBeNull();
      if (parsed.recurrence) expect(parsed.recurrence.frequency).toBe('DAILY');
    }
  });

  it('refuses missing time', () => {
    const parsed = parseRemindCommand('Review the docs', { timeZone: LAGOS, now: REF });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe('missing-time');
  });

  it('refuses missing title', () => {
    const parsed = parseRemindCommand('in 10 minutes', { timeZone: LAGOS, now: REF });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe('missing-title');
  });

  it('refuses date-only with no time', () => {
    const parsed = parseRemindCommand('on Friday', { timeZone: LAGOS, now: REF });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe('ambiguous-time');
  });

  it('reports assumption for "tomorrow morning"', () => {
    const parsed = parseRemindCommand('tomorrow morning Call Ada', {
      timeZone: LAGOS,
      now: REF,
      morningTime: '09:00',
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.assumption).toContain('no time given');
      expect(parsed.assumption).toContain('morning');
    }
  });
});

describe('parseSnoozeCommand', () => {
  it('parses "10m"', () => {
    const parsed = parseSnoozeCommand('10m', { timeZone: LAGOS, now: REF, morningTime: '09:00' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect('minutes' in parsed).toBe(true);
      if ('minutes' in parsed) expect(parsed.minutes).toBe(10);
      expect(parsed.label).toBe('10 minutes');
    }
  });

  it('parses "1h"', () => {
    const parsed = parseSnoozeCommand('1h', { timeZone: LAGOS, now: REF, morningTime: '09:00' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect('minutes' in parsed).toBe(true);
      if ('minutes' in parsed) expect(parsed.minutes).toBe(60);
      expect(parsed.label).toBe('1 hour');
    }
  });

  it('parses "tomorrow" as tomorrow 09:00', () => {
    const parsed = parseSnoozeCommand('tomorrow', { timeZone: LAGOS, now: REF, morningTime: '09:00' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect('until' in parsed).toBe(true);
      if ('until' in parsed) expect(parsed.until.toISOString()).toBe('2026-10-18T08:00:00.000Z');
    }
  });

  it('parses "tomorrow 9am"', () => {
    const parsed = parseSnoozeCommand('tomorrow 9am', { timeZone: LAGOS, now: REF, morningTime: '09:00' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect('until' in parsed).toBe(true);
      if ('until' in parsed) expect(parsed.until.toISOString()).toBe('2026-10-18T08:00:00.000Z');
    }
  });

  it('parses "tomorrow at 2:30pm"', () => {
    const parsed = parseSnoozeCommand('tomorrow at 2:30pm', { timeZone: LAGOS, now: REF, morningTime: '09:00' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect('until' in parsed).toBe(true);
      if ('until' in parsed) {
        // 2026-10-18 14:30 Africa/Lagos = 2026-10-18T13:30:00.000Z
        expect(parsed.until.toISOString()).toBe('2026-10-18T13:30:00.000Z');
      }
    }
  });

  it('refuses missing', () => {
    const parsed = parseSnoozeCommand('', { timeZone: LAGOS, now: REF });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe('missing');
  });

  it('refuses unsupported', () => {
    const parsed = parseSnoozeCommand('next week', { timeZone: LAGOS, now: REF });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe('unsupported');
  });
});

describe('splitSnoozeTarget', () => {
  it('splits "10m #abc123"', () => {
    const { interval, id } = splitSnoozeTarget('10m #abc123');
    expect(interval).toBe('10m');
    expect(id).toBe('#abc123');
  });

  it('splits "#abc123 10m"', () => {
    const { interval, id } = splitSnoozeTarget('#abc123 10m');
    expect(interval).toBe('10m');
    expect(id).toBe('#abc123');
  });

  it('splits "1h xyz789"', () => {
    const { interval, id } = splitSnoozeTarget('1h xyz789');
    expect(interval).toBe('1h');
    expect(id).toBe('xyz789');
  });

  it('returns null id when only interval', () => {
    const { interval, id } = splitSnoozeTarget('10m');
    expect(interval).toBe('10m');
    expect(id).toBeNull();
  });
});

describe('parseClockToHhMm', () => {
  it('parses "9am"', () => {
    expect(parseClockToHhMm('9am')).toBe('09:00');
  });

  it('parses "2:30pm"', () => {
    expect(parseClockToHhMm('2:30pm')).toBe('14:30');
  });

  it('parses "21:00"', () => {
    expect(parseClockToHhMm('21:00')).toBe('21:00');
  });

  it('parses "00:00"', () => {
    expect(parseClockToHhMm('00:00')).toBe('00:00');
  });

  it('returns null for invalid', () => {
    expect(parseClockToHhMm('25:00')).toBeNull();
    expect(parseClockToHhMm('9:60')).toBeNull();
    expect(parseClockToHhMm('tomorrow')).toBeNull();
  });
});