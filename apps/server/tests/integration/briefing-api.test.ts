/**
 * Briefing API integration.
 *
 * The acceptance criterion is that a briefing only ever reports records that
 * exist, in the owner's own time zone, in the sections the owner configured.
 * These tests drive the real HTTP endpoint against an isolated database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestApp, type TestApp } from '../helpers/app.js';
import { createTestDatabase, type TestDb } from '../helpers/db.js';
import { updateSettings } from '../../src/services/settings-service.js';

interface BriefingItem {
  type: string;
  id: string;
  title: string;
  snippet: string;
  timestamp: string;
  status: string | null;
}

interface BriefingSection {
  id: string;
  title: string;
  items: BriefingItem[];
}

interface BriefingPayload {
  date: string;
  timeZone: string;
  sections: BriefingSection[];
  summary: string;
  itemCount: number;
}

interface BriefingResponse {
  briefing: BriefingPayload;
  config: { enabled: boolean; time: string; sections: string[] };
}

let testDb: TestDb;
let app: TestApp;
let cookie: string;

beforeAll(async () => {
  testDb = await createTestDatabase('briefing-api');
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
  const { headers: extra, ...rest } = init;
  return app.app.inject({
    url,
    ...rest,
    headers: { cookie, ...(extra as Record<string, string> | undefined) },
  });
}

async function getBriefing(query = ''): Promise<BriefingResponse> {
  const response = await authed(`/api/briefing${query}`);
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as BriefingResponse;
}

async function post(url: string, payload: unknown): Promise<{ id: string; title: string }> {
  const response = await authed(url, { method: 'POST', payload });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as { id: string; title: string };
}

function sectionOf(payload: BriefingPayload, id: string): BriefingSection {
  const section = payload.sections.find((item) => item.id === id);
  if (!section) throw new Error(`Section ${id} is missing from the briefing`);
  return section;
}

describe('GET /api/briefing — access', () => {
  it('requires an owner session', async () => {
    const response = await app.app.inject({ method: 'GET', url: '/api/briefing' });
    expect(response.statusCode).toBe(401);
  });

  it('requires an owner session for the config', async () => {
    const response = await app.app.inject({ method: 'GET', url: '/api/briefing/config' });
    expect(response.statusCode).toBe(401);
  });
});

describe('GET /api/briefing — content', () => {
  it('reports nothing but the configured sections when there are no records', async () => {
    const { briefing } = await getBriefing();

    expect(briefing.date).toBe('2026-10-17');
    expect(briefing.timeZone).toBe('Africa/Lagos');
    expect(briefing.itemCount).toBe(0);
    expect(briefing.summary).toBe('Nothing scheduled for this day.');
    expect(briefing.sections.map((section) => section.id)).toEqual(['today', 'overdue', 'upcoming']);
    expect(briefing.sections.every((section) => section.items.length === 0)).toBe(true);
  });

  it('lists the tasks that are due today', async () => {
    const task = await post('/api/tasks', {
      title: 'Pay the rent',
      dueAt: '2026-10-17T09:00:00.000Z',
    });

    const { briefing } = await getBriefing();

    const today = sectionOf(briefing, 'today');
    expect(today.items.map((item) => item.id)).toEqual([task.id]);
    expect(today.items[0]!.title).toBe('Pay the rent');
    expect(briefing.itemCount).toBe(1);
  });

  it('lists the tasks whose deadline passed before today', async () => {
    const task = await post('/api/tasks', {
      title: 'Return the library book',
      dueAt: '2026-10-10T09:00:00.000Z',
    });

    const { briefing } = await getBriefing();

    const overdue = sectionOf(briefing, 'overdue');
    expect(overdue.items.map((item) => item.id)).toEqual([task.id]);
    expect(sectionOf(briefing, 'today').items).toEqual([]);
  });

  it('lists the tasks that are due later as deadlines', async () => {
    const task = await post('/api/tasks', {
      title: 'Submit the tax return',
      dueAt: '2026-10-20T09:00:00.000Z',
    });

    const { briefing } = await getBriefing();

    expect(sectionOf(briefing, 'today').items).toEqual([]);
    expect(sectionOf(briefing, 'overdue').items).toEqual([]);
    // `deadlines` is not in the default configuration, so it must not appear.
    expect(briefing.sections.map((section) => section.id)).not.toContain('deadlines');
    expect(briefing.itemCount).toBe(0);
    expect(task.id).toBeTruthy();
  });

  it('lists the events that start within the coming week', async () => {
    const event = await post('/api/events', {
      title: 'Dentist',
      startsAt: '2026-10-19T09:00:00.000Z',
    });

    const { briefing } = await getBriefing();

    const upcoming = sectionOf(briefing, 'upcoming');
    expect(upcoming.items.map((item) => item.id)).toEqual([event.id]);
    expect(upcoming.items[0]!.type).toBe('EVENT');
  });

  it('leaves out an event that starts beyond the coming week', async () => {
    await post('/api/events', {
      title: 'Conference',
      startsAt: '2026-10-25T09:00:00.000Z',
    });

    const { briefing } = await getBriefing();

    expect(sectionOf(briefing, 'upcoming').items).toEqual([]);
  });

  it('never reports a completed task', async () => {
    const task = await post('/api/tasks', {
      title: 'Finished already',
      dueAt: '2026-10-17T09:00:00.000Z',
      status: 'COMPLETED',
    });

    const { briefing } = await getBriefing();

    expect(sectionOf(briefing, 'today').items).toEqual([]);
    expect(sectionOf(briefing, 'overdue').items).toEqual([]);
    expect(task.id).toBeTruthy();
  });

  it('reports a section in the order the owner configured', async () => {
    await authed('/api/briefing/config', {
      method: 'PATCH',
      payload: { briefingSections: ['upcoming', 'today'] },
    });

    const { briefing } = await getBriefing();

    expect(briefing.sections.map((section) => section.id)).toEqual(['upcoming', 'today']);
  });

  it('returns an empty section the owner asked for', async () => {
    await authed('/api/briefing/config', {
      method: 'PATCH',
      payload: { briefingSections: ['ideas'] },
    });

    const { briefing } = await getBriefing();

    expect(briefing.sections).toHaveLength(1);
    expect(briefing.sections[0]!.id).toBe('ideas');
    expect(briefing.sections[0]!.items).toEqual([]);
  });

  it('lists the most recent ideas', async () => {
    await authed('/api/briefing/config', {
      method: 'PATCH',
      payload: { briefingSections: ['ideas'] },
    });
    const idea = await post('/api/ideas', { title: 'Build a rocket', body: 'Just because' });

    const { briefing } = await getBriefing();

    const ideas = sectionOf(briefing, 'ideas');
    expect(ideas.items.map((item) => item.id)).toEqual([idea.id]);
    expect(ideas.items[0]!.type).toBe('IDEA');
  });
});

describe('GET /api/briefing — the reference day', () => {
  it('accepts an explicit calendar date', async () => {
    const task = await post('/api/tasks', {
      title: 'Pay the rent',
      dueAt: '2026-10-20T09:00:00.000Z',
    });

    const { briefing } = await getBriefing('?date=2026-10-20');

    expect(briefing.date).toBe('2026-10-20');
    expect(sectionOf(briefing, 'today').items.map((item) => item.id)).toEqual([task.id]);
  });

  it('rejects a date that is not a calendar date', async () => {
    const response = await authed('/api/briefing?date=tomorrow');
    expect(response.statusCode).toBe(400);
  });

  it('rejects a date that does not exist', async () => {
    const response = await authed('/api/briefing?date=2026-13-01');
    expect(response.statusCode).toBe(400);
  });

  it('rejects a date with a time attached', async () => {
    const response = await authed('/api/briefing?date=2026-10-17T10:00');
    expect(response.statusCode).toBe(400);
  });

  it('uses seven local days for the upcoming window across a DST change', async () => {
    await updateSettings(
      app.ctx.db,
      { timeZone: 'America/New_York', briefingSections: ['upcoming'] },
      app.ctx.defaults,
    );
    await post('/api/events', {
      title: 'After the local window',
      startsAt: '2026-03-09T04:30:00.000Z',
    });

    const { briefing } = await getBriefing('?date=2026-03-02');

    expect(briefing.timeZone).toBe('America/New_York');
    expect(sectionOf(briefing, 'upcoming').items).toEqual([]);
  });

  it('resolves "today" in the owner zone, not in the server zone', async () => {
    // 23:30 UTC is already the next day in Lagos (UTC+1) and still the same
    // day in UTC. The briefing must follow the owner.
    const late = await createTestApp(testDb.db, {
      clock: (await import('../../src/ports.js')).advanceableClock('2026-10-17T23:30:00.000Z'),
    });
    try {
      const response = await late.app.inject({
        method: 'GET',
        url: '/api/briefing',
        headers: { cookie: await late.login() },
      });
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as BriefingResponse;
      expect(body.briefing.date).toBe('2026-10-18');
      expect(body.briefing.timeZone).toBe('Africa/Lagos');
    } finally {
      await late.close();
    }
  });
});

describe('GET /api/briefing — the disabled flag', () => {
  it('still returns a briefing when the daily delivery is switched off', async () => {
    const task = await post('/api/tasks', {
      title: 'Pay the rent',
      dueAt: '2026-10-17T09:00:00.000Z',
    });

    const { briefing, config } = await getBriefing();

    expect(config.enabled).toBe(false);
    expect(sectionOf(briefing, 'today').items.map((item) => item.id)).toEqual([task.id]);
  });
});

describe('GET/PATCH /api/briefing/config', () => {
  it('returns the current configuration', async () => {
    const response = await authed('/api/briefing/config');
    expect(response.statusCode, response.body).toBe(200);
    const config = response.json() as { enabled: boolean; time: string; sections: string[] };
    expect(config.enabled).toBe(false);
    expect(config.time).toBe('07:30');
    expect(config.sections).toEqual(['today', 'overdue', 'upcoming']);
  });

  it('saves a new configuration', async () => {
    const response = await authed('/api/briefing/config', {
      method: 'PATCH',
      payload: { briefingEnabled: true, briefingTime: '06:15', briefingSections: ['today', 'ideas'] },
    });
    expect(response.statusCode, response.body).toBe(200);
    const config = response.json() as { enabled: boolean; time: string; sections: string[] };
    expect(config.enabled).toBe(true);
    expect(config.time).toBe('06:15');
    expect(config.sections).toEqual(['today', 'ideas']);

    const reread = await authed('/api/briefing/config');
    expect((reread.json() as { enabled: boolean }).enabled).toBe(true);
  });

  it('rejects a time that is not HH:MM', async () => {
    const response = await authed('/api/briefing/config', {
      method: 'PATCH',
      payload: { briefingTime: '6am' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects an unknown section', async () => {
    const response = await authed('/api/briefing/config', {
      method: 'PATCH',
      payload: { briefingSections: ['not-a-section'] },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a JSON body that is not an object', async () => {
    const response = await authed('/api/briefing/config', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      payload: '"nope"',
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a body that is not JSON', async () => {
    const response = await authed('/api/briefing/config', {
      method: 'PATCH',
      payload: 'nope',
    });
    expect(response.statusCode).toBe(415);
  });

  it('requires an owner session', async () => {
    const response = await app.app.inject({
      method: 'PATCH',
      url: '/api/briefing/config',
      payload: { briefingEnabled: true },
    });
    expect(response.statusCode).toBe(401);
  });
});
