/**
 * Capture API integration.
 *
 * The dashboard and local scripts use these routes, so they must enforce the
 * same rules as Telegram: session required, idempotent ingest, guarded
 * conversion, and a reversible undo before the irreversible purge.
 */
import type { CaptureAckDto, CaptureDto, Paginated } from '@recall/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestApp, type TestApp } from '../helpers/app.js';
import { createTestDatabase, type TestDb } from '../helpers/db.js';
import { formatLocalHuman } from '../../src/lib/time.js';

let testDb: TestDb;
let app: TestApp;
let cookie: string;

beforeAll(async () => {
  testDb = await createTestDatabase('capture-api');
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

async function capture(text: string, extra: Record<string, unknown> = {}): Promise<CaptureAckDto> {
  const response = await authed('/api/captures', {
    method: 'POST',
    payload: { rawText: text, ...extra },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as CaptureAckDto;
}

describe('authentication', () => {
  it('refuses every capture route without a session', async () => {
    for (const [method, url] of [
      ['GET', '/api/captures'],
      ['GET', '/api/captures/inbox'],
      ['GET', '/api/captures/abc'],
      ['POST', '/api/captures'],
      ['POST', '/api/captures/abc/convert'],
      ['POST', '/api/captures/abc/undo'],
      ['DELETE', '/api/captures/abc'],
    ] as const) {
      const response = await app.app.inject({ method, url, payload: {} });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});

describe('ingest', () => {
  it('stores the text verbatim and returns a readable confirmation', async () => {
    const ack = await capture('I need to finish the report by Friday');
    expect(ack.duplicate).toBe(false);
    expect(ack.capture.rawText).toBe('I need to finish the report by Friday');
    expect(ack.message).toMatch(/Saved as a/);
    expect(ack.created.length).toBeGreaterThan(0);
  });

  it('is idempotent when the caller supplies an externalId', async () => {
    const first = await capture('buy milk', { externalId: 'web:abc-1' });
    const second = await authed('/api/captures', {
      method: 'POST',
      payload: { rawText: 'buy milk', externalId: 'web:abc-1' },
    });
    expect(second.statusCode).toBe(200);
    const body = second.json() as CaptureAckDto;
    expect(body.duplicate).toBe(true);
    expect(body.capture.id).toBe(first.capture.id);
    expect(await testDb.db.capture.count()).toBe(1);
  });

  it('rejects empty text', async () => {
    const response = await authed('/api/captures', {
      method: 'POST',
      payload: { rawText: '   ' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('stores without classifying when captureOnly is set', async () => {
    const ack = await capture('a thought I have not sorted out', { captureOnly: true });
    expect(ack.capture.status).toBe('RECEIVED');
    expect(ack.capture.kind).toBe('UNKNOWN');
    expect(ack.created).toHaveLength(0);
    expect(await testDb.db.task.count()).toBe(0);
  });

  it('honours an explicit forcedKind even when captureOnly is set', async () => {
    // Contradictory inputs are resolved rather than silently dropped: the owner
    // said what it is, so that wins, and no classifier runs.
    const ack = await capture('a thing I have not decided about', {
      captureOnly: true,
      forcedKind: 'OTHER',
    });
    expect(ack.capture.kind).toBe('OTHER');
    expect(ack.created).toHaveLength(0);

    const stored = await authed(`/api/captures/${ack.capture.id}`);
    expect(stored.json().kind).toBe('OTHER');
  });
});

describe('listing and reading', () => {
  it('paginates and reports a total', async () => {
    for (let i = 0; i < 3; i += 1) await capture(`item number ${i}`, { externalId: `api:${i}` });

    const first = await authed('/api/captures?limit=2&offset=0');
    const page = first.json() as Paginated<CaptureDto>;
    expect(first.statusCode).toBe(200);
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(3);
    expect(page.limit).toBe(2);

    const second = (await authed('/api/captures?limit=2&offset=2')).json() as Paginated<CaptureDto>;
    expect(second.items).toHaveLength(1);
  });

  it('filters by kind and by free text', async () => {
    await capture('I have an idea for a bicycle shop', { externalId: 'api:idea' });
    await capture('buy stamps', { externalId: 'api:task' });

    const ideas = (await authed('/api/captures?kind=IDEA')).json() as Paginated<CaptureDto>;
    expect(ideas.items.every((item) => item.kind === 'IDEA')).toBe(true);

    const text = (await authed('/api/captures?q=stamps')).json() as Paginated<CaptureDto>;
    expect(text.total).toBe(1);
    expect(text.items[0]?.rawText).toContain('stamps');
  });

  it('rejects an unknown status filter', async () => {
    const response = await authed('/api/captures?status=NOT_A_STATUS');
    expect(response.statusCode).toBe(400);
  });

  it('returns one capture by id, and 404 for an unknown id', async () => {
    const ack = await capture('something to keep');
    const found = await authed(`/api/captures/${ack.capture.id}`);
    expect(found.statusCode).toBe(200);
    expect((found.json() as CaptureDto).id).toBe(ack.capture.id);

    const missing = await authed('/api/captures/does-not-exist');
    expect(missing.statusCode).toBe(404);
  });

  it('lists captures that need review in the inbox', async () => {
    const ack = await capture('a thing I have not decided about', { forcedKind: 'OTHER' });
    expect(ack.needsReview).toBe(true);
    const response = await authed('/api/captures/inbox');
    expect(response.statusCode).toBe(200);
    const body = response.json() as Paginated<CaptureDto>;
    expect(body.items.map((item) => item.id)).toContain(ack.capture.id);
    expect(body.items.every((item) => item.needsReview)).toBe(true);
  });
});

describe('correcting', () => {
  it('converts the kind and keeps the original text', async () => {
    const ack = await capture('a website that helps students find study groups');
    const response = await authed(`/api/captures/${ack.capture.id}/convert`, {
      method: 'POST',
      payload: { kind: 'IDEA' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { capture: CaptureDto };
    expect(body.capture.kind).toBe('IDEA');
    expect(body.capture.rawText).toBe('a website that helps students find study groups');
    expect(await testDb.db.idea.count()).toBe(1);
  });

  it('reprocesses a capture that was stored without classification', async () => {
    const ack = await capture('I need to ring the dentist tomorrow', { captureOnly: true });
    expect(ack.capture.status).toBe('RECEIVED');

    const response = await authed(`/api/captures/${ack.capture.id}/reprocess`, { method: 'POST' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as CaptureAckDto;
    expect(body.capture.status).toBe('CLASSIFIED');
    expect(await testDb.db.task.count()).toBe(1);
  });

  it('refuses to convert a record the owner has edited, unless forced', async () => {
    const ack = await capture('I need to ring the dentist tomorrow');
    const task = await testDb.db.task.findFirstOrThrow();

    // Pretend the task was created a minute ago and edited since: the guard
    // exists so a conversion cannot throw away the owner's own words.
    await testDb.db.task.update({
      where: { id: task.id },
      data: { createdAt: new Date(Date.now() - 60_000) },
    });

    const refused = await authed(`/api/captures/${ack.capture.id}/convert`, {
      method: 'POST',
      payload: { kind: 'IDEA' },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({
      error: { details: { requiresConfirmation: true, edited: [task.id] } },
    });
    // Nothing changed: the task is still the task.
    expect(await testDb.db.task.count()).toBe(1);
    expect(await testDb.db.idea.count()).toBe(0);

    const forced = await authed(`/api/captures/${ack.capture.id}/convert`, {
      method: 'POST',
      payload: { kind: 'IDEA', force: true },
    });
    expect(forced.statusCode).toBe(200);
    expect(await testDb.db.idea.count()).toBe(1);
    expect(await testDb.db.task.count()).toBe(0);
  });

  it('rejects an unknown kind', async () => {
    const ack = await capture('something');
    const response = await authed(`/api/captures/${ack.capture.id}/convert`, {
      method: 'POST',
      payload: { kind: 'BANANA' },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('removing', () => {
  it('refuses to undo a record the owner has edited, unless forced', async () => {
    const ack = await capture('I need to call Ada tomorrow');
    const task = await testDb.db.task.findFirstOrThrow();
    await testDb.db.task.update({
      where: { id: task.id },
      data: { createdAt: new Date(Date.now() - 60_000) },
    });

    const refused = await authed(`/api/captures/${ack.capture.id}/undo`, {
      method: 'POST',
      payload: {},
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({
      error: { details: { requiresConfirmation: true, edited: [task.id] } },
    });
    expect(await testDb.db.task.count()).toBe(1);

    const forced = await authed(`/api/captures/${ack.capture.id}/undo`, {
      method: 'POST',
      payload: { force: true },
    });
    expect(forced.statusCode).toBe(200);
    expect(await testDb.db.task.count()).toBe(0);
  });

  it('undoes reversibly, then purges only with an explicit confirmation', async () => {
    const ack = await capture('I need to call Ada tomorrow');
    expect(await testDb.db.task.count()).toBe(1);

    const undo = await authed(`/api/captures/${ack.capture.id}/undo`, {
      method: 'POST',
      payload: {},
    });
    expect(undo.statusCode).toBe(200);
    expect(await testDb.db.task.count()).toBe(0);
    const softDeleted = await testDb.db.capture.findUniqueOrThrow({ where: { id: ack.capture.id } });
    expect(softDeleted.deletedAt).not.toBeNull();

    const refused = await authed(`/api/captures/${ack.capture.id}`, { method: 'DELETE', payload: {} });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: { details: { requiresConfirmation: true } } });
    expect(await testDb.db.capture.count()).toBe(1);

    const purged = await authed(`/api/captures/${ack.capture.id}`, {
      method: 'DELETE',
      payload: { force: true },
    });
    expect(purged.statusCode).toBe(200);
    expect(await testDb.db.capture.count()).toBe(0);
  });
});

describe('the owner Settings time zone', () => {
  // The test clock reads 2026-10-17T10:00Z: Saturday 11:00 in Africa/Lagos
  // (UTC+1) and Saturday 06:00 in America/New_York (UTC-4, daylight time).
  async function useZone(timeZone: string) {
    const response = await authed('/api/settings', { method: 'PATCH', payload: { timeZone } });
    expect(response.statusCode, response.body).toBe(200);
  }

  for (const timeZone of ['Africa/Lagos', 'America/New_York'] as const) {
    it(`describes a captured date in the Settings zone (${timeZone}), not the server default`, async () => {
      await useZone(timeZone);
      const ack = await capture('Call the dentist tomorrow at 9am');

      const task = await testDb.db.task.findFirstOrThrow({ where: { captureId: ack.capture.id } });
      expect(task.dueAt).not.toBeNull();
      // The confirmation renders the stored instant in the owner's zone. (How
      // the phrase itself is parsed is a separate concern of lib/nlp.ts.)
      expect(ack.message).toContain(formatLocalHuman(task.dueAt!, timeZone));
      if (timeZone !== 'Africa/Lagos') {
        expect(ack.message).not.toContain(formatLocalHuman(task.dueAt!, 'Africa/Lagos'));
      }
    });
  }

  it('converts a capture using the Settings zone, not the server default', async () => {
    // UTC is used here because it differs from the server default
    // (Africa/Lagos) and the date parser resolves it independently of the
    // host machine's zone.
    await useZone('UTC');
    const ack = await capture('dentist tomorrow at 9am', { forcedKind: 'NOTE' });

    const response = await authed(`/api/captures/${ack.capture.id}/convert`, {
      method: 'POST',
      payload: { kind: 'EVENT' },
    });
    expect(response.statusCode, response.body).toBe(200);

    const event = await testDb.db.event.findFirstOrThrow({ where: { captureId: ack.capture.id } });
    // 09:00 in the Settings zone (UTC); the server default would give 08:00Z.
    expect(event.startsAt.toISOString()).toBe('2026-10-18T09:00:00.000Z');
  });
});
