import { defineConfig } from 'vitest/config';

/**
 * The host machine's time zone is pinned for every test run.
 *
 * Recall must interpret dates in the owner's configured zone, never the
 * host's. A developer machine that happens to share the owner's zone (e.g. a
 * laptop in Africa/Lagos) hides host-zone bugs completely, so the suite runs
 * in a zone no test uses as an owner zone: Pacific/Kiritimati (UTC+14, no
 * DST). Override with RECALL_TEST_HOST_TZ, e.g. `RECALL_TEST_HOST_TZ=UTC` to
 * match the production container. Set here, before workers start, so every
 * forked worker inherits it.
 */
process.env.TZ = process.env.RECALL_TEST_HOST_TZ ?? 'Pacific/Kiritimati';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/helpers/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // SQLite/Prisma integration tests are I/O-heavy. On Windows the default
    // worker count caused setup-hook timeouts under load; two workers keeps the
    // full suite reliable without changing any assertions.
    ...(process.platform === 'win32' ? { maxWorkers: 2 } : {}),
    // SQLite files are per-test-file, so parallel workers stay independent.
    isolate: true,
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
    },
  },
});
