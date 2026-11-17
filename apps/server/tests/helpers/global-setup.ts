/**
 * Vitest global setup.
 *
 * Builds a *template* SQLite database once by running the real Prisma
 * migrations. Individual test files copy that file, which keeps tests fast while
 * still exercising the actual, versioned migrations.
 *
 * The template is built under a fresh, unique name for every run and published
 * through a pointer file. A fixed name would have to be deleted before the
 * build, and on Windows a file that is still open cannot be deleted — the
 * build would then fail (or, worse, the copy would pick up a half-migrated
 * file and every test would fail with a confusing "table does not exist").
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEMPLATE_DIR = path.join(os.tmpdir(), 'recall-tests');
/** Points at the template built by the current run. */
export const TEMPLATE_POINTER = path.join(TEMPLATE_DIR, 'template.json');

interface TemplatePointer {
  path: string;
  builtAt: string;
}

/** Reads the template path published by the global setup. */
export function readTemplatePointer(): TemplatePointer | null {
  try {
    const raw = fs.readFileSync(TEMPLATE_POINTER, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { path?: unknown }).path === 'string'
    ) {
      const pointer = parsed as TemplatePointer;
      if (fs.existsSync(pointer.path)) return pointer;
    }
  } catch {
    /* No template yet: the caller reports it. */
  }
  return null;
}

export default function globalSetup(): void {
  const helperDir = path.dirname(fileURLToPath(import.meta.url));
  const serverRoot = path.resolve(helperDir, '../..');
  const repoRoot = path.resolve(serverRoot, '../..');
  const prismaBin = path.join(repoRoot, 'node_modules', 'prisma', 'build', 'index.js');

  if (!fs.existsSync(prismaBin)) {
    throw new Error(`Prisma CLI not found at ${prismaBin}. Run \`npm install\` first.`);
  }

  fs.mkdirSync(TEMPLATE_DIR, { recursive: true });

  const buildPath = path.join(
    TEMPLATE_DIR,
    `template-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`,
  );
  // A relative `file:` URL is resolved against the schema folder, so the path
  // is made absolute with forward slashes (Windows rejects backslashes here).
  const url = `file:${buildPath.replace(/\\/g, '/')}`;

  execFileSync(process.execPath, [prismaBin, 'migrate', 'deploy'], {
    cwd: serverRoot,
    env: {
      ...process.env,
      DATABASE_URL: url,
      NODE_ENV: 'test',
      CHECKPOINT_DISABLE: '1',
      PRISMA_HIDE_UPDATE_MESSAGE: '1',
    },
    stdio: 'pipe',
  });

  // The migrations may write to a WAL side file; fold it into the main file so
  // a plain copy of the template is complete.
  try {
    execFileSync(process.execPath, [prismaBin, 'db', 'execute', '--url', url, '--stdin'], {
      cwd: serverRoot,
      env: {
        ...process.env,
        DATABASE_URL: url,
        NODE_ENV: 'test',
        CHECKPOINT_DISABLE: '1',
        PRISMA_HIDE_UPDATE_MESSAGE: '1',
      },
      input: 'PRAGMA wal_checkpoint(TRUNCATE);',
      stdio: 'pipe',
    });
  } catch {
    /* Checkpointing is a nicety; a missing side file is not fatal. */
  }

  if (!fs.existsSync(buildPath)) {
    throw new Error(`The migration template was not created at ${buildPath}.`);
  }

  const pointer: TemplatePointer = { path: buildPath, builtAt: new Date().toISOString() };
  fs.writeFileSync(TEMPLATE_POINTER, JSON.stringify(pointer), 'utf8');

  // eslint-disable-next-line no-console
  console.log(`[test-setup] migration template ready at ${buildPath}`);
}
