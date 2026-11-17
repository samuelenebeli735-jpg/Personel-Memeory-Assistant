/**
 * Evidence-grounded Q&A.
 *
 * The promise this service makes is narrow and absolute: an answer is only
 * returned when it is supported by records that are returned alongside it.
 * Three layers enforce that promise:
 *
 *  1. **Retrieval first.** Evidence is fetched from the database *before* an
 *     answer is generated. A model never sees a question without the records
 *     that back it.
 *  2. **Citations are validated.** Every id the model cites must exist in the
 *     retrieved evidence. Invented ids are dropped, and an answer that cites
 *     nothing is discarded.
 *  3. **Claims are validated.** A valid citation is *not* proof that every
 *     sentence of an answer is supported: a model can cite one real record and
 *     then assert anything at all. Each statement is therefore checked against
 *     the cited evidence, and unsupported statements are removed. If no
 *     statement survives, the answer falls back to a deterministic summary
 *     that is derived from the evidence itself.
 *
 * Layer 3 is a lexical check, not a proof of entailment: it can only reject
 * statements, never invent support for them. That asymmetry is deliberate —
 * the failure mode of a too-strict filter is a less useful answer, while the
 * failure mode of a too-lenient one is a fabricated memory.
 */
import type { SearchEntityType, SearchResultItem } from '@recall/shared';

import type { EvidenceRecord } from '../ai/types.js';
import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import { normalizeWhitespace, truncate } from '../lib/text.js';
import { getSettings } from './settings-service.js';
import { searchAll, visibleCaptureText } from './search-service.js';

/** Longest question the service accepts. */
export const MAX_QUESTION_LENGTH = 500;
/** Largest number of evidence records returned to the caller. */
export const MAX_EVIDENCE_LIMIT = 10;
/** Longest excerpt of a record kept as evidence text. */
export const EVIDENCE_SNIPPET_MAX = 400;

export interface AskRequest {
  question: string;
  /** Restricts retrieval to these record types. */
  types?: SearchEntityType[];
  /** How many evidence records to return (1..10). */
  limit?: number;
}

export interface AskOutcome {
  /** True when the answer is derived from the returned evidence. */
  grounded: boolean;
  answer: string;
  /** Every record the answer was derived from. */
  evidence: SearchResultItem[];
  /** Which provider produced the answer ('deterministic' or the AI provider). */
  provider: string;
  /** True when the answer came from deterministic retrieval, not a model. */
  deterministic: boolean;
}

/* -------------------------------------------------------------------------- */
/* Grounding vocabulary                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Words that carry no factual content.
 *
 * They are excluded from the support check, so an answer is not rejected for
 * saying "the" or "is". Negations are handled separately, because *removing*
 * a fact from the evidence is a different (and riskier) claim than adding one.
 */
const STOPWORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'also', 'am', 'an', 'and', 'any',
  'are', 'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but',
  'by', 'can', 'could', 'did', 'do', 'does', 'doing', 'down', 'during', 'each', 'few', 'for',
  'from', 'further', 'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'herself', 'him',
  'himself', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself', 'just', 'me',
  'more', 'most', 'my', 'myself', 'of', 'off', 'on', 'once', 'only', 'or', 'other', 'ought', 'our',
  'ours', 'ourselves', 'out', 'over', 'own', 'same', 'she', 'should', 'so', 'some', 'such', 'than',
  'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'these', 'they', 'this',
  'those', 'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was', 'we', 'were', 'what',
  'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'will', 'with', 'would', 'you', 'your',
  'yours', 'yourself', 'yourselves',
]);

/** Tokens that assert the absence of something. */
const NEGATION_MARKERS = new Set([
  'not', 'never', 'no', 'none', 'nothing', 'neither', 'nor', 'without', 'cannot',
]);

