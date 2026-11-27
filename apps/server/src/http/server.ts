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
import type { HealthDto } from '@recall/shared';

import type { AppContext } from '../context.js';
import { toAppError } from '../lib/errors.js';
import { sessionCookieOptions } from './auth.js';
import { createSessionGuard } from './session-guard.js';
import { registerPublicRoutes, type PublicRouteOptions } from './routes/public-routes.js';
import { registerProtectedRoutes } from './routes/index.js';

export interface SchedulerStatusSnapshot {
  running: boolean;
  lastTickAt: string | null;
  dueNow: number;
  scheduledTotal: number;
  /** Running, but no tick has finished within `stallLimitSeconds` (N14). */
  stalled: boolean;
  stallLimitSeconds: number;
}

export interface RuntimeStatus {
  version: string;
  startedAt: Date;
  schedulerStatus(): SchedulerStatusSnapshot;
  telegramStatus(): HealthDto['providers']['telegram'];
}

/** Content-Security-Policy for API responses (JSON only): nothing may load or run. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** Requests per minute per client address on ordinary routes (production policy). */
export const GLOBAL_RATE_LIMIT_PER_MINUTE = 240;

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
    trustProxy: ctx.config.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(cookie);
  await app.register(cors, {
    origin: ctx.config.dashboard.corsOrigins.length > 0 ? ctx.config.dashboard.corsOrigins : false,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });

  if (options.enableRateLimit !== false) {
    // Only the browser test server may raise the global limit, and only with
    // NODE_ENV=test (enforced by config validation). It never lowers or
    // disables it, and the tighter login and webhook limits are unaffected.
    const globalMax = ctx.config.testRateLimitPerMinute ?? GLOBAL_RATE_LIMIT_PER_MINUTE;
    if (ctx.config.testRateLimitPerMinute !== null) {
      ctx.logger.warn('test-only global rate limit override active', {
        perMinute: globalMax,
        productionDefault: GLOBAL_RATE_LIMIT_PER_MINUTE,
      });
    }
    await app.register(rateLimit, {
      // Enabled globally; login and the public webhook override the bucket with
      // their tighter route-level limits below.
      global: true,
      max: globalMax,
      timeWindow: '1 minute',
      keyGenerator: (request: FastifyRequest) => request.ip,
      errorResponseBuilder: () => ({
        statusCode: 429,
        error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down' },
      }),
    });
  }

  app.setErrorHandler((error, request, reply) => {
    const appError = toAppError(error);
    const level = appError.httpStatus >= 500 ? 'error' : 'warn';
    ctx.logger[level]('http request failed', {
      method: request.method,
      // The path only: query strings can hold personal text (search words) and
      // restore credentials, exactly like the access log below.
      path: request.url.split('?')[0],
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

  // Every API response is data, never a page: a policy that allows nothing to
  // load or run, and no type sniffing (R3-03). Set before routing, so errors
  // and 404s carry it too.
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Content-Security-Policy', API_CSP);
    reply.header('X-Content-Type-Options', 'nosniff');
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
    schedulerStatus: () => ({
      running: false,
      lastTickAt: null,
      dueNow: 0,
      scheduledTotal: 0,
      stalled: false,
      stallLimitSeconds: 0,
    }),
    telegramStatus: () => ({
      enabled: ctx.capabilities.telegramEnabled,
      mode: ctx.config.telegram.mode,
      configured: ctx.capabilities.telegramConfigured,
      ownerConfigured: ctx.config.telegram.ownerIds.length > 0,
    }),
  };

  await registerPublicRoutes(app, ctx, runtime, options);

  const requireSession = createSessionGuard(ctx);
  await app.register(
    async (api) => {
      api.addHook('preHandler', requireSession);
      await registerProtectedRoutes(api, ctx, runtime);
    },
    { prefix: '/api' },
  );

  return app;
}

export { sessionCookieOptions };
