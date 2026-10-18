import crypto from 'node:crypto';

import { normalizeForHash } from './text.js';

/** Hex SHA-256 of an arbitrary string. */
export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Dedupe fingerprint for a capture.
 *
 * Deliberately *not* used to suppress a capture: two identical notes on purpose
 * are legitimate. It only powers a "you may have already captured this" warning
 * and a `CaptureRelation` link.
 */
export function captureDedupeHash(parts: {
  rawText: string;
  source: string;
  occurredAtIso: string;
}): string {
  const normalised = normalizeForHash(parts.rawText);
  return sha256Hex(`${parts.source}\u0000${normalised}`);
}

/** Short, non-reversible identifier for logs and support. */
export function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8);
}
