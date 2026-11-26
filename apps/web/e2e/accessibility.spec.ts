import { expect, test } from '@playwright/test';

import { expectNoAxeViolations, readE2eEnv } from './helpers';

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
  for (const route of ['/', '/capture', '/tasks', '/reminders', '/search', '/settings', '/briefing', '/ask', '/inbox', '/settings/data', '/notes', '/ideas', '/events', '/projects']) {
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

  for (const route of ['/', '/capture', '/tasks', '/reminders', '/search', '/settings', '/briefing', '/ask', '/inbox', '/settings/data', '/notes', '/ideas', '/events', '/projects']) {
    await darkPage.goto(route);
    await darkPage.waitForLoadState('networkidle');
    await expectNoAxeViolations(darkPage);
  }

  await context.close();
});
