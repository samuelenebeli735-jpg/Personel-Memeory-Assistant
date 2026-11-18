import { expect, test } from '@playwright/test';

import { uniqueLabel } from './helpers';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('a capture is saved, appears in the recent list and opens from its detail link', async ({ page }) => {
  const rawText = `Remember to buy ${uniqueLabel('e2e-coffee')} before Monday`;
  await page.goto('/capture');

  const input = page.getByLabel("What's on your mind?");
  await expect(input).toBeVisible();
  await input.fill(rawText);

  await page.getByRole('button', { name: 'Save Capture' }).click();
  await expect(page.getByText('Capture saved')).toBeVisible();

  const recentRow = page.getByRole('link', { name: new RegExp(escapeRegExp(rawText)) });
  await expect(recentRow).toBeVisible();
  await recentRow.click();

  await expect(page).toHaveURL(/\/captures\/[^/]+$/);
  await expect(page.getByRole('heading', { name: rawText, exact: true })).toBeVisible();
  await expect(page.getByText('Captured text')).toBeVisible();
  await expect(page.getByText(rawText).first()).toBeVisible();
});
