/**
 * Small cryptographic helpers.
 *
 * Only here so the webhook secret is compared in constant time: a plain `===`
 * on a secret leaks its length and prefix through timing.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string comparison. Returns false when either side is empty or
 * the lengths differ (length is not itself a secret).
 */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** SHA-256 in lowercase hex. Used for non-secret fingerprints. */
export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
