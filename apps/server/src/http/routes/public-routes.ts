/**
 * Routes reachable without a session: login, logout, session probe, liveness and
 * the Telegram webhook. Nothing here returns stored personal data.
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';

import type { AppContext } from '../../context.js';
import { AppError } from '../../lib/errors.js';
import { SESSION_COOKIE, sessionCookieOptions, signSession, verifyPassword, verifySession } from '../auth.js';
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

  app.post('/api/auth/logout', async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  /** Lets the dashboard decide whether to render the login screen. */
  app.get('/api/auth/session', async (request) => {
    const secret = ctx.config.dashboard.sessionSecret;
    const raw = request.cookies?.[SESSION_COOKIE];
    if (!secret || !raw) return { authenticated: false as const };
    const verified = verifySession(raw, secret, ctx.clock.now());
    if (!verified.valid) return { authenticated: false as const, reason: verified.reason };
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

  if (options.telegramWebhook) {
    const handler = options.telegramWebhook;
    app.post('/api/telegram/webhook', async (request, reply) => {
      const headerSecret = request.headers['x-telegram-bot-api-secret-token'];
      const result = await handler({
        secretHeader: typeof headerSecret === 'string' ? headerSecret : undefined,
        body: request.body,
      });
      return reply.status(result.status).send(result.body);
    });
  }
}
