import { expect, test } from '@playwright/test';

import { readE2eEnv, uniqueLabel } from './helpers';

/**
 * R2-07 and refinement 5: forms show field and server errors and keep what
 * was typed; a 429 says how long to wait and never signs out; only a 401
 * signs out; offline pauses writes; new pages reflow at 320 px.
 */

test('a 400 with field details lands on the field and keeps the text', async ({ page }) => {
  await page.route('**/api/tasks', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid task',
              details: { issues: [{ path: 'title', message: 'Title is too long for the server' }] },
            },
          }),
        })
      : route.continue(),
  );
  await page.goto('/tasks');
  await page.getByRole('button', { name: 'New Task' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create Task' });
  const title = uniqueLabel('e2e-400');
  await dialog.getByLabel('Title').fill(title);
  await dialog.getByRole('button', { name: 'Create Task' }).click();
  await expect(dialog.getByLabel('Title')).toHaveAttribute('aria-invalid', 'true');
  await expect(dialog.locator('.form-error', { hasText: 'Title is too long for the server' })).toBeVisible();
  await expect(dialog.getByLabel('Title')).toHaveValue(title);
  await expect(dialog.getByLabel('Title')).toBeFocused();
  await page.unroute('**/api/tasks');
});

test('a 429 on save shows the wait, keeps the form and does not sign out', async ({ page }) => {
  await page.route('**/api/notes', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 429,
          headers: { 'retry-after': '21', 'content-type': 'application/json' },
          body: JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down' } }),
        })
      : route.continue(),
  );
  await page.goto('/notes');
  await page.getByRole('button', { name: 'New Note' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create Note' });
  await dialog.getByLabel('Body').fill('Keep this text');
  await dialog.getByRole('button', { name: 'Create Note' }).click();
  await expect(page.locator('.toast-warning', { hasText: 'Try again in 21 s.' })).toHaveAttribute('role', 'alert');
  await expect(dialog.getByLabel('Body')).toHaveValue('Keep this text');
  await expect(page).toHaveURL('/notes');
  await page.unroute('**/api/notes');
});

test('a rate-limited session check at start-up retries, then offers Retry instead of the login page', async ({ page }) => {
  let sessionCalls = 0;
  await page.route('**/api/auth/session', (route) => {
    sessionCalls += 1;
    return route.fulfill({
      status: 429,
      headers: { 'retry-after': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Too many requests' } }),
    });
  });
  await page.goto('/tasks');
  // 1 attempt + 3 retries waiting 1 s, 2 s and 4 s.
  await expect(page.getByRole('heading', { name: 'Can’t reach Recall' })).toBeVisible({ timeout: 20_000 });
  expect(sessionCalls).toBe(4);
  await expect(page).toHaveURL('/tasks');
  await expect(page.getByRole('button', { name: 'Sign In' })).toHaveCount(0);

  await page.unroute('**/api/auth/session');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible();
});

test('a 401 while working tells the owner first, then returns them to the page after signing in', async ({ page }) => {
  await page.goto('/notes');
  await expect(page.getByRole('heading', { name: 'Notes', exact: true })).toBeVisible();
  await page.route('**/api/notes', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Your session has expired' } }),
        })
      : route.continue(),
  );
  await page.getByRole('button', { name: 'New Note' }).click();
  await page.getByRole('dialog', { name: 'Create Note' }).getByLabel('Body').fill('Unsaved words');
  await page.getByRole('dialog', { name: 'Create Note' }).getByRole('button', { name: 'Create Note' }).click();
  const notice = page.getByRole('alertdialog', { name: 'You’ve been signed out' });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('copy it first');
  // The page and its text are still there underneath.
  await expect(page.getByRole('dialog', { name: 'Create Note' }).getByLabel('Body')).toHaveValue('Unsaved words');
  await page.unroute('**/api/notes');
  await notice.getByRole('button', { name: 'Sign in again' }).click();
  await expect(page).toHaveURL('/login');
  await page.getByLabel('Password').fill(readE2eEnv().password);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/notes');
});

test('offline pauses saving and says so', async ({ page, context }) => {
  await page.goto('/tasks');
  await expect(page.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByText('You’re offline.')).toBeVisible();
  await page.getByRole('button', { name: 'New Task' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create Task' });
  await expect(dialog.getByRole('button', { name: 'Create Task' })).toBeDisabled();
  await expect(dialog.getByText('Offline: saving is paused.')).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByText('You’re offline.')).toBeHidden();
  await expect(dialog.getByRole('button', { name: 'Create Task' })).toBeEnabled();
});

test('the new pages reflow at 320 px without horizontal scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  for (const route of ['/briefing', '/ask', '/inbox', '/tasks', '/settings/data']) {
    await page.goto(route);
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${route} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(0);
  }
});
