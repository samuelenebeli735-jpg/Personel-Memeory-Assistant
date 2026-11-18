/**
 * Database backups.
 *
 * A backup is a consistent SQLite snapshot created with `VACUUM INTO`, not a
 * byte-for-byte copy of a live file. That matters because the database runs in
 * WAL mode: copying only `recall.db` while a writer is active can capture a torn
 * state. `VACUUM INTO` asks SQLite to produce one self-contained database file
 * with no `-wal`/`-shm` siblings, while the service keeps running.
 *
 * Every backup is accompanied by the existing JSON export. The snapshot is the
 * restore unit; the export is portable and can be restored additively through
 * `POST /api/restore` when a full file swap is not appropriate.
 *
 * Retention only ever deletes files matching the managed naming pattern
 * (`recall-<UTC timestamp>.db` / `.json`). A stray file in the backup directory
 * is never touched.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { AppContext } from '../context.js';
import { createDb, type Db } from '../db/client.js';
import { exportAll } from './export-service.js';
import { getSettings } from './settings-service.js';

export const DEFAULT_BACKUP_KEEP = 14;

const MANAGED_BACKUP = /^(recall-\d{8}T\d{9}Z(?:-\d+)?)\.(db|json)$/;

export interface BackupCounts {
  captures: number;
  tasks: number;
  notes: number;
  ideas: number;
  events: number;
  projects: number;
  reminders: number;
  reminderDeliveries: number;
  briefingDeliveries: number;
}

export interface BackupVerification {
  integrity: string;
  foreignKeyViolations: number;
  appliedMigrations: number;
  unfinishedMigrations: number;
  counts: BackupCounts;
}

export interface CreateBackupOptions {
  outDir: string;
  /** Number of newest managed backup pairs to retain. Must be at least 1. */
  keep?: number;
  /** Injectable for deterministic tests. */
  now?: Date;
  /** Test-only hook used to model a write after the snapshot is finalized. */
  afterSnapshot?: () => Promise<void>;
}

export interface BackupResult {
  databasePath: string;
  exportPath: string;
  verification: BackupVerification;
  pruned: string[];
}

function timestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('.', '');
}

function managedStem(fileName: string): string | null {
  const match = MANAGED_BACKUP.exec(fileName);
  return match?.[1] ?? null;
}

/** Creates one consistent snapshot. Returns the path and the filesystem stem. */
export async function createDatabaseBackup(
  db: Db,
  outDir: string,
  now: Date = new Date(),
): Promise<{ filePath: string; stem: string }> {
  const directory = path.resolve(outDir);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  const base = `recall-${timestamp(now)}`;
  let stem = base;
  let suffix = 1;
  while (fs.existsSync(path.join(directory, `${stem}.db`))) {
    stem = `${base}-${suffix}`;
    suffix += 1;
  }

  const filePath = path.join(directory, `${stem}.db`);
  // `VACUUM INTO` takes a filename expression, not a bind parameter. The path is
  // operator-supplied and quoted; it is never assembled from record content.
  const escaped = filePath.replace(/'/g, "''");
  await db.$executeRawUnsafe(`VACUUM INTO '${escaped}'`);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* Windows and some filesystems do not implement POSIX modes. */
  }
  return { filePath, stem };
}

