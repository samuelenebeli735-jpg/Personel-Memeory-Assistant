/**
 * Reading the time intent of an Ask question (R1-03).
 *
 * Pure: no database. Boundaries are asserted as exact UTC instants so a
 * wrong zone, a wrong week start or a DST slip fails loudly. The host zone is
 * pinned by vitest.config.ts to one no test uses as an owner zone.
 */
import { describe, expect, it } from 'vitest';

import { detectTemporalIntent, type TemporalIntent } from '../../src/services/ask-temporal.js';

// Saturday 17 October 2026: 11:00 in Lagos (UTC+1), 06:00 in New York (UTC-4).
const NOW = new Date('2026-10-17T10:00:00.000Z');
const LAGOS = 'Africa/Lagos';
const NEW_YORK = 'America/New_York';

function range(question: string, zone = LAGOS, now = NOW) {
  const intent = detectTemporalIntent(question, zone, now);
  expect(intent?.kind, question).toBe('range');
  const r = intent as Extract<TemporalIntent, { kind: 'range' }>;
  return {
    start: r.range.start.toISOString(),
    end: r.range.end.toISOString(),
    label: r.range.label,
    mode: r.mode,
    types: r.types,
    subject: r.subject,
  };
}

describe('questions that are not about time', () => {
  for (const question of [
    'When is my dentist appointment?',
    'What did I say about tiles?',
    'May I see the plumber notes?',
    'Where is the invoice for the march of progress?',
  ]) {
    it(`leaves "${question}" to word search`, () => {
      expect(detectTemporalIntent(question, LAGOS, NOW)).toBeNull();
    });
  }
});

describe('days in the owner zone', () => {
  it('reads today, tomorrow and yesterday as whole local days in Lagos', () => {
    expect(range('What do I have today?')).toMatchObject({
      start: '2026-10-16T23:00:00.000Z',
      end: '2026-10-17T23:00:00.000Z',
      label: 'Today, Sat 17 Oct',
    });
    expect(range('What do I have tomorrow?')).toMatchObject({
      start: '2026-10-17T23:00:00.000Z',
      end: '2026-10-18T23:00:00.000Z',
      label: 'Tomorrow, Sun 18 Oct',
    });
    expect(range('What happened yesterday?')).toMatchObject({
      start: '2026-10-15T23:00:00.000Z',
      end: '2026-10-16T23:00:00.000Z',
      mode: 'activity',
    });
  });

  it('puts the same question on different UTC boundaries in New York', () => {
    expect(range('What do I have tomorrow?', NEW_YORK)).toMatchObject({
      start: '2026-10-18T04:00:00.000Z',
      end: '2026-10-19T04:00:00.000Z',
    });
  });

  it('uses the local day even when UTC is already on the next day', () => {
    // 23:30 in New York on Saturday is 03:30Z on Sunday.
    const lateSaturday = new Date('2026-10-18T03:30:00.000Z');
    expect(range('What do I have today?', NEW_YORK, lateSaturday).label).toBe('Today, Sat 17 Oct');
  });

  it('resolves last, next and plain weekdays (next Friday = the coming Friday)', () => {
    expect(range('What happened last Friday?').label).toBe('Fri 16 Oct');
    expect(range('What do I have next Friday?').label).toBe('Fri 23 Oct');
    expect(range('What do I have on Friday?').label).toBe('Fri 23 Oct');
    // Past tense without a modifier means the most recent such day.
    expect(range('What did I capture on Friday?').label).toBe('Fri 16 Oct');
    // "last Saturday" on a Saturday is a week ago; "this Saturday" is today.
    expect(range('What happened last Saturday?').label).toBe('Sat 10 Oct');
    expect(range('What do I have this Saturday?').label).toBe('Sat 17 Oct');
  });

  it('resolves an explicit date in the owner zone', () => {
    expect(range('What do I have on 25 December?')).toMatchObject({
      start: '2026-12-24T23:00:00.000Z',
      end: '2026-12-25T23:00:00.000Z',
      label: 'Fri 25 Dec',
    });
    expect(range('What is on 2026-12-25?', NEW_YORK)).toMatchObject({
      start: '2026-12-25T05:00:00.000Z',
      end: '2026-12-26T05:00:00.000Z',
    });
  });
});

describe('weeks and months', () => {
  it('runs a week from Monday to Sunday in the owner zone', () => {
    expect(range('What do I have this week?')).toMatchObject({
      start: '2026-10-11T23:00:00.000Z', // Mon 12 Oct 00:00 Lagos
      end: '2026-10-18T23:00:00.000Z', // Mon 19 Oct 00:00 Lagos
      label: 'This week, Mon 12 Oct – Sun 18 Oct',
    });
    expect(range('What do I have next week?').label).toBe('Next week, Mon 19 Oct – Sun 25 Oct');
    expect(range('What happened last week?').mode).toBe('activity');
  });

  it('keeps a week whole across the New York fall-back change (169 hours)', () => {
    const wednesday = new Date('2026-10-28T16:00:00.000Z');
    const week = range('What do I have this week?', NEW_YORK, wednesday);
    expect(week.start).toBe('2026-10-26T04:00:00.000Z'); // Mon 00:00 EDT
    expect(week.end).toBe('2026-11-02T05:00:00.000Z'); // Mon 00:00 EST
    expect((Date.parse(week.end) - Date.parse(week.start)) / 3_600_000).toBe(169);
  });

  it('reads this, next and last month', () => {
    expect(range('What do I have next month?').label).toBe('Next month, Sun 1 Nov – Mon 30 Nov');
  });
});

describe('shape of the question', () => {
  it('lists what is scheduled for the future, even with "happen"', () => {
    expect(range('What will happen tomorrow?').mode).toBe('agenda');
    expect(range('What do I need to get done tomorrow?').mode).toBe('agenda');
  });

  it('narrows to the named record types and keeps them distinct', () => {
    expect(range('What events do I have tomorrow?').types).toEqual(['EVENT']);
    expect(range('Any reminders or tasks this week?').types).toEqual(['REMINDER', 'TASK']);
    expect(range('What do I have tomorrow?').types).toBeNull();
  });

  it('keeps a subject the question is about', () => {
    expect(range('What did I note about tiles last week?').subject).toBe('tiles');
    expect(range('What do I have tomorrow?').subject).toBeNull();
  });

  it('reads next, last and until questions by record type', () => {
    expect(detectTemporalIntent('When is my next reminder?', LAGOS, NOW)).toEqual({ kind: 'next', type: 'REMINDER' });
    expect(detectTemporalIntent('When is my next appointment?', LAGOS, NOW)).toEqual({ kind: 'next', type: 'EVENT' });
    expect(detectTemporalIntent('What was my last event?', LAGOS, NOW)).toEqual({ kind: 'last', type: 'EVENT' });
    expect(detectTemporalIntent('How many days until my next event?', LAGOS, NOW)).toEqual({
      kind: 'until',
      type: 'EVENT',
      subject: null,
    });
    expect(detectTemporalIntent('How many days until the dentist appointment?', LAGOS, NOW)).toEqual({
      kind: 'until',
      type: 'EVENT',
      subject: 'dentist',
    });
  });

  it('asks for clarification instead of guessing a period', () => {
    expect(detectTemporalIntent('What do I have next weekend?', LAGOS, NOW)?.kind).toBe('unclear');
    expect(detectTemporalIntent('What happened in June?', LAGOS, NOW)?.kind).toBe('unclear');
    expect(detectTemporalIntent('How many days until?', LAGOS, NOW)?.kind).toBe('unclear');
  });
});
