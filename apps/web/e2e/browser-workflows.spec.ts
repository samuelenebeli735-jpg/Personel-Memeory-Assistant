import { expect, test, type Browser, type Page, type BrowserContext, type Locator } from '@playwright/test';
import { readE2eEnv, uniqueLabel, authStatePath } from './helpers';

/**
 * Browser Workflow Coverage Tests
 *
 * Covers:
 * - Keyboard navigation and focus visibility
 * - Login/logout, invalid credentials, expired sessions, anonymous access
 * - Form validation and accessible errors
 * - Empty states, failed API requests, missing-record detail pages
 * - Dialog open/close/action buttons
 * - Desktop/mobile viewports
 * - Browser console errors during workflows
 */

// Helper to create an unauthenticated context
async function unauthenticatedContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'UTC',
    storageState: { cookies: [], origins: [] },
  });
  await context.clearCookies();
  return context;
}

// Helper to capture console errors
function captureConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      errors.push(msg.text());
    }
  });
  page.on('pageerror', (error) => {
    errors.push(error.message);
  });
  return errors;
}

/** Captures failed network requests and non-success API responses separately
 * from browser console output. Expected negative-path tests use their own
 * assertions; successful workflows use this helper to catch silent API
 * failures that do not surface as console errors. */
function captureApplicationFailures(page: Page): string[] {
  const failures: string[] = [];
  page.on('requestfailed', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) {
      failures.push(`request failed ${request.method()} ${request.url()}: ${request.failure()?.errorText ?? 'unknown'}`);
    }
  });
  page.on('response', (response) => {
    if (new URL(response.url()).pathname.startsWith('/api/') && response.status() >= 400) {
      failures.push(`API ${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });
  return failures;
}

async function expectNoApplicationFailures(failures: string[], context: string) {
  expect(failures, `Application request failures during ${context}: ${failures.join('; ')}`).toHaveLength(0);
}

async function tabUntilFocused(page: Page, target: Locator, maxTabs = 8) {
  for (let index = 0; index < maxTabs; index += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}

// Helper to check for console errors
async function expectNoConsoleErrors(page: Page, errors: string[], context: string) {
  const filteredErrors = errors.filter(
    (e) => !e.includes('favicon.ico') && !e.includes('Failed to load resource') && !e.includes('net::ERR')
  );
  expect(filteredErrors, `Console errors during ${context}: ${filteredErrors.join('; ')}`).toHaveLength(0);
}

test.describe('Keyboard Navigation and Focus Visibility', () => {
  test('tab navigation works through login form', async ({ page, browser }) => {
    const context = await unauthenticatedContext(browser);
    const loginPage = await context.newPage();
    const errors = captureConsoleErrors(loginPage);
    const failures = captureApplicationFailures(loginPage);

    await loginPage.goto('/login');
    await expect(loginPage.getByRole('button', { name: 'Sign In' })).toBeVisible();

    // The password field is auto-focused so the form is immediately usable.
    await expect(loginPage.getByLabel('Password')).toBeFocused();

    // Tab to the Sign In button
    await loginPage.keyboard.press('Tab');
    await expect(loginPage.getByRole('button', { name: 'Sign In' })).toBeFocused();

    // Shift+Tab returns to the password field; ordinary Tab leaves the form.
    await loginPage.keyboard.press('Shift+Tab');
    await expect(loginPage.getByLabel('Password')).toBeFocused();

    await expectNoConsoleErrors(loginPage, errors, 'login keyboard navigation');
    await expectNoApplicationFailures(failures, 'login keyboard navigation');
    await context.close();
  });

  test('tab navigation works through sidebar navigation', async ({ page }) => {
    const errors = captureConsoleErrors(page);

    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Recall Home' })).toBeVisible();

    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    const firstLink = nav.getByRole('link', { name: 'Overview', exact: true });

    // Focus the first nav link
    await firstLink.focus();
    await expect(firstLink).toBeFocused();

    // Tab through navigation items
    await page.keyboard.press('Tab');
    await expect(nav.getByRole('link', { name: 'Quick Capture', exact: true })).toBeFocused();

    await page.keyboard.press('Tab');
    await expect(nav.getByRole('link', { name: 'Search', exact: true })).toBeFocused();

    await page.keyboard.press('Tab');
    await expect(nav.getByRole('link', { name: 'Tasks', exact: true })).toBeFocused();

    // Verify focus visible styles are applied
    const focusedLink = page.locator(':focus-visible');
    await expect(focusedLink).toBeVisible();

    await expectNoConsoleErrors(page, errors, 'sidebar keyboard navigation');
  });

  test('keyboard navigation works in dialogs', async ({ page }) => {
    const errors = captureConsoleErrors(page);

    await page.goto('/tasks');
    await page.getByRole('button', { name: 'New Task' }).click();

    const dialog = page.getByRole('dialog', { name: 'Create Task' });
    await expect(dialog).toBeVisible();

    // The dialog opens with the first form field focused.
    await expect(page.getByLabel('Title')).toBeFocused();

    // Tab through form fields
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Description')).toBeFocused();

    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Priority')).toBeFocused();

    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Due Date')).toBeFocused();

    await tabUntilFocused(page, dialog.getByRole('button', { name: 'Create Task' }));

    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();

    // Escape should close dialog
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();

    await expectNoConsoleErrors(page, errors, 'dialog keyboard navigation');
  });

  test('focus is trapped in modal dialogs', async ({ page }) => {
    const errors = captureConsoleErrors(page);

    await page.goto('/tasks');
    await page.getByRole('button', { name: 'New Task' }).click();

    const dialog = page.getByRole('dialog', { name: 'Create Task' });
    await expect(dialog).toBeVisible();

    // The dialog opens with the first form field focused.
    await expect(page.getByLabel('Title')).toBeFocused();

    // Tab forward through the remaining focusable elements.
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Description')).toBeFocused();

    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Priority')).toBeFocused();

    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Due Date')).toBeFocused();

    await tabUntilFocused(page, dialog.getByRole('button', { name: 'Create Task' }));

    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();

    // The dialog traps focus and wraps back to the first form field.
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Title')).toBeFocused();

    // Shift+Tab returns to the close control without leaving the dialog.
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();

    await expectNoConsoleErrors(page, errors, 'focus trapping');
  });

  test('skip link works for main content', async ({ page }) => {
    const errors = captureConsoleErrors(page);

    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Recall Home' })).toBeVisible();

    // Tab to skip link (if present)
    await page.keyboard.press('Tab');
    const skipLink = page.getByRole('link', { name: 'Skip to main content' });
    if (await skipLink.isVisible()) {
      await expect(skipLink).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.locator('main')).toBeFocused();
    }

    await expectNoConsoleErrors(page, errors, 'skip link');
  });
});

test.describe('Login, Logout, Invalid Credentials, Expired Sessions, Anonymous Access', () => {
  test('valid login creates session and redirects to dashboard', async ({ page, browser }) => {
    const context = await unauthenticatedContext(browser);
    const loginPage = await context.newPage();
    const errors = captureConsoleErrors(loginPage);
    const failures = captureApplicationFailures(loginPage);
    const { password } = readE2eEnv();

    await loginPage.goto('/login');
    await expect(loginPage.getByRole('button', { name: 'Sign In' })).toBeVisible();

    await loginPage.getByLabel('Password').fill(password);
    await loginPage.getByRole('button', { name: 'Sign In' }).click();

    await expect(loginPage).toHaveURL('/');
    await expect(loginPage.getByRole('link', { name: 'Recall Home' })).toBeVisible();

    const cookies = await context.cookies();
    const sessionCookie = cookies.find((c) => c.name === 'recall_session');
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie?.value.length).toBeGreaterThan(0);

    await expectNoConsoleErrors(loginPage, errors, 'valid login');
    await expectNoApplicationFailures(failures, 'valid login');
    await context.close();
  });

  test('invalid password shows error and does not create session', async ({ page, browser }) => {
    const context = await unauthenticatedContext(browser);
    const loginPage = await context.newPage();
    const errors = captureConsoleErrors(loginPage);
    const { password } = readE2eEnv();

    await loginPage.goto('/login');
    await loginPage.getByLabel('Password').fill(`${password}-wrong`);
    await loginPage.getByRole('button', { name: 'Sign In' }).click();

    await expect(loginPage.getByText('Incorrect password').first()).toBeVisible();
    await expect(loginPage).toHaveURL(/\/login$/);

    const cookies = await context.cookies();
    expect(cookies.filter((cookie) => cookie.name === 'recall_session')).toEqual([]);

    await expectNoConsoleErrors(loginPage, errors, 'invalid password');
    await context.close();
  });

  test('empty password shows validation error', async ({ page, browser }) => {
    const context = await unauthenticatedContext(browser);
    const loginPage = await context.newPage();
    const errors = captureConsoleErrors(loginPage);

    await loginPage.goto('/login');
    await loginPage.getByLabel('Password').fill('');
    await loginPage.getByRole('button', { name: 'Sign In' }).click();

    await expect(loginPage.getByText('Password is required').first()).toBeVisible();
    await expect(loginPage).toHaveURL(/\/login$/);

    await expectNoConsoleErrors(loginPage, errors, 'empty password');
    await context.close();
  });

  test('logout clears session and redirects to login', async ({ page, context }) => {
    const errors = captureConsoleErrors(page);

    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Recall Home' })).toBeVisible();

    await page.getByRole('button', { name: 'Logout' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();

    const cookies = await context.cookies();
    expect(cookies.filter((cookie) => cookie.name === 'recall_session')).toEqual([]);

    await expectNoConsoleErrors(page, errors, 'logout');
  });

  test('unauthenticated access to protected routes redirects to login', async ({ page, browser }) => {
    const context = await unauthenticatedContext(browser);
    const errors = captureConsoleErrors(page);

    const protectedRoutes = ['/', '/capture', '/tasks', '/reminders', '/search', '/settings', '/notes', '/ideas', '/events', '/projects'];

    for (const route of protectedRoutes) {
      const testPage = await context.newPage();
      const routeErrors = captureConsoleErrors(testPage);

      await testPage.goto(route);
      await expect(testPage).toHaveURL(/\/login$/);
      await expect(testPage.getByRole('button', { name: 'Sign In' })).toBeVisible();

      await expectNoConsoleErrors(testPage, routeErrors, `anonymous access to ${route}`);
      await testPage.close();
    }

    await context.close();
  });

  test('expired session redirects to login', async ({ page, browser }) => {
    // Create a context with an expired session cookie
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'en-US',
      timezoneId: 'UTC',
      storageState: { cookies: [], origins: [] },
    });

    // Add an expired session cookie
    await context.addCookies([
      {
        name: 'recall_session',
        value: 'expired-session-value',
        domain: '127.0.0.1',
        path: '/',
        expires: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
      },
    ]);

    const testPage = await context.newPage();
    const errors = captureConsoleErrors(testPage);

    await testPage.goto('/');
    await expect(testPage).toHaveURL(/\/login$/);
    await expect(testPage.getByRole('button', { name: 'Sign In' })).toBeVisible();

    await expectNoConsoleErrors(testPage, errors, 'expired session');
    await context.close();
  });

  test('session persists across page reloads', async ({ page, context }) => {
    const errors = captureConsoleErrors(page);

    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Recall Home' })).toBeVisible();

    // Reload the page
    await page.reload();
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('link', { name: 'Recall Home' })).toBeVisible();

    const cookies = await context.cookies();
    const sessionCookie = cookies.find((c) => c.name === 'recall_session');
    expect(sessionCookie).toBeDefined();

    await expectNoConsoleErrors(page, errors, 'session persistence');
  });
});

test.describe('Form Validation and Accessible Errors', () => {
  test('task creation form shows validation errors', async ({ page }) => {
    const errors = captureConsoleErrors(page);

    await page.goto('/tasks');
    await page.getByRole('button', { name: 'New Task' }).click();

    const dialog = page.getByRole('dialog', { name: 'Create Task' });
    await expect(dialog).toBeVisible();

    // Try to submit without title
    await dialog.getByRole('button', { name: 'Create Task' }).click();

    // Should show validation error
    await expect(page.getByText('Title is required').first()).toBeVisible();
    await expect(page.getByLabel('Title')).toHaveAttribute('aria-invalid', 'true');

    // Fill title and submit
    await page.getByLabel('Title').fill(uniqueLabel('e2e-task'));
    await dialog.getByRole('button', { name: 'Create Task' }).click();

    await expect(page.getByText('Task created')).toBeVisible();

    await expectNoConsoleErrors(page, errors, 'task form validation');
  });

  test('note creation form shows validation errors', async ({ page }) => {
    const errors = captureConsoleErrors(page);

    await page.goto('/notes');
    await page.getByRole('button', { name: 'New Note' }).click();

    const dialog = page.getByRole('dialog', { name: 'Create Note' });
    await expect(dialog).toBeVisible();

    // Try to submit without title (optional for notes, but body is required)
    await dialog.getByRole('button', { name: 'Create Note' }).click();

    // Should show validation error for body
    await expect(page.getByText('Body is required').first()).toBeVisible();
    await expect(page.getByLabel('Body')).toHaveAttribute('aria-invalid', 'true');

    await expectNoConsoleErrors(page, errors, 'note form validation');
  });

  test('reminder creation form validates required date/time', async ({ page }) => {
    const errors = captureConsoleErrors(page);

    await page.goto('/reminders');
    await page.getByRole('button', { name: 'New Reminder' }).click();

    const dialog = page.getByRole('dialog', { name: 'Create Reminder' });
    await expect(dialog).toBeVisible();

    // Try to submit without required fields
    await dialog.getByRole('button', { name: 'Create Reminder' }).click();

    await expect(page.getByText('Title is required').first()).toBeVisible();
    await expect(page.getByText('Remind At is required').first()).toBeVisible();

    // Fill the title but leave the native datetime-local value empty.
    await page.getByLabel('Title').fill(uniqueLabel('e2e-reminder'));
    await dialog.getByRole('button', { name: 'Create Reminder' }).click();

    await expect(page.getByText('Remind At is required').first()).toBeVisible();

    await expectNoConsoleErrors(page, errors, 'reminder form validation');
  });

  test('project creation form validates required fields', async ({ page }) => {
    const errors = captureConsoleErrors(page);

    await page.goto('/projects');
    await page.getByRole('button', { name: 'New Project' }).click();

    const dialog = page.getByRole('dialog', { name: 'Create Project' });
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: 'Create Project' }).click();

    await expect(page.getByText('Name is required').first()).toBeVisible();
    await expect(page.getByLabel('Name')).toHaveAttribute('aria-invalid', 'true');

    await expectNoConsoleErrors(page, errors, 'project form validation');
  });

  test('search form handles empty query', async ({ page }) => {
    const errors = captureConsoleErrors(page);

    await page.goto('/search');
    await expect(page.getByRole('heading', { name: 'Search', exact: true })).toBeVisible();

    // Submit empty search
    await page.getByRole('button', { name: 'Search' }).click();

    // Should show empty state or no results
    await expect(page.getByText('Enter a search query').first()).toBeVisible();

    await expectNoConsoleErrors(page, errors, 'empty search');
  });

  test('form error messages are announced to screen readers', async ({ page }) => {
    const errors = captureConsoleErrors(page);

    await page.goto('/tasks');
    await page.getByRole('button', { name: 'New Task' }).click();

    const dialog = page.getByRole('dialog', { name: 'Create Task' });
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: 'Create Task' }).click();

    // Error message should have role="alert" or be associated via aria-describedby
    const errorMessage = page.getByText('Title is required').first();
    await expect(errorMessage).toBeVisible();

    const titleInput = page.getByLabel('Title');
    await expect(titleInput).toHaveAttribute('aria-invalid', 'true');
    const describedBy = await titleInput.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();

    await expectNoConsoleErrors(page, errors, 'accessible error messages');
  });
});

test.describe('Empty States, Failed API Requests, Missing-Record Detail Pages', () => {
  test('empty tasks list shows empty state', async ({ page }) => {
    const errors = captureConsoleErrors(page);

    await page.goto('/tasks?status=CANCELLED');
    await expect(page.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible();

    // Other workflow tests create tasks, so use an empty status partition.
    await expect(page.getByText('No cancelled tasks').first()).toBeVisible();
    await expect(page.getByText('Create your first task to get started.').first()).toBeVisible();

    await expectNoConsoleErrors(page, errors, 'empty tasks list');
  });

  test('empty notes list shows empty state', async ({ page }) => {
    const errors = captureConsoleErrors(page);

    await page.route('**/api/notes*', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [], total: 0 }),
    }));
    await page.goto('/notes');
    await expect(page.getByRole('heading', { name: 'Notes', exact: true })).toBeVisible();

    await expect(page.getByText('No notes yet').first()).toBeVisible();
    await expect(
      page.getByText('Create a note to save information, links, or references.').first(),
    ).toBeVisible();

    await expectNoConsoleErrors(page, errors, 'empty notes list');
  });

  test('empty reminders list shows empty state', async ({ page }) => {
    const errors = captureConsoleErrors(page);

    await page.route('**/api/reminders*', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [], total: 0 }),
    }));
    await page.goto('/reminders');
    await expect(page.getByRole('heading', { name: 'Reminders', exact: true })).toBeVisible();

    await expect(page.getByText('No reminders yet').first()).toBeVisible();
    await expect(page.getByText('Create a reminder to get notified on time.').first()).toBeVisible();

    await expectNoConsoleErrors(page, errors, 'empty reminders list');
  });

  test('empty projects list shows empty state', async ({ page }) => {
    const errors = captureConsoleErrors(page);

    // GET /api/projects is paginated (Round 2, S2).
    await page.route('**/api/projects*', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [], total: 0, limit: 25, offset: 0 }),
    }));
    await page.goto('/projects');
    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();

    await expect(page.getByText('No projects yet').first()).toBeVisible();
    await expect(
      page.getByText('Create a project to organize your tasks, notes, and ideas.').first(),
    ).toBeVisible();

    await expectNoConsoleErrors(page, errors, 'empty projects list');
  });

  test('empty ideas list shows empty state', async ({ page }) => {
    const errors = captureConsoleErrors(page);

    await page.route('**/api/ideas*', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [], total: 0 }),
    }));
    await page.goto('/ideas');
    await expect(page.getByRole('heading', { name: 'Ideas', exact: true })).toBeVisible();

    await expect(page.getByText('No ideas yet').first()).toBeVisible();
    await expect(page.getByText('Capture your thoughts and inspirations.').first()).toBeVisible();

    await expectNoConsoleErrors(page, errors, 'empty ideas list');
  });

  test('empty events list shows empty state', async ({ page }) => {
    const errors = captureConsoleErrors(page);

    await page.route('**/api/events*', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [], total: 0 }),
    }));
    await page.goto('/events');
    await expect(page.getByRole('heading', { name: 'Events', exact: true })).toBeVisible();

    await expect(page.getByText('No events yet').first()).toBeVisible();
    await expect(page.getByText('Schedule appointments and happenings.').first()).toBeVisible();

    await expectNoConsoleErrors(page, errors, 'empty events list');
  });

  test('missing task detail page shows 404', async ({ page }) => {
    const errors = captureConsoleErrors(page);

    await page.goto('/tasks/non-existent-id');
    await expect(page.getByRole('heading', { name: 'Not Found', exact: true })).toBeVisible();
    await expect(page.getByText('The task you are looking for does not exist').first()).toBeVisible();

    await expectNoConsoleErrors(page, errors, 'missing task detail');
  });

  test('missing note detail page shows 404', async ({ page }) => {
    const errors = captureConsoleErrors(page);

    await page.goto('/notes/non-existent-id');
    await expect(page.getByRole('heading', { name: 'Not Found', exact: true })).toBeVisible();
    await expect(page.getByText('The note you are looking for does not exist').first()).toBeVisible();

    await expectNoConsoleErrors(page, errors, 'missing note detail');
  });

  test('missing reminder detail page shows 404', async ({ page }) => {
    const errors = captureConsoleErrors(page);

    await page.goto('/reminders/non-existent-id');
    await expect(page.getByRole('heading', { name: 'Not Found', exact: true })).toBeVisible();
    await expect(page.getByText('The reminder you are looking for does not exist').first()).toBeVisible();

    await expectNoConsoleErrors(page, errors, 'missing reminder detail');
  });

  test('failed API request shows error toast', async ({ page }) => {
    const errors = captureConsoleErrors(page);

    // Create a task first
    const title = uniqueLabel('e2e-task');
    await page.goto('/tasks');
    await page.getByRole('button', { name: 'New Task' }).click();
    const createDialog = page.getByRole('dialog', { name: 'Create Task' });
    await expect(createDialog).toBeVisible();
    await page.getByLabel('Title').fill(title);
    await createDialog.getByRole('button', { name: 'Create Task' }).click();
    await expect(page.getByText('Task created')).toBeVisible();

    // Intercept and fail the update request
    await page.route('**/api/tasks/**', (route) => {
      if (route.request().method() === 'PATCH') {
        route.fulfill({ status: 500, body: 'Internal Server Error' });
      } else {
        route.continue();
      }
    });

    const row = page.locator('.list-item', { hasText: title });
    await expect(row).toBeVisible();

    const select = row.getByRole('combobox');
    await select.selectOption('IN_PROGRESS');

    // Should show error toast
    await expect(page.getByText('Failed to update task').first()).toBeVisible();

    await page.unroute('**/api/tasks/**');
    await expectNoConsoleErrors(page, errors, 'failed API request');
  });

  test('network error during capture shows error', async ({ page }) => {
    const errors = captureConsoleErrors(page);

    await page.goto('/capture');

    // Intercept and fail the capture request
    await page.route('**/api/captures', (route) => {
      route.fulfill({ status: 500, body: 'Internal Server Error' });
    });

    await page.getByLabel("What's on your mind?").fill('Test capture');
    await page.getByRole('button', { name: 'Save Capture' }).click();

    await expect(page.getByText('Failed to save capture').first()).toBeVisible();

    await page.unroute('**/api/captures');
    await expectNoConsoleErrors(page, errors, 'network error capture');
  });
});

test.describe('Dialog Open/Close/Action Buttons', () => {
  test('create task dialog opens, closes, and submits', async ({ page }) => {
    const errors = captureConsoleErrors(page);

    await page.goto('/tasks');

    // Open dialog
    await page.getByRole('button', { name: 'New Task' }).click();
    const dialog = page.getByRole('dialog', { name: 'Create Task' });
    await expect(dialog).toBeVisible();

    // Close with Cancel button
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();

    // Open again
    await page.getByRole('button', { name: 'New Task' }).click();
    await expect(dialog).toBeVisible();

    // Close with Escape key
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();

    // Open and submit
    await page.getByRole('button', { name: 'New Task' }).click();
    await expect(dialog).toBeVisible();

    const title = uniqueLabel('e2e-task-dialog');
    await page.getByLabel('Title').fill(title);
    await page.getByLabel('Description').fill('Test description');
    await dialog.getByRole('button', { name: 'Create Task' }).click();

    await expect(page.getByText('Task created')).toBeVisible();
    await expect(dialog).not.toBeVisible();

    await expectNoConsoleErrors(page, errors, 'task dialog');
  });

  test('create note dialog opens, closes, and submits', async ({ page }) => {
    const errors = captureConsoleErrors(page);

    await page.goto('/notes');

    await page.getByRole('button', { name: 'New Note' }).click();
    const dialog = page.getByRole('dialog', { name: 'Create Note' });
    await expect(dialog).toBeVisible();

    // Close with X button
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).not.toBeVisible();

    // Open and submit
    await page.getByRole('button', { name: 'New Note' }).click();
    await expect(dialog).toBeVisible();

    const title = uniqueLabel('e2e-note-dialog');
    await page.getByLabel('Title (optional)').fill(title);
    await page.getByLabel('Body').fill('Test body');
    await dialog.getByRole('button', { name: 'Create Note' }).click();

    await expect(page.getByText('Note created')).toBeVisible();
    await expect(dialog).not.toBeVisible();

    await expectNoConsoleErrors(page, errors, 'note dialog');
  });

  test('create reminder dialog opens, closes, and submits', async ({ page }) => {
    const errors = captureConsoleErrors(page);

    await page.goto('/reminders');

    await page.getByRole('button', { name: 'New Reminder' }).click();
    const dialog = page.getByRole('dialog', { name: 'Create Reminder' });
    await expect(dialog).toBeVisible();

    // Close with Escape
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();

    // Open and submit
    await page.getByRole('button', { name: 'New Reminder' }).click();
    await expect(dialog).toBeVisible();

    const title = uniqueLabel('e2e-reminder-dialog');
    await page.getByLabel('Title').fill(title);
    await page.getByLabel('Remind At').fill('2032-01-15T09:30');
    await dialog.getByRole('button', { name: 'Create Reminder' }).click();

    await expect(page.getByText('Reminder created')).toBeVisible();
    await expect(dialog).not.toBeVisible();

    await expectNoConsoleErrors(page, errors, 'reminder dialog');
  });

  test('create project dialog opens, closes, and submits', async ({ page }) => {
    const errors = captureConsoleErrors(page);

    await page.goto('/projects');

    await page.getByRole('button', { name: 'New Project' }).click();
    const dialog = page.getByRole('dialog', { name: 'Create Project' });
    await expect(dialog).toBeVisible();

    // Close with Cancel
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();

    // Open and submit
    await page.getByRole('button', { name: 'New Project' }).click();
    await expect(dialog).toBeVisible();

    const name = uniqueLabel('e2e-project-dialog');
    await page.getByLabel('Name').fill(name);
    await page.getByLabel('Description (optional)').fill('Test description');
    await dialog.getByRole('button', { name: 'Create Project' }).click();

    await expect(page.getByText('Project created')).toBeVisible();
    await expect(dialog).not.toBeVisible();

    await expectNoConsoleErrors(page, errors, 'project dialog');
  });

  test('snooze reminder dialog works', async ({ page }) => {
    const errors = captureConsoleErrors(page);

    // Create a reminder first
    const title = uniqueLabel('e2e-reminder-snooze');
    await page.goto('/reminders');
    await page.getByRole('button', { name: 'New Reminder' }).click();
    const createDialog = page.getByRole('dialog', { name: 'Create Reminder' });
    await expect(createDialog).toBeVisible();
    await page.getByLabel('Title').fill(title);
    await page.getByLabel('Remind At').fill('2032-01-15T09:30');
    await createDialog.getByRole('button', { name: 'Create Reminder' }).click();
    await expect(page.getByText('Reminder created')).toBeVisible();

    // Click snooze
    const row = page.locator('.list-item', { hasText: title });
    await row.getByRole('button', { name: 'Snooze' }).click();

    const snoozeDialog = page.getByRole('dialog', { name: 'Snooze Reminder' });
    await expect(snoozeDialog).toBeVisible();

    // Close with Cancel
    await snoozeDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(snoozeDialog).not.toBeVisible();

    // Open and snooze
    await row.getByRole('button', { name: 'Snooze' }).click();
    await expect(snoozeDialog).toBeVisible();

    await snoozeDialog.getByLabel('Snooze for').selectOption('1h');
    await snoozeDialog.getByRole('button', { name: 'Snooze' }).click();

    await expect(page.getByText('Reminder snoozed')).toBeVisible();
    await expect(snoozeDialog).not.toBeVisible();

    await expectNoConsoleErrors(page, errors, 'snooze dialog');
  });

  test('delete confirmation dialog works', async ({ page }) => {
    const errors = captureConsoleErrors(page);

    // Create a task
    const title = uniqueLabel('e2e-task-delete');
    await page.goto('/tasks');
    await page.getByRole('button', { name: 'New Task' }).click();
    const createDialog = page.getByRole('dialog', { name: 'Create Task' });
    await expect(createDialog).toBeVisible();
    await page.getByLabel('Title').fill(title);
    await createDialog.getByRole('button', { name: 'Create Task' }).click();
    await expect(page.getByText('Task created')).toBeVisible();

    // Open detail page
    const row = page.locator('.list-item', { hasText: title });
    await row.getByRole('link').click();
    await expect(page).toHaveURL(/\/tasks\/[^/]+$/);

    // Click delete
    await page.getByRole('button', { name: 'Delete' }).click();

    const deleteDialog = page.getByRole('dialog', { name: 'Delete Task' });
    await expect(deleteDialog).toBeVisible();

    // Cancel deletion
    await deleteDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(deleteDialog).not.toBeVisible();

    // Confirm deletion
    await page.getByRole('button', { name: 'Delete' }).click();
    await expect(deleteDialog).toBeVisible();
    await deleteDialog.getByRole('button', { name: 'Delete' }).click();

    await expect(page.getByText('Task deleted')).toBeVisible();
    await expect(page).toHaveURL('/tasks');

    await expectNoConsoleErrors(page, errors, 'delete confirmation dialog');
  });

  test('dialog backdrop click closes dialog', async ({ page }) => {
    const errors = captureConsoleErrors(page);

    await page.goto('/tasks');
    await page.getByRole('button', { name: 'New Task' }).click();

    const dialog = page.getByRole('dialog', { name: 'Create Task' });
    await expect(dialog).toBeVisible();

    // Click on overlay (backdrop)
    await page.locator('.modal-overlay').click({ position: { x: 10, y: 10 } });
    await expect(dialog).not.toBeVisible();

    await expectNoConsoleErrors(page, errors, 'dialog backdrop click');
  });
});

test.describe('Desktop and Mobile Viewports', () => {
  test('desktop viewport (1440x900) renders correctly', async ({ page }) => {
    const errors = captureConsoleErrors(page);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Recall Home' })).toBeVisible();

    // Sidebar should be visible
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();

    // All nav items visible
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(nav.getByRole('link', { name: 'Overview', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Tasks', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Settings', exact: true })).toBeVisible();

    await expectNoConsoleErrors(page, errors, 'desktop viewport');
  });

  test('tablet viewport (768x1024) renders correctly', async ({ page }) => {
    const errors = captureConsoleErrors(page);

    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Recall Home' })).toBeVisible();

    // Sidebar should be hidden by default on tablet
    const sidebar = page.locator('.sidebar');
    // Check if sidebar is transformed off-screen
    const sidebarStyle = await sidebar.evaluate((el) => window.getComputedStyle(el).transform);
    expect(sidebarStyle).not.toBe('none');

    // Mobile menu button should be visible
    await expect(page.getByRole('button', { name: 'Open menu' })).toBeVisible();

    await expectNoConsoleErrors(page, errors, 'tablet viewport');
  });

  test('mobile viewport (375x667) renders correctly', async ({ page }) => {
    const errors = captureConsoleErrors(page);

    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Recall Home' })).toBeVisible();

    // Sidebar should be hidden
    const sidebar = page.locator('.sidebar');
    const sidebarStyle = await sidebar.evaluate((el) => window.getComputedStyle(el).transform);
    expect(sidebarStyle).not.toBe('none');

    // Mobile menu button should be visible
    await expect(page.getByRole('button', { name: 'Open menu' })).toBeVisible();

    // Open sidebar
    await page.getByRole('button', { name: 'Open menu' }).click();
    await expect(page.locator('.sidebar-overlay.open')).toBeVisible();
    await expect(page.locator('.sidebar.open')).toBeVisible();

    // Navigate via mobile sidebar
    await page.getByRole('link', { name: 'Tasks', exact: true }).click();
    await expect(page).toHaveURL('/tasks');
    await expect(page.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible();

    // Sidebar should close after navigation
    await expect(page.locator('.sidebar.open')).not.toBeVisible();

    await expectNoConsoleErrors(page, errors, 'mobile viewport');
  });

  test('mobile viewport - form dialogs are usable', async ({ page }) => {
    const errors = captureConsoleErrors(page);

    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/tasks');

    await page.getByRole('button', { name: 'New Task' }).click();
    const dialog = page.getByRole('dialog', { name: 'Create Task' });
    await expect(dialog).toBeVisible();

    // On a phone the dialog is a bottom sheet: full width, inside the
    // viewport, anchored to the bottom edge (Round 2 design, decision D1).
    const modal = page.locator('.modal');
    // Wait for the short slide-up animation to settle before measuring.
    await expect
      .poll(async () => {
        const box = await modal.boundingBox();
        return box ? Math.round(box.y + box.height) : null;
      })
      .toBe(667);
    const modalBox = await modal.boundingBox();
    expect(modalBox).toBeTruthy();
    if (modalBox) {
      expect(modalBox.x).toBeGreaterThanOrEqual(0);
      expect(modalBox.width).toBeLessThanOrEqual(375);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    // Fill form on mobile
    await page.getByLabel('Title').fill(uniqueLabel('e2e-mobile-task'));
    await dialog.getByRole('button', { name: 'Create Task' }).click();

    await expect(page.getByText('Task created')).toBeVisible();

    await expectNoConsoleErrors(page, errors, 'mobile dialog');
  });

  test('responsive navigation works across viewports', async ({ page }) => {
    const errors = captureConsoleErrors(page);

    // Test desktop
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();

    // Test tablet
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Open menu' })).toBeVisible();

    // Test mobile
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Open menu' })).toBeVisible();

    await expectNoConsoleErrors(page, errors, 'responsive navigation');
  });
});

test.describe('Browser Console Errors During Workflows', () => {
  test('no console errors during login flow', async ({ page, browser }) => {
    const context = await unauthenticatedContext(browser);
    const loginPage = await context.newPage();
    const errors = captureConsoleErrors(loginPage);
    const { password } = readE2eEnv();

    await loginPage.goto('/login');
    await loginPage.getByLabel('Password').fill(password);
    await loginPage.getByRole('button', { name: 'Sign In' }).click();
    await expect(loginPage).toHaveURL('/');

    await expectNoConsoleErrors(loginPage, errors, 'login flow');
    await context.close();
  });

  test('no console errors during task CRUD operations', async ({ page }) => {
    const errors = captureConsoleErrors(page);
    const failures = captureApplicationFailures(page);

    // Create
    const title = uniqueLabel('e2e-console-task');
    await page.goto('/tasks');
    await page.getByRole('button', { name: 'New Task' }).click();
    const createDialog = page.getByRole('dialog', { name: 'Create Task' });
    await expect(createDialog).toBeVisible();
    await page.getByLabel('Title').fill(title);
    await createDialog.getByRole('button', { name: 'Create Task' }).click();
    await expect(page.getByText('Task created')).toBeVisible();

    // Read
    const row = page.locator('.list-item', { hasText: title });
    await row.getByRole('link').click();
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();

    // Update
    await page.getByRole('button', { name: 'Edit' }).click();
    const editDialog = page.getByRole('dialog', { name: 'Edit Task' });
    await expect(editDialog).toBeVisible();
    await page.getByLabel('Title').fill(`${title}-updated`);
    await editDialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Task updated')).toBeVisible();

    // Delete
    await page.getByRole('button', { name: 'Delete' }).click();
    const deleteDialog = page.getByRole('dialog', { name: 'Delete Task' });
    await expect(deleteDialog).toBeVisible();
    await deleteDialog.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText('Task deleted')).toBeVisible();

    await expectNoConsoleErrors(page, errors, 'task CRUD');
    await expectNoApplicationFailures(failures, 'task CRUD');
  });

  test('no console errors during navigation', async ({ page }) => {
    const errors = captureConsoleErrors(page);
    const failures = captureApplicationFailures(page);

    const routes = ['/', '/capture', '/tasks', '/reminders', '/search', '/notes', '/ideas', '/events', '/projects', '/settings'];

    for (const route of routes) {
      await page.goto(route);
      await page.waitForLoadState('networkidle');
    }

    await expectNoConsoleErrors(page, errors, 'navigation');
    await expectNoApplicationFailures(failures, 'navigation');
  });

  test('no console errors during dialog interactions', async ({ page }) => {
    const errors = captureConsoleErrors(page);

    // Test multiple dialogs
    await page.goto('/tasks');
    await page.getByRole('button', { name: 'New Task' }).click();
    await page.keyboard.press('Escape');

    await page.goto('/notes');
    await page.getByRole('button', { name: 'New Note' }).click();
    await page.keyboard.press('Escape');

    await page.goto('/reminders');
    await page.getByRole('button', { name: 'New Reminder' }).click();
    await page.keyboard.press('Escape');

    await page.goto('/projects');
    await page.getByRole('button', { name: 'New Project' }).click();
    await page.keyboard.press('Escape');

    await expectNoConsoleErrors(page, errors, 'dialog interactions');
  });

  test('no console errors during form validation', async ({ page }) => {
    const errors = captureConsoleErrors(page);

    await page.goto('/tasks');
    await page.getByRole('button', { name: 'New Task' }).click();
    const dialog = page.getByRole('dialog', { name: 'Create Task' });
    await expect(dialog).toBeVisible();

    // Trigger validation
    await dialog.getByRole('button', { name: 'Create Task' }).click();
    await expect(page.getByText('Title is required').first()).toBeVisible();

    // Fix and submit
    await page.getByLabel('Title').fill(uniqueLabel('e2e-validation'));
    await dialog.getByRole('button', { name: 'Create Task' }).click();
    await expect(page.getByText('Task created')).toBeVisible();

    await expectNoConsoleErrors(page, errors, 'form validation');
  });

  test('no console errors during search', async ({ page }) => {
    const errors = captureConsoleErrors(page);

    await page.goto('/search');
    await page.getByLabel('Search').fill('test query');
    await page.getByRole('button', { name: 'Search' }).click();

    await expectNoConsoleErrors(page, errors, 'search');
  });

  test('no console errors during reminder snooze', async ({ page }) => {
    const errors = captureConsoleErrors(page);
    const failures = captureApplicationFailures(page);

    // Create reminder
    const title = uniqueLabel('e2e-console-reminder');
    await page.goto('/reminders');
    await page.getByRole('button', { name: 'New Reminder' }).click();
    const createDialog = page.getByRole('dialog', { name: 'Create Reminder' });
    await expect(createDialog).toBeVisible();
    await page.getByLabel('Title').fill(title);
    await page.getByLabel('Remind At').fill('2032-01-15T09:30');
    await createDialog.getByRole('button', { name: 'Create Reminder' }).click();
    await expect(page.getByText('Reminder created')).toBeVisible();

    // Snooze
    const row = page.locator('.list-item', { hasText: title });
    await row.getByRole('button', { name: 'Snooze' }).click();
    const snoozeDialog = page.getByRole('dialog', { name: 'Snooze Reminder' });
    await expect(snoozeDialog).toBeVisible();
    await snoozeDialog.getByLabel('Snooze for').selectOption('1h');
    await snoozeDialog.getByRole('button', { name: 'Snooze' }).click();
    await expect(page.getByText('Reminder snoozed')).toBeVisible();

    await expectNoConsoleErrors(page, errors, 'reminder snooze');
    await expectNoApplicationFailures(failures, 'reminder snooze');
  });
});

test.describe('Dark Mode Browser Workflows', () => {
  test('keyboard navigation works in dark mode', async ({ page, browser }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'en-US',
      timezoneId: 'UTC',
      colorScheme: 'dark',
      storageState: await page.context().storageState(),
    });
    const darkPage = await context.newPage();
    const errors = captureConsoleErrors(darkPage);

    await darkPage.goto('/');
    await expect(darkPage.getByRole('link', { name: 'Recall Home' })).toBeVisible();

    const nav = darkPage.getByRole('navigation', { name: 'Main navigation' });
    const firstLink = nav.getByRole('link', { name: 'Overview', exact: true });

    await firstLink.focus();
    await expect(firstLink).toBeFocused();

    await darkPage.keyboard.press('Tab');
    await expect(nav.getByRole('link', { name: 'Quick Capture', exact: true })).toBeFocused();

    await expectNoConsoleErrors(darkPage, errors, 'dark mode keyboard navigation');
    await context.close();
  });

  test('dialogs work in dark mode', async ({ page, browser }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'en-US',
      timezoneId: 'UTC',
      colorScheme: 'dark',
      storageState: await page.context().storageState(),
    });
    const darkPage = await context.newPage();
    const errors = captureConsoleErrors(darkPage);

    await darkPage.goto('/tasks');
    await darkPage.getByRole('button', { name: 'New Task' }).click();

    const dialog = darkPage.getByRole('dialog', { name: 'Create Task' });
    await expect(dialog).toBeVisible();

    await darkPage.getByLabel('Title').fill(uniqueLabel('e2e-dark-task'));
    await dialog.getByRole('button', { name: 'Create Task' }).click();

    await expect(darkPage.getByText('Task created')).toBeVisible();

    await expectNoConsoleErrors(darkPage, errors, 'dark mode dialog');
    await context.close();
  });

  test('form validation works in dark mode', async ({ page, browser }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'en-US',
      timezoneId: 'UTC',
      colorScheme: 'dark',
      storageState: await page.context().storageState(),
    });
    const darkPage = await context.newPage();
    const errors = captureConsoleErrors(darkPage);

    await darkPage.goto('/tasks');
    await darkPage.getByRole('button', { name: 'New Task' }).click();
    const dialog = darkPage.getByRole('dialog', { name: 'Create Task' });
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: 'Create Task' }).click();
    await expect(darkPage.getByText('Title is required').first()).toBeVisible();
    await expect(darkPage.getByLabel('Title')).toHaveAttribute('aria-invalid', 'true');

    await darkPage.getByLabel('Title').fill(uniqueLabel('e2e-dark-validation'));
    await dialog.getByRole('button', { name: 'Create Task' }).click();
    await expect(darkPage.getByText('Task created')).toBeVisible();

    await expectNoConsoleErrors(darkPage, errors, 'dark mode form validation');
    await context.close();
  });

  test('empty states render correctly in dark mode', async ({ page, browser }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'en-US',
      timezoneId: 'UTC',
      colorScheme: 'dark',
      storageState: await page.context().storageState(),
    });
    const darkPage = await context.newPage();
    const errors = captureConsoleErrors(darkPage);

    await darkPage.goto('/tasks?status=CANCELLED');
    await expect(darkPage.getByText('No cancelled tasks').first()).toBeVisible();

    await darkPage.route('**/api/notes*', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [], total: 0 }),
    }));
    await darkPage.goto('/notes');
    await expect(darkPage.getByText('No notes yet').first()).toBeVisible();

    await darkPage.route('**/api/reminders*', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [], total: 0 }),
    }));
    await darkPage.goto('/reminders');
    await expect(darkPage.getByText('No reminders yet').first()).toBeVisible();

    await expectNoConsoleErrors(darkPage, errors, 'dark mode empty states');
    await context.close();
  });
});
