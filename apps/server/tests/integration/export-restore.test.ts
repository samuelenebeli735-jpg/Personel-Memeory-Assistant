/**
 * Export and restore integration.
 *
 * The acceptance criterion is a **round trip**: everything that goes out comes
 * back, including tag links, reminder deliveries and relationships. Restore is
 * also checked for the two properties that make it safe to run against a live
 * database: it never overwrites, and it never deletes.
 */
import type { ExportBundleDto, RestoreReportDto } from '@recall/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestApp, type TestApp } from '../helpers/app.js';
import { createTestDatabase, type TestDb } from '../helpers/db.js';
import { createReminder } from '../../src/services/reminder-service.js';

let testDb: TestDb;
let app: TestApp;
let cookie: string;

beforeAll(async () => {
  testDb = await createTestDatabase('export-restore');
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

async function post<T>(url: string, payload: unknown, expectStatus = 201): Promise<T> {
  const response = await authed(url, { method: 'POST', payload });
  expect(response.statusCode, response.body).toBe(expectStatus);
  return response.json() as T;
}

async function exportBundle(): Promise<ExportBundleDto> {
  const response = await authed('/api/export');
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as ExportBundleDto;
}

async function restore(
  bundle: unknown,
  dryRun = false,
): Promise<RestoreReportDto> {
  return post<RestoreReportDto>('/api/restore', { bundle, dryRun }, 200);
}

type Rows = Record<string, Array<Record<string, unknown>>>;

/**
 * A database with one of everything, so the round trip has something to lose:
 * a project, a tagged task with a reminder and a delivery attempt, a note, an
 * idea, an event, a capture with a tag, and a link between two captures.
 */
async function seedEverything(): Promise<{ taskId: string; captureId: string }> {
  const project = await post<{ id: string }>('/api/projects', { name: 'Kitchen' });
  const capture = await post<{ capture: { id: string } }>('/api/captures', {
    rawText: 're-tile the kitchen in spring #home',
    source: 'API',
    externalId: 'seed:1',
  });
  const task = await post<{ id: string }>('/api/tasks', {
    title: 'Re-tile the kitchen',
    description: 'Ask about the tiles',
    projectId: project.id,
    captureId: capture.capture.id,
    dueAt: '2026-11-01T09:00:00.000Z',
    priority: 'HIGH',
    category: 'home',
    tags: ['home', 'renovation'],
  });
  await post('/api/notes', {
    body: 'Tiles cost 40 per square metre',
    projectId: project.id,
    tags: ['home'],
  });
  await post('/api/ideas', { title: 'Underfloor heating', projectId: project.id });
  await post('/api/events', {
    title: 'Tiler visit',
    startsAt: '2026-10-30T14:00:00.000Z',
    projectId: project.id,
  });

  const reminder = await createReminder(app.ctx, {
    title: 'Chase the tiles',
    remindAt: '2026-10-28T09:00:00.000Z',
    taskId: task.id,
  });
  await testDb.db.reminderDelivery.create({
    data: {
      reminderId: reminder.id,
      attempt: 1,
      status: 'FAILED',
      scheduledFor: new Date('2026-10-28T09:00:00.000Z'),
      attemptedAt: new Date('2026-10-28T09:00:05.000Z'),
      error: 'network unreachable',
      idempotencyKey: `${reminder.id}:seed:1`,
    },
  });

  const secondCapture = await post<{ capture: { id: string } }>('/api/captures', {
    rawText: 'the kitchen quote arrived',
    source: 'API',
    externalId: 'seed:2',
    captureOnly: true,
  });
  await testDb.db.captureRelation.create({
    data: {
      fromCaptureId: secondCapture.capture.id,
      toCaptureId: capture.capture.id,
      relationType: 'RELATED_TO',
      note: 'same project',
    },
  });

  return { taskId: task.id, captureId: capture.capture.id };
}

describe('export', () => {
  it('returns every table, with consistent counts and the settings row', async () => {
    await seedEverything();
    const bundle = await exportBundle();

    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(bundle.settings.timeZone).toBe('Africa/Lagos');

    expect(bundle.data.projects).toHaveLength(1);
    expect(bundle.data.tasks).toHaveLength(1);
    expect(bundle.data.notes).toHaveLength(1);
    expect(bundle.data.ideas).toHaveLength(1);
    expect(bundle.data.events).toHaveLength(1);
    expect(bundle.data.captures).toHaveLength(2);
    expect(bundle.data.tags.map((t) => (t as { name: string }).name).sort()).toEqual([
      'home',
      'renovation',
    ]);
    expect(bundle.data.captureTags).toHaveLength(1);
    expect(bundle.data.taskTags).toHaveLength(2);
    expect(bundle.data.noteTags).toHaveLength(1);
    expect(bundle.data.reminders).toHaveLength(1);
    expect(bundle.data.reminderDeliveries).toHaveLength(1);
    expect(bundle.data.captureRelations).toHaveLength(1);

    for (const [key, rows] of Object.entries(bundle.data)) {
      expect(bundle.counts[key], `${key} count`).toBe((rows as unknown[]).length);
    }
  });

  it('is byte-identical on a second export apart from the timestamp', async () => {
    await seedEverything();
    const first = await exportBundle();
    const second = await exportBundle();
    expect({ ...second, exportedAt: 'x' }).toEqual({ ...first, exportedAt: 'x' });
  });
});

describe('restore', () => {
  it('round-trips the whole database into an empty one', async () => {
    const { taskId, captureId } = await seedEverything();
    const bundle = await exportBundle();

    await testDb.reset();
    for (const model of ['task', 'note', 'idea', 'event', 'capture', 'project'] as const) {
      expect(await testDb.db[model].count(), `${model} before restore`).toBe(0);
    }

    const report = await restore(bundle);
    expect(report.dryRun).toBe(false);
    expect(report.errors).toEqual([]);
    expect(report.inserted.projects).toBe(1);
    expect(report.inserted.tasks).toBe(1);
    expect(report.inserted.captureTags).toBe(1);
    expect(report.inserted.taskTags).toBe(2);
    expect(report.inserted.reminderDeliveries).toBe(1);
    expect(report.inserted.captureRelations).toBe(1);

    // The task arrives complete: same id, project, capture, tags and deadline.
    const task = await testDb.db.task.findUniqueOrThrow({
      where: { id: taskId },
      include: { tags: { include: { tag: true } }, project: true },
    });
    expect(task.title).toBe('Re-tile the kitchen');
    expect(task.priority).toBe('HIGH');
    expect(task.dueAt?.toISOString()).toBe('2026-11-01T09:00:00.000Z');
    expect(task.project?.name).toBe('Kitchen');
    expect(task.captureId).toBe(captureId);
    expect(task.tags.map((t) => t.tag.name).sort()).toEqual(['home', 'renovation']);

    const delivery = await testDb.db.reminderDelivery.findFirstOrThrow();
    expect(delivery.status).toBe('FAILED');
    expect(delivery.error).toBe('network unreachable');
    expect(delivery.attemptedAt?.toISOString()).toBe('2026-10-28T09:00:05.000Z');

    // And a fresh export of the restored database matches the original bundle.
    // `settings.updatedAt` is the one value that legitimately changes: the
    // restored settings row is created now, not when the original was written.
    const after = await exportBundle();
    expect(after.data).toEqual(bundle.data);
    expect(after.counts).toEqual(bundle.counts);
    expect({ ...after.settings, updatedAt: 'x' }).toEqual({ ...bundle.settings, updatedAt: 'x' });
  });

  it('is idempotent: a second restore inserts nothing', async () => {
    await seedEverything();
    const bundle = await exportBundle();

    await testDb.reset();
    await restore(bundle);
    const second = await restore(bundle);

    expect(second.errors).toEqual([]);
    for (const [key, count] of Object.entries(second.inserted)) {
      expect(count, `inserted ${key}`).toBe(0);
    }
    expect(second.skipped.tasks).toBe(1);
    expect(second.skipped.captures).toBe(2);
    expect(second.skipped.tags).toBe(2);
    expect(await testDb.db.task.count()).toBe(1);
    expect(await testDb.db.tag.count()).toBe(2);
  });

  it('does not write anything on a dry run', async () => {
    await seedEverything();
    const bundle = await exportBundle();
    await testDb.reset();

    const report = await restore(bundle, true);
    expect(report.dryRun).toBe(true);
    expect(report.inserted.tasks).toBe(1);
    expect(report.inserted.tags).toBe(2);
    expect(await testDb.db.task.count()).toBe(0);
    expect(await testDb.db.tag.count()).toBe(0);
    expect(await testDb.db.capture.count()).toBe(0);
  });

  it('defaults to a dry run when dryRun is not supplied', async () => {
    await seedEverything();
    const bundle = await exportBundle();
    await testDb.reset();

    const response = await authed('/api/restore', { method: 'POST', payload: { bundle } });
    expect(response.statusCode).toBe(200);
    expect((response.json() as RestoreReportDto).dryRun).toBe(true);
    expect(await testDb.db.task.count()).toBe(0);
  });

  it('reuses a tag that already exists by name instead of duplicating it', async () => {
    await post('/api/tasks', { title: 'Tagged', tags: ['home'] });
    const bundle = await exportBundle();
    const rows = bundle.data as unknown as Rows;
    const bundledTagId = String(rows.tags![0]!.id);

    await testDb.reset();
    // Same name, different id: a real database that already has this tag.
    await testDb.db.tag.create({ data: { id: 'tag-existing', name: 'home' } });

    const report = await restore(bundle);
    expect(report.skipped.tags).toBe(1);
    expect(report.inserted.tags).toBe(0);
    expect(await testDb.db.tag.count()).toBe(1);

    const link = await testDb.db.taskTag.findFirstOrThrow();
    expect(link.tagId).toBe('tag-existing');
    expect(link.tagId).not.toBe(bundledTagId);
    expect(await testDb.db.taskTag.count()).toBe(1);
  });

  it('reuses a capture that already exists by source and external id', async () => {
    const capture = await post<{ capture: { id: string } }>('/api/captures', {
      rawText: 'call the tiler',
      source: 'API',
      externalId: 'api:42',
    });
    await post('/api/tasks', {
      title: 'Call the tiler',
      captureId: capture.capture.id,
    });
    const bundle = await exportBundle();

    await testDb.reset();
    await testDb.db.capture.create({
      data: {
        id: 'capture-existing',
        source: 'API',
        externalId: 'api:42',
        rawText: 'call the tiler',
        capturedAt: new Date('2026-10-17T09:00:00.000Z'),
      },
    });

    const report = await restore(bundle);
    expect(report.skipped.captures).toBe(1);
    expect(await testDb.db.capture.count()).toBe(1);

    const task = await testDb.db.task.findFirstOrThrow();
    expect(task.captureId).toBe('capture-existing');
  });

  it('never overwrites the existing settings row', async () => {
    await seedEverything();
    const bundle = await exportBundle();

    await testDb.reset();
    await restore(bundle);
    await authed('/api/settings', {
      method: 'PATCH',
      payload: { displayName: 'Owner', timeZone: 'Europe/Berlin' },
    });

    const second = await restore(bundle);
    expect(second.skipped.settings).toBe(1);

    const settings = await testDb.db.userSettings.findUniqueOrThrow({ where: { id: 'singleton' } });
    expect(settings.displayName).toBe('Owner');
    expect(settings.timeZone).toBe('Europe/Berlin');
  });

  it('reports a broken row without discarding the rest of the bundle', async () => {
    await seedEverything();
    const bundle = await exportBundle();
    const rows = bundle.data as unknown as Rows;
    // A task row with no title is unusable; everything else must still load.
    delete rows.tasks![0]!.title;

    await testDb.reset();
    const report = await restore(bundle);

    expect(report.errors[0]).toMatch(/^tasks\[0\]: missing required column "title"/);
    expect(report.inserted.tasks).toBe(0);
    // The rows that depended on that task cannot be written either, and each
    // failure is reported rather than silently swallowed.
    expect(report.errors.length).toBeGreaterThan(1);
    expect(report.errors.some((message) => message.startsWith('taskTags'))).toBe(true);
    expect(report.errors.some((message) => message.startsWith('reminders'))).toBe(true);

    // Everything independent of the broken row arrived.
    expect(report.inserted.projects).toBe(1);
    expect(report.inserted.notes).toBe(1);
    expect(report.inserted.ideas).toBe(1);
    expect(report.inserted.events).toBe(1);
    expect(report.inserted.captures).toBe(2);
    expect(await testDb.db.project.count()).toBe(1);
    expect(await testDb.db.event.count()).toBe(1);
  });

  it('refuses a bundle from a newer schema version', async () => {
    const bundle = await exportBundle();
    const response = await authed('/api/restore', {
      method: 'POST',
      payload: { bundle: { ...bundle, schemaVersion: 99 }, dryRun: false },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/newer version of Recall/);
  });

  it('refuses a file that is not a bundle at all', async () => {
    for (const payload of ['{"hello":true}', 'not json', { data: { tasks: 'nope' } }]) {
      const response = await authed('/api/restore', {
        method: 'POST',
        payload: { bundle: JSON.parse(JSON.stringify(payload)), dryRun: false },
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('refuses to restore more rows than the safety limit allows', async () => {
    await seedEverything();
    const bundle = await exportBundle();
    await testDb.reset();

    const response = await authed('/api/restore', {
      method: 'POST',
      payload: { bundle, dryRun: false, maxRowsPerTable: 1 },
    });
    const report = response.json() as RestoreReportDto;
    expect(response.statusCode).toBe(200);
    expect(report.errors.some((message) => message.includes('safety limit'))).toBe(true);
    expect(report.inserted.tasks).toBe(0);
  });
});
