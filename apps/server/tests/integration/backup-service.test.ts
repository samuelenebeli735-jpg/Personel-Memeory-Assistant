/**
 * Backup and restore-support behavior.
 *
 * These tests use a real SQLite database copied from the migrated template, so
 * `VACUUM INTO`, WAL handling and the migration table are exercised rather than
 * mocked. Backup files live in a disposable temp directory.
 */
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createBackup, pruneBackups, verifyDatabaseBackup } from '../../src/services/backup-service.js';
import { createTestContext } from '../helpers/app.js';
import { createTestDatabase, tempDir, type TestDb } from '../helpers/db.js';

let testDb: TestDb;
let outDir: string;

beforeEach(async () => {
  testDb = await createTestDatabase('backup-service');
  outDir = tempDir('recall-backups');
});

afterEach(async () => {
  await testDb.cleanup();
  fs.rmSync(outDir, { recursive: true, force: true });
});

describe('database backups', () => {
  it('creates a consistent snapshot and a JSON export of the same rows', async () => {
    const { ctx } = createTestContext({ db: testDb.db });
    await ctx.db.capture.create({
      data: { source: 'CLI', rawText: 'call Ada tomorrow at 4pm' },
    });
    await ctx.db.task.create({ data: { title: 'Call Ada' } });

    const result = await createBackup(ctx, {
      outDir,
      keep: 5,
      now: new Date('2026-10-22T10:00:00.000Z'),
    });

    expect(fs.existsSync(result.databasePath)).toBe(true);
    expect(fs.existsSync(result.exportPath)).toBe(true);
    expect(result.verification.integrity).toBe('ok');
    expect(result.verification.foreignKeyViolations).toBe(0);
    expect(result.verification.unfinishedMigrations).toBe(0);
    expect(result.verification.counts.captures).toBe(1);
    expect(result.verification.counts.tasks).toBe(1);

    const bundle = JSON.parse(fs.readFileSync(result.exportPath, 'utf8')) as {
      data: { captures: Array<{ rawText: string }> };
    };
    expect(bundle.data.captures.map((capture) => capture.rawText)).toEqual([
      'call Ada tomorrow at 4pm',
    ]);
  });

  it('restores the snapshot as a standalone database with the same rows', async () => {
    const { ctx } = createTestContext({ db: testDb.db });
    await ctx.db.note.create({ data: { title: 'Restore drill', body: 'the original words' } });

    const result = await createBackup(ctx, {
      outDir,
      keep: 5,
      now: new Date('2026-10-22T10:01:00.000Z'),
    });
    const restoredPath = path.join(outDir, 'restored.db');
    fs.copyFileSync(result.databasePath, restoredPath);

    const restored = await verifyDatabaseBackup(restoredPath);

    expect(restored.integrity).toBe('ok');
    expect(restored.unfinishedMigrations).toBe(0);
    expect(restored.counts.notes).toBe(1);
  });

  it('exports the same snapshot point even when the live database changes afterward', async () => {
    const { ctx } = createTestContext({ db: testDb.db });
    const result = await createBackup(ctx, {
      outDir,
      keep: 5,
      now: new Date('2026-10-22T10:02:00.000Z'),
      afterSnapshot: async () => {
        await ctx.db.task.create({ data: { title: 'Written after snapshot' } });
      },
    });

    const bundle = JSON.parse(fs.readFileSync(result.exportPath, 'utf8')) as {
      data: { tasks: Array<{ title: string }> };
    };
    expect(bundle.data.tasks).toEqual([]);
    expect(await ctx.db.task.count()).toBe(1);
    expect(result.verification.counts.tasks).toBe(0);
  });

  it('retains only the newest managed backup pairs and ignores stray files', async () => {
    const { ctx } = createTestContext({ db: testDb.db });
    for (let index = 0; index < 3; index += 1) {
      await createBackup(ctx, {
        outDir,
        keep: 99,
        now: new Date(`2026-10-22T10:00:0${index}.000Z`),
      });
    }
    const stray = path.join(outDir, 'keep-me.txt');
    fs.writeFileSync(stray, 'not a backup');

    const pruned = pruneBackups(outDir, 2);

    expect(pruned).toHaveLength(2); // the oldest .db and .json
    expect(fs.existsSync(stray)).toBe(true);
    const managed = fs.readdirSync(outDir).filter((name) => name.startsWith('recall-'));
    expect(managed).toHaveLength(4); // two newest pairs
  });

  it('reports a missing backup instead of creating an empty database', async () => {
    await expect(verifyDatabaseBackup(path.join(outDir, 'absent.db'))).rejects.toThrow(
      /does not exist/,
    );
  });

  it('rejects a retention value that would delete everything', () => {
    expect(() => pruneBackups(outDir, 0)).toThrow(/at least 1/);
  });
});
