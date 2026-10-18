/** Isolated SQLite databases for tests, copied from the migrated template. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb, applySqlitePragmas, type Db } from '../../src/db/client.js';
import { TEMPLATE_DIR, TEMPLATE_DB } from './global-setup.js';

export interface TestDb {
  db: Db;
  filePath: string;
  /** Removes every row, keeping the schema. Useful for shared fixtures. */
  reset(): Promise<void>;
  cleanup(): Promise<void>;
}

const TABLES_IN_DELETE_ORDER = [
  'reminderDelivery',
  'reminder',
  'captureRelation',
  'captureTag',
  'taskTag',
  'noteTag',
  'ideaTag',
  'task',
  'note',
  'idea',
  'event',
  'project',
  'tag',
  'capture',
  'userSettings',
] as const;

/** Prisma model delegates are keyed by the lower-camel model name. */
type DeletableModel = (typeof TABLES_IN_DELETE_ORDER)[number];

/** Wipes every row while keeping the schema, in foreign-key-safe order. */
async function deleteAllRows(db: Db): Promise<void> {
  for (const model of TABLES_IN_DELETE_ORDER) {
    const delegate = (db as unknown as Record<DeletableModel, { deleteMany(): Promise<unknown> }>)[
      model
    ];
    await delegate.deleteMany();
  }
}

export async function createTestDatabase(label = 'test'): Promise<TestDb> {
  if (!fs.existsSync(TEMPLATE_DB)) {
    throw new Error(
      `Test template database missing at ${TEMPLATE_DB}. The vitest globalSetup step should have created it.`,
    );
  }
  const filePath = path.join(
    TEMPLATE_DIR,
    `${label}-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`,
  );
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.copyFileSync(TEMPLATE_DB, filePath);

  const db = createDb({ url: `file:${filePath}` });
  await applySqlitePragmas(db);

  const cleanupFiles = () => {
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      const file = `${filePath}${suffix}`;
      if (fs.existsSync(file)) {
        try {
          fs.rmSync(file, { force: true });
        } catch {
          /* Windows can briefly hold the handle; the temp dir is disposable. */
        }
      }
    }
  };

  return {
    db,
    filePath,
    async reset() {
      await deleteAllRows(db);
    },
    async cleanup() {
      await db.$disconnect();
      cleanupFiles();
    },
  };
}

export function tempDir(prefix = 'recall'): string {
  const dir = path.join(os.tmpdir(), `${prefix}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
