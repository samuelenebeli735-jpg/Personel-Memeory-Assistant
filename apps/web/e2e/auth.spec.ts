import { expect, test, type Browser } from '@playwright/test';

import { readE2eEnv, sessionCookieHeader, signedInContext } from './helpers';

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

test('logout clears the owner session and revokes it on the server', async ({ browser }) => {
  // Its own session: signing out revokes it, so the shared one must not be used.
  const context = await signedInContext(browser);
  const page = await context.newPage();
  const copy = await sessionCookieHeader(context);
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Recall Home' })).toBeVisible();

  await page.getByRole('button', { name: 'Logout' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();

  const cookies = await context.cookies();
  expect(cookies.filter((cookie) => cookie.name === 'recall_session')).toEqual([]);

  // A copy of the signed-out cookie no longer works (R3-03).
  const replay = await page.request.get('/api/settings', { headers: { cookie: copy } });
  expect(replay.status()).toBe(401);

  await context.close();
});
