import fs from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

import { expectNoAxeViolations, uniqueLabel } from './helpers';

/**
 * R2-06 Your data: export download named by date; restore refuses bad files
 * before upload, checks first, restores only the checked bytes, adds only
 * what is missing, and explains an interrupted restore.
 */

async function downloadExport(page: Page): Promise<{ name: string; bytes: Buffer }> {
  await page.goto('/settings/data');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download export' }).click(),
  ]);
  // The success toast closes itself after 5 s, so check it before reading the file.
  await expect(page.getByText(`${download.suggestedFilename()} contains all your data. Keep it somewhere private.`)).toBeVisible();
  const filePath = await download.path();
  return { name: download.suggestedFilename(), bytes: await fs.readFile(filePath) };
}

async function choose(page: Page, name: string, bytes: Buffer) {
  // Handing a large file to the browser can take a while on a slow machine.
  await page
    .getByLabel('Export file (.json, up to 25 MB)')
    .setInputFiles({ name, mimeType: 'application/json', buffer: bytes }, { timeout: 60_000 });
}

const currentStep = (page: Page) => page.getByRole('list', { name: 'Restore steps' }).locator('[aria-current="step"]');

test('export downloads a dated file with every table', async ({ page }) => {
  const { name, bytes } = await downloadExport(page);
  expect(name).toMatch(/^recall-export-\d{4}-\d{2}-\d{2}\.json$/);
  const bundle = JSON.parse(bytes.toString('utf8')) as { schemaVersion: number; data: Record<string, unknown[]> };
  expect(bundle.schemaVersion).toBe(1);
  expect(Object.keys(bundle.data)).toEqual(expect.arrayContaining(['captures', 'tasks', 'notes', 'reminders']));
  await expectNoAxeViolations(page);
});

test('restore refuses bad files before uploading anything', async ({ page }) => {
  await page.goto('/settings/data');
  let uploads = 0;
  await page.route('**/api/restore/file**', (route) => {
    uploads += 1;
    return route.continue();
  });
  const cases: Array<[string, Buffer, RegExp]> = [
    ['broken.json', Buffer.from('{ not json'), /isn’t valid JSON/],
    ['other.json', Buffer.from(JSON.stringify({ hello: 'world' })), /isn’t a Recall export/],
    ['future.json', Buffer.from(JSON.stringify({ schemaVersion: 2, data: {} })), /newer version of Recall \(schema 2\)/],
    ['huge.json', Buffer.alloc(26 * 1024 * 1024, 32), /up to 25 MB/],
  ];
  for (const [name, bytes, message] of cases) {
    await choose(page, name, bytes);
    await expect(page.getByRole('alert')).toContainText(message);
    await expect(page.getByRole('button', { name: 'Check this file' })).toHaveCount(0);
    await expect(currentStep(page)).toHaveText('1 Choose file');
  }
  expect(uploads).toBe(0);
  await page.unroute('**/api/restore/file**');
});

test('a restore adds only what is missing, and repeating it adds nothing', async ({ page }) => {
  const title = uniqueLabel('e2e-restore-note');
  const created = await page.request.post('/api/notes', { data: { title, body: 'Restored by the browser suite' } });
  const note = (await created.json()) as { id: string };
  const { bytes } = await downloadExport(page);
  expect((await page.request.delete(`/api/notes/${note.id}`)).ok()).toBe(true);

  await choose(page, 'backup.json', bytes);
  await expect(currentStep(page)).toHaveText('2 Check');
  await expect(page.getByText(/^Fingerprint [0-9a-f]{4}…[0-9a-f]{4} · not checked yet$/)).toBeVisible();
  await page.getByRole('button', { name: 'Check this file' }).click();
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByRole('row', { name: /^Notes 1 \d+$/ })).toBeVisible();
  // A dry run writes nothing.
  expect((await page.request.get(`/api/notes/${note.id}`)).status()).toBe(404);

  // Choosing the file again discards the check.
  await choose(page, 'backup.json', bytes);
  await expect(page.getByRole('button', { name: /^Restore \d+ records?$/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Check this file' }).click();

  const restore = page.getByRole('button', { name: /^Restore 1 record$/ });
  await expect(restore).toBeEnabled();
  await restore.click();
  const confirm = page.getByRole('alertdialog', { name: 'Restore 1 record?' });
  await expect(confirm).toContainText('backup.json');
  await expect(confirm).toContainText(/fingerprint [0-9a-f]{4}…[0-9a-f]{4}/);
  await expectNoAxeViolations(page);
  await confirm.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Restore finished' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Restore finished' })).toBeFocused();
  expect((await page.request.get(`/api/notes/${note.id}`)).status()).toBe(200);

  // The same file again: nothing to add.
  await page.getByRole('button', { name: 'Restore another file' }).click();
  await choose(page, 'backup.json', bytes);
  await page.getByRole('button', { name: 'Check this file' }).click();
  await expect(page.getByRole('button', { name: 'Nothing to restore' })).toBeDisabled();
});

test('a lost connection during restore is explained and safe to repeat', async ({ page }) => {
  const title = uniqueLabel('e2e-restore-lost');
  const created = await page.request.post('/api/notes', { data: { title, body: 'Interrupted restore' } });
  const note = (await created.json()) as { id: string };
  const { bytes } = await downloadExport(page);
  expect((await page.request.delete(`/api/notes/${note.id}`)).ok()).toBe(true);

  await choose(page, 'backup.json', bytes);
  await page.getByRole('button', { name: 'Check this file' }).click();
  await page.route('**/api/restore/file?dryRun=false**', (route) => route.abort('failed'));
  await page.getByRole('button', { name: /^Restore \d+ records?$/ }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(page.getByText('We couldn’t confirm the restore finished.')).toBeVisible();
  await expect(page.getByText('it’s safe to restore the same file again')).toBeVisible();
  // A request that never reached Recall pauses changes until it answers again.
  await expect(page.getByText('Can’t reach Recall.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check the same file again' })).toBeDisabled();
  await page.unroute('**/api/restore/file?dryRun=false**');
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(page.getByText('Can’t reach Recall.')).toBeHidden();

  await page.getByRole('button', { name: 'Check the same file again' }).click();
  await expect(page.getByRole('button', { name: /^Restore 1 record$/ })).toBeEnabled();
});

test('the server refusing a changed file is shown and nothing is restored', async ({ page }) => {
  const created = await page.request.post('/api/notes', { data: { title: uniqueLabel('e2e-restore-409'), body: 'x' } });
  const note = (await created.json()) as { id: string };
  const { bytes } = await downloadExport(page);
  expect((await page.request.delete(`/api/notes/${note.id}`)).ok()).toBe(true);
  await choose(page, 'backup.json', bytes);
  await page.getByRole('button', { name: 'Check this file' }).click();
  await page.route('**/api/restore/file?dryRun=false**', (route) =>
    route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 'RESTORE_FILE_MISMATCH',
          message: 'This file has not been checked, or it changed since it was checked. Check it again before restoring.',
        },
      }),
    }),
  );
  await page.getByRole('button', { name: /^Restore 1 record$/ }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Check it again before restoring.');
  expect((await page.request.get(`/api/notes/${note.id}`)).status()).toBe(404);
  await page.unroute('**/api/restore/file?dryRun=false**');
});
