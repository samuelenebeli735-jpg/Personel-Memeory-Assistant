/**
 * Individual session revocation (R3-03, N15).
 *
 * Sessions are stateless signed tokens, so signing out used to clear only the
 * browser's cookie: a copy of the token kept working until it expired. Signing
 * out now records the token's random `nonce`, and the session guard refuses a
 * token whose nonce is recorded. A row is kept only until the token would have
 * expired anyway, then pruned.
 *
 * Tokens issued before this existed carry a nonce too, so they can be revoked
 * the same way; nothing else about them changes.
 */
import type { Db } from '../db/client.js';
import type { SessionPayload } from './auth.js';

/** Records `payload` as signed out. Idempotent: signing out twice is fine. */
export async function revokeSession(db: Db, payload: SessionPayload, now: Date): Promise<void> {
  const expiresAt = new Date(payload.exp * 1000);
  await db.revokedSession.upsert({
    where: { nonce: payload.nonce },
    update: {},
    create: { nonce: payload.nonce, expiresAt, revokedAt: now },
  });
}

/** True when the token with this nonce was signed out. */
export async function isSessionRevoked(db: Db, nonce: string): Promise<boolean> {
  if (typeof nonce !== 'string' || nonce.length === 0) return false;
  const row = await db.revokedSession.findUnique({ where: { nonce }, select: { nonce: true } });
  return row !== null;
}

/** Removes rows for tokens that have expired anyway. Returns how many. */
export async function pruneRevokedSessions(db: Db, now: Date): Promise<number> {
  const result = await db.revokedSession.deleteMany({ where: { expiresAt: { lte: now } } });
  return result.count;
}
