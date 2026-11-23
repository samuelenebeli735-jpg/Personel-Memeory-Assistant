import { describe, expect, it } from 'vitest';

import {
  detectRecurrence,
  looksLikeQuestion,
  parseRelativeDuration,
  parseTemporalExpression,
  resolveWallClock,
  stripTemporalPhrase,
} from '../../src/lib/nlp.js';
import { localDateKey, toLocal } from '../../src/lib/time.js';

const TZ = 'Africa/Lagos';
// Saturday 17 October 2026, 11:00 local (UTC+1).
const REFERENCE = new Date('2026-10-17T10:00:00.000Z');

function parse(text: string) {
  return parseTemporalExpression(text, {
    timeZone: TZ,
    reference: REFERENCE,
    morningTime: '09:00',
    eveningTime: '19:00',
  });
}

describe('natural-language date parsing', () => {
  it('resolves an explicit clock time later today', () => {
    const result = parse('Remind me to call someone at 4 PM.');
    expect(result.found).toBe(true);
    expect(result.instant?.toISOString()).toBe('2026-10-17T15:00:00.000Z');
    expect(result.usedDefaultTime).toBe(false);
    // The day itself was implied rather than stated, so certainty stays medium.
    expect(result.certainty).toBe('medium');
  });

  it('reports high certainty when both the day and the time were stated', () => {
    const result = parse('Lunch with Ada tomorrow at 1 PM');
    expect(result.certainty).toBe('high');
    expect(result.instant?.toISOString()).toBe('2026-10-18T12:00:00.000Z');
  });

  it('resolves a relative duration', () => {
    const result = parse('Remind me to stretch in 10 minutes');
    expect(result.found).toBe(true);
    expect(result.instant?.toISOString()).toBe('2026-10-17T10:10:00.000Z');
  });

  it('resolves "tomorrow at 9 AM" in the configured zone', () => {
    const result = parse('Send the invoice tomorrow at 9 AM');
    expect(result.instant?.toISOString()).toBe('2026-10-18T08:00:00.000Z');
    expect(result.dateOnly).toBe(false);
  });

  it('resolves "next Friday at 4 PM" to the following week', () => {
    const result = parse('Review the design next Friday at 4 PM');
    expect(result.found).toBe(true);
    const local = toLocal(result.instant!, TZ);
    expect(localDateKey(result.instant!, TZ)).toBe('2026-10-23');
    expect(local.hour).toBe(16);
  });

  it('uses the configured default for a vague time of day and reports the assumption', () => {
    const result = parse('Take the bins out tomorrow morning');
    expect(result.found).toBe(true);
    expect(result.usedDefaultTime).toBe(true);
    expect(result.instant?.toISOString()).toBe('2026-10-18T08:00:00.000Z');
    expect(result.assumption).toContain('09:00');
  });

  it('marks a date with no time as date-only instead of inventing an hour', () => {
    const result = parse('I need to finish my project documentation tomorrow.');
    expect(result.found).toBe(true);
    expect(result.dateOnly).toBe(true);
    expect(localDateKey(result.instant!, TZ)).toBe('2026-10-18');
  });

  it('returns found:false when there is genuinely no date', () => {
    expect(parse('Buy milk and eggs').found).toBe(false);
    expect(parse('I have an idea for a website that helps students').found).toBe(false);
    expect(parse('Research PostgreSQL concepts for later').found).toBe(false);
  });

  it('does not treat the verb "may" as the month May', () => {
    const result = parse('I may go to the market');
    expect(result.found).toBe(false);
  });

  it('does not treat the verb "sat" as Saturday', () => {
    expect(parse('I sat down and wrote out the plan').found).toBe(false);
  });

  it('still parses a month followed by a day number', () => {
    const result = parse('Renew the licence on May 5');
    expect(result.found).toBe(true);
    expect(localDateKey(result.instant!, TZ)).toBe('2027-05-05');
  });

  it('flags a stated time that is already in the past rather than moving it', () => {
    const result = parse('Call the bank at 7 AM');
    expect(result.found).toBe(true);
    // 07:00 local has already passed today, so chrono rolls forward to tomorrow.
    expect(localDateKey(result.instant!, TZ)).toBe('2026-10-18');
  });

  it('reports the matched text so callers can build a clean title', () => {
    const result = parse('Pay the electricity bill on Tuesday at 5 PM');
    expect(result.matchedText).toBeTruthy();
    const stripped = stripTemporalPhrase('Pay the electricity bill on Tuesday at 5 PM', result.matchedText);
    expect(stripped).not.toMatch(/Tuesday/i);
    expect(stripped).toContain('electricity bill');
  });
});

