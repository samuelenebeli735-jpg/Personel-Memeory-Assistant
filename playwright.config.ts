/**
 * Browser E2E configuration.
 *
 * The suite runs against the real Vite dashboard and the real Fastify server,
 * with SQLite and authentication isolated from the developer's own database.
 * Microsoft Edge is used through Playwright's `msedge` channel, so no separate
 * Chromium download is required on this machine.
 */
import { defineConfig } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const envPath = path.resolve('apps/web/e2e/.tmp/e2e-env.json');
if (!fs.existsSync(envPath)) {
  throw new Error(
    'Missing apps/web/e2e/.tmp/e2e-env.json. Run "npm run test:e2e" instead of invoking Playwright directly.',
  );
}

const e2eEnv = JSON.parse(fs.readFileSync(envPath, 'utf8')) as {
  password: string;
  sessionSecret: string;
  databaseUrl: string;
};

function childProcessEnv(): Record<string, string> {
  const entries = Object.entries(process.env).filter((entry): entry is [string, string] => {
    return entry[1] !== undefined;
  });
  return Object.fromEntries(entries);
}

const inheritedEnv = childProcessEnv();

const serverEnv: Record<string, string> = {
  ...inheritedEnv,
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: '4000',
  DATABASE_URL: e2eEnv.databaseUrl,
  DASHBOARD_PASSWORD: e2eEnv.password,
  SESSION_SECRET: e2eEnv.sessionSecret,
  TELEGRAM_ENABLED: 'false',
  AI_PROVIDER: 'none',
  STT_PROVIDER: 'none',
  COOKIE_SECURE: 'false',
  DEFAULT_TIME_ZONE: 'UTC',
  BRIEFING_ENABLED: 'false',
  LOG_LEVEL: 'warn',
  LOG_MESSAGE_CONTENT: 'false',
  // Every browser request comes from 127.0.0.1, so a fast machine can exceed the
  // production limit of 240 requests per minute from one address. This raises
  // the global limit for this test server only; the server refuses the setting
  // unless NODE_ENV=test. Login keeps its own limit of 10 per minute.
  RECALL_TEST_RATE_LIMIT_PER_MINUTE: '5000',
};

export default defineConfig({
  testDir: './apps/web/e2e',
  outputDir: './test-results/playwright',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: './test-results/playwright-report', open: 'never' }],
  ],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    channel: 'msedge',
    headless: true,
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'UTC',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 10_000,
  },
  webServer: [
    {
      command: 'npm run dev --workspace @recall/server',
      url: 'http://127.0.0.1:4000/api/health/live',
      timeout: 120_000,
      reuseExistingServer: false,
      stdout: 'ignore',
      stderr: 'pipe',
      env: serverEnv,
    },
    {
      command: 'npm run preview --workspace @recall/web -- --host 127.0.0.1 --port 5173 --strictPort',
      url: 'http://127.0.0.1:5173',
      timeout: 120_000,
      reuseExistingServer: false,
      stdout: 'ignore',
      stderr: 'pipe',
      env: inheritedEnv,
    },
  ],
  projects: [
    {
      name: 'setup',
      testMatch: /auth-setup\.ts/,
    },
    {
      name: 'edge',
      testMatch: /.*\.spec\.ts/,
      dependencies: ['setup'],
      use: { storageState: path.resolve('apps/web/e2e/.tmp/auth-state.json') },
    },
  ],
});
