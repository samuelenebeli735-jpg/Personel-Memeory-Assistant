/** Small, dependency-free text helpers used across services. */

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Normalisation used for duplicate detection (not for storage). */
export function normalizeForHash(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' url ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Builds a decent title from free text without inventing content. */
export function deriveTitle(text: string, max = 140): string {
  const cleaned = normalizeWhitespace(text)
    .replace(/^(please\s+)?(remind me to|remind me|remember to|remember|note that|note|i need to|i have to|i should|i must|todo:?|task:?|idea:?)\s+/i, '')
    .trim();
  const base = cleaned.length > 0 ? cleaned : normalizeWhitespace(text);
  const firstSentence = base.split(/(?<=[.!?])\s+/)[0] ?? base;
  const candidate = firstSentence.length >= 12 ? firstSentence : base;
  return truncate(candidate.replace(/[.,;:!?\s]+$/, ''), max);
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"')\]]+/gi;

export function extractUrls(text: string): string[] {
  const found = text.match(URL_PATTERN) ?? [];
  return [...new Set(found.map((url) => url.replace(/[.,;:!?]+$/, '')))];
}

export function isOnlyUrl(text: string): boolean {
  const trimmed = text.trim();
  const urls = extractUrls(trimmed);
  if (urls.length === 0) return false;
  return urls.every((url) => trimmed.includes(url)) && normalizeWhitespace(trimmed.replace(URL_PATTERN, '')).length === 0;
}

/** Extracts `#tags` written inline. */
export function extractInlineTags(text: string): string[] {
  const matches = text.match(/(?:^|\s)#([\p{L}\p{N}_-]{1,40})/gu) ?? [];
  return [...new Set(matches.map((m) => m.trim().slice(1).toLowerCase()))];
}

export function reduceInlineNoise(text: string): string {
  return normalizeWhitespace(text.replace(/(?:^|\s)#[\p{L}\p{N}_-]{1,40}/gu, ' '));
}

/** Stable, non-cryptographic-enough-for-dedupe hash key. */
export function stableKey(parts: (string | null | undefined)[]): string {
  return parts.map((p) => (p ?? '').trim()).join('\u0000');
}
