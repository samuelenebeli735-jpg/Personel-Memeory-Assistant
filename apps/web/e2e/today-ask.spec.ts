import { expect, test, type Page } from '@playwright/test';

import { expectNoAxeViolations, uniqueLabel } from './helpers';

/**
 * R2-02 Today and R2-01 Ask. The Settings zone is set to Asia/Tokyo while the
 * browser runs in UTC, so any use of the browser's zone would show.
 */
const ZONE = 'Asia/Tokyo';
let originalZone = '';

test.beforeEach(async ({ page }) => {
  originalZone = ((await (await page.request.get('/api/settings')).json()) as { timeZone: string }).timeZone;
  expect((await page.request.patch('/api/settings', { data: { timeZone: ZONE } })).ok()).toBe(true);
});

test.afterEach(async ({ page }) => {
  expect((await page.request.patch('/api/settings', { data: { timeZone: originalZone } })).ok()).toBe(true);
});

function dateKeyIn(zone: string, offsetDays = 0): string {
  const now = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Noon on a Tokyo calendar day, as UTC. */
function tokyoNoon(dateKey: string): string {
  return new Date(`${dateKey}T03:00:00.000Z`).toISOString();
}

function longLabel(dateKey: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long',
  }).formatToParts(new Date(`${dateKey}T12:00:00.000Z`));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('weekday')} ${part('day')} ${part('month')}`;
}

async function post(page: Page, path: string, data: unknown): Promise<{ id: string }> {
  const response = await page.request.post(path, { data });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as { id: string };
}

test('Today shows the Settings-zone day, moves through days in the URL and links items', async ({ page }) => {
  const today = dateKeyIn(ZONE);
  const tomorrow = dateKeyIn(ZONE, 1);
  const taskTitle = uniqueLabel('e2e-today-task');
  const eventTitle = uniqueLabel('e2e-tomorrow-event');
  const task = await post(page, '/api/tasks', { title: taskTitle, dueAt: tokyoNoon(today) });
  await post(page, '/api/events', { title: eventTitle, startsAt: tokyoNoon(tomorrow) });

  await page.goto('/briefing');
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toHaveText(longLabel(today));
  await expect(page.getByText(new RegExp(`^${ZONE} · \\d+ items? in \\d+ sections? · now \\d\\d:\\d\\d$`))).toBeVisible();
  await expect(page.locator('.rail-now')).toHaveCount(1);
  const taskLink = page.getByRole('link', { name: taskTitle });
  await expect(taskLink).toBeVisible();
  // Noon in Tokyo, not 03:00 (the browser's UTC).
  await expect(page.locator('.rail-row', { has: taskLink }).locator('.time-col')).toHaveText('12:00');
  await expectNoAxeViolations(page);

  await page.getByRole('button', { name: /next day/ }).click();
  await expect(page).toHaveURL(new RegExp(`/briefing\\?date=${tomorrow}$`));
  await expect(heading).toHaveText(longLabel(tomorrow));
  await expect(heading).toBeFocused();
  await expect(page.getByRole('link', { name: eventTitle })).toBeVisible();
  await expect(page.locator('.rail-now')).toHaveCount(0);

  await page.getByRole('button', { name: 'Today', exact: true }).click();
  await expect(page).toHaveURL(/\/briefing$/);

  // The date picker and Back.
  await page.getByLabel('Pick a date').fill('2031-06-02');
  await expect(page).toHaveURL(/date=2031-06-02/);
  await expect(page.getByText('Nothing scheduled for this day.')).toBeVisible();
  await page.goBack();
  await expect(heading).toHaveText(longLabel(today));

  await page.getByRole('link', { name: taskTitle }).click();
  await expect(page).toHaveURL(`/tasks/${task.id}`);
});

test('an invalid date falls back to today with a notice', async ({ page }) => {
  await page.goto('/briefing?date=2026-02-30');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(longLabel(dateKeyIn(ZONE)));
  await expect(page.getByText('“2026-02-30” isn’t a date Recall can read, so this is today.')).toBeVisible();
});

test('Ask answers from records with numbered sources, and keeps the question out of the URL', async ({ page }) => {
  const label = uniqueLabel('e2e-ask');
  const note = await post(page, '/api/notes', { title: `${label} boiler`, body: `${label} boiler pressure should be 1.5 bar` });

  await page.goto('/ask');
  await page.getByLabel('Your question').fill(`What did I note about ${label}?`);
  await page.getByRole('button', { name: 'Ask', exact: true }).click();

  const answer = page.locator('.ask-answer');
  await expect(answer).toBeVisible();
  await expect(page.locator('.chip', { hasText: /^Based on \d+ records?$/ })).toBeVisible();
  await expect(page.locator('.chip', { hasText: 'Written by Recall’s built-in rules' })).toBeVisible();
  const source = page.getByRole('link', { name: new RegExp(`^Source 1: .*${label}`) });
  await expect(source).toBeVisible();
  expect(page.url()).not.toContain(label);
  expect(page.url()).toMatch(/\/ask$/);
  await expectNoAxeViolations(page);

  const sourceLinks = page.locator('.ask-sources a');
  const hrefs = await sourceLinks.evaluateAll((links) => links.map((a) => a.getAttribute('href')));
  expect(hrefs).toContain(`/notes/${note.id}`);
  await page.locator(`.ask-sources a[href="/notes/${note.id}"]`).click();
  await expect(page).toHaveURL(`/notes/${note.id}`);
});

test('an unmatched question is labelled not grounded and lists no sources', async ({ page }) => {
  await page.goto('/ask');
  const question = `${uniqueLabel('zzqx')} qwvz?`;
  await page.getByLabel('Your question').fill(question);
  await page.getByLabel('Your question').press('Enter');
  await expect(page.locator('.chip', { hasText: 'Not grounded: no matching records' })).toBeVisible();
  await expect(page.getByText('Searched: tasks, notes, ideas, events, reminders, projects and captures.')).toBeVisible();
  await expect(page.locator('.ask-sources')).toHaveCount(0);
});

test('a date question shows the period and zone as returned', async ({ page }) => {
  await page.goto('/ask');
  await page.getByRole('button', { name: 'What do I have tomorrow?' }).click();
  await expect(page.locator('.ask-answer .kind-label')).toContainText(`· ${ZONE}`);
  await expect(page.locator('.ask-answer .kind-label')).toContainText(/Tomorrow/);
});

test('a rate-limited question keeps the text and says how long to wait', async ({ page }) => {
  await page.route('**/api/ask', (route) =>
    route.fulfill({
      status: 429,
      headers: { 'retry-after': '14', 'content-type': 'application/json' },
      body: JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down' } }),
    }),
  );
  await page.goto('/ask');
  await page.getByLabel('Your question').fill('What is overdue?');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Try again in 14 s. Your question is still in the box.');
  await expect(page.getByLabel('Your question')).toHaveValue('What is overdue?');
  // A 429 never signs out.
  await expect(page.getByRole('heading', { name: 'Ask', exact: true })).toBeVisible();
  await page.unroute('**/api/ask');
});
