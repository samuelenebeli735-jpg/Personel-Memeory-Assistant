import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestApp, TEST_TIME_ZONE, type TestApp } from '../helpers/app.js';
import { createTestDatabase, type TestDb } from '../helpers/db.js';
import { localDayRange } from '../../src/lib/time.js';

let testDb: TestDb;
let app: TestApp;
let cookie: string;

beforeAll(async () => {
  testDb = await createTestDatabase('dashboard-api');
  app = await createTestApp(testDb.db);
  cookie = await app.login();
});

afterAll(async () => {
  await app.close();
  await testDb.cleanup();
});

beforeEach(async () => {
  await testDb.reset();
});

function authed(url: string) {
  return app.app.inject({ url, headers: { cookie } });
}

async function post(url: string, payload: unknown) {
  const response = await app.app.inject({
    method: 'POST',
    url,
    headers: { cookie },
    payload,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as Record<string, string | number>;
}

describe('dashboard overview', () => {
  it('returns a stable overview shape for an empty account', async () => {
    const response = await authed('/api/dashboard/overview');
    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      timeZone: string;
      today: string;
      counts: Record<string, number>;
      tasksDueToday: unknown[];
      overdueTasks: unknown[];
      upcomingReminders: unknown[];
      recentCaptures: unknown[];
      inbox: unknown[];
    };

    expect(body.timeZone).toBe(TEST_TIME_ZONE);
    expect(body.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.counts).toEqual({
      inboxNeedsReview: 0,
      tasksDueToday: 0,
      tasksOverdue: 0,
      tasksOpen: 0,
      ideas: 0,
      notes: 0,
      eventsUpcoming: 0,
      capturesToday: 0,
    });
    expect(body.tasksDueToday).toEqual([]);
    expect(body.overdueTasks).toEqual([]);
    expect(body.upcomingReminders).toEqual([]);
    expect(body.recentCaptures).toEqual([]);
    expect(body.inbox).toEqual([]);
  });

  it('aggregates today, overdue, upcoming and capture data in the owner zone', async () => {
    const now = app.clock.now();
    const today = localDayRange(now, TEST_TIME_ZONE);
    const dueToday = new Date(now.getTime() + 60 * 60 * 1000);
    const overdueAt = new Date(today.startUtc.getTime() - 60 * 60 * 1000);

    await post('/api/tasks', {
      title: 'Due today',
      dueAt: dueToday.toISOString(),
      priority: 'HIGH',
      tags: [],
    });
    await post('/api/tasks', {
      title: 'Overdue',
      dueAt: overdueAt.toISOString(),
      tags: [],
    });
    await post('/api/notes', { title: 'A note', body: 'Note body', tags: [] });
    await post('/api/ideas', { title: 'An idea', body: 'Idea body', tags: [] });
    await post('/api/events', {
      title: 'Upcoming event',
      startsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    });
    await post('/api/captures', { rawText: 'Dashboard capture', source: 'API' });

    const response = await authed('/api/dashboard/overview');
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      counts: Record<string, number>;
      tasksDueToday: { title: string }[];
      overdueTasks: { title: string }[];
      recentCaptures: { rawText: string }[];
    };

    expect(body.counts.tasksOpen).toBe(2);
    expect(body.counts.tasksDueToday).toBe(1);
    expect(body.counts.tasksOverdue).toBe(1);
    expect(body.counts.notes).toBe(1);
    expect(body.counts.ideas).toBe(1);
    expect(body.counts.eventsUpcoming).toBe(1);
    expect(body.counts.capturesToday).toBe(1);
    expect(body.tasksDueToday.map((task) => task.title)).toEqual(['Due today']);
    expect(body.overdueTasks.map((task) => task.title)).toEqual(['Overdue']);
    expect(body.recentCaptures).toHaveLength(1);
    expect(body.recentCaptures[0]?.rawText).toBe('Dashboard capture');
  });
});
