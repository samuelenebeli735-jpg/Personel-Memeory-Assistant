import { expect, test } from '@playwright/test';

import { uniqueLabel } from './helpers';

test('a note is created and opened from its detail page', async ({ page }) => {
  const title = uniqueLabel('e2e-note');
  await page.goto('/notes');

  await page.getByRole('button', { name: 'New Note' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create Note' });
  await expect(dialog).toBeVisible();

  await dialog.getByLabel('Title (optional)').fill(title);
  await dialog.getByLabel('Body').fill('A saved reference created by the browser E2E suite.');

  await dialog.getByRole('button', { name: 'Create Note' }).click();
  await expect(page.getByText('Note created')).toBeVisible();

  const row = page.locator('.list-item', { hasText: title });
  await expect(row).toBeVisible();
  await row.getByRole('link').click();

  await expect(page).toHaveURL(/\/notes\/[^/]+$/);
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(page.getByText('A saved reference created by the browser E2E suite.')).toBeVisible();
});

test('an idea is created and opened from its detail page', async ({ page }) => {
  const title = uniqueLabel('e2e-idea');
  await page.goto('/ideas');

  await page.getByRole('button', { name: 'New Idea' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create Idea' });
  await expect(dialog).toBeVisible();

  await dialog.getByLabel('Title').fill(title);
  await dialog.getByLabel('Body (optional)').fill('An idea created by the browser E2E suite.');

  await dialog.getByRole('button', { name: 'Create Idea' }).click();
  await expect(page.getByText('Idea created', { exact: true })).toBeVisible();

  const row = page.locator('.list-item', { hasText: title });
  await expect(row).toBeVisible();
  await row.getByRole('link').click();

  await expect(page).toHaveURL(/\/ideas\/[^/]+$/);
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(page.getByText('An idea created by the browser E2E suite.')).toBeVisible();
});

test('an event is created and opened from its detail page', async ({ page }) => {
  const title = uniqueLabel('e2e-event');
  await page.goto('/events');

  await page.getByRole('button', { name: 'New Event' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create Event' });
  await expect(dialog).toBeVisible();

  await dialog.getByLabel('Title').fill(title);
  await dialog.getByLabel('Description (optional)').fill('A future appointment.');
  await dialog.getByLabel('Starts At').fill('2032-02-01T10:00');

  await dialog.getByRole('button', { name: 'Create Event' }).click();
  await expect(page.getByText('Event created')).toBeVisible();

  const row = page.locator('.list-item', { hasText: title });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Upcoming');
  await row.getByRole('link').click();

  await expect(page).toHaveURL(/\/events\/[^/]+$/);
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(page.getByText('A future appointment.')).toBeVisible();
});

test('a project is created and opened from its detail page', async ({ page }) => {
  const name = uniqueLabel('e2e-project');
  await page.goto('/projects');

  await page.getByRole('button', { name: 'New Project' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create Project' });
  await expect(dialog).toBeVisible();

  await dialog.getByLabel('Name').fill(name);
  await dialog.getByLabel('Description (optional)').fill('A container for related records.');

  await dialog.getByRole('button', { name: 'Create Project' }).click();
  await expect(page.getByText('Project created')).toBeVisible();

  const row = page.locator('.list-item', { hasText: name });
  await expect(row).toBeVisible();
  await expect(row).toContainText('ACTIVE');
  await row.getByRole('link').click();

  await expect(page).toHaveURL(/\/projects\/[^/]+$/);
  await expect(page.getByRole('heading', { name: name, exact: true })).toBeVisible();
  await expect(page.getByText('A container for related records.')).toBeVisible();
});
