import { expect, test } from '@playwright/test';

import { DASHBOARD_CSP } from '../src/csp';

/**
 * R3-03: the dashboard runs under the production Content-Security-Policy
 * (served here by `vite preview`, in production by Caddy) without a single
 * violation, and the policy is really enforced.
 */

const PAGES = [
  '/',
  '/briefing',
  '/ask',
  '/capture',
  '/inbox',
  '/tasks',
  '/reminders',
  '/notes',
  '/ideas',
  '/events',
  '/projects',
  '/search',
  '/settings',
  '/settings/data',
];

test('every page loads under the production CSP with no violations', async ({ page }) => {
  await page.addInitScript(() => {
    const store = window as unknown as { __cspViolations: string[] };
    store.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      store.__cspViolations.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  const consoleReports: string[] = [];
  page.on('console', (message) => {
    if (/content.security.policy/i.test(message.text())) consoleReports.push(message.text());
  });

  const first = await page.goto('/');
  expect(first?.headers()['content-security-policy']).toBe(DASHBOARD_CSP);

  for (const path of PAGES) {
    await page.goto(path);
    await expect(page.getByRole('main')).toBeVisible();
    await page.waitForLoadState('networkidle');
    const violations = await page.evaluate(
      () => (window as unknown as { __cspViolations: string[] }).__cspViolations,
    );
    expect(violations, path).toEqual([]);
  }
  expect(consoleReports).toEqual([]);
});

test('the policy is enforced: an injected inline script does not run', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('main')).toBeVisible();
  const ran = await page.evaluate(() => {
    const script = document.createElement('script');
    script.textContent = '(window).__inlineRan = true';
    document.head.appendChild(script);
    return (window as unknown as { __inlineRan?: boolean }).__inlineRan === true;
  });
  expect(ran).toBe(false);
});
