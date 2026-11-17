import { expect, test } from '@playwright/test';

import { uniqueLabel } from './helpers';

test('a task can be found through the dashboard search and opened from the result', async ({ page }) => {
  const title = uniqueLabel('e2e-search');
  await page.goto('/tasks');

  await page.getByRole('button', { name: 'New Task' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create Task' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Title').fill(title);
  await dialog.getByRole('button', { name: 'Create Task' }).click();
  await expect(page.getByText('Task created')).toBeVisible();

  await page.getByRole('link', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Search', exact: true })).toBeVisible();

  await page.getByLabel('Search').fill(title);
  await page.getByRole('button', { name: 'Search' }).click();

  const result = page.locator('.list-item', { hasText: title });
  await expect(result).toBeVisible();
  await result.click();

  await expect(page).toHaveURL(/\/tasks\/[^/]+$/);
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
});
