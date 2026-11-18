/**
 * Prepares a disposable database and random per-run credentials for the
 * browser E2E suite.
 *
 * Nothing here reads or writes the developer's real database or .env. The
 * generated values live only in the git-ignored `apps/web/e2e/.tmp` directory
 * and are never printed.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const tmpDir = path.join(here, '.tmp');
const dbPath = path.join(tmpDir, 'recall-e2e.db');
const envPath = path.join(tmpDir, 'e2e-env.json');

await fs.mkdir(tmpDir, { recursive: true });

for (const suffix of ['', '-journal', '-wal', '-shm']) {
  await fs.rm(`${dbPath}${suffix}`, { force: true });
}

const password = `e2e-${crypto.randomBytes(18).toString('base64url')}`;
const sessionSecret = crypto.randomBytes(48).toString('base64url');
// Prisma's SQLite URL accepts a forward-slash absolute path on Windows.
const databaseUrl = `file:${dbPath.replaceAll('\\', '/')}`;

await fs.writeFile(
  envPath,
  JSON.stringify({ password, sessionSecret, databaseUrl, databasePath: dbPath }, null, 2),
  { encoding: 'utf8', mode: 0o600 },
);

const result = spawnSync(
  process.execPath,
  [path.join(repoRoot, 'node_modules', 'prisma', 'build', 'index.js'), 'migrate', 'deploy', '--schema', path.join('apps', 'server', 'prisma', 'schema.prisma')],
  {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      DASHBOARD_PASSWORD: password,
      SESSION_SECRET: sessionSecret,
      TELEGRAM_ENABLED: 'false',
      AI_PROVIDER: 'none',
      STT_PROVIDER: 'none',
      COOKIE_SECURE: 'false',
      DEFAULT_TIME_ZONE: 'UTC',
      LOG_LEVEL: 'warn',
    },
    stdio: 'inherit',
  },
);

if (result.error) {
  console.error(`Failed to start Prisma migrate: ${result.error.message}`);
  process.exit(1);
}

if (result.status !== 0) {
  console.error(`Prisma migrate deploy failed with exit code ${result.status ?? 'unknown'}.`);
  process.exit(result.status ?? 1);
}

// The browser suite runs against the production bundle. Vite's dev server
// transforms modules on demand, and a cold first load can consume most of a
// test's timeout before the login form is even interactive.
const buildSteps = [
  {
    label: 'dashboard typecheck',
    cwd: repoRoot,
    script: path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    args: ['-p', path.join('apps', 'web', 'tsconfig.json'), '--noEmit'],
  },
  {
    label: 'dashboard build',
    cwd: path.join(repoRoot, 'apps', 'web'),
    script: path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js'),
    args: ['build'],
  },
];

for (const step of buildSteps) {
  const build = spawnSync(process.execPath, [step.script, ...step.args], {
    cwd: step.cwd,
    env: process.env,
    stdio: 'inherit',
  });

  if (build.error) {
    console.error(`Failed to start ${step.label}: ${build.error.message}`);
    process.exit(1);
  }

  if (build.status !== 0) {
    console.error(`${step.label} failed with exit code ${build.status ?? 'unknown'}.`);
    process.exit(build.status ?? 1);
  }
}

console.log(`Prepared disposable E2E database at ${path.relative(repoRoot, dbPath)}.`);
