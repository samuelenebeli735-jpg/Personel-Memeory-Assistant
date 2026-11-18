import { expect, test, type Page } from '@playwright/test';

/**
 * Settings are a singleton shared by the whole suite, so every test restores
 * the values it found. Restoring goes through the API with the page's own
 * session cookie.
 */
const RESTORED_FIELDS = [
  'displayName',
  'timeZone',
  'morningDefaultTime',
  'eveningDefaultTime',
  'locale',
  'quietHoursStart',
  'quietHoursEnd',
  'maxNotificationsPerDay',
  'reminderOverdueGraceHours',
  'aiEnabled',
  'briefingEnabled',
  'briefingTime',
  'briefingSections',
] as const;

let original: Record<string, unknown> = {};

test.beforeEach(async ({ page }) => {
  const response = await page.request.get('/api/settings');
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as Record<string, unknown>;
  original = Object.fromEntries(RESTORED_FIELDS.map((key) => [key, body[key]]));
});

test.afterEach(async ({ page }) => {
  const response = await page.request.patch('/api/settings', { data: original });
  expect(response.ok(), 'settings restored for the rest of the suite').toBe(true);
});

async function save(page: Page): Promise<number> {
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().endsWith('/api/settings')),
    page.getByRole('button', { name: 'Save Settings' }).click(),
  ]);
  return response.status();
}

test('a fresh install saves without changes (empty quiet hours are accepted)', async ({ page }) => {
  // Start from the shipped defaults: no quiet hours, no display name.
  const reset = await page.request.patch('/api/settings', {
    data: { displayName: null, quietHoursStart: null, quietHoursEnd: null },
  });
  expect(reset.ok()).toBe(true);

  await page.goto('/settings');
  await expect(page.getByLabel('Quiet Hours Start')).toHaveValue('');
  await expect(page.getByLabel('Quiet Hours End')).toHaveValue('');

  expect(await save(page)).toBe(200);
  await expect(page.getByText('Settings saved')).toBeVisible();
});

test('custom settings are saved, reloaded and retained after a refresh, then cleared again', async ({ page }) => {
  await page.goto('/settings');

  await page.getByLabel('Display Name').fill('E2E Owner');
  await page.getByLabel('Time Zone').selectOption('America/New_York');
  await page.getByLabel('Quiet Hours Start').fill('22:00');
  await page.getByLabel('Quiet Hours End').fill('07:00');
  await page.getByLabel('Max Notifications Per Day (0 = unlimited)').fill('15');

  const ai = page.getByLabel('Use AI to classify captures and answer questions');
  await ai.uncheck();
  const briefing = page.getByLabel('Send the daily briefing');
  await briefing.check();
  await page.getByLabel('Briefing Time').fill('06:45');

  // Sections: keep "Due today", drop the other two defaults, add ideas and put it first.
  await page.getByRole('checkbox', { name: /^Overdue/ }).uncheck();
  await page.getByRole('checkbox', { name: /^Upcoming events/ }).uncheck();
  await page.getByRole('checkbox', { name: /^Recent ideas/ }).check();
  await page.getByRole('button', { name: 'Move Recent ideas up' }).click();

  expect(await save(page)).toBe(200);
  await expect(page.getByText('Settings saved')).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.getByLabel('Display Name')).toHaveValue('E2E Owner');
  await expect(page.getByLabel('Time Zone')).toHaveValue('America/New_York');
  await expect(page.getByLabel('Quiet Hours Start')).toHaveValue('22:00');
  await expect(page.getByLabel('Quiet Hours End')).toHaveValue('07:00');
  await expect(page.getByLabel('Max Notifications Per Day (0 = unlimited)')).toHaveValue('15');
  await expect(ai).not.toBeChecked();
  await expect(briefing).toBeChecked();
  await expect(page.getByLabel('Briefing Time')).toHaveValue('06:45');
  await expect(page.getByRole('checkbox', { name: /^Overdue/ })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: /^Recent ideas/ })).toBeChecked();
  // Order is retained: ideas first, so it cannot move further up.
  await expect(page.getByRole('button', { name: 'Move Recent ideas up' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Move Due today up' })).toBeEnabled();

  const stored = (await (await page.request.get('/api/settings')).json()) as Record<string, unknown>;
  expect(stored.briefingSections).toEqual(['ideas', 'today']);
  expect(stored.aiEnabled).toBe(false);

  // Clearing quiet hours and turning AI back on also survives a refresh.
  await page.getByLabel('Quiet Hours Start').fill('');
  await page.getByLabel('Quiet Hours End').fill('');
  await ai.check();
  expect(await save(page)).toBe(200);

  await page.reload();
  await expect(page.getByLabel('Quiet Hours Start')).toHaveValue('');
  await expect(page.getByLabel('Quiet Hours End')).toHaveValue('');
  await expect(page.getByLabel('Use AI to classify captures and answer questions')).toBeChecked();
});

test('half-configured quiet hours are explained on the field and never sent', async ({ page }) => {
  await page.goto('/settings');
  await page.getByLabel('Quiet Hours Start').fill('22:00');
  await page.getByLabel('Quiet Hours End').fill('');

  let patched = false;
  page.on('request', (request) => {
    if (request.method() === 'PATCH' && request.url().endsWith('/api/settings')) patched = true;
  });
  await page.getByRole('button', { name: 'Save Settings' }).click();

  await expect(page.getByText('Set an end time, or clear the start time.')).toBeVisible();
  await expect(page.getByLabel('Quiet Hours End')).toHaveAttribute('aria-invalid', 'true');
  expect(patched).toBe(false);
});

test('removing every briefing section is refused with a message', async ({ page }) => {
  await page.goto('/settings');
  for (const name of [/^Due today/, /^Overdue/, /^Upcoming events/, /^Recent ideas/, /^Later deadlines/]) {
    await page.getByRole('checkbox', { name }).uncheck();
  }
  await page.getByRole('button', { name: 'Save Settings' }).click();
  await expect(page.getByText('Choose at least one briefing section.')).toBeVisible();
});
