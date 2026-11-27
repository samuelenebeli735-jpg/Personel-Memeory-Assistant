/**
 * Routes reachable without a session: login, logout, session probe, liveness and
 * the Telegram webhook. Nothing here returns stored personal data.
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';

import type { AppContext } from '../../context.js';
import { AppError } from '../../lib/errors.js';
import {
  extractToken,
  SESSION_COOKIE,
  sessionCookieOptions,
  signSession,
  verifyPassword,
  verifySession,
} from '../auth.js';
import { isSessionRevoked, pruneRevokedSessions, revokeSession } from '../session-revocation.js';
import type { RuntimeStatus } from '../server.js';

const loginSchema = z.object({
  password: z.string().min(1).max(512),
});

export interface PublicRouteOptions {
  enableRateLimit?: boolean;
  /** Telegram webhook handler, when the bot is configured in webhook mode. */
  telegramWebhook?: (input: {
    secretHeader: string | undefined;
    body: unknown;
  }) => Promise<{ status: number; body: unknown }>;
}

export async function registerPublicRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  runtime: RuntimeStatus,
  options: PublicRouteOptions = {},
): Promise<void> {
  const loginRouteOptions =
    options.enableRateLimit === false
      ? {}
      : { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
  const webhookRouteOptions =
    options.enableRateLimit === false
      ? {}
      : { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };

  app.post('/api/auth/login', loginRouteOptions, async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', 'Password is required', { httpStatus: 400 });
    }
    const expected = ctx.config.dashboard.password;
    const secret = ctx.config.dashboard.sessionSecret;
    if (!expected || !secret) {
      throw new AppError('UNAUTHORIZED', 'Dashboard authentication is not configured on the server', {
        httpStatus: 503,
      });
    }
    if (!verifyPassword(parsed.data.password, expected)) {
      ctx.logger.warn('dashboard login rejected', { ip: request.ip });
      throw new AppError('UNAUTHORIZED', 'Incorrect password', { httpStatus: 401 });
    }

    const now = ctx.clock.now();
    const token = signSession(secret, ctx.config.dashboard.sessionTtlHours, now);
    reply.setCookie(
      SESSION_COOKIE,
      token,
      sessionCookieOptions(ctx.config.dashboard.cookieSecure, ctx.config.dashboard.sessionTtlHours),
    );
    ctx.logger.info('dashboard login succeeded', { ip: request.ip });
    return { ok: true, expiresInHours: ctx.config.dashboard.sessionTtlHours };
  });

  /**
   * Signs out: clears the cookie and revokes the token on the server, so a copy
   * of it stops working too (R3-03). Always succeeds for the browser; if the
   * revocation cannot be recorded, that is logged and reported as
   * `revoked: false` rather than leaving the owner signed in.
   */
  app.post('/api/auth/logout', async (request, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    const secret = ctx.config.dashboard.sessionSecret;
    const token = extractToken(
      request.headers.cookie,
      typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined,
    );
    if (!secret || !token) return { ok: true, revoked: false };
    const now = ctx.clock.now();
    const verified = verifySession(token, secret, now);
    // An invalid or expired token cannot be used anyway; nothing to record.
    if (!verified.valid) return { ok: true, revoked: false };
    try {
      await revokeSession(ctx.db, verified.payload!, now);
    } catch (error) {
      ctx.logger.error('could not record a signed-out session', {
        reason: error instanceof Error ? error.message : String(error),
      });
      return { ok: true, revoked: false };
    }
    // Housekeeping only: the session is already revoked, so a failure here
    // must not make the response say otherwise.
    try {
      await pruneRevokedSessions(ctx.db, now);
    } catch (error) {
      ctx.logger.warn('could not prune expired signed-out sessions', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    ctx.logger.info('dashboard session signed out', {});
    return { ok: true, revoked: true };
  });

  /** Lets the dashboard decide whether to render the login screen. */
  app.get('/api/auth/session', async (request) => {
    const secret = ctx.config.dashboard.sessionSecret;
    const raw = request.cookies?.[SESSION_COOKIE];
    if (!secret || !raw) return { authenticated: false as const };
    const verified = verifySession(raw, secret, ctx.clock.now());
    if (!verified.valid) return { authenticated: false as const, reason: verified.reason };
    // This probe returns no data. If the sign-out list cannot be read (the
    // database is down) the dashboard still loads and reports that; every
    // data route stays closed (the session guard fails closed).
    const revoked = await isSessionRevoked(ctx.db, verified.payload!.nonce).catch(() => false);
    if (revoked) {
      return { authenticated: false as const, reason: 'revoked' as const };
    }
    return {
      authenticated: true as const,
      expiresAt: new Date(verified.payload!.exp * 1000).toISOString(),
    };
  });

  /** Unauthenticated liveness probe for the process supervisor. */
  app.get('/api/health/live', async () => ({
    status: 'ok' as const,
    version: runtime.version,
    uptimeSeconds: Math.round((ctx.clock.now().getTime() - runtime.startedAt.getTime()) / 1000),
  }));

  /**
   * Unauthenticated scheduler probe for the container health check (N14).
   * Data-free: one word, no counts or times. 503 when the reminder loop is not
   * running (still starting, or stopped) or has stalled.
   */
  app.get('/api/health/scheduler', async (_request, reply) => {
    const scheduler = runtime.schedulerStatus();
    const status = !scheduler.running ? 'stopped' : scheduler.stalled ? 'stalled' : 'ok';
    return reply.code(status === 'ok' ? 200 : 503).send({ status });
  });

  if (options.telegramWebhook) {
    const handler = options.telegramWebhook;
    app.post('/api/telegram/webhook', webhookRouteOptions, async (request, reply) => {
      const headerSecret = request.headers['x-telegram-bot-api-secret-token'];
      const result = await handler({
        secretHeader: typeof headerSecret === 'string' ? headerSecret : undefined,
        body: request.body,
      });
      return reply.status(result.status).send(result.body);
    });
  }
}
