import { describe, expect, it, beforeEach } from 'vitest';

import { createTestDatabase } from '../helpers/db.js';
import { createTestApp } from '../helpers/app.js';
import { createReminder, findReminders } from '../../src/services/reminder-service.js';
import { advanceableClock } from '../../src/ports.js';

describe('reminder API', () => {
  let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: Awaited<ReturnType<typeof createTestApp>>['app'];
  let cookie: string;
  let ctx: Awaited<ReturnType<typeof createTestApp>>['ctx'];

  beforeEach(async () => {
    testDb = await createTestDatabase('reminder-api');
    const clock = advanceableClock('2026-10-17T10:00:00.000Z');
    const testApp = await createTestApp(testDb.db, { clock });
    app = testApp.app;
    ctx = testApp.ctx;
    cookie = await testApp.login();
  });

  const authHeaders = (c: string) => ({ cookie: c });

  it('creates a reminder', async () => {
    const now = new Date('2026-10-17T10:00:00.000Z');
    const remindAt = new Date(now.getTime() + 3600_000).toISOString();

    const response = await app.inject({
      method: 'POST',
      url: '/api/reminders',
      headers: authHeaders(cookie),
      payload: { title: 'API reminder', remindAt },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.title).toBe('API reminder');
    expect(body.status).toBe('SCHEDULED');
    expect(body.id).toMatch(/^[a-z0-9]{24,25}$/);
  });

  it('lists reminders', async () => {
    const now = new Date('2026-10-17T10:00:00.000Z');
    await createReminder(ctx, { title: 'First', remindAt: new Date(now.getTime() + 1000).toISOString() });
    await createReminder(ctx, { title: 'Second', remindAt: new Date(now.getTime() + 2000).toISOString() });

    const response = await app.inject({
      method: 'GET',
      url: '/api/reminders',
      headers: authHeaders(cookie),
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.items).toHaveLength(2);
    expect(body.total).toBe(2);
  });

  it('filters by status', async () => {
    const now = new Date('2026-10-17T10:00:00.000Z');
    await createReminder(ctx, { title: 'Scheduled', remindAt: new Date(now.getTime() + 1000).toISOString() });
    await createReminder(ctx, { title: 'Second', remindAt: new Date(now.getTime() + 2000).toISOString() });

    // Mark one SENT
    const reminders = await findReminders(ctx.db, { limit: 2 });
    await ctx.db.reminder.update({ where: { id: reminders[0].id }, data: { status: 'SENT' } });

    const response = await app.inject({
      method: 'GET',
      url: '/api/reminders?status=SCHEDULED',
      headers: authHeaders(cookie),
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.total).toBe(1);
    expect(body.items[0].status).toBe('SCHEDULED');
  });

  it('gets a single reminder', async () => {
    const now = new Date('2026-10-17T10:00:00.000Z');
    const created = await createReminder(ctx, { title: 'Single', remindAt: new Date(now.getTime() + 1000).toISOString() });

    const response = await app.inject({
      method: 'GET',
      url: `/api/reminders/${created.id}`,
      headers: authHeaders(cookie),
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.title).toBe('Single');
  });

  it('updates a reminder', async () => {
    const now = new Date('2026-10-17T10:00:00.000Z');
    const created = await createReminder(ctx, { title: 'Old', remindAt: new Date(now.getTime() + 1000).toISOString() });

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/reminders/${created.id}`,
      headers: authHeaders(cookie),
      payload: { title: 'Updated', remindAt: new Date(now.getTime() + 5000).toISOString() },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.title).toBe('Updated');
  });

  it('cancels a reminder', async () => {
    const now = new Date('2026-10-17T10:00:00.000Z');
    const created = await createReminder(ctx, { title: 'To cancel', remindAt: new Date(now.getTime() + 1000).toISOString() });

    const response = await app.inject({
      method: 'POST',
      url: `/api/reminders/${created.id}/cancel`,
      headers: authHeaders(cookie),
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('CANCELLED');
  });

  it('snoozes a reminder', async () => {
    const now = new Date('2026-10-17T10:00:00.000Z');
    const created = await createReminder(ctx, { title: 'To snooze', remindAt: new Date(now.getTime() + 1000).toISOString() });

    const response = await app.inject({
      method: 'POST',
      url: `/api/reminders/${created.id}/snooze`,
      headers: authHeaders(cookie),
      payload: { minutes: 60 },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(new Date(body.remindAt).getTime()).toBeGreaterThan(new Date(created.remindAt).getTime());
  });

  it('lists deliveries', async () => {
    const now = new Date('2026-10-17T10:00:00.000Z');
    const created = await createReminder(ctx, { title: 'With deliveries', remindAt: new Date(now.getTime() + 1000).toISOString() });

    const response = await app.inject({
      method: 'GET',
      url: `/api/reminders/${created.id}/deliveries`,
      headers: authHeaders(cookie),
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(Array.isArray(body)).toBe(true);
  });

  it('deletes a reminder', async () => {
    const now = new Date('2026-10-17T10:00:00.000Z');
    const created = await createReminder(ctx, { title: 'To delete', remindAt: new Date(now.getTime() + 1000).toISOString() });

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/reminders/${created.id}`,
      headers: authHeaders(cookie),
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.deleted).toBe(true);
  });

  it('refuses to edit a SENT reminder', async () => {
    const now = new Date('2026-10-17T10:00:00.000Z');
    const created = await createReminder(ctx, { title: 'Sent', remindAt: new Date(now.getTime() + 1000).toISOString() });
    await ctx.db.reminder.update({ where: { id: created.id }, data: { status: 'SENT', deliveredAt: now } });

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/reminders/${created.id}`,
      headers: authHeaders(cookie),
      payload: { title: 'New title' },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});