/** Contractions are expanded so "isn't" is recognised as a negation. */
function expandContractions(text: string): string {
  return text
    .replace(/n['’]t\b/gi, ' not')
    .replace(/\bcan['’]t\b/gi, 'can not')
    .replace(/\bwon['’]t\b/gi, 'will not')
    .replace(/\bshan['’]t\b/gi, 'shall not');
}

function tokenize(text: string): string[] {
  return expandContractions(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/**
 * The content of a statement: the words and numbers that must be supported.
 *
 * Short words are ignored (they are usually function words), but any token
 * that contains a digit is content — a number in an answer is a claim about
 * a quantity, a date or a time, and it must appear in the evidence.
 */
function contentTokens(claim: string): string[] {
  const tokens = tokenize(claim);
  const content: string[] = [];
  for (const token of tokens) {
    if (NEGATION_MARKERS.has(token)) continue;
    if (STOPWORDS.has(token)) continue;
    if (/\d/.test(token)) {
      content.push(token);
      continue;
    }
    if (token.length >= 3) content.push(token);
  }
  return content;
}

/** Splits an answer into statements. */
export function splitClaims(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((claim) => claim.trim())
    .filter((claim) => claim.length > 0);
}

interface EvidenceHaystack {
  /** Normalised word tokens of the cited evidence. */
  words: Set<string>;
  /** Digits and words, with punctuation replaced by spaces. */
  text: string;
}

function buildHaystack(evidence: EvidenceRecord[]): EvidenceHaystack {
  const parts: string[] = [];
  for (const item of evidence) {
    parts.push(item.title ?? '');
    parts.push(item.snippet ?? '');
    parts.push(item.status ?? '');
  }
  const raw = parts.join(' \n ');
  const text = raw.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ');
  return { words: new Set(tokenize(raw)), text };
}

/**
 * True when a digit-bearing token appears in the evidence.
 *
 * The token must not be part of a longer number ("3" does not match "13"),
 * but it may be followed by letters so "10" matches "10am".
 */
function containsNumber(haystack: EvidenceHaystack, token: string): boolean {
  const pattern = new RegExp(`(?<!\\d)${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\d)`);
  return pattern.test(haystack.text);
}

/**
 * True when a word appears in the evidence.
 *
 * Exact match, plus a prefix match when the shorter of the two words has at
 * least five characters, so "invoice" is supported by "invoices" while "bus"
 * is not supported by "business".
 */
function containsWord(haystack: EvidenceHaystack, token: string): boolean {
  if (haystack.words.has(token)) return true;
  for (const word of haystack.words) {
    const shorter = token.length <= word.length ? token : word;
    if (shorter.length < 5) continue;
    if (word.startsWith(token) || token.startsWith(word)) return true;
  }
  return false;
}

/** True when the claim negates something the evidence does not negate. */
function unsupportedNegation(claim: string, haystack: EvidenceHaystack): boolean {
  const claimNegates = tokenize(claim).some((token) => NEGATION_MARKERS.has(token));
  if (!claimNegates) return false;
  for (const token of haystack.words) {
    if (NEGATION_MARKERS.has(token)) return false;
  }
  return true;
}

export interface GroundingResult {
  /** Statements that are supported by the cited evidence. */
  supported: string[];
  /** Statements that were removed because nothing in the evidence backs them. */
  dropped: string[];
  /** The supported statements joined into a single answer. */
  answer: string;
}

/**
 * Keeps only the statements of an answer that the cited evidence supports.
 *
 * A statement is supported when every content token in it appears in the
 * evidence and it does not assert a negation the evidence does not contain.
 */
export function groundAnswer(answer: string, cited: EvidenceRecord[]): GroundingResult {
  const claims = splitClaims(answer);
  if (claims.length === 0) return { supported: [], dropped: [], answer: '' };

  const haystack = buildHaystack(cited);
  const supported: string[] = [];
  const dropped: string[] = [];

  for (const claim of claims) {
    const content = contentTokens(claim);
    if (content.length === 0) {
      // Nothing checkable in this statement (an acknowledgement, a question).
      dropped.push(claim);
      continue;
    }
    const isSupported = content.every((token) =>
      /\d/.test(token) ? containsNumber(haystack, token) : containsWord(haystack, token),
    );
    if (!isSupported || unsupportedNegation(claim, haystack)) {
      dropped.push(claim);
      continue;
    }
    supported.push(claim);
  }

  return { supported, dropped, answer: supported.join(' ') };
}

/* -------------------------------------------------------------------------- */
/* Evidence helpers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The search queries to try, from the strictest to the most relaxed.
 *
 * Search matches a record only when *every* word of the query appears in it.
 * A natural question is mostly filler ("what did I say about tiles"), and no
 * record contains "what did I say about" — so the filler is dropped first. If
 * the remaining words still match nothing, each of them is tried on its own:
 * the question then finds the record it was about, instead of nothing.
 *
 * The strict query is always tried first, so a record that matches every
 * content word still wins over a looser match.
 */
export function queryVariants(question: string): string[] {
  // Two-letter content words are real queries ("AI", "ID", "TV"); only a
  // single stray letter is treated as noise. Stopwords are removed separately.
  const words = tokenize(question).filter((word) => !STOPWORDS.has(word) && word.length > 1);
  const trimmed = question.trim();
  if (words.length === 0) return trimmed.length > 0 ? [trimmed] : [];

  const variants = [words.join(' ')];
  for (const word of words) {
    if (word !== variants[0]) variants.push(word);
  }
  return variants;
}

/** Retrieves the candidate records that back an answer. */
export async function retrieveEvidence(
  ctx: AppContext,
  question: string,
  options: { types?: SearchEntityType[]; limit?: number } = {},
): Promise<SearchResultItem[]> {
  const limit = Math.min(Math.max(options.limit ?? MAX_EVIDENCE_LIMIT, 1), MAX_EVIDENCE_LIMIT);
  const search = (q: string) =>
    searchAll(ctx.db, {
      q,
      types: options.types,
      limit,
      offset: 0,
      includeDeleted: false,
      sort: 'relevance',
      order: 'desc',
    });

  const variants = queryVariants(question);
  if (variants.length === 0) return [];

  const strict = await search(variants[0]!);
  if (strict.items.length > 0) {
    return enrichEvidence(ctx.db, strict.items.slice(0, limit));
  }

  // The strict query found nothing: retry with the individual content words
  // and keep the records that several of them agree on.
  const relaxed = await Promise.all(variants.slice(1).map((variant) => search(variant)));
  const merged = new Map<string, { item: SearchResultItem; hits: number }>();
  for (const result of relaxed) {
    for (const item of result.items) {
      const entry = merged.get(item.id);
      if (entry) entry.hits += 1;
      else merged.set(item.id, { item, hits: 1 });
    }
  }

  const items = [...merged.values()]
    .sort((a, b) => b.hits - a.hits)
    .slice(0, limit)
    .map((entry) => entry.item);

  return enrichEvidence(ctx.db, items);
}

/**
 * Replaces the search excerpt with the record's own text.
 *
 * Search snippets are cut around the match, so they show *why* a record was
 * found but not what the record says. An answer is only allowed to assert
 * things that appear in the evidence the caller also receives, so the evidence
 * has to carry the record's text — otherwise a correct answer would be
 * discarded for not repeating the snippet.
 *
 * Only the excerpt changes. Title, timestamp, status and `matchedOn` stay
 * exactly as the search produced them, so a result still explains its match.
 */
export async function enrichEvidence(
  db: Db,
  items: SearchResultItem[],
): Promise<SearchResultItem[]> {
  if (items.length === 0) return items;

  const idsByType = new Map<SearchEntityType, string[]>();
  for (const item of items) {
    const ids = idsByType.get(item.type) ?? [];
    ids.push(item.id);
    idsByType.set(item.type, ids);
  }

  const texts = new Map<string, string>();

  for (const [type, ids] of idsByType) {
    switch (type) {
      case 'TASK': {
        const rows = await db.task.findMany({
          where: { id: { in: ids } },
          select: { id: true, title: true, description: true },
        });
        for (const row of rows) texts.set(row.id, row.description ?? row.title);
        break;
      }
      case 'NOTE': {
        const rows = await db.note.findMany({
          where: { id: { in: ids } },
          select: { id: true, body: true },
        });
        for (const row of rows) texts.set(row.id, row.body);
        break;
      }
      case 'IDEA': {
        const rows = await db.idea.findMany({
          where: { id: { in: ids } },
          select: { id: true, title: true, body: true },
        });
        for (const row of rows) texts.set(row.id, row.body ?? row.title);
        break;
      }
      case 'EVENT': {
        const rows = await db.event.findMany({
          where: { id: { in: ids } },
          select: { id: true, title: true, description: true },
        });
        for (const row of rows) texts.set(row.id, row.description ?? row.title);
        break;
      }
      case 'CAPTURE': {
        const rows = await db.capture.findMany({
          where: { id: { in: ids } },
          select: { id: true, rawText: true, transcript: true },
        });
        for (const row of rows) texts.set(row.id, visibleCaptureText(row));
        break;
      }
      case 'PROJECT': {
        const rows = await db.project.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true, description: true },
        });
        for (const row of rows) texts.set(row.id, row.description ?? row.name);
        break;
      }
      case 'REMINDER': {
        const rows = await db.reminder.findMany({
          where: { id: { in: ids } },
          select: { id: true, title: true, body: true },
        });
        for (const row of rows) texts.set(row.id, row.body ?? row.title);
        break;
      }
    }
  }

  return items.map((item) => {
    const text = texts.get(item.id);
    if (text === undefined) return item;
    const normalized = normalizeWhitespace(text);
    if (normalized.length === 0) return item;
    return { ...item, snippet: truncate(normalized, EVIDENCE_SNIPPET_MAX) };
  });
}

/** Projects search results into the shape the AI provider receives. */
export function buildEvidenceRecords(items: SearchResultItem[]): EvidenceRecord[] {
  return items.map((item) => ({
    type: item.type,
    id: item.id,
    title: item.title,
    snippet: item.snippet,
    timestamp: item.timestamp,
    status: item.status ?? null,
  }));
}

/** Keeps only the cited ids that are actually part of the evidence. */
export function validateCitations(citedIds: unknown, evidence: SearchResultItem[]): string[] {
  if (!Array.isArray(citedIds)) return [];
  const allowed = new Set(evidence.map((item) => item.id));
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of citedIds) {
    if (typeof id !== 'string') continue;
    if (!allowed.has(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/**
 * The answer used when no model answer can be trusted.
 *
 * It is built from the evidence itself, so it is grounded by construction: it
 * names the records that were found and nothing else.
 */
export function deterministicAnswer(evidence: SearchResultItem[]): string {
  if (evidence.length === 0) return 'I could not find anything about that.';
  const byType = new Map<string, string[]>();
  for (const item of evidence) {
    const list = byType.get(item.type) ?? [];
    list.push(item.title);
    byType.set(item.type, list);
  }
  const parts = [...byType.entries()].map(([type, titles]) => `${type}: ${titles.join('; ')}`);
  return `Based on your records, I found ${evidence.length} relevant record${evidence.length === 1 ? '' : 's'}: ${parts.join('. ')}.`;
}

/** The answer returned when there is nothing to answer from. */
export const NO_EVIDENCE_ANSWER = 'I could not find anything about that.';

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Answers a question from the owner's records.
 *
 * Returns the answer, the evidence it is based on and which provider produced
 * it. The HTTP layer does no reasoning of its own.
 */
export async function askQuestion(ctx: AppContext, request: AskRequest): Promise<AskOutcome> {
  const question = request.question.trim();
  if (question.length === 0) {
    throw new Error('Question cannot be empty');
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    throw new Error(`Question too long (max ${MAX_QUESTION_LENGTH} characters)`);
  }

  const evidenceItems = await retrieveEvidence(ctx, question, {
    types: request.types,
    limit: request.limit,
  });

  if (evidenceItems.length === 0) {
    return {
      grounded: false,
      answer: NO_EVIDENCE_ANSWER,
      evidence: [],
      provider: 'deterministic',
      deterministic: true,
    };
  }

  // The owner's configured zone decides what "now" means for the model.
  const settings = await getSettings(ctx.db, ctx.defaults);
  const timeZone = settings.timeZone;
  const referenceNow = ctx.clock.now();

  // `aiEnabled` is the owner's switch, not a capability flag: a configured
  // provider must never be called while the owner has disabled AI.
  const ai = settings.aiEnabled ? ctx.ai : null;
  if (ai) {
    try {
      const aiAnswer = await ai.answer({
        question,
        timeZone,
        referenceNow,
        evidence: buildEvidenceRecords(evidenceItems),
      });

      const citedIds = validateCitations(aiAnswer?.citedIds, evidenceItems);
      if (citedIds.length > 0) {
        const citedItems = evidenceItems.filter((item) => citedIds.includes(item.id));
        const grounding = groundAnswer(
          typeof aiAnswer.answer === 'string' ? aiAnswer.answer : '',
          buildEvidenceRecords(citedItems),
        );

        if (grounding.supported.length > 0) {
          if (grounding.dropped.length > 0) {
            // The count is logged, never the content.
            ctx.logger.warn('removed unsupported statements from an answer', {
              provider: ai.name,
              removed: grounding.dropped.length,
              kept: grounding.supported.length,
            });
          }
          return {
            grounded: true,
            answer: grounding.answer,
            evidence: citedItems,
            provider: ai.name,
            deterministic: false,
          };
        }

        ctx.logger.warn('discarded an answer that no statement of could be grounded', {
          provider: ai.name,
          removed: grounding.dropped.length,
        });
      }
    } catch (error) {
      ctx.logger.warn('AI answer failed, falling back to a deterministic answer', {
        provider: ai.name,
        reason: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  return {
    grounded: true,
    answer: deterministicAnswer(evidenceItems),
    evidence: evidenceItems,
    provider: 'deterministic',
    deterministic: true,
  };
}
