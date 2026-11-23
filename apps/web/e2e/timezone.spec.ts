import { expect, test, type Page } from '@playwright/test';

import { uniqueLabel } from './helpers';

/**
 * The dashboard reads and writes wall-clock times in the owner's Settings zone.
 *
 * The browser itself runs in UTC (playwright.config.ts `timezoneId`), so every
 * assertion below would fail if the dashboard used the browser's zone or a
 * hard-coded one. Settings are a shared singleton: each test restores them.
 */
let originalZone = '';

test.beforeEach(async ({ page }) => {
  const settings = (await (await page.request.get('/api/settings')).json()) as { timeZone: string };
  originalZone = settings.timeZone;
  const set = await page.request.patch('/api/settings', { data: { timeZone: 'America/New_York' } });
  expect(set.ok()).toBe(true);
});

test.afterEach(async ({ page }) => {
  const restore = await page.request.patch('/api/settings', { data: { timeZone: originalZone } });
  expect(restore.ok(), 'time zone restored for the rest of the suite').toBe(true);
});

/** The stored UTC instant of a record, read through search. */
async function storedTimestamp(page: Page, type: string, title: string): Promise<string> {
  const response = await page.request.get(`/api/search?q=${encodeURIComponent(title)}&types=${type}`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { items: { title: string; timestamp: string }[] };
  const item = body.items.find((candidate) => candidate.title === title);
  expect(item, `${type} ${title} found by search`).toBeDefined();
  return item!.timestamp;
}

test('a reminder typed as 09:00 fires at 09:00 New York time, not browser (UTC) time', async ({ page }) => {
  const title = uniqueLabel('e2e-tz-reminder');
  await page.goto('/reminders');
  await page.getByRole('button', { name: 'New Reminder' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create Reminder' });
  await expect(dialog.getByText('Time zone: America/New_York')).toBeVisible();

  await dialog.getByLabel('Title').fill(title);
  await dialog.getByLabel('Remind At').fill('2026-12-01T09:00');
  await dialog.getByRole('button', { name: 'Create Reminder' }).click();
  await expect(page.getByText('Reminder created')).toBeVisible();

  // 09:00 EST (UTC-5) on 1 December.
  expect(await storedTimestamp(page, 'REMINDER', title)).toBe('2026-12-01T14:00:00.000Z');
  await expect(page.locator('.list-item', { hasText: title })).toContainText(/\b9:00\s?am/i);
});

test('a task due date is accepted and stored in the Settings zone', async ({ page }) => {
  const title = uniqueLabel('e2e-tz-task');
  await page.goto('/tasks');
  await page.getByRole('button', { name: 'New Task' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create Task' });

  await dialog.getByLabel('Title').fill(title);
  await dialog.getByLabel('Due Date').fill('2026-12-02T10:30');
  await dialog.getByRole('button', { name: 'Create Task' }).click();
  // Before R1-02 the raw value was sent without a zone and the API refused it.
  await expect(page.getByText('Task created')).toBeVisible();

  expect(await storedTimestamp(page, 'TASK', title)).toBe('2026-12-02T15:30:00.000Z');
  await expect(page.locator('.list-item', { hasText: title })).toContainText(/\b10:30\s?am/i);
});

test('an event in summer time is stored with the daylight-saving offset', async ({ page }) => {
  const title = uniqueLabel('e2e-tz-event');
  await page.goto('/events');
  await page.getByRole('button', { name: 'New Event' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create Event' });

  await dialog.getByLabel('Title').fill(title);
  await dialog.getByLabel('Starts At').fill('2027-07-15T18:00');
  await dialog.getByRole('button', { name: 'Create Event' }).click();
  await expect(page.getByText('Event created')).toBeVisible();

  // 18:00 EDT (UTC-4) in July.
  expect(await storedTimestamp(page, 'EVENT', title)).toBe('2027-07-15T22:00:00.000Z');
});

test('a time inside the spring-forward gap is refused with an explanation', async ({ page }) => {
  await page.goto('/reminders');
  await page.getByRole('button', { name: 'New Reminder' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create Reminder' });

  await dialog.getByLabel('Title').fill(uniqueLabel('e2e-tz-gap'));
  // New York skips 02:00-03:00 on 14 March 2027.
  await dialog.getByLabel('Remind At').fill('2027-03-14T02:30');
  await dialog.getByRole('button', { name: 'Create Reminder' }).click();
  await expect(dialog.getByText('That local time does not exist in the configured time zone.')).toBeVisible();
});

test('saving a new zone in Settings changes the dashboard immediately', async ({ page }) => {
  const title = uniqueLabel('e2e-tz-switch');
  const created = await page.request.post('/api/tasks', {
    data: { title, dueAt: '2026-12-02T15:30:00.000Z' },
  });
  expect(created.ok()).toBe(true);

  await page.goto('/tasks');
  await expect(page.locator('.list-item', { hasText: title })).toContainText(/\b10:30\s?am/i);

  await page.goto('/settings');
  await page.getByLabel('Time Zone').selectOption('Africa/Lagos');
  await page.getByRole('button', { name: 'Save Settings' }).click();
  await expect(page.getByText('Settings saved')).toBeVisible();

  // Client-side navigation: no reload, the provider already holds the new zone.
  await page.getByRole('link', { name: 'Tasks', exact: true }).click();
  await expect(page.locator('.list-item', { hasText: title })).toContainText(/\b4:30\s?pm/i);
});
