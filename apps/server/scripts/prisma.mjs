// Prisma CLI wrapper.
//
// `npm --workspace @recall/server run db:*` executes with cwd = apps/server, but
// the single source of environment variables is the repository-root `.env`.
// Prisma only auto-loads `.env` from its own cwd, so this wrapper loads the root
// file explicitly and then delegates to the local Prisma CLI.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const repoRoot = path.resolve(serverRoot, '../..');

for (const file of [path.join(repoRoot, '.env'), path.join(serverRoot, '.env')]) {
  dotenv.config({ path: file, override: false, quiet: true });
}

const prismaBin = path.join(repoRoot, 'node_modules', 'prisma', 'build', 'index.js');
const args = process.argv.slice(2);

const result = spawnSync(process.execPath, [prismaBin, ...args], {
  stdio: 'inherit',
  cwd: serverRoot,
  env: process.env,
});

process.exit(result.status ?? 1);
