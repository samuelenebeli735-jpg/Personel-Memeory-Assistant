/**
 * Shared helpers for the browser E2E suite.
 *
 * The generated credentials are read from the git-ignored `.tmp/e2e-env.json`
 * file created by `prepare.mjs`. They are passed to the page and server only;
 * nothing in this file logs them.
 */
import fs from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
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
