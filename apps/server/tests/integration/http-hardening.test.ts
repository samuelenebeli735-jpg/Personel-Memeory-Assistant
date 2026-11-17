/**
 * HTTP boundary hardening.
 *
 * These are integration tests over the real Fastify instance: proxy trust is
 * observed through `request.ip`, and the public webhook is driven through the
 * same route-level rate limiter used in production.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildServer, type BuildServerOptions } from '../../src/http/server.js';
import { createTestContext, type EnvOverrides } from '../helpers/app.js';
import { createTestDatabase, type TestDb } from '../helpers/db.js';

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDatabase('http-hardening');
});

afterAll(async () => {
  await testDb.cleanup();
});

beforeEach(async () => {
  await testDb.reset();
});

async function buildApp(
  overrides: EnvOverrides = {},
  options: BuildServerOptions = {},
): Promise<FastifyInstance> {
  const { ctx } = createTestContext({ db: testDb.db, overrides });
  const app = await buildServer(ctx, { enableRateLimit: false, ...options });
  app.get('/test/ip', async (request) => ({ ip: request.ip }));
  await app.ready();
  return app;
}

describe('HTTP boundary hardening', () => {
  it('ignores X-Forwarded-For unless proxy trust is configured', async () => {
    const app = await buildApp({ TRUST_PROXY: 'false' });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/test/ip',
        remoteAddress: '10.0.0.5',
        headers: { 'x-forwarded-for': '203.0.113.7' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ip: '10.0.0.5' });
    } finally {
      await app.close();
    }
  });

  it('uses X-Forwarded-For from a configured trusted proxy list', async () => {
    const app = await buildApp({ TRUST_PROXY: '127.0.0.1,10.0.0.0/8' });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/test/ip',
        remoteAddress: '10.0.0.5',
        headers: { 'x-forwarded-for': '203.0.113.7' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ip: '203.0.113.7' });
    } finally {
      await app.close();
    }
  });

  it('rate-limits the public Telegram webhook', async () => {
    let calls = 0;
    const app = await buildApp(
      { TRUST_PROXY: 'false' },
      {
        enableRateLimit: true,
        telegramWebhook: async () => {
          calls += 1;
          return { status: 200, body: { ok: true } };
        },
      },
    );

    try {
      for (let i = 0; i < 120; i += 1) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/telegram/webhook',
          remoteAddress: '10.2.3.4',
          payload: { update_id: i },
        });
        expect(response.statusCode).toBe(200);
      }

      const limited = await app.inject({
        method: 'POST',
        url: '/api/telegram/webhook',
        remoteAddress: '10.2.3.4',
        payload: { update_id: 120 },
      });
      expect(limited.statusCode, limited.body).toBe(429);
      expect(limited.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
      expect(calls).toBe(120);
    } finally {
      await app.close();
    }
  });

  it('rate-limits the login route at 10 requests per minute', async () => {
    const app = await buildApp({ TRUST_PROXY: 'false' }, { enableRateLimit: true });

    try {
      for (let i = 0; i < 10; i += 1) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          remoteAddress: '10.3.4.5',
          payload: { password: 'wrong-password' },
        });
        expect(response.statusCode).toBe(401);
      }

      const limited = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: '10.3.4.5',
        payload: { password: 'wrong-password' },
      });
      expect(limited.statusCode, limited.body).toBe(429);
      expect(limited.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    } finally {
      await app.close();
    }
  });

  it('applies the documented 240/minute global limit to ordinary routes', async () => {
    const app = await buildApp({ TRUST_PROXY: 'false' }, { enableRateLimit: true });

    try {
      for (let i = 0; i < 240; i += 1) {
        const response = await app.inject({
          method: 'GET',
          url: '/test/ip',
          remoteAddress: '10.4.5.6',
        });
        expect(response.statusCode).toBe(200);
      }

      const limited = await app.inject({
        method: 'GET',
        url: '/test/ip',
        remoteAddress: '10.4.5.6',
      });
      expect(limited.statusCode, limited.body).toBe(429);
      expect(limited.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    } finally {
      await app.close();
    }
  });
});
