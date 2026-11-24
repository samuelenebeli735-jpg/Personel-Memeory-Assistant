/**
 * Round 2 server contracts (step 4).
 *
 * S1  the inbox pages with a real total and honours offset;
 * S2  /projects is paginated;
 * S3  POST /api/restore/file accepts export files up to 25 MB, on that route
 *     only, and checks the session before reading the body;
 * S4  every paginated list ends with id, so rows with equal sort values never
 *     repeat or go missing between pages;
 * and the restore file contract: the server validates and applies exactly the
 * bytes it checked, and repeating a restore adds nothing.
 */
import { createHash } from 'node:crypto';
import type { ExportBundleDto, RestoreFileReportDto } from '@recall/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestApp, type TestApp } from '../helpers/app.js';
import { createTestDatabase, type TestDb } from '../helpers/db.js';

let testDb: TestDb;
let app: TestApp;
let cookie: string;

beforeAll(async () => {
  testDb = await createTestDatabase('round2-contracts');
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

const SAME_TIME = new Date('2026-11-20T09:00:00.000Z');

function get(url: string) {
  return app.app.inject({ method: 'GET', url, headers: { cookie } });
}

async function getJson<T>(url: string): Promise<T> {
  const response = await get(url);
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as T;
}

/** Reads every page of a list and checks the totals and that ids never repeat. */
async function readAllPages(path: string, expectedTotal: number, pageSize = 25): Promise<string[]> {
  const ids: string[] = [];
  const pages = Math.ceil(expectedTotal / pageSize);
  for (let page = 0; page < pages + 1; page += 1) {
    const sep = path.includes('?') ? '&' : '?';
    const body = await getJson<{ items: Array<{ id: string }>; total: number; limit: number; offset: number }>(
      `${path}${sep}limit=${pageSize}&offset=${page * pageSize}`,
    );
    expect(body.total).toBe(expectedTotal);
    expect(body.offset).toBe(page * pageSize);
    expect(body.items.length).toBe(Math.max(0, Math.min(pageSize, expectedTotal - page * pageSize)));
    ids.push(...body.items.map((item) => item.id));
  }
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.length).toBe(expectedTotal);
  return ids;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function postFile(bytes: Buffer, query: Record<string, string>, headers: Record<string, string> = {}) {
  const qs = new URLSearchParams(query).toString();
  return app.app.inject({
    method: 'POST',
    url: `/api/restore/file?${qs}`,
    headers: { cookie, 'content-type': 'application/json', ...headers },
    payload: bytes,
  });
}

async function checkFile(bytes: Buffer): Promise<RestoreFileReportDto> {
  const response = await postFile(bytes, { dryRun: 'true', sha256: sha256(bytes) });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as RestoreFileReportDto;
}

async function applyFile(bytes: Buffer, check: RestoreFileReportDto): Promise<RestoreFileReportDto> {
  const response = await postFile(bytes, {
    dryRun: 'false',
    sha256: check.file.sha256,
    checkToken: check.file.checkToken ?? '',
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as RestoreFileReportDto;
}

async function tableCounts(): Promise<Record<string, number>> {
  const db = testDb.db;
  return {
    captures: await db.capture.count(),
    tasks: await db.task.count(),
    notes: await db.note.count(),
    ideas: await db.idea.count(),
    events: await db.event.count(),
    projects: await db.project.count(),
    reminders: await db.reminder.count(),
    tags: await db.tag.count(),
    settings: await db.userSettings.count(),
  };
}

/** A small database worth exporting: one of most things, linked together. */
async function seedForExport(): Promise<void> {
  const post = async (url: string, payload: unknown) => {
    const response = await app.app.inject({ method: 'POST', url, headers: { cookie }, payload });
    expect(response.statusCode, response.body).toBeLessThan(300);
    return response.json() as { id: string };
  };
  const project = await post('/api/projects', { name: 'Kitchen' });
  await post('/api/tasks', { title: 'Re-tile the kitchen', projectId: project.id, tags: ['home'] });
  await post('/api/tasks', { title: 'Buy grout', projectId: project.id });
  await post('/api/notes', { body: 'Tiles cost 40 per square metre', tags: ['home'] });
  await post('/api/ideas', { title: 'Underfloor heating' });
  await post('/api/events', { title: 'Tiler visit', startsAt: '2026-12-01T14:00:00.000Z' });
  await post('/api/captures', { rawText: 'remember the grout colour', source: 'API', externalId: 'r2:1', captureOnly: true });
}

async function exportBytes(): Promise<{ bundle: ExportBundleDto; bytes: Buffer }> {
  const bundle = await getJson<ExportBundleDto>('/api/export');
  return { bundle, bytes: Buffer.from(JSON.stringify(bundle, null, 2), 'utf8') };
}

/* -------------------------------------------------------------------------- */

describe('S1: inbox pagination', () => {
  it('returns a real total and honours offset, with no capture on two pages', async () => {
    for (let i = 0; i < 61; i += 1) {
      await testDb.db.capture.create({
        data: {
          source: 'API',
          rawText: `unclear capture ${i}`,
          status: 'NEEDS_REVIEW',
          needsReview: true,
          capturedAt: SAME_TIME,
        },
      });
    }
    // Reviewed and deleted captures are not in the inbox.
    await testDb.db.capture.create({ data: { source: 'API', rawText: 'done', status: 'PROCESSED', capturedAt: SAME_TIME } });
    await testDb.db.capture.create({
      data: { source: 'API', rawText: 'gone', status: 'NEEDS_REVIEW', capturedAt: SAME_TIME, deletedAt: SAME_TIME },
    });

    await readAllPages('/api/captures/inbox', 61);

    const overview = await getJson<{ counts: { inboxNeedsReview: number } }>('/api/dashboard/overview');
    expect(overview.counts.inboxNeedsReview).toBe(61);
  });

  it('rejects an invalid page request', async () => {
    expect((await get('/api/captures/inbox?limit=0')).statusCode).toBe(400);
    expect((await get('/api/captures/inbox?offset=-1')).statusCode).toBe(400);
  });
});

describe('S2: paginated projects', () => {
  it('pages projects with a total and keeps archived ones out unless asked', async () => {
    for (let i = 0; i < 27; i += 1) {
      await testDb.db.project.create({ data: { name: `Project ${String(i).padStart(2, '0')}`, createdAt: SAME_TIME } });
    }
    await testDb.db.project.create({ data: { name: 'Old project', status: 'ARCHIVED', archivedAt: SAME_TIME } });

    await readAllPages('/api/projects', 27);
    await readAllPages('/api/projects?includeArchived=true', 28);
  });
});

describe('S4: stable order with equal sort values', () => {
  it('never repeats or drops a row across pages of every list', async () => {
    const db = testDb.db;
    for (let i = 0; i < 62; i += 1) {
      const task = await db.task.create({ data: { title: `Task ${i}`, dueAt: SAME_TIME, createdAt: SAME_TIME } });
      await db.note.create({ data: { body: `Note ${i}`, createdAt: SAME_TIME } });
      await db.idea.create({ data: { title: `Idea ${i}`, createdAt: SAME_TIME } });
      await db.event.create({ data: { title: `Event ${i}`, startsAt: SAME_TIME, createdAt: SAME_TIME } });
      await db.reminder.create({ data: { title: `Reminder ${i}`, remindAt: SAME_TIME, taskId: task.id, createdAt: SAME_TIME } });
      await db.capture.create({ data: { source: 'API', rawText: `Capture ${i}`, status: 'PROCESSED', capturedAt: SAME_TIME } });
    }

    await readAllPages('/api/tasks', 62);
    await readAllPages('/api/tasks?sort=priority', 62);
    await readAllPages('/api/tasks?sort=createdAt&order=desc', 62);
    await readAllPages('/api/notes', 62);
    await readAllPages('/api/ideas', 62);
    await readAllPages('/api/events', 62);
    await readAllPages('/api/reminders', 62);
    await readAllPages('/api/captures', 62);
  });

  it('returns the same page twice in the same order', async () => {
    for (let i = 0; i < 30; i += 1) {
      await testDb.db.note.create({ data: { body: `Same time ${i}`, createdAt: SAME_TIME } });
    }
    const first = await getJson<{ items: Array<{ id: string }> }>('/api/notes?limit=25&offset=0');
    const second = await getJson<{ items: Array<{ id: string }> }>('/api/notes?limit=25&offset=0');
    expect(second.items.map((n) => n.id)).toEqual(first.items.map((n) => n.id));
  });

  it('breaks ties on id in the direction of the main sort', async () => {
    const db = testDb.db;
    // Explicit ids inserted out of order, so insertion (rowid) order differs
    // from id order and only an id tie-breaker gives the expected sequence.
    const shuffled = [7, 2, 11, 0, 9, 4, 1, 10, 5, 3, 8, 6];
    for (const n of shuffled) {
      const id = `tie-${String(n).padStart(2, '0')}`;
      await db.note.create({ data: { id: `note-${id}`, body: `Tie ${n}`, createdAt: SAME_TIME } });
      await db.event.create({ data: { id: `event-${id}`, title: `Tie ${n}`, startsAt: SAME_TIME } });
      await db.capture.create({
        data: { id: `capture-${id}`, source: 'API', rawText: `Tie ${n}`, status: 'NEEDS_REVIEW', capturedAt: SAME_TIME },
      });
      await db.idea.create({ data: { id: `idea-${id}`, title: `Tie ${n}`, createdAt: SAME_TIME } });
      await db.task.create({ data: { id: `task-${id}`, title: `Tie ${n}`, dueAt: SAME_TIME, createdAt: SAME_TIME } });
      await db.reminder.create({ data: { id: `reminder-${id}`, title: `Tie ${n}`, remindAt: SAME_TIME, taskId: `task-${id}` } });
    }
    const ids = async (url: string) => (await getJson<{ items: Array<{ id: string }> }>(url)).items.map((r) => r.id);
    const ascending = (list: string[]) => [...list].sort((a, b) => a.localeCompare(b));
    const descending = (list: string[]) => [...list].sort((a, b) => b.localeCompare(a));

    // Notes and captures are newest first, so equal times fall back to id descending.
    const notes = await ids('/api/notes?limit=50');
    expect(notes).toEqual(descending(notes));
    const captures = await ids('/api/captures?limit=50');
    expect(captures).toEqual(descending(captures));
    // Events and the inbox run oldest first, so ties fall back to id ascending.
    const events = await ids('/api/events?limit=50');
    expect(events).toEqual(ascending(events));
    const inbox = await ids('/api/captures/inbox?limit=50');
    expect(inbox).toEqual(ascending(inbox));
    const ideas = await ids('/api/ideas?limit=50');
    expect(ideas).toEqual(descending(ideas));
    // Tasks default to newest first (database sort)…
    const tasks = await ids('/api/tasks?limit=50');
    expect(tasks).toEqual(descending(tasks));
    // …and by due date they are sorted in memory, which also ends with id.
    const byDue = await ids('/api/tasks?limit=50&sort=dueAt&order=asc');
    expect(byDue).toEqual(ascending(byDue));
    const byDueDesc = await ids('/api/tasks?limit=50&sort=dueAt&order=desc');
    expect(byDueDesc).toEqual(descending(byDueDesc));
    const reminders = await ids('/api/reminders?limit=50');
    expect(reminders).toEqual(ascending(reminders));
  });
});

/* -------------------------------------------------------------------------- */

describe('restore file contract', () => {
  it('checks then applies exactly the same bytes, and a repeated restore adds nothing', async () => {
    await seedForExport();
    const { bytes } = await exportBytes();
    const original = await tableCounts();
    await testDb.reset();

    const check = await checkFile(bytes);
    expect(check.dryRun).toBe(true);
    expect(check.file.sha256).toBe(sha256(bytes));
    expect(check.file.bytes).toBe(bytes.length);
    expect(check.file.schemaVersion).toBe(1);
    expect(check.file.checkToken).toMatch(/^[0-9a-f]{64}$/);
    expect(check.inserted.tasks).toBe(2);
    // A dry run writes nothing.
    expect((await tableCounts()).tasks).toBe(0);

    const applied = await applyFile(bytes, check);
    expect(applied.dryRun).toBe(false);
    expect(applied.errors).toEqual([]);
    expect(applied.file.checkToken).toBeNull();
    expect(applied.inserted).toEqual(check.inserted);
    const afterFirst = await tableCounts();
    expect(afterFirst).toEqual(original);

    // Repeating the same file against the real server: the dry run reports
    // nothing to add and the second restore inserts nothing and changes nothing.
    const recheck = await checkFile(bytes);
    for (const [table, count] of Object.entries(recheck.inserted)) {
      expect(count, `dry run would add to ${table}`).toBe(0);
    }
    const reapplied = await applyFile(bytes, recheck);
    for (const [table, count] of Object.entries(reapplied.inserted)) {
      expect(count, `second restore added to ${table}`).toBe(0);
    }
    expect(Object.values(reapplied.skipped).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(await tableCounts()).toEqual(afterFirst);
  });

  it('refuses when the received bytes are not the ones the browser hashed', async () => {
    await seedForExport();
    const { bytes } = await exportBytes();
    await testDb.reset();

    const response = await postFile(bytes, { dryRun: 'true', sha256: sha256(Buffer.from('another file')) });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('RESTORE_FILE_MISMATCH');
    expect(response.json().error.details.receivedSha256).toBe(sha256(bytes));
  });

  it('refuses to apply a file that was not checked, or that changed after the check', async () => {
    await seedForExport();
    const { bundle, bytes } = await exportBytes();
    await testDb.reset();
    const check = await checkFile(bytes);

    // No check token at all.
    const unchecked = await postFile(bytes, { dryRun: 'false', sha256: sha256(bytes) });
    expect(unchecked.statusCode).toBe(409);

    // A different file sent with its own correct hash but the first file's token.
    const edited = Buffer.from(JSON.stringify({ ...bundle, exportedAt: '2026-11-01T00:00:00.000Z' }), 'utf8');
    const swapped = await postFile(edited, {
      dryRun: 'false',
      sha256: sha256(edited),
      checkToken: check.file.checkToken ?? '',
    });
    expect(swapped.statusCode).toBe(409);
    expect(swapped.json().error.code).toBe('RESTORE_FILE_MISMATCH');

    // A forged token is refused too.
    const forged = await postFile(bytes, { dryRun: 'false', sha256: sha256(bytes), checkToken: 'a'.repeat(64) });
    expect(forged.statusCode).toBe(409);

    // Nothing was written by any refused request.
    expect((await tableCounts()).tasks).toBe(0);
  });

  it('refuses non-JSON, non-UTF-8, non-export and newer-version files', async () => {
    const cases: Array<{ bytes: Buffer; status: number; message: RegExp }> = [
      { bytes: Buffer.from('{ not json'), status: 400, message: /valid JSON/ },
      { bytes: Buffer.from([0xff, 0xfe, 0x7b, 0x7d]), status: 400, message: /UTF-8/ },
      { bytes: Buffer.from(JSON.stringify({ hello: 'world' })), status: 400, message: /not a Recall export bundle/ },
      {
        bytes: Buffer.from(
          JSON.stringify({ schemaVersion: 2, exportedAt: '2026-11-20T00:00:00.000Z', settings: {}, counts: {}, data: {} }),
        ),
        status: 400,
        message: /newer version of Recall \(schema 2\)/,
      },
    ];
    for (const item of cases) {
      const response = await postFile(item.bytes, { dryRun: 'true', sha256: sha256(item.bytes) });
      expect(response.statusCode, response.body).toBe(item.status);
      expect(response.json().error.message).toMatch(item.message);
    }
  });

  it('accepts a byte-order mark as part of the file', async () => {
    await seedForExport();
    const { bytes } = await exportBytes();
    await testDb.reset();
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]);
    const check = await checkFile(withBom);
    expect(check.file.sha256).toBe(sha256(withBom));
    expect(check.inserted.tasks).toBe(2);
  });

  it('accepts a 3 MB export, refuses 26 MB, and keeps 2 MB everywhere else (S3)', async () => {
    await seedForExport();
    const { bundle } = await exportBytes();
    await testDb.reset();

    // JSON allows trailing whitespace, so padding makes a valid 3 MB export.
    const big = Buffer.from(JSON.stringify(bundle) + ' '.repeat(3 * 1024 * 1024), 'utf8');
    const check = await checkFile(big);
    expect(check.file.bytes).toBe(big.length);
    expect(check.inserted.tasks).toBe(2);

    const huge = Buffer.alloc(26 * 1024 * 1024, 0x20);
    const refused = await postFile(huge, { dryRun: 'true', sha256: sha256(huge) });
    expect(refused.statusCode).toBe(413);

    // The JSON restore route and every other route keep the 2 MB limit.
    const oldRoute = await app.app.inject({
      method: 'POST',
      url: '/api/restore',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ bundle, dryRun: true }) + ' '.repeat(2.5 * 1024 * 1024),
    });
    expect(oldRoute.statusCode).toBe(413);
    const note = await app.app.inject({
      method: 'POST',
      url: '/api/notes',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ body: 'x' }) + ' '.repeat(2.5 * 1024 * 1024),
    });
    expect(note.statusCode).toBe(413);
  });

  it('checks the session before reading a large upload', async () => {
    const huge = Buffer.alloc(30 * 1024 * 1024, 0x20);
    const response = await app.app.inject({
      method: 'POST',
      url: `/api/restore/file?dryRun=true&sha256=${sha256(huge)}`,
      headers: { 'content-type': 'application/json' },
      payload: huge,
    });
    // 401, not 413: the request was refused before its body was read.
    expect(response.statusCode).toBe(401);
  });

  it('only accepts JSON uploads and a well-formed hash', async () => {
    const bytes = Buffer.from('{}');
    expect((await postFile(bytes, { dryRun: 'true', sha256: sha256(bytes) }, { 'content-type': 'text/plain' })).statusCode).toBe(415);
    expect((await postFile(bytes, { dryRun: 'true', sha256: 'not-a-hash' })).statusCode).toBe(400);
  });

  it('a restore interrupted part-way can be run again and adds only what is missing', async () => {
    await seedForExport();
    const { bundle, bytes } = await exportBytes();
    const original = await tableCounts();
    await testDb.reset();

    // Simulate an interruption: only part of the file had been written (the
    // project and one of the two tasks) when the connection was lost.
    const partial = {
      ...bundle,
      settings: undefined,
      data: {
        ...Object.fromEntries(Object.keys(bundle.data).map((key) => [key, []])),
        projects: bundle.data.projects,
        tasks: bundle.data.tasks.slice(0, 1),
      },
    };
    const partialBytes = Buffer.from(JSON.stringify(partial), 'utf8');
    await applyFile(partialBytes, await checkFile(partialBytes));
    expect((await tableCounts()).tasks).toBe(1);

    // Re-running the full file adds only what is missing.
    const check = await checkFile(bytes);
    expect(check.inserted.tasks).toBe(1);
    expect(check.inserted.projects).toBe(0);
    await applyFile(bytes, check);
    expect(await tableCounts()).toEqual(original);
  });

  it('skips a table over the row safety limit and restores the others', async () => {
    await seedForExport();
    const { bytes } = await exportBytes();
    await testDb.reset();
    const response = await postFile(bytes, { dryRun: 'true', sha256: sha256(bytes), maxRowsPerTable: '1' });
    expect(response.statusCode, response.body).toBe(200);
    const report = response.json() as RestoreFileReportDto;
    expect(report.errors.some((e) => e.startsWith('tasks: 2 rows exceeds the 1-row safety limit'))).toBe(true);
    expect(report.inserted.tasks).toBe(0);
    expect(report.inserted.notes).toBe(1);
  });
});
