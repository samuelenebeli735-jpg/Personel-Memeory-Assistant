import { expect, test, type Page } from '@playwright/test';

import { expectNoAxeViolations, uniqueLabel } from './helpers';

/**
 * R2-03 Inbox review: convert, Undo inside and outside the 15-minute window,
 * permanent delete with a typed confirmation, the "already edited" refusal
 * with force, J/K, the badge, and the stacked layout on a phone.
 */

/** A question goes to review: the rules classifier never guesses a kind for it. */
async function seedQuestion(page: Page, label: string): Promise<{ id: string; text: string }> {
  const text = `${uniqueLabel(label)} is this for Friday or Monday?`;
  const response = await page.request.post('/api/captures', { data: { rawText: text, source: 'WEB' } });
  expect(response.status(), await response.text()).toBe(201);
  const body = (await response.json()) as { capture: { id: string; status: string } };
  expect(body.capture.status).toBe('NEEDS_REVIEW');
  return { id: body.capture.id, text };
}

const row = (page: Page, text: string) => page.locator('.inbox-row', { hasText: text });

async function openInbox(page: Page) {
  await page.goto('/inbox');
  await expect(page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible();
}

async function inboxTotal(page: Page): Promise<number> {
  return ((await (await page.request.get('/api/captures/inbox?limit=1')).json()) as { total: number }).total;
}

test('keeping a capture as a task removes it from the inbox and counts the badge down', async ({ page }) => {
  const capture = await seedQuestion(page, 'e2e-inbox-keep');
  await openInbox(page);
  const before = await inboxTotal(page);
  await expect(page.locator('#inbox-count-desc')).toHaveText(`${before} ${before === 1 ? 'capture needs' : 'captures need'} a decision`);

  await row(page, capture.text).click();
  const detail = page.getByRole('region', { name: 'Selected capture' });
  await expect(detail.locator('.inbox-raw')).toHaveText(capture.text);
  await expect(detail).toContainText('Recall’s guess: not sure');
  await expect(row(page, capture.text)).toHaveAttribute('aria-current', 'true');

  await detail.getByRole('group', { name: 'Keep as' }).getByRole('button', { name: 'Task', exact: true }).click();
  await expect(page.locator('.toast', { hasText: 'Kept as task' })).toBeVisible();
  await expect(row(page, capture.text)).toHaveCount(0);
  if (before - 1 === 0) {
    // With nothing left to review the badge and its description disappear.
    await expect(page.locator('#inbox-count-desc')).toHaveCount(0);
  } else {
    await expect(page.locator('#inbox-count-desc')).toHaveText(
      `${before - 1} ${before - 1 === 1 ? 'capture needs' : 'captures need'} a decision`,
    );
  }
  await page.getByRole('link', { name: 'Open task' }).click();
  await expect(page).toHaveURL(/\/tasks\/[^/]+$/);
});

test('Undo inside the window is one click; outside it asks and sends force', async ({ page }) => {
  const recent = await seedQuestion(page, 'e2e-inbox-undo');
  const old = await seedQuestion(page, 'e2e-inbox-old');
  await openInbox(page);

  await row(page, recent.text).click();
  const detail = page.getByRole('region', { name: 'Selected capture' });
  const undo = detail.getByRole('button', { name: /^Undo · \d+ min left$/ });
  await expect(undo).toBeVisible();
  await undo.click();
  await expect(page.locator('.toast', { hasText: 'Capture removed' })).toBeVisible();
  await expect(row(page, recent.text)).toHaveCount(0);

  // The server decides the window: a refusal leads to the confirmation.
  const bodies: unknown[] = [];
  await page.route(`**/api/captures/${old.id}/undo`, async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as { force?: boolean };
    bodies.push(body);
    if (!body.force) {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'This capture is older than 15 minutes. Delete the individual items instead.',
            details: { requiresConfirmation: true },
          },
        }),
      });
    } else {
      await route.continue();
    }
  });
  await row(page, old.text).click();
  await detail.getByRole('button', { name: /^Undo/ }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Remove this capture?' });
  await expect(confirm).toContainText('older than 15 minutes');
  await expect(confirm).toContainText('you can’t bring it back from the dashboard');
  await expect(confirm.getByRole('button', { name: 'Keep capture' })).toBeFocused();
  await expectNoAxeViolations(page);
  await confirm.getByRole('button', { name: 'Remove capture' }).click();
  await expect(row(page, old.text)).toHaveCount(0);
  expect(bodies).toEqual([{ force: false }, { force: true }]);
  await page.unroute(`**/api/captures/${old.id}/undo`);
});

