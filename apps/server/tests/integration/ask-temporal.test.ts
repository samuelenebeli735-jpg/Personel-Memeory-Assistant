/**
 * Ask answers questions about time from the records' own timestamps (R1-03).
 *
 * Real HTTP endpoint, real SQLite, the test clock fixed at
 * 2026-10-17T10:00Z (Saturday: 11:00 Lagos, 06:00 New York). Records are
 * written with exact timestamps so day boundaries are tested precisely. The
 * AI provider is a fake that records calls: time questions must not use it.
 */
import type { AskResponse } from '@recall/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestApp, type TestApp } from '../helpers/app.js';
import { createTestDatabase, type TestDb } from '../helpers/db.js';
import { fakeAiProvider, type FakeAiProvider } from '../helpers/providers.js';
import { updateSettings } from '../../src/services/settings-service.js';

let testDb: TestDb;
let app: TestApp;
let ai: FakeAiProvider;
let cookie: string;

beforeAll(async () => {
  testDb = await createTestDatabase('ask-temporal');
  ai = fakeAiProvider();
  app = await createTestApp(testDb.db, { ai });
  cookie = await app.login();
});

afterAll(async () => {
  await app.close();
  await testDb.cleanup();
});

beforeEach(async () => {
  await testDb.reset();
  ai.answerCalls.length = 0;
});

