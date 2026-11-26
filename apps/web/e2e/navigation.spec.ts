import { expect, test } from '@playwright/test';

type Target = {
  label: string;
  heading?: string;
  text?: string;
};

test('the overview renders live dashboard widgets', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL('/');

  await expect(page.getByText('Open Tasks').first()).toBeVisible();
  await expect(page.getByText('Due Today').first()).toBeVisible();
  await expect(page.getByText('Overdue').first()).toBeVisible();
  await expect(page.getByText('Upcoming Reminders').first()).toBeVisible();
  await expect(page.getByText('Inbox').first()).toBeVisible();
  await expect(page.getByText('Captures Today').first()).toBeVisible();

  await expect(page.getByRole('heading', { name: 'Tasks Due Today', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Overdue Tasks', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Upcoming Reminders', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recent Captures', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible();
  await expect(page.getByText('Failed to load dashboard')).toHaveCount(0);
});

test('the sidebar reaches every top-level dashboard page', async ({ page }) => {
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Main navigation' });

  const targets: Target[] = [
    { label: 'Today', text: 'Sections and their order come from' },
    { label: 'Ask', heading: 'Ask' },
    { label: 'Inbox', heading: 'Inbox' },
    { label: 'Overview', text: 'Open Tasks' },
    { label: 'Quick Capture', heading: 'Quick Capture' },
    { label: 'Search', heading: 'Search' },
    { label: 'Tasks', heading: 'Tasks' },
    { label: 'Reminders', heading: 'Reminders' },
    { label: 'Notes', heading: 'Notes' },
    { label: 'Ideas', heading: 'Ideas' },
    { label: 'Events', heading: 'Events' },
    { label: 'Projects', heading: 'Projects' },
    { label: 'Settings', heading: 'Settings' },
    { label: 'Your data', heading: 'Your data' },
  ];

  for (const target of targets) {
    await nav.getByRole('link', { name: target.label, exact: true }).click();

    if (target.heading) {
      await expect(
        page.getByRole('heading', { name: target.heading, exact: true }).first(),
      ).toBeVisible();
    } else if (target.text) {
      await expect(page.getByText(target.text)).toBeVisible();
    } else {
      throw new Error(`Navigation target ${target.label} needs a heading or text assertion.`);
    }
  }
});

test('the settings page loads live configuration and system status', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();

  await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Localization' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Quiet Hours & Notifications' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Daily Briefing' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'System Status' })).toBeVisible();
  await expect(page.getByText('Database')).toBeVisible();
  await expect(page.getByText('Connected', { exact: true })).toBeVisible();
});
