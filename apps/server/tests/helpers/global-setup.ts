/**
 * Vitest global setup.
 *
 * Builds a *template* SQLite database once by running the real Prisma
 * migrations. Individual test files copy that file, which keeps tests fast while
 * still exercising the actual, versioned migrations.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEMPLATE_DIR = path.join(os.tmpdir(), 'recall-tests');
export const TEMPLATE_DB = path.join(TEMPLATE_DIR, 'template.db');

export default function globalSetup(): void {
  const helperDir = path.dirname(fileURLToPath(import.meta.url));
  const serverRoot = path.resolve(helperDir, '../..');
  const repoRoot = path.resolve(serverRoot, '../..');
  const prismaBin = path.join(repoRoot, 'node_modules', 'prisma', 'build', 'index.js');

  if (!fs.existsSync(prismaBin)) {
    throw new Error(`Prisma CLI not found at ${prismaBin}. Run \`npm install\` first.`);
  }

  fs.mkdirSync(TEMPLATE_DIR, { recursive: true });
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const file = `${TEMPLATE_DB}${suffix}`;
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  }

  execFileSync(process.execPath, [prismaBin, 'migrate', 'deploy'], {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL: `file:${TEMPLATE_DB}`, NODE_ENV: 'test' },
    stdio: 'pipe',
  });

  // eslint-disable-next-line no-console
  console.log(`[test-setup] migration template ready at ${TEMPLATE_DB}`);
}
