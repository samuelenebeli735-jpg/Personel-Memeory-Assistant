/**
 * Search integration.
 *
 * The acceptance criterion is that a match is explainable: every result carries
 * the fields it matched on, and the same query returns the same order twice.
 */
import type { CaptureAckDto, SearchResponse, SearchResultItem } from '@recall/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestApp, type TestApp } from '../helpers/app.js';
import { createTestDatabase, type TestDb } from '../helpers/db.js';
import { VOICE_PLACEHOLDER } from '../../src/lib/voice.js';
import { createReminder } from '../../src/services/reminder-service.js';

let testDb: TestDb;
let app: TestApp;
let cookie: string;

beforeAll(async () => {
  testDb = await createTestDatabase('search-api');
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

async function post<T>(url: string, payload: unknown): Promise<T> {
  const response = await authed(url, { method: 'POST', payload });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as T;
}

async function search(query: string): Promise<SearchResponse> {
  const response = await authed(`/api/search${query}`);
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as SearchResponse;
}

/** One row of every searchable type, all mentioning the word "boiler". */
async function seedBoilerData(): Promise<void> {
  await post('/api/tasks', {
    title: 'Call the boiler engineer',
    description: 'The boiler is making a noise',
  });
  await post('/api/notes', { body: 'The boiler service is booked for June.' });
  await post('/api/ideas', { title: 'Boiler sensor idea' });
  await post('/api/events', {
    title: 'Boiler inspection',
    startsAt: '2026-11-02T09:30:00.000Z',
  });
  await post('/api/projects', { name: 'Boiler replacement' });
  await post<CaptureAckDto>('/api/captures', {
    rawText: 'the boiler pressure drops overnight',
    captureOnly: true,
  });
  await createReminder(app.ctx, {
    title: 'Chase the boiler parts',
    remindAt: '2026-11-03T09:00:00.000Z',
  });
}

/**
 * One "tagged" row of every searchable type. Only tasks, notes, ideas and
 * captures can own tags; events, projects and reminders deliberately match the
 * text but have no tag relation.
 */
async function seedTagData(): Promise<void> {
  await post('/api/tasks', { title: 'Tagged task', tags: ['home'] });
  await post('/api/tasks', { title: 'Tagged task with another tag', tags: ['work'] });
  await post('/api/tasks', { title: 'Tagged task without tags' });
  await post('/api/notes', { body: 'Tagged note', tags: ['home'] });
  await post('/api/notes', { body: 'Tagged note without tags' });
  await post('/api/ideas', { title: 'Tagged idea', tags: ['home'] });
  await post('/api/ideas', { title: 'Tagged idea without tags' });
  await post('/api/events', {
    title: 'Tagged event',
    startsAt: '2026-11-05T09:30:00.000Z',
  });
  await post('/api/projects', { name: 'Tagged project' });
  await createReminder(app.ctx, {
    title: 'Tagged reminder',
    remindAt: '2026-11-06T09:00:00.000Z',
  });

  const home = await testDb.db.tag.findUniqueOrThrow({ where: { name: 'home' } });
  await testDb.db.capture.create({
    data: {
      source: 'API',
      rawText: 'Tagged capture',
      tags: { create: [{ tagId: home.id }] },
    },
  });
  await testDb.db.capture.create({
    data: { source: 'API', rawText: 'Tagged capture without tags' },
  });
}

describe('matching', () => {
  it('finds one row of every type and says what matched', async () => {
    await seedBoilerData();
    const response = await search('?q=boiler');

    const types = response.items.map((item) => item.type).sort();
    expect(types).toEqual(['CAPTURE', 'EVENT', 'IDEA', 'NOTE', 'PROJECT', 'REMINDER', 'TASK']);
    expect(response.total).toBe(7);

    const task = response.items.find((item) => item.type === 'TASK')!;
    expect(task.matchedOn).toEqual(['title', 'description']);
    expect(task.snippet).toContain('boiler');
  });

  it('matches every word, in any field, in any order', async () => {
    await post('/api/tasks', {
      title: 'Call Ada',
      description: 'about the invoice for the boiler',
    });
    await post('/api/tasks', { title: 'Call Bob', description: 'about the boiler only' });

    const response = await search('?q=ada%20invoice');
    expect(response.items.map((item) => item.title)).toEqual(['Call Ada']);
  });

  it('ignores case', async () => {
    await post('/api/tasks', { title: 'Call the BOILER engineer' });
    const response = await search('?q=boiler');
    expect(response.total).toBe(1);
    expect(response.items[0]?.matchedOn).toEqual(['title']);
  });

  it('never exposes the internal voice placeholder as search content', async () => {
    await app.ctx.db.capture.create({
      data: { source: 'TELEGRAM', rawText: VOICE_PLACEHOLDER, metadata: '{"voice":{}}' },
    });
    await app.ctx.db.capture.create({
      data: {
        source: 'TELEGRAM',
        rawText: VOICE_PLACEHOLDER,
        transcript: 'Call the plumber tomorrow',
        transcriptSource: 'SPEECH_PROVIDER',
        metadata: '{"voice":{}}',
      },
    });
    await app.ctx.db.capture.create({
      data: { source: 'TELEGRAM', rawText: 'Call Ada tomorrow', metadata: '{"voice":{}}' },
    });

    const placeholderMatches = await search('?q=voice');
    expect(placeholderMatches.total).toBe(2);
    expect(placeholderMatches.items.map((item) => item.title)).not.toContain(VOICE_PLACEHOLDER);
    expect(placeholderMatches.items.flatMap((item) => [item.title, item.snippet]).join('\n'))
      .not.toContain(VOICE_PLACEHOLDER);
    expect(placeholderMatches.items.map((item) => item.title)).toEqual(
      expect.arrayContaining(['Voice capture — transcript unavailable', 'Call the plumber tomorrow']),
    );

    const transcriptMatch = await search('?q=plumber');
    expect(transcriptMatch.items[0]?.title).toBe('Call the plumber tomorrow');

    const captionMatch = await search('?q=Ada');
    expect(captionMatch.items[0]?.title).toBe('Call Ada tomorrow');
  });

  it('returns an empty result set with a zero total rather than an error', async () => {
    await seedBoilerData();
    const response = await search('?q=thermodynamics');
    expect(response.items).toEqual([]);
    expect(response.total).toBe(0);
  });

  it('centres the snippet on the match', async () => {
    const long = `${'filler '.repeat(40)}the boiler pressure drops${' more filler'.repeat(40)}`;
    await post('/api/notes', { body: long });
    const response = await search('?q=boiler');

    const note = response.items[0]!;
    expect(note.snippet).toContain('boiler pressure');
    expect(note.snippet.length).toBeLessThanOrEqual(162);
  });

  it('orders a title match ahead of a body-only match', async () => {
    await post('/api/notes', { body: 'boiler parts are ordered' });
    await post('/api/notes', { title: 'boiler', body: 'unrelated text' });

    const response = await search('?q=boiler&sort=relevance');
    expect(response.items[0]?.title).toBe('boiler');
  });

  it('is deterministic for equal scores', async () => {
    await seedBoilerData();
    const first = await search('?q=boiler');
    const second = await search('?q=boiler');
    expect(first.items.map((i) => `${i.type}:${i.id}`)).toEqual(
      second.items.map((i) => `${i.type}:${i.id}`),
    );
  });
});

describe('filters', () => {
  it('narrows to a task status and therefore searches tasks only', async () => {
    await seedBoilerData();
    await post('/api/tasks', {
      title: 'Old boiler task',
      status: 'COMPLETED',
    });

    const response = await search('?q=boiler&status=COMPLETED');
    expect(response.items.length).toBeGreaterThan(0);
    expect(response.items.every((item) => item.type === 'TASK')).toBe(true);
    expect(response.items.every((item) => item.status === 'COMPLETED')).toBe(true);
  });

  it('keeps a status filter task-only when mixed types are selected', async () => {
    await seedBoilerData();
    await post('/api/tasks', { title: 'Old boiler task', status: 'COMPLETED' });

    const response = await search(
      '?q=boiler&types=TASK&types=NOTE&types=EVENT&status=COMPLETED',
    );
    expect(response.total).toBe(1);
    expect(response.items).toEqual([
      expect.objectContaining({ type: 'TASK', status: 'COMPLETED' }),
    ]);
  });

  it('rejects reminder and delivery statuses as search statuses', async () => {
    for (const status of ['SCHEDULED', 'SENT', 'FAILED', 'MISSED']) {
      const response = await authed(`/api/search?q=boiler&status=${status}`);
      expect(response.statusCode, status).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('does not apply a status filter when none is supplied', async () => {
    await seedBoilerData();
    await post('/api/tasks', { title: 'Old boiler task', status: 'COMPLETED' });

    const response = await search('?q=boiler');
    expect(response.total).toBe(8);
    expect(new Set(response.items.map((item) => item.type))).toEqual(
      new Set(['TASK', 'NOTE', 'IDEA', 'EVENT', 'CAPTURE', 'PROJECT', 'REMINDER']),
    );
  });

  it('narrows to captures when a capture kind is given', async () => {
    await seedBoilerData();
    // The seeded capture was stored with `captureOnly: true`, so it was never
    // classified and its kind is UNKNOWN. That is the behaviour under test:
    // `kind` narrows the search to captures, and only those of that kind.
    const unknownKind = await search('?q=boiler&kind=UNKNOWN');
    expect(unknownKind.items.every((item) => item.type === 'CAPTURE')).toBe(true);
    expect(unknownKind.total).toBe(1);

    const otherKind = await search('?q=boiler&kind=OTHER');
    expect(otherKind.total).toBe(0);

    const captured = await post<CaptureAckDto>('/api/captures', {
      rawText: 'boiler idea: a sensor',
      forcedKind: 'OTHER',
      captureOnly: true,
    });
    expect(captured.capture.kind).toBe('OTHER');

    const otherNow = await search('?q=boiler&kind=OTHER');
    expect(otherNow.items.map((item) => item.id)).toEqual([captured.capture.id]);
  });

  it('restricts to the requested types', async () => {
    await seedBoilerData();
    const response = await search('?q=boiler&types=TASK&types=NOTE');
    expect(response.items.map((i) => i.type).sort()).toEqual(['NOTE', 'TASK']);
  });

  it('accepts every entity type the search service supports', async () => {
    await seedBoilerData();
    const allTypes = 'TASK&types=NOTE&types=IDEA&types=EVENT&types=CAPTURE&types=PROJECT&types=REMINDER';
    const response = await search(`?q=boiler&types=${allTypes}`);
    expect(response.items.map((i) => i.type).sort()).toEqual([
      'CAPTURE',
      'EVENT',
      'IDEA',
      'NOTE',
      'PROJECT',
      'REMINDER',
      'TASK',
    ]);
  });

  it('accepts a capture, project, or reminder filter individually', async () => {
    await seedBoilerData();
    for (const [type, expected] of [
      ['CAPTURE', ['CAPTURE']],
      ['PROJECT', ['PROJECT']],
      ['REMINDER', ['REMINDER']],
    ] as const) {
      const response = await search(`?q=boiler&types=${type}`);
      expect(response.items.map((item) => item.type)).toEqual(expected);
    }
  });

  it('filters by project', async () => {
    const project = await post<{ id: string }>('/api/projects', { name: 'Boiler replacement' });
    await post('/api/tasks', { title: 'Boiler part', projectId: project.id });
    await post('/api/tasks', { title: 'Boiler other' });

    const response = await search(`?q=boiler&projectId=${project.id}&types=TASK`);
    expect(response.items.map((item) => item.title)).toEqual(['Boiler part']);
  });

  it('applies a tag filter to every type that can own tags', async () => {
    await seedTagData();

    const response = await search('?q=tagged&tag=home');
    expect(response.total).toBe(4);
    expect(response.items.map((item) => item.type).sort()).toEqual([
      'CAPTURE',
      'IDEA',
      'NOTE',
      'TASK',
    ]);
    expect(response.items.map((item) => item.title).sort()).toEqual([
      'Tagged capture',
      'Tagged idea',
      'Tagged note',
      'Tagged task',
    ]);
  });

  it('excludes records without the requested tag and counts only matches', async () => {
    await seedTagData();

    const wrongTag = await search('?q=tagged&tag=work');
    expect(wrongTag.total).toBe(1);
    expect(wrongTag.items.map((item) => item.title)).toEqual([
      'Tagged task with another tag',
    ]);

    const tagOnly = await search('?tag=home');
    expect(tagOnly.total).toBe(4);
  });

  it('returns no events, projects or reminders for a tag filter', async () => {
    await seedTagData();

    const matchingText = await search('?q=tagged');
    expect(matchingText.total).toBe(12);
    expect(matchingText.items.map((item) => item.type).sort()).toEqual([
      'CAPTURE',
      'CAPTURE',
      'EVENT',
      'IDEA',
      'IDEA',
      'NOTE',
      'NOTE',
      'PROJECT',
      'REMINDER',
      'TASK',
      'TASK',
      'TASK',
    ]);

    for (const type of ['EVENT', 'PROJECT', 'REMINDER'] as const) {
      const response = await search(`?q=tagged&tag=home&types=${type}`);
      expect(response.total, type).toBe(0);
      expect(response.items, type).toEqual([]);
    }
  });

  it('applies the date range to each type own timestamp', async () => {
    await post('/api/tasks', { title: 'Boiler in range', dueAt: '2026-11-01T09:00:00.000Z' });
    await post('/api/tasks', { title: 'Boiler out of range', dueAt: '2026-12-01T09:00:00.000Z' });

    const response = await search('?q=boiler&from=2026-10-31T00:00:00.000Z&to=2026-11-02T00:00:00.000Z');
    expect(response.items.map((item) => item.title)).toEqual(['Boiler in range']);
  });

  it('excludes an undone capture unless deleted rows are asked for', async () => {
    const ack = await post<CaptureAckDto>('/api/captures', {
      rawText: 'boiler secret',
      captureOnly: true,
    });
    const undone = await authed(`/api/captures/${ack.capture.id}/undo`, { method: 'POST', payload: {} });
    expect(undone.statusCode).toBe(200);

    const hidden = await search('?q=boiler');
    expect(hidden.total).toBe(0);

    const shown = await search('?q=boiler&includeDeleted=true');
    expect(shown.total).toBe(1);
  });

  it('rejects an unknown type instead of silently ignoring it', async () => {
    const response = await authed('/api/search?q=boiler&types=TOASTER');
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('pagination and transparency', () => {
  it('reports an accurate total and pages through merged results', async () => {
    for (let index = 0; index < 5; index += 1) {
      await post('/api/tasks', { title: `boiler task ${index}` });
      await post('/api/notes', { body: `boiler note ${index}` });
    }

    const firstPage = await search('?q=boiler&limit=4&offset=0');
    const secondPage = await search('?q=boiler&limit=4&offset=4');
    expect(firstPage.total).toBe(10);
    expect(firstPage.items).toHaveLength(4);
    expect(secondPage.items).toHaveLength(4);

    const seen = new Set([...firstPage.items, ...secondPage.items].map((i: SearchResultItem) => i.id));
    expect(seen.size).toBe(8);
  });

  it('echoes the effective query so the client can explain it', async () => {
    const response = await search('?q=boiler&limit=5&types=TASK');
    expect(response.limit).toBe(5);
    expect(response.query).toMatchObject({ q: 'boiler', types: ['TASK'], includeDeleted: false });
  });

  it('accepts an empty query and returns everything, newest first', async () => {
    await post('/api/tasks', { title: 'First' });
    await post('/api/tasks', { title: 'Second' });

    const response = await search('?types=TASK');
    expect(response.total).toBe(2);
    expect(response.items.length).toBe(2);
  });
});
