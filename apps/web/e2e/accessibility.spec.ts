import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

import { readE2eEnv } from './helpers';

/** Runs axe against the live DOM and reports every violation it finds. */
async function expectNoAxeViolations(page: Page) {
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

test('the login page has no detectable WCAG 2.0/2.1 A or AA violations (light mode)', async ({ page, browser }) => {
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'UTC' });
  const loginPage = await context.newPage();

  await loginPage.goto('/login');
  await expect(loginPage.getByRole('button', { name: 'Sign In' })).toBeVisible();

  await expectNoAxeViolations(loginPage);

  await context.close();
  expect(readE2eEnv().password.length).toBeGreaterThan(0);
});

test('authenticated pages have no detectable WCAG 2.0/2.1 A or AA violations (light mode)', async ({ page }) => {
  for (const route of ['/', '/capture', '/tasks', '/reminders', '/search', '/settings']) {
    await page.goto(route);
    await page.waitForLoadState('networkidle');
    await expectNoAxeViolations(page);
  }
});

test('the login page has no detectable WCAG 2.0/2.1 A or AA violations (dark mode)', async ({ page, browser }) => {
  const context = await browser.newContext({
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'dark',
  });
  const loginPage = await context.newPage();

  await loginPage.goto('/login');
  await expect(loginPage.getByRole('button', { name: 'Sign In' })).toBeVisible();

  await expectNoAxeViolations(loginPage);

  await context.close();
  expect(readE2eEnv().password.length).toBeGreaterThan(0);
});

test('authenticated pages have no detectable WCAG 2.0/2.1 A or AA violations (dark mode)', async ({ page }) => {
  // Create a new context with dark color scheme
  const context = await page.context().browser()?.newContext({
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'dark',
    storageState: await page.context().storageState(),
  });
  if (!context) {
    throw new Error('Failed to create dark mode context');
  }
  const darkPage = await context.newPage();

  for (const route of ['/', '/capture', '/tasks', '/reminders', '/search', '/settings']) {
    await darkPage.goto(route);
    await darkPage.waitForLoadState('networkidle');
    await expectNoAxeViolations(darkPage);
  }

  await context.close();
});
