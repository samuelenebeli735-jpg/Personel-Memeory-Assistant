/**
 * The owner-session check for every protected /api route.
 *
 * `server.ts` runs it as a preHandler for the whole /api scope. The restore
 * file route also runs it in `onRequest`, before any of a large body is read,
 * so an unauthenticated client can never make the server buffer an upload.
 *
 * A token that was signed out is refused even if its signature and expiry are
 * still good (R3-03): a copied cookie stops working at sign-out.
 *
 * If the sign-out list cannot be read (the database is down or busy), the
 * request is refused with 503 rather than let through: a revoked token must
 * never work just because the check failed. The one exception is the
 * operational health report, which holds no personal data and is how the
 * dashboard learns that the database is down.
 */
import type { FastifyRequest } from 'fastify';

import type { AppContext } from '../context.js';
import { AppError } from '../lib/errors.js';
import { extractToken, verifySession } from './auth.js';
import { isSessionRevoked } from './session-revocation.js';

export function createSessionGuard(ctx: AppContext): (request: FastifyRequest) => Promise<void> {
  return async (request) => {
    if (request.session) return;
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
    let revoked: boolean;
    try {
      revoked = await isSessionRevoked(ctx.db, verified.payload!.nonce);
    } catch (error) {
      if (!isHealthReport(request)) {
        ctx.logger.warn('could not check whether a session was signed out', {
          reason: error instanceof Error ? error.message : String(error),
        });
        throw new AppError('UNAVAILABLE', 'Recall cannot check your session right now. Try again shortly.', {
          httpStatus: 503,
        });
      }
      revoked = false;
    }
    if (revoked) {
      throw new AppError('UNAUTHORIZED', 'Sign in to continue', {
        httpStatus: 401,
        details: { reason: 'revoked' },
      });
    }
    request.session = { sub: 'owner', exp: verified.payload!.exp };
  };
}

/** `GET /api/health`: operational status only, needed while the database is down. */
function isHealthReport(request: FastifyRequest): boolean {
  return request.method === 'GET' && request.routeOptions?.url === '/api/health';
}
