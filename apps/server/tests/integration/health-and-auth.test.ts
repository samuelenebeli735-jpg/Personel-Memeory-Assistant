import type { HealthDto, SettingsDto } from '@recall/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb } from '../../src/db/client.js';
import { buildServer } from '../../src/http/server.js';
import { createTestDatabase, type TestDb } from '../helpers/db.js';
import { createTestApp, TEST_PASSWORD, testConfig, testLogger, type TestApp } from '../helpers/app.js';

let testDb: TestDb;
let app: TestApp;

beforeAll(async () => {
  testDb = await createTestDatabase('health');
  app = await createTestApp(testDb.db);
});

afterAll(async () => {
  await app.close();
  await testDb.cleanup();
});

describe('liveness and authentication', () => {
  it('exposes a liveness probe without authentication', async () => {
    const response = await app.app.inject({ method: 'GET', url: '/api/health/live' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok' });
  });

  it('refuses the detailed health endpoint without a session', async () => {
    const response = await app.app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  });

  it('refuses every personal-data endpoint without a session', async () => {
    for (const url of ['/api/settings', '/api/settings']) {
      const response = await app.app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(401);
    }
  });

  it('rejects an incorrect password', async () => {
    const response = await app.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'definitely-not-the-password' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain(TEST_PASSWORD);
  });

  it('rejects a malformed login body', async () => {
    const response = await app.app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });
    expect(response.statusCode).toBe(400);
  });

  it('accepts the correct password and issues an HttpOnly cookie', async () => {
    const response = await app.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: TEST_PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    const setCookie = response.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie);
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('SameSite=Lax');
  });

  it('rejects a tampered session cookie', async () => {
    const response = await app.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { cookie: 'recall_session=v1.abc.def' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('reports the session state for the dashboard bootstrap', async () => {
    const anonymous = await app.app.inject({ method: 'GET', url: '/api/auth/session' });
    expect(anonymous.json()).toEqual({ authenticated: false });

    const cookie = await app.login();
    const authenticated = await app.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie },
    });
    expect(authenticated.json()).toMatchObject({ authenticated: true });
  });

  it('clears the session cookie on logout', async () => {
    const cookie = await app.login();
    const response = await app.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(String(response.headers['set-cookie'])).toContain('recall_session=;');
  });
});

