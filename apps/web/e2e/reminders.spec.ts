import { expect, test } from '@playwright/test';

import { uniqueLabel } from './helpers';

test('a reminder is created, listed, opened from its detail page and snoozed', async ({ page }) => {
  const title = uniqueLabel('e2e-reminder');
  await page.goto('/reminders');

  await page.getByRole('button', { name: 'New Reminder' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create Reminder' });
  await expect(dialog).toBeVisible();

  await dialog.getByLabel('Title').fill(title);
  await dialog.getByLabel('Body (optional)').fill('Browser E2E reminder.');
  await dialog.getByLabel('Remind At').fill('2032-01-15T09:30');

  await dialog.getByRole('button', { name: 'Create Reminder' }).click();
  await expect(page.getByText('Reminder created')).toBeVisible();

  const row = page.locator('.list-item', { hasText: title });
  await expect(row).toBeVisible();
  await expect(row).toContainText('SCHEDULED');

  await row.getByRole('link').click();
  await expect(page).toHaveURL(/\/reminders\/[^/]+$/);
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(page.getByText('Browser E2E reminder.')).toBeVisible();
  await expect(page.getByText('SCHEDULED')).toBeVisible();

  await page.getByRole('link', { name: 'Reminders', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Reminders', exact: true })).toBeVisible();

  const rowAfterDetail = page.locator('.list-item', { hasText: title });
  await expect(rowAfterDetail).toBeVisible();
  await rowAfterDetail.getByRole('button', { name: 'Snooze' }).click();

  const snoozeDialog = page.getByRole('dialog', { name: 'Snooze Reminder' });
  await expect(snoozeDialog).toBeVisible();
  await snoozeDialog.getByLabel('Snooze for').selectOption('1h');
  await snoozeDialog.getByRole('button', { name: 'Snooze' }).click();

  await expect(page.getByText('Reminder snoozed')).toBeVisible();
});
