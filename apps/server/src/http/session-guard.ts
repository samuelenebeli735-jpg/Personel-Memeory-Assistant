/**
 * The owner-session check for every protected /api route.
 *
 * `server.ts` runs it as a preHandler for the whole /api scope. The restore
 * file route also runs it in `onRequest`, before any of a large body is read,
 * so an unauthenticated client can never make the server buffer an upload.
 */
import type { FastifyRequest } from 'fastify';

import type { AppContext } from '../context.js';
import { AppError } from '../lib/errors.js';
import { extractToken, verifySession } from './auth.js';

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
    request.session = { sub: 'owner', exp: verified.payload!.exp };
  };
}