describe('recurrence detection', () => {
  it('detects daily and weekly phrases', () => {
    expect(detectRecurrence('remind me every day to stretch', TZ, REFERENCE)?.frequency).toBe('DAILY');
    expect(detectRecurrence('standup every week', TZ, REFERENCE)?.frequency).toBe('WEEKLY');
    expect(detectRecurrence('pay rent monthly', TZ, REFERENCE)?.frequency).toBe('MONTHLY');
  });

  it('detects specific weekdays', () => {
    const recurrence = detectRecurrence('remind me every Monday morning', TZ, REFERENCE);
    expect(recurrence?.frequency).toBe('WEEKLY');
    expect(recurrence?.weekdays).toEqual([1]);
  });

  it('collects multiple weekdays without duplicates', () => {
    const recurrence = detectRecurrence('every monday and every thursday', TZ, REFERENCE);
    expect(recurrence?.weekdays).toEqual([1, 4]);
  });

  it('returns null when nothing recurs', () => {
    expect(detectRecurrence('call mum at 4pm', TZ, REFERENCE)).toBeNull();
  });
});

describe('relative durations and question detection', () => {
  it('parses hours, days and weeks', () => {
    expect(parseRelativeDuration('in 2 hours', REFERENCE)?.instant.toISOString()).toBe('2026-10-17T12:00:00.000Z');
    expect(parseRelativeDuration('in 3 days', REFERENCE)?.instant.toISOString()).toBe('2026-10-20T10:00:00.000Z');
    expect(parseRelativeDuration('in 1 week', REFERENCE)?.instant.toISOString()).toBe('2026-10-24T10:00:00.000Z');
    expect(parseRelativeDuration('no duration here', REFERENCE)).toBeNull();
  });

  it('recognises recall questions so they are not stored as tasks', () => {
    expect(looksLikeQuestion('What were the things I wanted to do yesterday?')).toBe(true);
    expect(looksLikeQuestion('show me my overdue tasks')).toBe(true);
    expect(looksLikeQuestion('Find the idea I had about a student platform')).toBe(true);
    expect(looksLikeQuestion('I need to finish the documentation')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Owner time zone, independent of the host                                    */
/* -------------------------------------------------------------------------- */

describe('the owner zone, not the host zone', () => {
  it('runs with a pinned host zone that differs from every owner zone tested', () => {
    // vitest.config.ts pins the host; a Lagos laptop must not hide host bugs.
    const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(host).toBe(process.env.RECALL_TEST_HOST_TZ ?? 'Pacific/Kiritimati');
  });

  function parseIn(timeZone: string, text: string, reference = REFERENCE) {
    return parseTemporalExpression(text, {
      timeZone,
      reference,
      morningTime: '09:00',
      eveningTime: '19:00',
    });
  }

  // REFERENCE is 2026-10-17T10:00Z: Saturday 11:00 Lagos (UTC+1),
  // Saturday 06:00 New York (UTC-4, daylight time), Saturday 10:00 UTC.
  const cases: [string, string, string][] = [
    // [zone, phrase, expected UTC]
    ['Africa/Lagos', 'tomorrow at 9am', '2026-10-18T08:00:00.000Z'],
    ['America/New_York', 'tomorrow at 9am', '2026-10-18T13:00:00.000Z'],
    ['UTC', 'tomorrow at 9am', '2026-10-18T09:00:00.000Z'],
    ['Africa/Lagos', 'next monday at 9am', '2026-10-19T08:00:00.000Z'],
    ['America/New_York', 'next monday at 9am', '2026-10-19T13:00:00.000Z'],
    ['UTC', 'next monday at 9am', '2026-10-19T09:00:00.000Z'],
    ['America/New_York', 'meeting on friday at 14:30', '2026-10-23T18:30:00.000Z'],
    ['America/New_York', 'tomorrow morning', '2026-10-18T13:00:00.000Z'],
    ['Africa/Lagos', 'tonight', '2026-10-17T18:00:00.000Z'],
    ['America/New_York', 'tonight', '2026-10-17T23:00:00.000Z'],
  ];
  for (const [timeZone, phrase, expected] of cases) {
    it(`reads "${phrase}" in ${timeZone}`, () => {
      expect(parseIn(timeZone, phrase).instant?.toISOString()).toBe(expected);
    });
  }

  it('keeps a bare date on the owner local calendar', () => {
    const result = parseIn('America/New_York', 'dentist on friday');
    expect(result.dateOnly).toBe(true);
    expect(localDateKey(result.instant!, 'America/New_York')).toBe('2026-10-23');
  });

  it('moves a time that already passed today to tomorrow, per zone', () => {
    // 07:00 has passed in Lagos (11:00) but not in New York (06:00).
    expect(parseIn('Africa/Lagos', 'at 7am').instant?.toISOString()).toBe('2026-10-18T06:00:00.000Z');
    expect(parseIn('America/New_York', 'at 7am').instant?.toISOString()).toBe('2026-10-17T11:00:00.000Z');
  });

  it('keeps an exact duration as elapsed time', () => {
    expect(parseIn('America/New_York', 'remind me in 2 hours').instant?.toISOString()).toBe(
      '2026-10-17T12:00:00.000Z',
    );
  });

  it('respects a zone written in the text', () => {
    // 09:00 UTC already passed at 10:00Z, so it means tomorrow at 09:00 UTC.
    expect(parseIn('America/New_York', 'standup at 9am UTC').instant?.toISOString()).toBe(
      '2026-10-18T09:00:00.000Z',
    );
  });
});

describe('daylight-saving changes in the owner zone', () => {
  // New York: clocks go forward 2027-03-14 02:00 -> 03:00, back 2026-11-01 02:00 -> 01:00.
  it('uses the offset of the target date, not of today', () => {
    // Today is in daylight time (UTC-4); 25 December is standard time (UTC-5).
    const result = parseTemporalExpression('dec 25 at 10am', {
      timeZone: 'America/New_York',
      reference: REFERENCE,
    });
    expect(result.instant?.toISOString()).toBe('2026-12-25T15:00:00.000Z');
  });

  it('crosses the spring-forward change with the right offset', () => {
    // Saturday 13 March 2027, 12:00 New York (UTC-5); tomorrow is UTC-4.
    const result = parseTemporalExpression('tomorrow at 9am', {
      timeZone: 'America/New_York',
      reference: new Date('2027-03-13T17:00:00.000Z'),
    });
    expect(result.instant?.toISOString()).toBe('2027-03-14T13:00:00.000Z');
  });

  it('crosses the fall-back change with the right offset', () => {
    // Saturday 31 October 2026, 12:00 New York (UTC-4); tomorrow is UTC-5.
    const result = parseTemporalExpression('tomorrow at 9am', {
      timeZone: 'America/New_York',
      reference: new Date('2026-10-31T16:00:00.000Z'),
    });
    expect(result.instant?.toISOString()).toBe('2026-11-01T14:00:00.000Z');
  });

  it('moves a non-existent time forward and says so', () => {
    const result = parseTemporalExpression('tomorrow at 2:30am', {
      timeZone: 'America/New_York',
      reference: new Date('2027-03-13T17:00:00.000Z'),
    });
    // 02:30 does not exist on 14 March; 03:30 EDT is 07:30Z.
    expect(result.instant?.toISOString()).toBe('2027-03-14T07:30:00.000Z');
    expect(result.assumption).toMatch(/02:30 does not exist on 2027-03-14 in America\/New_York; used 03:30/);
  });

  it('uses the first occurrence of a repeated time and says so', () => {
    const result = parseTemporalExpression('tomorrow at 1:30am', {
      timeZone: 'America/New_York',
      reference: new Date('2026-10-31T16:00:00.000Z'),
    });
    // 01:30 happens at 05:30Z (EDT) and again at 06:30Z (EST): the first wins.
    expect(result.instant?.toISOString()).toBe('2026-11-01T05:30:00.000Z');
    expect(result.assumption).toMatch(/01:30 occurs twice on 2026-11-01 in America\/New_York; used the first occurrence/);
  });

  it('resolveWallClock handles normal, missing and repeated times directly', () => {
    expect(resolveWallClock({ year: 2026, month: 7, day: 1, hour: 9, minute: 0 }, 'Africa/Lagos')).toEqual({
      instant: new Date('2026-07-01T08:00:00.000Z'),
      note: null,
    });
    expect(
      resolveWallClock({ year: 2027, month: 3, day: 14, hour: 2, minute: 30 }, 'America/New_York').instant?.toISOString(),
    ).toBe('2027-03-14T07:30:00.000Z');
    expect(
      resolveWallClock({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, 'America/New_York').instant?.toISOString(),
    ).toBe('2026-11-01T05:30:00.000Z');
  });
});