test('an "already edited" refusal offers to convert anyway', async ({ page }) => {
  const capture = await seedQuestion(page, 'e2e-inbox-force');
  const bodies: unknown[] = [];
  await page.route(`**/api/captures/${capture.id}/convert`, async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as { force?: boolean };
    bodies.push(body);
    if (!body.force) {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'This item was edited after it was captured (event). Converting it would discard those edits. Confirm to continue.',
            details: { requiresConfirmation: true, edited: ['x'] },
          },
        }),
      });
    } else {
      await route.continue();
    }
  });
  await openInbox(page);
  await row(page, capture.text).click();
  const noteButton = page.getByRole('group', { name: 'Keep as' }).getByRole('button', { name: 'Note', exact: true });
  await noteButton.click();

  const confirm = page.getByRole('alertdialog', { name: 'Convert to note anyway?' });
  await expect(confirm).toContainText('Converting it would discard those edits.');
  await expect(confirm.getByRole('button', { name: 'Keep it as it is' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();
  await expect(noteButton).toBeFocused();

  await noteButton.click();
  await confirm.getByRole('button', { name: 'Convert to note' }).click();
  await expect(page.locator('.toast', { hasText: 'Kept as note' })).toBeVisible();
  expect(bodies).toEqual([
    { kind: 'NOTE', force: false },
    { kind: 'NOTE', force: false },
    { kind: 'NOTE', force: true },
  ]);
  await page.unroute(`**/api/captures/${capture.id}/convert`);
});

test('delete permanently needs the word typed and erases the capture', async ({ page }) => {
  const capture = await seedQuestion(page, 'e2e-inbox-purge');
  await openInbox(page);
  await row(page, capture.text).click();
  await page.getByRole('button', { name: 'Delete permanently…' }).click();

  const confirm = page.getByRole('alertdialog', { name: /permanently\?$/ });
  await expect(confirm).toContainText('the capture and its original words');
  await expect(confirm).toContainText('This can’t be undone.');
  const field = confirm.getByLabel('Type delete to confirm');
  await expect(field).toBeFocused();
  const button = confirm.getByRole('button', { name: 'Delete permanently' });
  await expect(button).toBeDisabled();
  await field.fill('delet');
  await expect(button).toBeDisabled();
  // Shortcuts never fire while typing in the dialog.
  await expect(row(page, capture.text)).toHaveAttribute('aria-current', 'true');
  await field.fill('delete');
  await expect(button).toBeEnabled();
  await expectNoAxeViolations(page);
  await button.click();
  await expect(page.locator('.toast', { hasText: 'Capture deleted permanently' })).toBeVisible();
  expect((await page.request.get(`/api/captures/${capture.id}`)).status()).toBe(404);
});

test('J and K move through the list; modifiers and fields are ignored', async ({ page }) => {
  await seedQuestion(page, 'e2e-inbox-j');
  await seedQuestion(page, 'e2e-inbox-k');
  await openInbox(page);
  const rows = page.locator('.inbox-row');
  // Wait for the list to load before counting (count() does not wait).
  await expect(rows.nth(1)).toBeVisible();

  await rows.nth(0).focus();
  await rows.nth(0).click();
  await page.keyboard.press('j');
  await expect(rows.nth(1)).toHaveAttribute('aria-current', 'true');
  await expect(rows.nth(1)).toBeFocused();
  await page.keyboard.press('k');
  await expect(rows.nth(0)).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('Control+j');
  await expect(rows.nth(0)).toHaveAttribute('aria-current', 'true');
  await expectNoAxeViolations(page);
});

test('on a phone the list and the capture stack, with a way back', async ({ page }) => {
  const capture = await seedQuestion(page, 'e2e-inbox-phone');
  await page.setViewportSize({ width: 390, height: 844 });
  await openInbox(page);
  const detail = page.getByRole('region', { name: 'Selected capture' });
  await expect(page.locator('.inbox-list-wrap')).toBeVisible();
  await expect(detail).toBeHidden();

  await row(page, capture.text).click();
  await expect(detail).toBeVisible();
  await expect(page.locator('.inbox-list-wrap')).toBeHidden();
  await detail.getByRole('button', { name: '← All captures' }).click();
  await expect(page.locator('.inbox-list-wrap')).toBeVisible();
  await expect(row(page, capture.text)).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('the inbox has no axe violations in dark mode', async ({ browser }) => {
  const context = await browser.newContext({
    colorScheme: 'dark',
    storageState: 'apps/web/e2e/.tmp/auth-state.json',
    locale: 'en-US',
    timezoneId: 'UTC',
  });
  const page = await context.newPage();
  await seedQuestion(page, 'e2e-inbox-dark');
  await openInbox(page);
  await page.locator('.inbox-row').first().click();
  await expectNoAxeViolations(page);
  await context.close();
});
