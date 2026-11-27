/**
 * Development seed: creates a NEW disposable database and fills it with
 * fictional sample records (N11, R3-04).
 *
 * It can never touch an existing database. Every check runs before anything is
 * written, and the file is created with an exclusive "create new" open, so a
 * file that appears in the meantime is never overwritten:
 *
 *  - refuses `NODE_ENV=production`;
 *  - requires an explicit target (`--database <new file>`); there is no default;
 *  - resolves the target's real folder (following symlinks and junctions)
 *    before checking anything else;
 *  - refuses any file named `dev.db`, and the configured `DATABASE_URL` (or its
 *    default, `prisma/dev.db`), compared by real path;
 *  - refuses a target that already exists in any form: a file, an empty file,
 *    a folder, or a symlink (even a dangling one).
 *
 * The owner's real database is never populated with fabricated history.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { createDb, resolveDatabaseUrl } from '../db/client.js';

export class SeedRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedRefusedError';
  }
}

export interface SeedEnv {
  NODE_ENV?: string | undefined;
  DATABASE_URL?: string | undefined;
}

export interface SeedPaths {
  /** Folder that relative `file:` URLs resolve against (Prisma's rule). */
  prismaDir: string;
  /** Folder a relative `--database` path resolves against. */
  cwd: string;
}

const sameFile = (a: string, b: string) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** The configured database as a real path (the default when unset is prisma/dev.db). */
function configuredDatabasePath(env: SeedEnv, prismaDir: string): string | null {
  const url = env.DATABASE_URL ?? 'file:./dev.db';
  if (!url.startsWith('file:')) return null;
  const resolved = resolveDatabaseUrl(url, prismaDir).slice('file:'.length);
  const absolute = path.resolve(resolved);
  // Compare by real path when the file or its folder exists.
  try {
    return fs.realpathSync(absolute);
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute));
    } catch {
      return absolute;
    }
  }
}

/**
 * Validates the requested target and returns the final, real path to create.
 * Throws `SeedRefusedError` for every unsafe case; writes nothing.
 */
export function resolveSeedTarget(requested: string | undefined, env: SeedEnv, paths: SeedPaths): string {
  if (env.NODE_ENV === 'production') {
    throw new SeedRefusedError('The seed is for development and tests only; it refuses to run with NODE_ENV=production.');
  }
  if (!requested || !requested.trim()) {
    throw new SeedRefusedError(
      'Name a new database file to create: npm run db:seed -- <new file> (or --database <path>). There is no default target.',
    );
  }
  const raw = requested.trim().startsWith('file:') ? requested.trim().slice('file:'.length) : requested.trim();
  const absolute = path.resolve(paths.cwd, raw);

  const refuseName = (p: string) => {
    if (path.basename(p).toLowerCase() === 'dev.db') {
      throw new SeedRefusedError('Refusing a file named dev.db: that is the development database, which holds real data.');
    }
  };
  refuseName(absolute);

  if (lstatOrNull(absolute)) {
    throw new SeedRefusedError(`Refusing ${absolute}: it already exists. The seed only creates a new file.`);
  }

  const parent = path.dirname(absolute);
  let realParent: string;
  try {
    realParent = fs.realpathSync(parent);
  } catch {
    throw new SeedRefusedError(`Refusing ${absolute}: the folder ${parent} does not exist.`);
  }
  const target = path.join(realParent, path.basename(absolute));
  refuseName(target);
  if (lstatOrNull(target)) {
    throw new SeedRefusedError(`Refusing ${target}: it already exists. The seed only creates a new file.`);
  }

  const configured = configuredDatabasePath(env, paths.prismaDir);
  if (configured && sameFile(configured, target)) {
    throw new SeedRefusedError(`Refusing ${target}: it is the configured database (DATABASE_URL).`);
  }
  return target;
}

export interface SeedResult {
  path: string;
  counts: Record<string, number>;
}

/**
 * Creates `target` (which must not exist), applies the real migrations and adds
 * fictional sample records. If anything fails after the file was created, the
 * new file (and only that file) is removed.
 */
