import { expect, test } from '@playwright/test';

import { uniqueLabel } from './helpers';

test('a task is created, shown in the list, updated to in progress and visible on its detail page', async ({ page }) => {
  const title = uniqueLabel('e2e-task');
  await page.goto('/tasks');

  await page.getByRole('button', { name: 'New Task' }).click();
  await expect(page.getByRole('dialog', { name: 'Create Task' })).toBeVisible();

  await page.getByLabel('Title').fill(title);
  await page.getByLabel('Description').fill('Created by the browser E2E suite.');
  await page.getByLabel('Priority').selectOption('HIGH');

  await page.getByRole('button', { name: 'Create Task' }).click();
  await expect(page.getByText('Task created')).toBeVisible();

  const row = page.locator('.list-item', { hasText: title });
  await expect(row).toBeVisible();
  await expect(row).toContainText('PENDING');
  await expect(row).toContainText('HIGH');

  const select = row.getByRole('combobox');
  const [response] = await Promise.all([
    page.waitForResponse((response) =>
      response.request().method() === 'PATCH' && response.url().includes('/api/tasks/'),
    ),
    select.selectOption('IN_PROGRESS'),
  ]);
  expect(response.status()).toBe(200);

  await row.getByRole('link').click();
  await expect(page).toHaveURL(/\/tasks\/[^/]+$/);
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(page.getByText('IN_PROGRESS').first()).toBeVisible();
  await expect(page.getByText('Created by the browser E2E suite.')).toBeVisible();
});