/** Opens a backup read-only in spirit and checks it is a complete Recall DB. */
export async function verifyDatabaseBackup(filePath: string): Promise<BackupVerification> {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) {
    throw new Error(`Backup file does not exist: ${absolute}`);
  }

  const db = createDb({ url: `file:${absolute}` });
  try {
    const integrityRows = await db.$queryRawUnsafe<Array<{ integrity_check: string }>>(
      'PRAGMA integrity_check;',
    );
    const integrity = integrityRows[0]?.integrity_check ?? 'unknown';
    if (integrity !== 'ok') {
      throw new Error(`Backup integrity check failed: ${integrity}`);
    }
    const foreignKeyRows = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
      'PRAGMA foreign_key_check;',
    );
    if (foreignKeyRows.length > 0) {
      throw new Error(`Backup has ${foreignKeyRows.length} foreign-key violation(s)`);
    }

    let migrations: Array<{ finished_at: unknown; rolled_back_at: unknown }>;
    try {
      migrations = await db.$queryRawUnsafe<
        Array<{ finished_at: unknown; rolled_back_at: unknown }>
      >('SELECT finished_at, rolled_back_at FROM "_prisma_migrations"');
    } catch (error) {
      throw new Error(
        `Not a Recall database backup (missing migration history): ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }

    const appliedMigrations = migrations.filter(
      (row) => row.finished_at !== null && row.rolled_back_at === null,
    ).length;
    const unfinishedMigrations = migrations.length - appliedMigrations;

    const counts: BackupCounts = {
      captures: await db.capture.count(),
      tasks: await db.task.count(),
      notes: await db.note.count(),
      ideas: await db.idea.count(),
      events: await db.event.count(),
      projects: await db.project.count(),
      reminders: await db.reminder.count(),
      reminderDeliveries: await db.reminderDelivery.count(),
      briefingDeliveries: await db.briefingDelivery.count(),
    };

    return {
      integrity,
      foreignKeyViolations: foreignKeyRows.length,
      appliedMigrations,
      unfinishedMigrations,
      counts,
    };
  } finally {
    await db.$disconnect();
  }
}

/**
 * Deletes the oldest managed backup pairs beyond `keep`. Returns removed paths.
 * Non-managed files are ignored, and an empty/missing directory is a no-op.
 */
export function pruneBackups(outDir: string, keep: number = DEFAULT_BACKUP_KEEP): string[] {
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error('Backup retention must be a whole number of at least 1');
  }
  const directory = path.resolve(outDir);
  if (!fs.existsSync(directory)) return [];

  const stems = new Set<string>();
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const stem = managedStem(entry.name);
    if (stem) stems.add(stem);
  }

  const stale = [...stems].sort().reverse().slice(keep);
  const removed: string[] = [];
  for (const stem of stale) {
    for (const extension of ['db', 'json'] as const) {
      const file = path.join(directory, `${stem}.${extension}`);
      if (!fs.existsSync(file)) continue;
      fs.rmSync(file, { force: true });
      removed.push(file);
    }
  }
  return removed;
}

/**
 * Creates the snapshot, verifies it, writes the JSON export, then applies
 * retention. The settings row is materialised first so the snapshot and the
 * export describe the same configuration.
 */
export async function createBackup(
  ctx: AppContext,
  options: CreateBackupOptions,
): Promise<BackupResult> {
  const keep = options.keep ?? DEFAULT_BACKUP_KEEP;
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error('Backup retention must be a whole number of at least 1');
  }

  await getSettings(ctx.db, ctx.defaults);
  const now = options.now ?? ctx.clock.now();
  const { filePath, stem } = await createDatabaseBackup(ctx.db, options.outDir, now);
  const verification = await verifyDatabaseBackup(filePath);
  if (verification.unfinishedMigrations > 0) {
    throw new Error(
      `Backup has ${verification.unfinishedMigrations} unfinished migration(s); refusing to accept it`,
    );
  }
  if (options.afterSnapshot) await options.afterSnapshot();

  const exportPath = path.join(path.resolve(options.outDir), `${stem}.json`);

  // Export from the verified snapshot, not the live database. A live export
  // after VACUUM INTO could observe writes that happened after the snapshot and
  // produce a JSON companion describing a different point in time. The SQLite
  // file is authoritative; the JSON export must describe that same file.
  const snapshotDb = createDb({ url: `file:${filePath}` });
  let bundle: Awaited<ReturnType<typeof exportAll>>;
  try {
    bundle = await exportAll(ctx, snapshotDb);
  } finally {
    await snapshotDb.$disconnect();
  }
  fs.writeFileSync(exportPath, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(exportPath, 0o600);
  } catch {
    /* Windows and some filesystems do not implement POSIX modes. */
  }

  return {
    databasePath: filePath,
    exportPath,
    verification,
    pruned: pruneBackups(options.outDir, keep),
  };
}