export async function seedNewDatabase(
  target: string,
  tools: { prismaBin: string; schemaPath: string; now?: Date },
): Promise<SeedResult> {
  // Exclusive create: fails if anything appeared at the path since the checks.
  let fd: number;
  try {
    fd = fs.openSync(target, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new SeedRefusedError(`Refusing ${target}: it already exists. The seed only creates a new file.`);
    }
    throw error;
  }
  fs.closeSync(fd);

  const url = `file:${target}`;
  try {
    execFileSync(process.execPath, [tools.prismaBin, 'migrate', 'deploy', '--schema', tools.schemaPath], {
      env: { ...process.env, DATABASE_URL: url, CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1' },
      stdio: 'pipe',
    });
    const db = createDb({ url });
    try {
      // Belt and braces: a brand-new file must hold no records before seeding.
      const before = await db.reminder.count() + await db.task.count() + await db.capture.count();
      if (before !== 0) throw new SeedRefusedError(`Refusing ${target}: it is not empty.`);
      const counts = await populate(db, tools.now ?? new Date());
      return { path: target, counts };
    } finally {
      await db.$disconnect();
    }
  } catch (error) {
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try {
        fs.rmSync(`${target}${suffix}`, { force: true });
      } catch {
        // The file is ours and disposable; a leftover is harmless.
      }
    }
    throw error;
  }
}

/** Clearly fictional records covering every type the dashboard shows. */
async function populate(db: ReturnType<typeof createDb>, now: Date): Promise<Record<string, number>> {
  const hours = (h: number) => new Date(now.getTime() + h * 3_600_000);
  const project = await db.project.create({ data: { name: 'Sample: kitchen renovation' } });
  await db.task.create({ data: { title: 'Sample: call the plumber', dueAt: hours(-30), priority: 'HIGH', projectId: project.id } });
  const task = await db.task.create({ data: { title: 'Sample: buy tiles', dueAt: hours(4), projectId: project.id } });
  await db.task.create({ data: { title: 'Sample: read the warranty' } });
  await db.note.create({ data: { title: 'Sample note', body: 'Sample: tiles cost 40 per square metre.', projectId: project.id } });
  await db.idea.create({ data: { title: 'Sample: underfloor heating' } });
  await db.event.create({ data: { title: 'Sample: tiler visit', startsAt: hours(26) } });
  await db.reminder.create({ data: { title: 'Sample: check the tile order', remindAt: hours(20), taskId: task.id } });
  await db.capture.create({
    data: {
      source: 'CLI',
      rawText: 'Sample: is the tiler coming Friday or Monday?',
      status: 'NEEDS_REVIEW',
      needsReview: true,
      kind: 'UNKNOWN',
    },
  });
  return {
    projects: await db.project.count(),
    tasks: await db.task.count(),
    notes: await db.note.count(),
    ideas: await db.idea.count(),
    events: await db.event.count(),
    reminders: await db.reminder.count(),
    captures: await db.capture.count(),
  };
}

/** Command-line entry: `npm run db:seed -- --database <new file>`. Returns an exit code. */
export async function runSeedCli(
  argv: string[],
  env: SeedEnv,
  paths: SeedPaths & { prismaBin: string; schemaPath: string },
  out: { log: (line: string) => void; error: (line: string) => void } = console,
): Promise<number> {
  // `--database <path>`, `--database=<path>` or a plain path. npm swallows
  // `--database` when the root script forwards to the workspace, so the plain
  // form is what `npm run db:seed -- <new file>` delivers.
  let requested: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--database') {
      requested = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--database=')) requested = arg.slice('--database='.length);
    else if (!arg.startsWith('-') && requested === undefined) requested = arg;
  }
  try {
    const target = resolveSeedTarget(requested, env, paths);
    const result = await seedNewDatabase(target, { prismaBin: paths.prismaBin, schemaPath: paths.schemaPath });
    out.log(`Created a new sample database at ${result.path}`);
    out.log(`Records: ${Object.entries(result.counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    return 0;
  } catch (error) {
    out.error(error instanceof SeedRefusedError ? error.message : `Seed failed: ${(error as Error).message}`);
    return 1;
  }
}
