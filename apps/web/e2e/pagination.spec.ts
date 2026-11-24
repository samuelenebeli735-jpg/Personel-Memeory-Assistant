import { expect, test, type Page } from '@playwright/test';

import { uniqueLabel } from './helpers';

/**
 * R2-05: every list pages at 25 with an accurate total; the page lives in the
 * URL (refresh and Back keep it); filters return to page 1; a page past the
 * end clamps to the last page and says so.
 */

async function seedIdeas(page: Page, prefix: string, count: number): Promise<void> {
  for (let start = 0; start < count; start += 10) {
    await Promise.all(
      Array.from({ length: Math.min(10, count - start) }, (_, i) =>
        page.request
          .post('/api/ideas', { data: { title: `${prefix} ${String(start + i).padStart(2, '0')}` } })
          .then((response) => expect(response.status()).toBe(201)),
      ),
    );
  }
}

async function ideaTotal(page: Page): Promise<number> {
  const response = await page.request.get('/api/ideas?limit=1');
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { total: number }).total;
}

const rowTitles = (page: Page) => page.locator('.list .list-item .list-item-title').allInnerTexts();

test('ideas page through 60+ records without repeating or losing one', async ({ page }) => {
  const prefix = uniqueLabel('e2e-page');
  await seedIdeas(page, prefix, 62);
  const total = await ideaTotal(page);
  const pages = Math.ceil(total / 25);

  await page.goto('/ideas');
  const pager = page.getByRole('navigation', { name: 'Pagination' });
  await expect(pager).toContainText(`1–25 of ${total}`);
  await expect(pager.getByRole('button', { name: 'Page 1' })).toHaveAttribute('aria-current', 'page');
  await expect(pager.getByRole('button', { name: 'Previous page' })).toBeDisabled();

  const seen: string[] = [];
  for (let p = 1; p <= pages; p += 1) {
    if (p > 1) {
      await pager.getByRole('button', { name: 'Next page' }).click();
      await expect(page).toHaveURL(new RegExp(`[?&]page=${p}(&|$)`));
      await expect(pager.getByRole('button', { name: `Page ${p}` })).toHaveAttribute('aria-current', 'page');
      // Focus moves to the list heading after a page change.
      await expect(page.getByRole('heading', { name: 'Ideas', exact: true })).toBeFocused();
    }
    await expect(page.locator('.list .list-item').first()).toBeVisible();
    seen.push(...(await rowTitles(page)));
  }
  expect(new Set(seen).size).toBe(seen.length);
  expect(seen.length).toBe(total);
  const mine = seen.filter((title) => title.startsWith(prefix));
  expect(mine).toHaveLength(62);
  await expect(pager.getByRole('button', { name: 'Next page' })).toBeDisabled();
});

test('the page survives refresh and Back, and a missing page clamps to the last one', async ({ page }) => {
  await seedIdeas(page, uniqueLabel('e2e-page-url'), 30);
  const total = await ideaTotal(page);
  const last = Math.ceil(total / 25);

  await page.goto('/ideas?page=2');
  const pager = page.getByRole('navigation', { name: 'Pagination' });
  await expect(pager).toContainText(`26–${Math.min(50, total)} of ${total}`);
  const pageTwo = await rowTitles(page);

  await page.reload();
  await expect(pager).toContainText(`26–${Math.min(50, total)} of ${total}`);
  expect(await rowTitles(page)).toEqual(pageTwo);

  await pager.getByRole('button', { name: 'Page 1' }).click();
  await expect(page).not.toHaveURL(/page=/);
  await page.goBack();
  await expect(page).toHaveURL(/page=2/);
  await expect(pager).toContainText(`26–${Math.min(50, total)} of ${total}`);

  await page.goto('/ideas?page=999');
  await expect(page).toHaveURL(new RegExp(`page=${last}(&|$)`));
  await expect(page.getByText(`Page 999 no longer exists, so you’re now on page ${last}.`)).toBeVisible();
});

test('changing a filter returns to page 1', async ({ page }) => {
  await page.goto('/tasks?status=PENDING&page=3');
  await expect(page.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible();
  await page.getByRole('group', { name: 'Filter by status' }).getByRole('button', { name: 'Completed' }).click();
  await expect(page).toHaveURL(/status=COMPLETED/);
  await expect(page).not.toHaveURL(/page=/);
  await expect(
    page.getByRole('group', { name: 'Filter by status' }).getByRole('button', { name: 'Completed' }),
  ).toHaveAttribute('aria-pressed', 'true');
});

test('search results page through the URL', async ({ page }) => {
  const prefix = uniqueLabel('e2e-searchpage');
  await seedIdeas(page, prefix, 30);

  await page.goto('/search');
  await page.getByLabel('Search').fill(prefix);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Results (30)' })).toBeVisible();
  const pager = page.getByRole('navigation', { name: 'Pagination' });
  await expect(pager).toContainText('1–25 of 30');

  await pager.getByRole('button', { name: 'Next page' }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(pager).toContainText('26–30 of 30');
  await expect(page.locator('.list .list-item')).toHaveCount(5);

  // A shared or refreshed link runs the same search on the same page.
  await page.reload();
  await expect(page.getByLabel('Search')).toHaveValue(prefix);
  await expect(pager).toContainText('26–30 of 30');
});

test('the pager becomes Previous / Page n of m / Next on a phone', async ({ page }) => {
  await seedIdeas(page, uniqueLabel('e2e-page-phone'), 26);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/ideas');
  const pager = page.getByRole('navigation', { name: 'Pagination' });
  await expect(pager.getByRole('button', { name: 'Next', exact: true })).toBeVisible();
  await expect(pager.getByRole('button', { name: 'Page 1' })).toBeHidden();
  await expect(pager).toContainText(/Page 1 of \d+/);
  await pager.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page).toHaveURL(/page=2/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
