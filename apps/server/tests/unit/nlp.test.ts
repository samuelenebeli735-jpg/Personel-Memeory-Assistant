import { describe, expect, it } from 'vitest';

import {
  detectRecurrence,
  looksLikeQuestion,
  parseRelativeDuration,
  parseTemporalExpression,
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
