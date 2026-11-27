/**
 * The development seed (N11, R3-04): it may only ever create a NEW disposable
 * database. Every refusal is checked, and a stand-in "owner database" is
 * proven byte-for-byte unchanged.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb } from '../../src/db/client.js';
import { resolveSeedTarget, runSeedCli, SeedRefusedError, seedNewDatabase } from '../../src/dev/seed.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..', '..');
const repoRoot = path.resolve(serverRoot, '..', '..');
const prismaBin = path.join(repoRoot, 'node_modules', 'prisma', 'build', 'index.js');
const schemaPath = path.join(serverRoot, 'prisma', 'schema.prisma');

let root: string;
let ownerDir: string;
let ownerDb: string;
let ownerHash: string;

const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** True when this OS lets the test process create file symlinks (Windows needs a privilege). */
function canCreateFileSymlinks(): boolean {
  const probe = path.join(os.tmpdir(), `recall-symlink-probe-${process.pid}`);
  try {
    fs.symlinkSync(path.join(os.tmpdir(), 'does-not-exist'), probe, 'file');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}
const fileSymlinks = canCreateFileSymlinks();

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-seed-'));
  ownerDir = path.join(root, 'owner');
  fs.mkdirSync(ownerDir);
  // A stand-in for the owner's configured database, with real bytes in it.
  ownerDb = path.join(ownerDir, 'recall.db');
  fs.writeFileSync(ownerDb, 'owner data that must never change');
  ownerHash = sha(ownerDb);
});

afterAll(() => {
  expect(sha(ownerDb)).toBe(ownerHash);
  fs.rmSync(root, { recursive: true, force: true });
});

const env = () => ({ NODE_ENV: 'development', DATABASE_URL: `file:${ownerDb}` });
const paths = () => ({ prismaDir: path.join(root, 'prisma-dir'), cwd: root });

function expectRefused(fn: () => unknown, message: RegExp) {
  let error: unknown;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  expect(error, 'expected a refusal').toBeInstanceOf(SeedRefusedError);
  expect((error as Error).message).toMatch(message);
}

describe('seed target refusals (nothing is written)', () => {
  it('refuses NODE_ENV=production even for a fresh path', () => {
    expectRefused(
      () => resolveSeedTarget(path.join(root, 'fresh.db'), { ...env(), NODE_ENV: 'production' }, paths()),
      /production/,
    );
    expect(fs.existsSync(path.join(root, 'fresh.db'))).toBe(false);
  });

  it('requires an explicit target', () => {
    expectRefused(() => resolveSeedTarget(undefined, env(), paths()), /--database/);
    expectRefused(() => resolveSeedTarget('  ', env(), paths()), /--database/);
  });

  it('refuses the configured DATABASE_URL, absolute or relative to the prisma folder', () => {
    expectRefused(() => resolveSeedTarget(ownerDb, env(), paths()), /already exists|configured/);
    // A configured database that does not exist yet is still refused by path.
    const future = path.join(ownerDir, 'future.db');
    expectRefused(
      () => resolveSeedTarget(future, { NODE_ENV: 'development', DATABASE_URL: `file:${future}` }, paths()),
      /configured database/,
    );
    const prismaDir = path.join(root, 'prisma-like');
    fs.mkdirSync(prismaDir, { recursive: true });
    expectRefused(
      () =>
        resolveSeedTarget(path.join(prismaDir, 'relative.db'), { NODE_ENV: 'development', DATABASE_URL: 'file:./relative.db' }, {
          prismaDir,
          cwd: root,
        }),
      /configured database/,
    );
  });

  it('refuses any file named dev.db, in any folder and any letter case', () => {
    for (const name of ['dev.db', 'DEV.DB', 'Dev.Db']) {
      expectRefused(() => resolveSeedTarget(path.join(root, name), env(), paths()), /dev\.db/);
    }
    expectRefused(() => resolveSeedTarget(`file:${path.join(root, 'dev.db')}`, env(), paths()), /dev\.db/);
  });

  it('defaults the configured database to prisma/dev.db when DATABASE_URL is unset', () => {
    const prismaDir = path.join(root, 'default-prisma');
    fs.mkdirSync(prismaDir, { recursive: true });
    expectRefused(
      () => resolveSeedTarget(path.join(prismaDir, 'dev.db'), { NODE_ENV: 'development' }, { prismaDir, cwd: root }),
      /dev\.db/,
    );
  });

  it('refuses an existing empty file, an existing non-empty file and an existing folder', () => {
    const empty = path.join(root, 'empty.db');
    fs.writeFileSync(empty, '');
    expectRefused(() => resolveSeedTarget(empty, env(), paths()), /already exists/);
    const full = path.join(root, 'full.db');
    fs.writeFileSync(full, 'not empty');
    expectRefused(() => resolveSeedTarget(full, env(), paths()), /already exists/);
    const folder = path.join(root, 'a-folder.db');
    fs.mkdirSync(folder);
    expectRefused(() => resolveSeedTarget(folder, env(), paths()), /already exists/);
    expect(fs.readFileSync(full, 'utf8')).toBe('not empty');
  });

  it('refuses a target whose folder does not exist', () => {
    expectRefused(() => resolveSeedTarget(path.join(root, 'missing', 'x.db'), env(), paths()), /does not exist/);
  });

  it('resolves a junctioned folder to its real path and refuses the database behind it', () => {
    const junction = path.join(root, 'junction-to-owner');
    fs.symlinkSync(ownerDir, junction, 'junction');
    // Through the junction this *is* the owner's database.
    expectRefused(() => resolveSeedTarget(path.join(junction, 'recall.db'), env(), paths()), /already exists|configured/);
    // A new name through the junction is allowed, and the real path is returned.
    const target = resolveSeedTarget(path.join(junction, 'brand-new.db'), env(), paths());
    expect(target).toBe(path.join(fs.realpathSync(ownerDir), 'brand-new.db'));
  });

  it.skipIf(!fileSymlinks)('refuses a symlink target, including a dangling one', () => {
    const link = path.join(root, 'link-to-owner.db');
    fs.symlinkSync(ownerDb, link, 'file');
    expectRefused(() => resolveSeedTarget(link, env(), paths()), /already exists/);
    const dangling = path.join(root, 'dangling.db');
    fs.symlinkSync(path.join(root, 'nowhere.db'), dangling, 'file');
    expectRefused(() => resolveSeedTarget(dangling, env(), paths()), /already exists/);
  });
});

