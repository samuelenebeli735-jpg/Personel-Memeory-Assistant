import { describe, expect, it } from 'vitest';

import {
  extractToken,
  sessionCookieOptions,
  SESSION_COOKIE,
  signSession,
  verifyPassword,
  verifySession,
} from '../../src/http/auth.js';
import { createLogger } from '../../src/lib/logger.js';

const SECRET = 'unit-test-session-secret-value-1234567890';

describe('session tokens', () => {
  it('round-trips a freshly signed session', () => {
    const now = new Date('2026-10-17T10:00:00.000Z');
    const token = signSession(SECRET, 1, now);
    const verified = verifySession(token, SECRET, now);
    expect(verified.valid).toBe(true);
    expect(verified.payload?.sub).toBe('owner');
    expect(verified.payload?.exp).toBe(Math.floor(now.getTime() / 1000) + 3600);
  });

  it('rejects a tampered payload', () => {
    const now = new Date('2026-10-17T10:00:00.000Z');
    const token = signSession(SECRET, 1, now);
    const [version, , signature] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ sub: 'owner', iat: 0, exp: 9_999_999_999, nonce: 'x' }),
    ).toString('base64url');
    expect(verifySession(`${version}.${forged}.${signature}`, SECRET, now).valid).toBe(false);
  });

  it('rejects a token signed with a different secret', () => {
    const token = signSession('another-secret-0000000000000000', 1);
    expect(verifySession(token, SECRET).reason).toBe('bad-signature');
  });

  it('rejects malformed tokens without throwing', () => {
    expect(verifySession('', SECRET).reason).toBe('malformed');
    expect(verifySession('v1.only-two-parts', SECRET).reason).toBe('malformed');
    expect(verifySession('v2.abc.def', SECRET).reason).toBe('malformed');
    expect(verifySession('v1.@@@.@@@', SECRET).valid).toBe(false);
  });

  it('expires sessions', () => {
    const issued = new Date('2026-10-17T10:00:00.000Z');
    const token = signSession(SECRET, 1, issued);
    const later = new Date(issued.getTime() + 3600 * 1000 + 1);
    expect(verifySession(token, SECRET, later).reason).toBe('expired');
  });

  it('produces distinct nonces so tokens are not deterministic', () => {
    const a = signSession(SECRET, 1);
    const b = signSession(SECRET, 1);
    expect(a).not.toBe(b);
  });
});

describe('password verification', () => {
  it('accepts the exact password and rejects everything else', () => {
    expect(verifyPassword('correct horse', 'correct horse')).toBe(true);
    expect(verifyPassword('correct horse ', 'correct horse')).toBe(false);
    expect(verifyPassword('', 'correct horse')).toBe(false);
    expect(verifyPassword('Correct Horse', 'correct horse')).toBe(false);
  });
});

describe('token extraction', () => {
  it('prefers a bearer token', () => {
    expect(extractToken('recall_session=cookie-value', 'Bearer bearer-value')).toBe('bearer-value');
    expect(extractToken(undefined, 'bearer lower-case')).toBe('lower-case');
  });

  it('reads the session cookie', () => {
    expect(extractToken(`${SESSION_COOKIE}=abc.def.ghi`, undefined)).toBe('abc.def.ghi');
    expect(extractToken('other=1; recall_session=xyz; another=2', undefined)).toBe('xyz');
    expect(extractToken('other=1', undefined)).toBeNull();
    expect(extractToken(undefined, undefined)).toBeNull();
  });

  it('builds hardened cookie options', () => {
    expect(sessionCookieOptions(true, 1)).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      path: '/',
      maxAge: 3600,
    });
  });
});

describe('logger redaction', () => {
  it('never writes secrets or capture text to the log', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', sink: (line) => lines.push(line) });
    logger.info('test', {
      password: 'super-secret-password',
      token: 'bot-token-value',
      rawText: 'my private thought',
      transcript: 'private voice note',
      safeField: 'visible',
    });
    const output = lines.join('\n');
    expect(output).not.toContain('super-secret-password');
    expect(output).not.toContain('bot-token-value');
    expect(output).not.toContain('my private thought');
    expect(output).not.toContain('private voice note');
    expect(output).toContain('visible');
  });

  it('redacts nested objects and error messages collapse to name+message', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', sink: (line) => lines.push(line) });
    logger.error('nested', { ctx: { apiKey: 'leak-me', ok: 1 }, err: new Error('boom') });
    const output = lines.join('\n');
    expect(output).not.toContain('leak-me');
    expect(output).toContain('boom');
  });

  it('respects the log level threshold', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'warn', sink: (line) => lines.push(line) });
    logger.debug('hidden');
    logger.warn('shown');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('shown');
  });

  it('allows content logging only when explicitly opted in', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'info', logMessageContent: true, sink: (line) => lines.push(line) });
    logger.info('dev', { rawText: 'visible in dev only' });
    expect(lines.join('\n')).toContain('visible in dev only');
  });
});
