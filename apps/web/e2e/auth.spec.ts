import { expect, test, type Browser } from '@playwright/test';

import { readE2eEnv } from './helpers';

/** A context that deliberately has no saved session. */
async function unauthenticatedContext(browser: Browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'UTC',
    storageState: { cookies: [], origins: [] },
  });
  await context.clearCookies();
  return context;
}

test('an unauthenticated visit is redirected to /login', async ({ browser }) => {
  const context = await unauthenticatedContext(browser);
  const page = await context.newPage();

  await page.goto('/tasks');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();

  await context.close();
});

test('an incorrect password does not create a session', async ({ browser }) => {
  const context = await unauthenticatedContext(browser);
  const page = await context.newPage();
  const { password } = readE2eEnv();

  await page.goto('/login');
  await page.getByLabel('Password').fill(`${password}-wrong`);
  await page.getByRole('button', { name: 'Sign In' }).click();

  await expect(page.getByText('Incorrect password').first()).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);

  const cookies = await context.cookies();
  expect(cookies.filter((cookie) => cookie.name === 'recall_session')).toEqual([]);

  await context.close();
});

test('logout clears the owner session', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Recall Home' })).toBeVisible();

  await page.getByRole('button', { name: 'Logout' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();

  const cookies = await context.cookies();
  expect(cookies.filter((cookie) => cookie.name === 'recall_session')).toEqual([]);
});