describe('seeding a new database', () => {
  it('creates a new file, applies the real migrations and adds fictional records', async () => {
    const target = resolveSeedTarget(path.join(root, 'sample.db'), env(), paths());
    const result = await seedNewDatabase(target, { prismaBin, schemaPath, now: new Date('2026-11-27T10:00:00Z') });
    expect(result.path).toBe(target);
    expect(result.counts).toEqual({ projects: 1, tasks: 3, notes: 1, ideas: 1, events: 1, reminders: 1, captures: 1 });

    const db = createDb({ url: `file:${target}` });
    try {
      const titles = (await db.task.findMany({ select: { title: true } })).map((t) => t.title);
      expect(titles.every((t) => t.startsWith('Sample:'))).toBe(true);
    } finally {
      await db.$disconnect();
    }
    // The owner's database was not touched.
    expect(sha(ownerDb)).toBe(ownerHash);
  }, 120_000);

  it('never overwrites a file that appears after the checks (exclusive create)', async () => {
    const target = resolveSeedTarget(path.join(root, 'race.db'), env(), paths());
    fs.writeFileSync(target, 'appeared in the meantime');
    await expect(seedNewDatabase(target, { prismaBin, schemaPath })).rejects.toBeInstanceOf(SeedRefusedError);
    expect(fs.readFileSync(target, 'utf8')).toBe('appeared in the meantime');
  });

  it('the command line refuses the configured database and reports why', async () => {
    const lines: string[] = [];
    const code = await runSeedCli(['--database', ownerDb], env(), { ...paths(), prismaBin, schemaPath }, {
      log: (l) => lines.push(l),
      error: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/already exists|configured/);
    // The plain-path form (what npm forwards) is refused the same way.
    lines.length = 0;
    expect(await runSeedCli([ownerDb], env(), { ...paths(), prismaBin, schemaPath }, { log: (l) => lines.push(l), error: (l) => lines.push(l) })).toBe(1);
    expect(lines.join('\n')).toMatch(/already exists|configured/);
    // No target at all is refused too.
    lines.length = 0;
    expect(await runSeedCli([], env(), { ...paths(), prismaBin, schemaPath }, { log: (l) => lines.push(l), error: (l) => lines.push(l) })).toBe(1);
    expect(lines.join('\n')).toMatch(/--database/);
  });
});
