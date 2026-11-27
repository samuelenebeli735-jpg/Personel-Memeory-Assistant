/**
 * HTTP boundary hardening.
 *
 * These are integration tests over the real Fastify instance: proxy trust is
 * observed through `request.ip`, and the public webhook is driven through the
 * same route-level rate limiter used in production.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { API_CSP, buildServer, GLOBAL_RATE_LIMIT_PER_MINUTE, type BuildServerOptions } from '../../src/http/server.js';
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

  it('reports the 240/minute limit to clients when no test override is set', async () => {
    const app = await buildApp({ TRUST_PROXY: 'false' }, { enableRateLimit: true });
    try {
      const response = await app.inject({ method: 'GET', url: '/test/ip', remoteAddress: '10.4.5.7' });
      expect(response.statusCode).toBe(200);
      expect(response.headers['x-ratelimit-limit']).toBe(String(GLOBAL_RATE_LIMIT_PER_MINUTE));
      expect(GLOBAL_RATE_LIMIT_PER_MINUTE).toBe(240);
    } finally {
      await app.close();
    }
  });

  it('raises only the global limit when the test-only override is set', async () => {
    const app = await buildApp(
      { TRUST_PROXY: 'false', RECALL_TEST_RATE_LIMIT_PER_MINUTE: '250' },
      { enableRateLimit: true },
    );

    try {
      // Requests 241-250 would have been refused at the production limit.
      for (let i = 0; i < 250; i += 1) {
        const response = await app.inject({ method: 'GET', url: '/test/ip', remoteAddress: '10.4.5.8' });
        expect(response.statusCode).toBe(200);
        expect(response.headers['x-ratelimit-limit']).toBe('250');
      }
      // Still a limit: the 251st request is refused.
      const limited = await app.inject({ method: 'GET', url: '/test/ip', remoteAddress: '10.4.5.8' });
      expect(limited.statusCode, limited.body).toBe(429);

      // Login keeps its own, tighter limit of 10 per minute.
      for (let i = 0; i < 10; i += 1) {
        const login = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          remoteAddress: '10.4.5.9',
          payload: { password: 'wrong-password' },
        });
        expect(login.statusCode).not.toBe(429);
      }
      const loginLimited = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: '10.4.5.9',
        payload: { password: 'wrong-password' },
      });
      expect(loginLimited.statusCode, loginLimited.body).toBe(429);
    } finally {
      await app.close();
    }
  });
});

describe('API security headers (R3-03)', () => {
  it('every API response, including errors and unknown routes, forbids loading or running anything', async () => {
    const app = await buildApp();
    try {
      for (const [method, url] of [
        ['GET', '/api/health/live'],
        ['GET', '/api/health/scheduler'],
        ['GET', '/api/settings'],
        ['GET', '/api/nope'],
        ['POST', '/api/auth/login'],
      ] as const) {
        const response = await app.inject({ method, url, ...(method === 'POST' ? { payload: {} } : {}) });
        expect(response.headers['content-security-policy'], `${method} ${url}`).toBe(API_CSP);
        expect(response.headers['x-content-type-options'], `${method} ${url}`).toBe('nosniff');
      }
    } finally {
      await app.close();
    }
  });

  it('the API policy allows nothing at all', () => {
    expect(API_CSP).toMatch(/^default-src 'none';/);
    expect(API_CSP).toContain("frame-ancestors 'none'");
    expect(API_CSP).not.toMatch(/'self'|unsafe/);
  });
});

describe('trusted proxy under Docker Compose (R3-03)', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  const compose = fs.readFileSync(path.join(repoRoot, 'compose.yaml'), 'utf8');
  const proxyDefault = /ipv4_address: \$\{RECALL_PROXY_IP:-([\d.]+)\}/.exec(compose)?.[1];
  const subnetDefault = /subnet: \$\{RECALL_SUBNET:-([\d.]+)\/(\d+)\}/.exec(compose);

  it('compose pins the subnet and Caddy, and trusts exactly that address', () => {
    expect(proxyDefault).toBe('172.31.250.10');
    expect(subnetDefault?.slice(1)).toEqual(['172.31.250.0', '24']);
    // The app's TRUST_PROXY comes from the same variable and default as Caddy's address.
    expect(compose).toContain(`TRUST_PROXY: \${RECALL_PROXY_IP:-${proxyDefault}}`);
    // The address is inside the subnet (/24: same first three octets).
    expect(proxyDefault!.split('.').slice(0, 3)).toEqual(subnetDefault![1]!.split('.').slice(0, 3));
    // The example env no longer sets a broad range itself.
    const example = fs.readFileSync(path.join(repoRoot, '.env.production.example'), 'utf8');
    expect(example).not.toMatch(/^TRUST_PROXY=/m);
  });

  const viaCaddy = { remoteAddress: '172.31.250.10' };

  it('honours X-Forwarded-For from Caddy only, not from another container on the network', async () => {
    const app = await buildApp({ TRUST_PROXY: proxyDefault! });
    try {
      const fromCaddy = await app.inject({ method: 'GET', url: '/test/ip', ...viaCaddy, headers: { 'x-forwarded-for': '203.0.113.7' } });
      expect(fromCaddy.json()).toEqual({ ip: '203.0.113.7' });
      const neighbour = await app.inject({
        method: 'GET',
        url: '/test/ip',
        remoteAddress: '172.31.250.11',
        headers: { 'x-forwarded-for': '203.0.113.7' },
      });
      expect(neighbour.json()).toEqual({ ip: '172.31.250.11' });
    } finally {
      await app.close();
    }
  });

  it('a spoofed X-Forwarded-For cannot dodge the login limit', async () => {
    const app = await buildApp({ TRUST_PROXY: proxyDefault! }, { enableRateLimit: true });
    const login = (remoteAddress: string, forwardedFor: string) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress,
        headers: { 'x-forwarded-for': forwardedFor },
        payload: { password: 'wrong-password' },
      });
    try {
      // A direct client rotating forged addresses still shares one bucket.
      for (let i = 0; i < 10; i += 1) expect((await login('198.51.100.9', `203.0.113.${i}`)).statusCode).toBe(401);
      expect((await login('198.51.100.9', '203.0.113.99')).statusCode).toBe(429);

      // Through Caddy, one real client is limited on its own address ...
      for (let i = 0; i < 10; i += 1) expect((await login(viaCaddy.remoteAddress, '192.0.2.50')).statusCode).toBe(401);
      expect((await login(viaCaddy.remoteAddress, '192.0.2.50')).statusCode).toBe(429);
      // ... without locking out a different client behind the same proxy.
      expect((await login(viaCaddy.remoteAddress, '192.0.2.51')).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe('Caddy access log redaction (R3-03)', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  const caddyfile = fs.readFileSync(path.join(repoRoot, 'deploy', 'Caddyfile'), 'utf8');
  const logBlock = /\n\tlog \{[\s\S]*?\n\t\}/.exec(caddyfile)?.[0] ?? '';

  it('drops the query string from the request URI and the Referer header', () => {
    expect(logBlock).toContain('format filter {');
    expect(logBlock).toContain('wrap json');
    expect(logBlock).toMatch(/request>uri regexp "\[\?\]\.\*\$" ""/);
    expect(logBlock).toMatch(/request>headers>Referer regexp "\[\?\]\.\*\$" ""/);
    expect(logBlock).not.toMatch(/^\s*format json\s*$/m);
  });

  it('the redaction pattern keeps the path and removes everything from "?"', () => {
    // The same regular expression Caddy applies (Go RE2 and JavaScript agree on it).
    const redact = (value: string) => value.replace(/[?].*$/, '');
    expect(redact('/api/search?q=private+words')).toBe('/api/search');
    expect(redact('/api/export/restore/file?sha256=abc&token=t')).toBe('/api/export/restore/file');
    expect(redact('https://recall.example/search?q=secret')).toBe('https://recall.example/search');
    expect(redact('/tasks')).toBe('/tasks');
  });
});

describe('Docker base images are pinned (R3-04)', () => {
  it('every external FROM image carries a sha256 index digest', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
    const dockerfile = fs.readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8');
    const stages = new Set([...dockerfile.matchAll(/^FROM\s+\S+\s+AS\s+(\S+)/gim)].map((m) => m[1]!.toLowerCase()));
    const external = [...dockerfile.matchAll(/^FROM\s+(\S+)/gim)]
      .map((m) => m[1]!)
      .filter((image) => !stages.has(image.toLowerCase()));
    expect(external.length).toBeGreaterThanOrEqual(3);
    for (const image of external) expect(image).toMatch(/^[a-z0-9./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/);
  });
});
