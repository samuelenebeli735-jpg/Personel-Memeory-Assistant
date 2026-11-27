/**
 * Individual session revocation (R3-03, N15): signing out revokes that token on
 * the server, so a copied cookie or bearer token stops working, while other
 * sessions keep working. Expired rows are pruned. The migration is additive.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../../src/db/client.js';
import { signSession } from '../../src/http/auth.js';
import { createTestApp, TEST_PASSWORD, type TestApp } from '../helpers/app.js';
import { createTestDatabase, type TestDb } from '../helpers/db.js';

let testDb: TestDb;
let app: TestApp;

beforeAll(async () => {
  testDb = await createTestDatabase('session-revocation');
  app = await createTestApp(testDb.db);
});

afterAll(async () => {
  await app.close();
  await testDb.cleanup();
});

beforeEach(async () => {
  await testDb.db.revokedSession.deleteMany();
});

const settingsWith = (headers: Record<string, string>) => app.app.inject({ method: 'GET', url: '/api/settings', headers });
const logoutWith = (headers: Record<string, string>) => app.app.inject({ method: 'POST', url: '/api/auth/logout', headers });

describe('signing out revokes the session on the server', () => {
  it('a copy of the signed-out cookie is refused afterwards', async () => {
    const cookie = await app.login();
    expect((await settingsWith({ cookie })).statusCode).toBe(200);

    const out = await logoutWith({ cookie });
    expect(out.statusCode).toBe(200);
    expect(out.json()).toEqual({ ok: true, revoked: true });

    // The browser dropped it; an attacker's copy is refused.
    const replay = await settingsWith({ cookie });
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toMatchObject({ error: { code: 'UNAUTHORIZED', details: { reason: 'revoked' } } });
    const probe = await app.app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie } });
    expect(probe.json()).toEqual({ authenticated: false, reason: 'revoked' });
  });

  it('a bearer token can be signed out the same way', async () => {
    const secret = app.ctx.config.dashboard.sessionSecret!;
    const token = signSession(secret, 1, app.clock.now());
    const authorization = `Bearer ${token}`;
    expect((await settingsWith({ authorization })).statusCode).toBe(200);

    expect((await logoutWith({ authorization })).json()).toEqual({ ok: true, revoked: true });
    expect((await settingsWith({ authorization })).statusCode).toBe(401);
  });

  it('only the signed-out session is affected: another session keeps working', async () => {
    const first = await app.login();
    const second = await app.login();
    await logoutWith({ cookie: first });

    expect((await settingsWith({ cookie: first })).statusCode).toBe(401);
    expect((await settingsWith({ cookie: second })).statusCode).toBe(200);
  });

  it('a token issued earlier (before revocation existed) works until it is signed out', async () => {
    const secret = app.ctx.config.dashboard.sessionSecret!;
    const old = signSession(secret, 24, new Date(app.clock.now().getTime() - 3_600_000));
    const cookie = `recall_session=${encodeURIComponent(old)}`;
    expect((await settingsWith({ cookie })).statusCode).toBe(200);
    await logoutWith({ cookie });
    expect((await settingsWith({ cookie })).statusCode).toBe(401);
  });

  it('signing out twice, or with no token or a forged one, is harmless', async () => {
    const cookie = await app.login();
    expect((await logoutWith({ cookie })).json()).toEqual({ ok: true, revoked: true });
    expect((await logoutWith({ cookie })).json()).toEqual({ ok: true, revoked: true });
    expect(await testDb.db.revokedSession.count()).toBe(1);

    expect((await logoutWith({})).json()).toEqual({ ok: true, revoked: false });
    const forged = signSession('a-different-secret-entirely!!', 1, app.clock.now());
    expect((await logoutWith({ authorization: `Bearer ${forged}` })).json()).toEqual({ ok: true, revoked: false });
    expect(await testDb.db.revokedSession.count()).toBe(1);
  });

  it('a signed-out token keeps its expiry, and expired rows are pruned at the next sign-out', async () => {
    const now = app.clock.now();
    await testDb.db.revokedSession.create({
      data: { nonce: 'long-gone', expiresAt: new Date(now.getTime() - 60_000), revokedAt: new Date(now.getTime() - 86_400_000) },
    });
    await testDb.db.revokedSession.create({
      data: { nonce: 'still-valid', expiresAt: new Date(now.getTime() + 3_600_000), revokedAt: now },
    });

    const cookie = await app.login();
    await logoutWith({ cookie });

    const nonces = (await testDb.db.revokedSession.findMany()).map((r) => r.nonce).sort();
    expect(nonces).toHaveLength(2);
    expect(nonces).toContain('still-valid');
    expect(nonces).not.toContain('long-gone');
    const mine = (await testDb.db.revokedSession.findMany()).find((r) => r.nonce !== 'still-valid')!;
    expect(mine.expiresAt.getTime()).toBe(now.getTime() + app.ctx.config.dashboard.sessionTtlHours * 3_600_000 - (now.getTime() % 1000));
  });

  it('when the revocation cannot be recorded, sign-out still clears the cookie and says so', async () => {
    const failing = (testDb.db as unknown as { $extends: (d: unknown) => unknown }).$extends({
      query: {
        revokedSession: {
          upsert() {
            throw new Error('injected: database is read-only');
          },
        },
      },
    }) as Db;
    const broken = await createTestApp(failing);
    try {
      const login = await broken.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: TEST_PASSWORD } });
      const raw = ([] as string[]).concat(login.headers['set-cookie'] ?? [])[0]!;
      const cookie = raw.split(';')[0]!;
      const out = await broken.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
      expect(out.statusCode).toBe(200);
      expect(out.json()).toEqual({ ok: true, revoked: false });
      expect(String(out.headers['set-cookie'])).toMatch(/recall_session=;/);
    } finally {
      await broken.close();
    }
  });
});

describe('pruning is housekeeping only', () => {
  it('a failed prune still reports the session as revoked, and it is', async () => {
    const failing = (testDb.db as unknown as { $extends: (d: unknown) => unknown }).$extends({
      query: {
        revokedSession: {
          deleteMany() {
            throw new Error('injected: prune failed');
          },
        },
      },
    }) as Db;
    const broken = await createTestApp(failing);
    try {
      const cookie = await app.login();
      const out = await broken.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
      expect(out.json()).toEqual({ ok: true, revoked: true });
      expect((await settingsWith({ cookie })).statusCode).toBe(401);
    } finally {
      await broken.close();
    }
  });
});

describe('when the sign-out list cannot be read', () => {
  it('data routes fail closed (503), while the health report and the session probe still answer', async () => {
    const failing = (testDb.db as unknown as { $extends: (d: unknown) => unknown }).$extends({
      query: {
        revokedSession: {
          findUnique() {
            throw new Error('injected: database is busy');
          },
        },
      },
    }) as Db;
    const broken = await createTestApp(failing);
    try {
      const cookie = await app.login();
      const data = await broken.app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } });
      expect(data.statusCode).toBe(503);
      expect(data.json()).toMatchObject({ error: { code: 'UNAVAILABLE' } });
      expect(data.body).not.toContain('injected');

      const health = await broken.app.inject({ method: 'GET', url: '/api/health', headers: { cookie } });
      expect(health.statusCode).toBe(200);
      const probe = await broken.app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie } });
      expect(probe.json()).toMatchObject({ authenticated: true });
    } finally {
      await broken.close();
    }
  });
});

describe('the revocation migration is additive', () => {
  it('only creates the new table and its index', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const sql = fs.readFileSync(
      path.resolve(here, '../../prisma/migrations/20261127120000_revoked_sessions/migration.sql'),
      'utf8',
    );
    const statements = sql
      .split(';')
      .map((s) => s.replace(/--.*$/gm, '').trim())
      .filter(Boolean);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(/^CREATE TABLE "revoked_sessions"/);
    expect(statements[1]).toMatch(/^CREATE INDEX "revoked_sessions_expiresAt_idx" ON "revoked_sessions"/);
    expect(sql).not.toMatch(/\b(DROP|ALTER|DELETE|UPDATE|INSERT|RENAME)\b/i);
  });
});
