/**
 * One-time authentication project. It logs into the real dashboard and saves
 * the resulting session cookies for every subsequent browser test.
 */
import { test as setup, expect } from '@playwright/test';

import { authStatePath, readE2eEnv } from './helpers';

setup('authenticate as the owner', async ({ page }) => {
  const { password } = readE2eEnv();

  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Recall' })).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);

  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign In' }).click();

  await expect(page).toHaveURL('/');
  // This proves the authenticated bootstrap and dashboard overview request both
  // succeeded; a broken overview endpoint would leave an error toast instead.
  await expect(page.getByRole('link', { name: 'Recall Home' })).toBeVisible();
  await expect(page.getByText('Open Tasks')).toBeVisible();
  await expect(page.getByText('Failed to load dashboard')).toHaveCount(0);

  await page.context().storageState({ path: authStatePath });
});
