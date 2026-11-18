/**
 * Detail route contract used by the dashboard.
 *
 * The browser tests prove that visible links point at registered React routes;
 * this test proves the API behind those routes returns the requested record,
 * rejects anonymous callers, and never includes record content in an error.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestApp, type TestApp } from '../helpers/app.js';
import { createTestDatabase, type TestDb } from '../helpers/db.js';

let testDb: TestDb;
let app: TestApp;
let cookie: string;

beforeAll(async () => {
  testDb = await createTestDatabase('detail-routes');
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

function authed(url: string, init: Record<string, unknown> = {}) {
  return app.app.inject({
    url,
    headers: { cookie, ...(init.headers as Record<string, string> | undefined) },
    ...init,
  });
}

async function create<T>(url: string, payload: unknown): Promise<T> {
  const response = await authed(url, { method: 'POST', payload });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as T;
}

async function seedRecords(): Promise<Array<[string, string, string]>> {
  const capture = await create<{ capture: { id: string } }>('/api/captures', { rawText: 'SECRET-CAPTURE' });
  const task = await create<{ id: string }>('/api/tasks', { title: 'SECRET-TASK' });
  const reminder = await create<{ id: string }>('/api/reminders', {
    title: 'SECRET-REMINDER',
    remindAt: '2026-10-25T10:00:00.000Z',
  });
  const note = await create<{ id: string }>('/api/notes', { body: 'SECRET-NOTE' });
  const idea = await create<{ id: string }>('/api/ideas', { title: 'SECRET-IDEA' });
  const event = await create<{ id: string }>('/api/events', {
    title: 'SECRET-EVENT',
    startsAt: '2026-10-25T10:00:00.000Z',
  });
  const project = await create<{ id: string }>('/api/projects', { name: 'SECRET-PROJECT' });

  return [
    ['captures', capture.capture.id, 'SECRET-CAPTURE'],
    ['tasks', task.id, 'SECRET-TASK'],
    ['reminders', reminder.id, 'SECRET-REMINDER'],
    ['notes', note.id, 'SECRET-NOTE'],
    ['ideas', idea.id, 'SECRET-IDEA'],
    ['events', event.id, 'SECRET-EVENT'],
    ['projects', project.id, 'SECRET-PROJECT'],
  ];
}

describe('dashboard detail API', () => {
  it('returns the exact record requested by each detail route', async () => {
    const records = await seedRecords();

    for (const [resource, id, marker] of records) {
      const response = await authed(`/api/${resource}/${id}`);
      expect(response.statusCode, `${resource}: ${response.body}`).toBe(200);
      const body = response.json() as { id: string; isVoice?: boolean };
      expect(body.id).toBe(id);
      expect(response.body).toContain(marker);
      if (resource === 'captures') expect(body.isVoice).toBe(false);
    }
  });

  it('rejects anonymous detail requests without leaking the record', async () => {
    const records = await seedRecords();

    for (const [resource, id] of records) {
      const response = await app.app.inject({ method: 'GET', url: `/api/${resource}/${id}` });
      expect(response.statusCode, resource).toBe(401);
      expect(JSON.stringify(response.json())).toMatch(/UNAUTHORIZED/);
      expect(response.body).not.toContain('SECRET-');
    }
  });

  it('returns a non-leaking 404 for a missing record', async () => {
    await seedRecords();

    for (const resource of ['captures', 'tasks', 'reminders', 'notes', 'ideas', 'events', 'projects']) {
      const response = await authed(`/api/${resource}/missing-record`);
      expect(response.statusCode, resource).toBe(404);
      expect(JSON.stringify(response.json())).toMatch(/NOT_FOUND/);
      expect(response.body).not.toContain('SECRET-');
    }
  });
});
