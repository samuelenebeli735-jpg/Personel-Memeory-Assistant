import { expect, test, type Page } from '@playwright/test';

import { expectNoAxeViolations, uniqueLabel } from './helpers';

/**
 * R2-04: every record type can be edited with the same form used to create
 * it, and deleted through a confirmation that names it and says what
 * happens. Deletes are permanent (decision D3).
 */

async function create<T = { id: string }>(page: Page, path: string, data: unknown): Promise<T> {
  const response = await page.request.post(path, { data });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as T;
}

async function openEdit(page: Page, noun: string) {
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Edit ${noun}` });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('a note is edited and deleted from its detail page', async ({ page }) => {
  const title = uniqueLabel('e2e-note-edit');
  const note = await create(page, '/api/notes', { title, body: 'First body' });
  await page.goto(`/notes/${note.id}`);

  const dialog = await openEdit(page, 'Note');
  await expect(dialog.getByLabel('Body')).toHaveValue('First body');
  await dialog.getByLabel('Body').fill('Second body');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Note updated')).toBeVisible();
  await expect(page.getByText('Second body')).toBeVisible();

  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  const confirm = page.getByRole('alertdialog', { name: `Delete note “${title}”?` });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('This can’t be undone.');
  // The safe choice has focus.
  await expect(confirm.getByRole('button', { name: 'Keep note' })).toBeFocused();
  await expectNoAxeViolations(page);
  await confirm.getByRole('button', { name: 'Delete note' }).click();
  await expect(page.getByText('Note deleted')).toBeVisible();
  await expect(page).toHaveURL('/notes');
  expect((await page.request.get(`/api/notes/${note.id}`)).status()).toBe(404);
});

test('an idea is edited, made into a task, and deleted', async ({ page }) => {
  const title = uniqueLabel('e2e-idea-edit');
  const idea = await create(page, '/api/ideas', { title });
  await page.goto(`/ideas/${idea.id}`);

  const dialog = await openEdit(page, 'Idea');
  await dialog.getByLabel('Body (optional)').fill('With details');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Idea updated')).toBeVisible();

  await page.getByRole('button', { name: 'Make it a task' }).click();
  await expect(page.getByText('Task created from idea')).toBeVisible();
  await page.getByRole('link', { name: 'Open task' }).click();
  await expect(page).toHaveURL(/\/tasks\/[^/]+$/);
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();

  await page.goto(`/ideas/${idea.id}`);
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  const confirm = page.getByRole('alertdialog', { name: `Delete idea “${title}”?` });
  await expect(confirm).toContainText('Tasks made from it stay.');
  await confirm.getByRole('button', { name: 'Delete idea' }).click();
  await expect(page).toHaveURL('/ideas');
});

test('an event is edited in the Settings zone and deleted', async ({ page }) => {
  const settings = (await (await page.request.get('/api/settings')).json()) as { timeZone: string };
  const original = settings.timeZone;
  expect((await page.request.patch('/api/settings', { data: { timeZone: 'Asia/Tokyo' } })).ok()).toBe(true);
  try {
    const title = uniqueLabel('e2e-event-edit');
    const event = await create(page, '/api/events', { title, startsAt: '2031-05-01T01:00:00.000Z' });
    await page.goto(`/events/${event.id}`);

    const dialog = await openEdit(page, 'Event');
    // 01:00 UTC is 10:00 in Tokyo; the browser itself runs in UTC.
    await expect(dialog.getByLabel('Starts At')).toHaveValue('2031-05-01T10:00');
    await dialog.getByLabel('Starts At').fill('2031-05-01T15:30');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Event updated')).toBeVisible();
    const stored = (await (await page.request.get(`/api/events/${event.id}`)).json()) as { startsAt: string };
    expect(stored.startsAt).toBe('2031-05-01T06:30:00.000Z');

    // An end before the start is refused on the field, and the text is kept.
    const again = await openEdit(page, 'Event');
    await again.getByLabel('Ends At (optional)').fill('2031-05-01T09:00');
    await again.getByRole('button', { name: 'Save changes' }).click();
    await expect(again.getByLabel('Ends At (optional)')).toHaveAttribute('aria-invalid', 'true');
    await expect(again.getByLabel('Ends At (optional)')).toBeFocused();
    await expect(again.getByLabel('Ends At (optional)')).toHaveValue('2031-05-01T09:00');
    await expectNoAxeViolations(page);
    await again.getByRole('button', { name: 'Cancel' }).click();
    await again.getByRole('button', { name: 'Discard' }).click();

    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete event' }).click();
    await expect(page).toHaveURL('/events');
  } finally {
    expect((await page.request.patch('/api/settings', { data: { timeZone: original } })).ok()).toBe(true);
  }
});

test('a project delete says how many items will be detached', async ({ page }) => {
  const name = uniqueLabel('e2e-project-delete');
  const project = await create(page, '/api/projects', { name });
  await create(page, '/api/tasks', { title: uniqueLabel('e2e-in-project'), projectId: project.id });
  await create(page, '/api/notes', { body: 'In the project', projectId: project.id });
  await page.goto(`/projects/${project.id}`);

  const dialog = await openEdit(page, 'Project');
  await expect(dialog.getByLabel('Status')).toHaveValue('ACTIVE');
  await dialog.getByLabel('Description (optional)').fill('Renovation');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Project updated')).toBeVisible();

  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  const confirm = page.getByRole('alertdialog', { name: `Delete project “${name}”?` });
  await expect(confirm).toContainText('2 items (tasks, notes, ideas and events) stay, but are no longer in a project.');
  await confirm.getByRole('button', { name: 'Delete project' }).click();
  await expect(page.getByText('2 items are no longer in a project.')).toBeVisible();
  await expect(page).toHaveURL('/projects');
});

test('a reminder is edited (time and recurrence) and deleted', async ({ page }) => {
  const title = uniqueLabel('e2e-reminder-edit');
  const reminder = await create(page, '/api/reminders', { title, remindAt: '2032-02-01T09:00:00.000Z' });
  await page.goto(`/reminders/${reminder.id}`);

  const dialog = await openEdit(page, 'Reminder');
  await dialog.getByLabel('Recurrence').selectOption('WEEKLY');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Reminder updated')).toBeVisible();
  const stored = (await (await page.request.get(`/api/reminders/${reminder.id}`)).json()) as {
    recurrence: { frequency: string } | null;
  };
  expect(stored.recurrence?.frequency).toBe('WEEKLY');

  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  const confirm = page.getByRole('alertdialog', { name: `Delete reminder “${title}”?` });
  await expect(confirm).toContainText('every later reminder in its series');
  await confirm.getByRole('button', { name: 'Delete reminder' }).click();
  await expect(page).toHaveURL('/reminders');
});

test('a task due date is edited; unsaved changes are protected', async ({ page }) => {
  const title = uniqueLabel('e2e-task-edit');
  const task = await create(page, '/api/tasks', { title });
  await page.goto(`/tasks/${task.id}`);

  const dialog = await openEdit(page, 'Task');
  await dialog.getByLabel('Due Date').fill('2031-01-10T08:15');
  // Escape with unsaved changes asks first and keeps the text.
  await page.keyboard.press('Escape');
  await expect(dialog.getByRole('group', { name: 'Discard your changes?' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Keep editing' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Keep editing' }).click();
  await expect(dialog.getByLabel('Due Date')).toHaveValue('2031-01-10T08:15');

  // Only the changed field is sent.
  const request = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().includes(`/api/tasks/${task.id}`));
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  expect(Object.keys(JSON.parse((await request).postData() ?? '{}'))).toEqual(['dueAt']);
  await expect(page.getByText('Task updated')).toBeVisible();

  // A server error keeps the form open with the text and says what happened.
  await page.route(`**/api/tasks/${task.id}`, (route) =>
    route.request().method() === 'PATCH'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'x' } }) })
      : route.continue(),
  );
  const failing = await openEdit(page, 'Task');
  await failing.getByLabel('Title').fill(`${title} changed`);
  await failing.getByRole('button', { name: 'Save changes' }).click();
  await expect(failing.getByText('The server had a problem (INTERNAL_ERROR). Try again. Your text is still in the form.')).toBeVisible();
  await expect(failing.getByLabel('Title')).toHaveValue(`${title} changed`);
  await expect(page.locator('.toast-error', { hasText: 'Task not saved' })).toHaveAttribute('role', 'alert');
  await page.unroute(`**/api/tasks/${task.id}`);
});
