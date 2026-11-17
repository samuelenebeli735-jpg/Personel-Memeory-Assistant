import { defineConfig } from 'vitest/config';

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
