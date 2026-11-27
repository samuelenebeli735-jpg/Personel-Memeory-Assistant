/**
 * `npm run db:seed -- <new file>` (or `--database <new file>` when run directly)
 *
 * Creates a NEW disposable database with fictional sample records. It never
 * writes to an existing file, `dev.db` or the configured DATABASE_URL, and it
 * refuses NODE_ENV=production. See src/dev/seed.ts for every rule.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

import { runSeedCli } from '../src/dev/seed.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const repoRoot = path.resolve(serverRoot, '../..');

// Load the configured DATABASE_URL the same way the app does, so the seed can
// recognise (and refuse) it.
for (const file of [path.join(repoRoot, '.env'), path.join(serverRoot, '.env')]) {
  dotenv.config({ path: file, override: false, quiet: true });
}

process.exitCode = await runSeedCli(process.argv.slice(2), process.env, {
  prismaDir: here,
  cwd: process.env.INIT_CWD ?? process.cwd(),
  prismaBin: path.join(repoRoot, 'node_modules', 'prisma', 'build', 'index.js'),
  schemaPath: path.join(here, 'schema.prisma'),
});
