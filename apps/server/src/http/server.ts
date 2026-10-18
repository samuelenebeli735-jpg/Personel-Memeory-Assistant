/**
 * HTTP API.
 *
 * Security posture:
 *  - Every /api route except login + liveness requires an owner session; the
 *    check runs server-side in a Fastify hook, not in the client.
 *  - CORS is restricted to configured origins and credentials are allowed.
 *  - Rate limiting is applied per-IP with a tighter bucket for login.
 *  - Error responses never leak stack traces, provider bodies or secrets.
 */
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

import type { AppContext } from '../context.js';
import { AppError, toAppError } from '../lib/errors.js';
import { extractToken, sessionCookieOptions, verifySession } from './auth.js';
import { registerPublicRoutes, type PublicRouteOptions } from './routes/public-routes.js';
import { registerProtectedRoutes } from './routes/index.js';

export interface SchedulerStatusSnapshot {
  running: boolean;
  lastTickAt: string | null;
  dueNow: number;
  scheduledTotal: number;
}

export interface RuntimeStatus {
  version: string;
  startedAt: Date;
  schedulerStatus(): SchedulerStatusSnapshot;
  telegramStatus(): { enabled: boolean; mode: string; configured: boolean; ownerConfigured: boolean };
}

export interface BuildServerOptions {
  runtime?: RuntimeStatus;
  /** Set to false in tests to reduce noise. */
  enableRateLimit?: boolean;
  /** Registered by the process entry point when the bot runs in webhook mode. */
  telegramWebhook?: PublicRouteOptions['telegramWebhook'];
}

/** Attaches the resolved session to the request for downstream hooks/routes. */
declare module 'fastify' {
  interface FastifyRequest {
    session?: { sub: 'owner'; exp: number };
  }
}

export async function buildServer(
  ctx: AppContext,
  options: BuildServerOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(cookie);
  await app.register(cors, {
    origin: ctx.config.dashboard.corsOrigins.length > 0 ? ctx.config.dashboard.corsOrigins : false,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });

  if (options.enableRateLimit !== false) {
    await app.register(rateLimit, {
      global: false,
      max: 240,
      timeWindow: '1 minute',
      keyGenerator: (request: FastifyRequest) => request.ip,
      errorResponseBuilder: () => ({
        error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down' },
      }),
    });
  }

  app.setErrorHandler((error, request, reply) => {
    const appError = toAppError(error);
    const level = appError.httpStatus >= 500 ? 'error' : 'warn';
    ctx.logger[level]('http request failed', {
      method: request.method,
      url: request.url,
      status: appError.httpStatus,
      code: appError.code,
      reason: appError.message,
    });
    if (appError.httpStatus >= 500 && appError.details !== undefined) {
      ctx.logger.debug('error details', { details: appError.details });
    }
    void reply.status(appError.httpStatus).send({
      error: {
        code: appError.code,
        message: appError.userMessage,
        ...(appError.details === undefined ? {} : { details: appError.details }),
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({
      error: { code: 'NOT_FOUND', message: `No route for ${request.method} ${request.url}` },
    });
  });

  // Access log without bodies or query strings (they may contain personal text).
  app.addHook('onResponse', async (request, reply) => {
    ctx.logger.info('http', {
      method: request.method,
      path: request.url.split('?')[0],
      status: reply.statusCode,
    });
  });

  const runtime: RuntimeStatus = options.runtime ?? {
    version: ctx.config.version,
    startedAt: new Date(),
    schedulerStatus: () => ({ running: false, lastTickAt: null, dueNow: 0, scheduledTotal: 0 }),
    telegramStatus: () => ({
      enabled: ctx.capabilities.telegramEnabled,
      mode: ctx.config.telegram.mode,
      configured: ctx.capabilities.telegramConfigured,
      ownerConfigured: ctx.config.telegram.ownerIds.length > 0,
    }),
  };

  await registerPublicRoutes(app, ctx, runtime, options);

  await app.register(
    async (api) => {
      api.addHook('preHandler', async (request) => {
        const token = extractToken(
          request.headers.cookie,
          typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined,
        );
        if (!token) throw new AppError('UNAUTHORIZED', 'Sign in to continue', { httpStatus: 401 });
        const secret = ctx.config.dashboard.sessionSecret;
        if (!secret) {
          throw new AppError('UNAUTHORIZED', 'Dashboard authentication is not configured', {
            httpStatus: 503,
          });
        }
        const verified = verifySession(token, secret, ctx.clock.now());
        if (!verified.valid) {
          throw new AppError(
            'UNAUTHORIZED',
            verified.reason === 'expired' ? 'Your session has expired' : 'Sign in to continue',
            { httpStatus: 401, details: { reason: verified.reason } },
          );
        }
        request.session = { sub: 'owner', exp: verified.payload!.exp };
      });
      await registerProtectedRoutes(api, ctx, runtime);
    },
    { prefix: '/api' },
  );

  return app;
}

export { sessionCookieOptions };
