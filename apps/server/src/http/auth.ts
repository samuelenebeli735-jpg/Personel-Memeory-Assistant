/**
 * Dashboard authentication.
 *
 * Threat model: a single owner. The API is protected by a signed, HttpOnly
 * session cookie (or an equivalent `Authorization: Bearer` token for scripts).
 * Authorization is enforced on the server for every /api route; hiding UI is
 * never treated as protection.
 *
 * Token format: `v1.<base64url(payload)>.<base64url(hmacSha256)>`
 *   payload = { sub: "owner", iat, exp, nonce }
 * Verification is constant-time and checks the expiry.
 */
import crypto from 'node:crypto';

import { UnauthorizedError } from '../lib/errors.js';

const TOKEN_VERSION = 'v1';
export const SESSION_COOKIE = 'recall_session';

export interface SessionPayload {
  sub: 'owner';
  iat: number;
  exp: number;
  nonce: string;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function hmac(secret: string, data: string): Buffer {
  return crypto.createHmac('sha256', secret).update(data).digest();
}

export function signSession(secret: string, ttlHours: number, now: Date = new Date()): string {
  const iat = Math.floor(now.getTime() / 1000);
  const payload: SessionPayload = {
    sub: 'owner',
    iat,
    exp: iat + Math.round(ttlHours * 3600),
    nonce: crypto.randomBytes(12).toString('base64url'),
  };
  const body = base64url(JSON.stringify(payload));
  const signature = base64url(hmac(secret, `${TOKEN_VERSION}.${body}`));
  return `${TOKEN_VERSION}.${body}.${signature}`;
}

export interface VerifiedSession {
  valid: boolean;
  payload?: SessionPayload;
  reason?: 'malformed' | 'bad-signature' | 'expired';
}

export function verifySession(
  token: string,
  secret: string,
  now: Date = new Date(),
): VerifiedSession {
  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false, reason: 'malformed' };
  const [version, body, signature] = parts as [string, string, string];
  if (version !== TOKEN_VERSION) return { valid: false, reason: 'malformed' };

  const expected = hmac(secret, `${version}.${body}`);
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, 'base64url');
  } catch {
    return { valid: false, reason: 'malformed' };
  }
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return { valid: false, reason: 'bad-signature' };
  }

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
  } catch {
    return { valid: false, reason: 'malformed' };
  }
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now.getTime()) {
    return { valid: false, reason: 'expired' };
  }
  if (payload.sub !== 'owner') return { valid: false, reason: 'malformed' };
  return { valid: true, payload };
}

/** Constant-time password comparison over SHA-256 digests. */
export function verifyPassword(provided: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(provided, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

export interface AuthConfig {
  password: string;
  sessionSecret: string;
  sessionTtlHours: number;
}

export function requireAuthConfig(config: {
  dashboard: { password: string | null; sessionSecret: string | null; sessionTtlHours: number };
}): AuthConfig {
  const { password, sessionSecret } = config.dashboard;
  if (!password) {
    throw new UnauthorizedError('DASHBOARD_PASSWORD is not configured; the dashboard cannot start');
  }
  if (!sessionSecret || sessionSecret.length < 16) {
    throw new UnauthorizedError('SESSION_SECRET is not configured (min 16 characters)');
  }
  return { password, sessionSecret, sessionTtlHours: config.dashboard.sessionTtlHours };
}

/** Extracts a session token from the cookie header or an Authorization header. */
export function extractToken(
  cookieHeader: string | undefined,
  authorizationHeader: string | undefined,
): string | null {
  if (authorizationHeader) {
    const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
    if (match && match[1]) return match[1].trim();
  }
  if (cookieHeader) {
    for (const part of cookieHeader.split(';')) {
      const [name, ...rest] = part.split('=');
      if (name && name.trim() === SESSION_COOKIE) {
        const value = rest.join('=').trim();
        if (value.length > 0) return decodeURIComponent(value);
      }
    }
  }
  return null;
}

export function sessionCookieOptions(secure: boolean, ttlHours: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
    path: '/',
    maxAge: Math.round(ttlHours * 3600),
  };
}