async function ask(question: string, extra: Record<string, unknown> = {}): Promise<AskResponse> {
  const response = await app.app.inject({
    method: 'POST',
    url: '/api/ask',
    headers: { cookie },
    payload: { question, ...extra },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as AskResponse;
}

async function useZone(timeZone: string) {
  await updateSettings(testDb.db, { timeZone }, app.ctx.defaults);
}

const db = () => testDb.db;
const task = (title: string, dueAt: string, extra: Record<string, unknown> = {}) =>
  db().task.create({ data: { title, dueAt: new Date(dueAt), ...extra } });
const event = (title: string, startsAt: string) => db().event.create({ data: { title, startsAt: new Date(startsAt) } });
const reminder = (title: string, remindAt: string, status = 'SCHEDULED') =>
  db().reminder.create({ data: { title, remindAt: new Date(remindAt), status } });
const capture = (rawText: string, capturedAt: string, extra: Record<string, unknown> = {}) =>
  db().capture.create({ data: { source: 'API', rawText, capturedAt: new Date(capturedAt), ...extra } });

describe('"What do I have tomorrow?"', () => {
  async function seedTomorrow() {
    await task('Call the dentist', '2026-10-18T08:00:00.000Z'); // Sun 09:00 Lagos
    await task('Late filing', '2026-10-18T22:30:00.000Z'); // Sun 23:30 Lagos — still Sunday
    await task('Monday report', '2026-10-18T23:30:00.000Z'); // Mon 00:30 Lagos — not Sunday
    await task('Already done', '2026-10-18T09:00:00.000Z', { status: 'COMPLETED', completedAt: new Date('2026-10-16T09:00:00.000Z') });
    await event('Team lunch', '2026-10-18T12:00:00.000Z');
    await reminder('Pay rent', '2026-10-18T17:00:00.000Z');
    await reminder('Cancelled one', '2026-10-18T17:30:00.000Z', 'CANCELLED');
  }

  it('lists open tasks, events and scheduled reminders of the local day, by type', async () => {
    await seedTomorrow();
    const result = await ask('What do I have tomorrow?');

    expect(result.deterministic).toBe(true);
    expect(result.grounded).toBe(true);
    expect(ai.answerCalls).toHaveLength(0);
    expect(result.evidence.map((item) => `${item.type}:${item.title}`).sort()).toEqual([
      'EVENT:Team lunch',
      'REMINDER:Pay rent',
      'TASK:Call the dentist',
      'TASK:Late filing',
    ]);
    expect(result.answer).toContain('For tomorrow (Sun 18 Oct) you have 4 items:');
    expect(result.answer).toContain('Events:\n• Team lunch — 1:00 PM');
    expect(result.answer).toContain('• Call the dentist — due 9:00 AM');
    expect(result.answer).toContain('Reminders:\n• Pay rent — 6:00 PM');
    expect(result.answer).not.toContain('Monday report');
    expect(result.answer).not.toContain('Already done');
    expect(result.answer).not.toContain('Cancelled one');
    expect(result.period).toEqual({
      start: '2026-10-17T23:00:00.000Z',
      end: '2026-10-18T23:00:00.000Z',
      label: 'Tomorrow, Sun 18 Oct',
      timeZone: 'Africa/Lagos',
    });
  });

  it('moves the boundary with the Settings zone (New York)', async () => {
    await seedTomorrow();
    await useZone('America/New_York');
    const result = await ask('What do I have tomorrow?');
    // In New York, 23:30Z on the 18th is still Sunday evening (19:30).
    expect(result.evidence.map((item) => item.title)).toContain('Monday report');
    expect(result.answer).toContain('• Call the dentist — due 4:00 AM');
    expect(result.period?.timeZone).toBe('America/New_York');
    expect(result.period?.start).toBe('2026-10-18T04:00:00.000Z');
  });

  it('says plainly when nothing is scheduled', async () => {
    const result = await ask('What do I have tomorrow?');
    expect(result.grounded).toBe(false);
    expect(result.evidence).toEqual([]);
    expect(result.answer).toBe('You have nothing scheduled for tomorrow (Sun 18 Oct).');
    expect(result.period?.label).toBe('Tomorrow, Sun 18 Oct');
  });

  it('answers only for the named type', async () => {
    await seedTomorrow();
    const events = await ask('What events do I have tomorrow?');
    expect(events.evidence.map((item) => item.type)).toEqual(['EVENT']);

    await testDb.reset();
    const none = await ask('What events do I have tomorrow?');
    expect(none.answer).toBe('You have no events scheduled for tomorrow (Sun 18 Oct).');
  });

  it('respects the types the caller asked for', async () => {
    await seedTomorrow();
    const result = await ask('What do I have tomorrow?', { types: ['TASK'] });
    expect(new Set(result.evidence.map((item) => item.type))).toEqual(new Set(['TASK']));
  });
});

describe('"What do I have this week?"', () => {
  it('covers Monday to Sunday and shows the day of each item', async () => {
    await task('Monday task', '2026-10-12T09:00:00.000Z');
    await event('Sunday event', '2026-10-18T15:00:00.000Z');
    await event('Next Monday event', '2026-10-19T09:00:00.000Z');
    const result = await ask('What do I have this week?');
    expect(result.evidence.map((item) => item.title).sort()).toEqual(['Monday task', 'Sunday event']);
    expect(result.answer).toContain('• Sunday event — Sun 18 Oct, 4:00 PM');
    expect(result.period?.label).toBe('This week, Mon 12 Oct – Sun 18 Oct');
  });
});

describe('"What happened last Friday?"', () => {
  it('lists that day’s captures, events that took place and tasks completed then', async () => {
    await capture('Idea about the garden', '2026-10-16T08:00:00.000Z');
    await capture('Deleted thought', '2026-10-16T09:00:00.000Z', { deletedAt: new Date('2026-10-16T09:05:00.000Z') });
    await capture('Thursday note', '2026-10-15T20:00:00.000Z');
    await event('Board meeting', '2026-10-16T13:00:00.000Z');
    await task('Send invoice', '2026-10-20T09:00:00.000Z', { status: 'COMPLETED', completedAt: new Date('2026-10-16T15:00:00.000Z') });
    await task('Open task due Friday', '2026-10-16T10:00:00.000Z');

    const result = await ask('What happened last Friday?');
    expect(result.evidence.map((item) => `${item.type}:${item.title}`)).toEqual([
      'CAPTURE:Idea about the garden',
      'EVENT:Board meeting',
      'TASK:Send invoice',
    ]);
    expect(result.answer).toContain('For Fri 16 Oct I have 3 items recorded:');
    expect(result.answer).toContain('Completed tasks:\n• Send invoice — completed 4:00 PM');
    expect(result.period?.label).toBe('Fri 16 Oct');
  });

  it('says plainly when nothing was recorded', async () => {
    const result = await ask('What happened yesterday?');
    expect(result.grounded).toBe(false);
    expect(result.answer).toBe('I have nothing recorded for yesterday (Fri 16 Oct).');
  });
});

describe('next, last and how many days until', () => {
  it('returns the next reminder and never a task or event', async () => {
    await task('Earlier task', '2026-10-17T12:00:00.000Z');
    await event('Earlier event', '2026-10-17T13:00:00.000Z');
    await reminder('Past reminder', '2026-10-17T09:00:00.000Z');
    await reminder('Sent reminder', '2026-10-17T11:00:00.000Z', 'SENT');
    await reminder('Water the plants', '2026-10-18T07:00:00.000Z');

    const result = await ask('When is my next reminder?');
    expect(result.evidence.map((item) => `${item.type}:${item.title}`)).toEqual(['REMINDER:Water the plants']);
    expect(result.answer).toBe('Your next reminder is “Water the plants” on Sun 18 Oct at 8:00 AM (tomorrow).');
  });

  it('returns the next event, never a reminder', async () => {
    await reminder('Sooner reminder', '2026-10-17T11:00:00.000Z');
    await event('Dentist', '2026-10-21T08:00:00.000Z');
    const result = await ask('When is my next event?');
    expect(result.evidence.map((item) => item.type)).toEqual(['EVENT']);
    expect(result.answer).toContain('“Dentist” on Wed 21 Oct at 9:00 AM (in 4 days)');
  });

  it('returns the most recent past event', async () => {
    await event('Old event', '2026-10-01T08:00:00.000Z');
    await event('Recent event', '2026-10-16T08:00:00.000Z');
    await event('Future event', '2026-10-20T08:00:00.000Z');
    const result = await ask('What was my last event?');
    expect(result.answer).toBe('Your last event was “Recent event” on Fri 16 Oct at 9:00 AM.');
  });

  it('counts calendar days to the next event, not 24-hour periods', async () => {
    await event('Past event', '2026-10-16T08:00:00.000Z');
    await event('Dentist', '2026-10-21T08:00:00.000Z');
    const result = await ask('How many days until my next event?');
    expect(result.answer).toBe('Your next event, “Dentist”, is in 4 days: Wed 21 Oct at 9:00 AM.');
  });

  it('says "today" for an event later today', async () => {
    await event('Evening class', '2026-10-17T18:00:00.000Z');
    const result = await ask('How many days until my next event?');
    expect(result.answer).toBe('Your next event, “Evening class”, is today, Sat 17 Oct at 7:00 PM.');
  });

  it('counts across the New York fall-back change without losing a day', async () => {
    await useZone('America/New_York');
    await event('After the change', '2026-11-02T14:00:00.000Z'); // Mon 2 Nov 09:00 EST
    const result = await ask('How many days until my next event?');
    expect(result.answer).toContain('is in 16 days: Mon 2 Nov at 9:00 AM');
  });

  it('finds the subject of "how many days until"', async () => {
    await event('Dentist appointment', '2026-10-21T08:00:00.000Z');
    await event('Haircut', '2026-10-19T08:00:00.000Z');
    const result = await ask('How many days until my dentist appointment?');
    expect(result.evidence.map((item) => item.title)).toEqual(['Dentist appointment']);
    expect(result.answer).toContain('in 4 days');
  });

  it('says so when there is nothing upcoming', async () => {
    expect((await ask('When is my next reminder?')).answer).toBe('You have no upcoming reminders.');
    expect((await ask('How many days until my dentist appointment?')).answer).toBe(
      'I could not find anything upcoming matching “dentist”.',
    );
  });
});

describe('ambiguous time questions', () => {
  it('asks for a clearer period instead of guessing', async () => {
    const result = await ask('What do I have next weekend?');
    expect(result.grounded).toBe(false);
    expect(result.evidence).toEqual([]);
    expect(result.period).toBeUndefined();
    expect(result.answer).toMatch(/^I could not tell which day or period you mean/);
  });
});

describe('word-search questions keep working, with local dates', () => {
  it('answers "when is my dentist appointment" with its local date and time, without AI', async () => {
    await event('Dentist appointment', '2026-10-21T08:00:00.000Z');
    const plain = await createTestApp(testDb.db);
    try {
      const response = await plain.app.inject({
        method: 'POST',
        url: '/api/ask',
        headers: { cookie: await plain.login() },
        payload: { question: 'When is my dentist appointment?' },
      });
      const result = response.json() as AskResponse;
      expect(result.answer).toContain('Dentist appointment (Wed 21 Oct 2026, 09:00)');
      expect(result.period).toBeUndefined();
    } finally {
      await plain.close();
    }
  });

  it('keeps a correct AI statement about the date and drops a wrong one', async () => {
    const dentist = await event('Dentist appointment', '2026-10-21T08:00:00.000Z');
    ai.setAnswer({
      answer: 'Your dentist appointment is on Wednesday 21 October at 9:00 am. It is on Thursday 22 October.',
      citedIds: [dentist.id],
    });
    const result = await ask('When is my dentist appointment?');
    expect(result.deterministic).toBe(false);
    expect(result.answer).toBe('Your dentist appointment is on Wednesday 21 October at 9:00 am.');
    // The model received the owner-local time, not UTC.
    expect(ai.answerCalls[0]?.evidence[0]?.localTime).toBe('Wed 21 Oct 2026, 09:00');
  });

  it('accepts ISO and 24-hour forms of the record’s own date and rejects a wrong time', async () => {
    const dentist = await event('Dentist appointment', '2026-10-21T08:00:00.000Z');
    ai.setAnswer({
      answer: 'The dentist appointment is on 2026-10-21 at 09:00. The appointment is at 3pm.',
      citedIds: [dentist.id],
    });
    const result = await ask('When is my dentist appointment?');
    expect(result.answer).toBe('The dentist appointment is on 2026-10-21 at 09:00.');
  });

  it('removes an invented sentence even when the date sentence is right', async () => {
    const dentist = await event('Dentist appointment', '2026-10-21T08:00:00.000Z');
    ai.setAnswer({
      answer: 'Your dentist appointment is on Wed 21 Oct at 09:00. Bring your insurance card.',
      citedIds: [dentist.id],
    });
    const result = await ask('When is my dentist appointment?');
    expect(result.answer).toBe('Your dentist appointment is on Wed 21 Oct at 09:00.');
  });
});