describe('health report', () => {
  it('returns a complete, authenticated health report', async () => {
    const cookie = await app.login();
    const response = await app.app.inject({ method: 'GET', url: '/api/health', headers: { cookie } });
    expect(response.statusCode).toBe(200);
    const health = response.json() as HealthDto;
    expect(health.status).toBe('ok');
    expect(health.database.connected).toBe(true);
    expect(health.providers.ai.provider).toBe('none');
    expect(health.providers.ai.configured).toBe(false);
    expect(health.providers.telegram.enabled).toBe(false);
    expect(health.counts).toEqual({ captures: 0, tasks: 0, reminders: 0, pendingDeliveries: 0 });
  });

  it('reports degraded (not a crash) when the database is unavailable', async () => {
    const brokenDb = createDb({ url: 'file:/recall-nonexistent-dir-xyz/never.sqlite' });
    const brokenApp = await buildServer(
      {
        ...app.ctx,
        db: brokenDb,
        config: testConfig(),
        logger: testLogger(),
      },
      { enableRateLimit: false },
    );
    await brokenApp.ready();
    try {
      const cookie = await app.login();
      const response = await brokenApp.inject({ method: 'GET', url: '/api/health', headers: { cookie } });
      expect(response.statusCode).toBe(200);
      const health = response.json() as HealthDto;
      expect(health.status).toBe('degraded');
      expect(health.database.connected).toBe(false);
    } finally {
      await brokenApp.close();
      await brokenDb.$disconnect().catch(() => undefined);
    }
  });

  it('returns a structured 404 for unknown routes', async () => {
    const cookie = await app.login();
    const response = await app.app.inject({ method: 'GET', url: '/api/nope', headers: { cookie } });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});

describe('owner settings', () => {
  it('creates the singleton row from configuration on first read', async () => {
    const cookie = await app.login();
    const response = await app.app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } });
    expect(response.statusCode).toBe(200);
    const settings = response.json() as SettingsDto;
    expect(settings.timeZone).toBe('Africa/Lagos');
    expect(settings.morningDefaultTime).toBe('09:00');
    expect(settings.quietHoursStart).toBeNull();
    expect(settings.telegramOwnerConfigured).toBe(true);
    expect(settings.aiProviderConfigured).toBe(false);
  });

  it('updates settings and persists them', async () => {
    const cookie = await app.login();
    const patch = await app.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: { timeZone: 'Europe/London', quietHoursStart: '22:30', quietHoursEnd: '06:30', maxNotificationsPerDay: 12 },
    });
    expect(patch.statusCode).toBe(200);
    const updated = patch.json() as SettingsDto;
    expect(updated.timeZone).toBe('Europe/London');
    expect(updated.quietHoursStart).toBe('22:30');
    expect(updated.maxNotificationsPerDay).toBe(12);

    const reread = await app.app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } });
    expect((reread.json() as SettingsDto).timeZone).toBe('Europe/London');

    // restore for other tests in this file
    await app.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: { timeZone: 'Africa/Lagos', quietHoursStart: null, quietHoursEnd: null, maxNotificationsPerDay: 0 },
    });
  });

  it('accepts the full dashboard form payload and returns every field on re-read', async () => {
    const cookie = await app.login();
    const before = (await app.app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } })).json() as SettingsDto;

    // The exact shape the dashboard sends from a fresh install: every field,
    // with unset optional values as null (never empty strings).
    const fresh = await app.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: {
        displayName: null,
        timeZone: 'Africa/Lagos',
        morningDefaultTime: '09:00',
        eveningDefaultTime: '19:00',
        locale: 'en',
        quietHoursStart: null,
        quietHoursEnd: null,
        maxNotificationsPerDay: 0,
        reminderOverdueGraceHours: 12,
        aiEnabled: true,
        briefingEnabled: false,
        briefingTime: '07:30',
        briefingSections: ['today', 'overdue', 'upcoming'],
      },
    });
    expect(fresh.statusCode).toBe(200);

    const custom = await app.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: {
        displayName: 'Owner',
        timeZone: 'America/New_York',
        quietHoursStart: '22:00',
        quietHoursEnd: '07:00',
        aiEnabled: false,
        briefingEnabled: true,
        briefingTime: '06:45',
        briefingSections: ['ideas', 'today'],
      },
    });
    expect(custom.statusCode).toBe(200);

    const reread = (await app.app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } })).json() as SettingsDto;
    expect(reread).toMatchObject({
      displayName: 'Owner',
      timeZone: 'America/New_York',
      quietHoursStart: '22:00',
      quietHoursEnd: '07:00',
      aiEnabled: false,
      briefingEnabled: true,
      briefingTime: '06:45',
      briefingSections: ['ideas', 'today'],
    });

    // The pre-fix dashboard sent '' for unset quiet hours; that stays a 400.
    const emptyStrings = await app.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: { quietHoursStart: '', quietHoursEnd: '' },
    });
    expect(emptyStrings.statusCode).toBe(400);

    // restore for other tests in this file
    const restore = await app.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: {
        displayName: before.displayName,
        timeZone: before.timeZone,
        morningDefaultTime: before.morningDefaultTime,
        eveningDefaultTime: before.eveningDefaultTime,
        locale: before.locale,
        quietHoursStart: before.quietHoursStart,
        quietHoursEnd: before.quietHoursEnd,
        maxNotificationsPerDay: before.maxNotificationsPerDay,
        reminderOverdueGraceHours: before.reminderOverdueGraceHours,
        aiEnabled: before.aiEnabled,
        briefingEnabled: before.briefingEnabled,
        briefingTime: before.briefingTime,
        briefingSections: before.briefingSections,
      },
    });
    expect(restore.statusCode).toBe(200);
  });

  it('rejects an invalid time zone with a field-level error', async () => {
    const cookie = await app.login();
    const response = await app.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: { timeZone: 'Mars/Olympus' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('rejects a half-configured quiet-hours window', async () => {
    const cookie = await app.login();
    const response = await app.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: { quietHoursStart: '22:00', quietHoursEnd: null },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects an unknown field instead of ignoring it', async () => {
    const cookie = await app.login();
    const response = await app.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: { timeZone: 'Africa/Lagos', nonsenseField: true },
    });
    expect(response.statusCode).toBe(200);
    const settings = response.json() as SettingsDto;
    expect(settings).not.toHaveProperty('nonsenseField');
  });
});
