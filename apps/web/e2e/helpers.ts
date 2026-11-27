/**
 * Shared helpers for the browser E2E suite.
 *
 * The generated credentials are read from the git-ignored `.tmp/e2e-env.json`
 * file created by `prepare.mjs`. They are passed to the page and server only;
 * nothing in this file logs them.
 */
import fs from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const tmpDir = path.join(here, '.tmp');

export interface E2eEnv {
  password: string;
  sessionSecret: string;
  databaseUrl: string;
  databasePath: string;
}

export function readE2eEnv(): E2eEnv {
  const file = path.join(tmpDir, 'e2e-env.json');
  if (!fs.existsSync(file)) {
    throw new Error(
      'Missing apps/web/e2e/.tmp/e2e-env.json. Run "npm run test:e2e" instead of invoking Playwright directly.',
    );
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as E2eEnv;
}

export const authStatePath = path.join(tmpDir, 'auth-state.json');

/**
 * A browser context with its own, freshly signed-in session.
 *
 * Signing out revokes the session on the server (R3-03), so a test that signs
 * out must never use the shared session from `auth-setup.ts`: every later test
 * would then carry a revoked cookie.
 */
export async function signedInContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'UTC',
    storageState: { cookies: [], origins: [] },
  });
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByLabel('Password').fill(readE2eEnv().password);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('link', { name: 'Recall Home' })).toBeVisible();
  await page.close();
  return context;
}

/** The session cookie as a `Cookie` header value, to replay a copy of it. */
export async function sessionCookieHeader(context: BrowserContext): Promise<string> {
  const cookie = (await context.cookies()).find((c) => c.name === 'recall_session');
  expect(cookie, 'a session cookie').toBeTruthy();
  return `recall_session=${cookie!.value}`;
}

/** Unique test-data label; retries and reruns never collide in the same list. */
export function uniqueLabel(prefix: string): string {
  const suffix = Math.random().toString(36).slice(2, 7);
  return `${prefix}-${suffix}`;
}

/** Runs axe against the live DOM and reports every violation it finds. */
export async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();

  const report = results.violations
    .map((violation) => {
      const nodes = violation.nodes
        .map((node) => {
          const summary = node.failureSummary ? `\n${node.failureSummary}` : '';
          return `${node.target.join(' ')}${summary}\n${node.html}`;
        })
        .join('\n');
      return `${violation.id} [${violation.impact ?? 'unknown'}] ${violation.help}\n${nodes}`;
    })
    .join('\n---\n');

  expect(report, report).toBe('');
}
