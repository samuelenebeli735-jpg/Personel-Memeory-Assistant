import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

import { uniqueLabel } from './helpers';

/**
 * Structural checks on the accessibility tree that a screen reader reads
 * (landmarks, one h1, heading order, named regions). This is an automated
 * proxy, not a screen-reader test: a manual NVDA + Edge pass is still needed.
 *
 * Set A11Y_TREE_DIR to also write each screen's accessibility tree to that
 * directory for manual review.
 */

async function checkStructure(page: Page, label: string) {
  await expect(page.getByRole('main')).toHaveCount(1);
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toHaveCount(1);
  await expect(page.getByRole('banner')).toHaveCount(1);
  await expect(page.getByRole('region', { name: 'Notifications' })).toHaveCount(1);
  const h1 = page.getByRole('heading', { level: 1 });
  await expect(h1).toHaveCount(1);
  expect((await h1.innerText()).trim().length).toBeGreaterThan(0);

  // Heading levels never skip on the way down (h1 → h3 without an h2).
  const levels = await page.locator('main').evaluate((main) =>
    Array.from(main.querySelectorAll('h1, h2, h3, h4, h5, h6'))
      .filter((h) => (h as HTMLElement).offsetParent !== null)
      .map((h) => Number(h.tagName.slice(1))),
  );
  for (let i = 1; i < levels.length; i += 1) {
    expect(levels[i]! - levels[i - 1]!, `${label}: heading levels ${levels.join(',')}`).toBeLessThanOrEqual(1);
  }

  const dir = process.env.A11Y_TREE_DIR;
  if (dir) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${label}.yml`), await page.locator('body').ariaSnapshot());
  }
}

test('Round 2 screens have one main landmark, a labelled navigation and an orderly heading outline', async ({ page }) => {
  // One capture that needs review, so the inbox has a detail pane to read.
  await page.request.post('/api/captures', {
    data: { rawText: `${uniqueLabel('e2e-a11y')} is this for Friday or Monday?`, source: 'WEB' },
  });

  await page.goto('/briefing');
  await expect(page.getByText('Sections and their order come from')).toBeVisible();
  await checkStructure(page, 'today');

  await page.goto('/ask');
  await page.getByRole('button', { name: 'What do I have tomorrow?' }).click();
  await expect(page.locator('.ask-answer')).toBeVisible();
  await checkStructure(page, 'ask-answer');

  await page.goto('/inbox');
  await page.locator('.inbox-row').first().click();
  await expect(page.getByRole('region', { name: 'Selected capture' })).toBeVisible();
  await checkStructure(page, 'inbox-detail');
  await page.getByRole('button', { name: 'Delete permanently…' }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  const dir = process.env.A11Y_TREE_DIR;
  if (dir) await fs.writeFile(path.join(dir, 'inbox-purge-dialog.yml'), await page.getByRole('alertdialog').ariaSnapshot());
  await page.keyboard.press('Escape');

  await page.goto('/tasks');
  await expect(page.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible();
  await checkStructure(page, 'tasks');
  await page.getByRole('button', { name: 'New Task' }).click();
  await page.getByRole('dialog', { name: 'Create Task' }).getByRole('button', { name: 'Create Task' }).click();
  if (dir) await fs.writeFile(path.join(dir, 'task-form-errors.yml'), await page.getByRole('dialog').ariaSnapshot());
  await page.keyboard.press('Escape');

  await page.goto('/settings/data');
  await checkStructure(page, 'your-data');
});

test('the new screens reflow at 200% zoom (640 CSS px wide)', async ({ page }) => {
  // A 1280 px window at 200% zoom lays out like a 640 px one.
  await page.setViewportSize({ width: 640, height: 450 });
  for (const route of ['/briefing', '/ask', '/inbox', '/tasks', '/search', '/settings/data']) {
    await page.goto(route);
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${route} scrolls sideways by ${overflow}px at 200%`).toBeLessThanOrEqual(0);
  }
});
