/**
 * Cross-entity search.
 *
 * One query, many tables. Three things are deliberate:
 *
 * 1. **Every result says why it matched.** `matchedOn` lists the fields that
 *    actually contain the search text, computed from the row itself rather than
 *    inferred from the SQL. `snippet` is taken around the first match, so the
 *    dashboard can show the reason without guessing.
 * 2. **Merged pagination is honest.** Each type is fetched into a bounded window,
 *    the windows are merged and sorted in one place, and `total` comes from real
 *    `count` queries, so paging is consistent even when a type has more rows than
 *    the window. The cap is documented (see `SEARCH_WINDOW_CAP`).
 * 3. **A type-specific filter narrows the search to that type.** Passing
 *    `status` or `priority` searches tasks only; `kind` searches captures only.
 *    A filter that silently applied to some rows and not others would be worse
 *    than a slightly narrower result set. The same rule applies to `tag`:
 *    events, projects and reminders have no tag relation, so they return no
 *    rows under a tag filter rather than ignoring it.
 *
 * Search is plain `LIKE` (`contains`), one condition per query word, so every
 * word must appear somewhere in the row but the words do not need to be adjacent
 * or in the same field. On SQLite `LIKE` is case-insensitive for ASCII and
 * case-sensitive for other scripts; the application-level comparison used for
 * `matchedOn` is always case-insensitive. Full-text search is a documented
 * backlog item, not an accident.
 */
import {
  SEARCH_ENTITY_TYPES,
  type SearchEntityType,
  type SearchQuery,
  type SearchResponse,
  type SearchResultItem,
} from '@recall/shared';

import type { Db } from '../db/client.js';
import { normalizeWhitespace, truncate } from '../lib/text.js';
import { VOICE_PLACEHOLDER } from '../lib/voice.js';

export const SEARCH_TYPES = SEARCH_ENTITY_TYPES;
export type SearchType = SearchEntityType;

/**
 * Per-type row cap for one search. `limit` and `offset` are bounded by the
 * request schema, so personal-scale data is never truncated in practice; a
 * caveat is recorded in docs/ARCHITECTURE.md rather than hidden.
 */
export const SEARCH_WINDOW_CAP = 200;

/** Field weights decide relevance ordering and which snippet is shown. */
const FIELD_WEIGHT: Record<SearchType, Record<string, number>> = {
  TASK: { title: 3, category: 2, description: 1 },
  NOTE: { title: 3, url: 2, body: 1 },
  IDEA: { title: 3, body: 1 },
  EVENT: { title: 3, description: 1 },
  CAPTURE: { rawText: 3, transcript: 2 },
  PROJECT: { name: 3, description: 1 },
  REMINDER: { title: 3, body: 1 },
};

interface Candidate {
  item: SearchResultItem;
  score: number;
  createdAt: Date;
  updatedAt: Date | null;
  /** The entity's own timestamp: dueAt, startsAt, capturedAt, remindAt or createdAt. */
  relevantAt: Date | null;
}

type TextRecord = Record<string, unknown>;

/* -------------------------------------------------------------------------- */
/* Matching                                                                    */
/* -------------------------------------------------------------------------- */

function textEntries(record: TextRecord): [string, string][] {
  return Object.entries(record).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0,
  );
}

/** Splits a query into the words that must all appear somewhere in a row. */
export function wordsOf(q: string): string[] {
  return q
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 0);
}

interface MatchInfo {
  matchedOn: string[];
  score: number;
  best: { text: string; weight: number; phrase: boolean } | null;
}

/**
 * Scores a row against the query.
 *
 * Every word must appear in at least one searched field (the SQL applies the
 * same rule), but the fields do not have to agree: searching "invoice ada"
 * matches a task titled "Call Ada" whose description mentions the invoice. A
 * field scores higher when it contains the whole phrase, and higher still when
 * the phrase is the entire field.
 */
function computeMatch(type: SearchType, record: TextRecord, q: string): MatchInfo {
  const weights = FIELD_WEIGHT[type];
  const words = wordsOf(q);
  const phrase = q.trim().toLowerCase();

  const entries = textEntries(record).sort(
    (a, b) => (weights[b[0]] ?? 1) - (weights[a[0]] ?? 1),
  );

  const matchedOn: string[] = [];
  let score = 0;
  let best: { text: string; weight: number; phrase: boolean } | null = null;

  for (const [field, value] of entries) {
    const haystack = value.toLowerCase();
    if (!words.every((word) => haystack.includes(word))) continue;

    const weight = weights[field] ?? 1;
    matchedOn.push(field);

    const containsPhrase = phrase.length > 0 && haystack.includes(phrase);
    const exact = containsPhrase && haystack.trim() === phrase;
    const startsWith = containsPhrase && haystack.startsWith(phrase);
    const quality = 1 + (containsPhrase ? 2 : 0) + (exact ? 2 : 0) + (startsWith ? 1 : 0);
    score += weight * 10 + quality;

    if (!best || weight > best.weight) best = { text: value, weight, phrase: containsPhrase };
  }

  return { matchedOn, score, best };
}

export function buildSnippet(text: string, q?: string, max = 160): string {
  const flat = normalizeWhitespace(text);
  if (!q || q.trim().length === 0) return truncate(flat, max);

  const haystack = flat.toLowerCase();
  const phrase = q.trim().toLowerCase();
  // Centre the snippet on the whole phrase when it is present, otherwise on the
  // first query word, so a match is always visible.
  const needle = haystack.includes(phrase) ? phrase : (wordsOf(q)[0] ?? phrase);
  const index = haystack.indexOf(needle);
  if (index < 0) return truncate(flat, max);

  const half = Math.max(0, Math.floor((max - needle.length) / 2));
  const start = Math.max(0, index - half);
  const end = Math.min(flat.length, start + max);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

/* -------------------------------------------------------------------------- */
/* Type resolution                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Which types a query applies to. A type-specific filter implies its type.
 */
export function resolveSearchTypes(query: SearchQuery): SearchType[] {
  if (query.kind) return ['CAPTURE'];
  if (query.status || query.priority) return ['TASK'];
  if (query.types && query.types.length > 0) return [...query.types];
  return [...SEARCH_TYPES];
}

/* -------------------------------------------------------------------------- */
/* Where clauses                                                               */
/* -------------------------------------------------------------------------- */

function timeRange(query: SearchQuery): { gte?: Date; lte?: Date } | null {
  if (!query.from && !query.to) return null;
  return {
    ...(query.from ? { gte: new Date(query.from) } : {}),
    ...(query.to ? { lte: new Date(query.to) } : {}),
  };
}

/**
 * Builds the text condition for a type.
 *
 * Every word in the query must appear in one of the searched fields, but not
 * necessarily in the same one: "invoice ada" matches a task titled "Call Ada"
 * whose description mentions the invoice. The same rule is applied in
 * `computeMatch`, so `matchedOn` and the SQL can never disagree.
 */
function textWhere(fields: string[], q?: string): Record<string, unknown>[] | null {
  const words = q ? wordsOf(q) : [];
  if (words.length === 0) return null;
  return words.map((word) => ({
    OR: fields.map((field) => ({ [field]: { contains: word } })),
  }));
}

type Where = Record<string, unknown>;

function taskWhere(query: SearchQuery, q?: string): Where {
  const where: Where = {};
  if (query.status) where.status = query.status;
  if (query.priority) where.priority = query.priority;
  if (query.projectId) where.projectId = query.projectId;
  if (query.tag) where.tags = { some: { tag: { name: query.tag } } };
  const text = textWhere(['title', 'description', 'category'], q);
  if (text) where.AND = text;
  const range = timeRange(query);
  if (range) where.dueAt = range;
  return where;
}

function noteWhere(query: SearchQuery, q?: string): Where {
  const where: Where = {};
  if (query.projectId) where.projectId = query.projectId;
  if (query.tag) where.tags = { some: { tag: { name: query.tag } } };
  const text = textWhere(['title', 'body', 'url'], q);
  if (text) where.AND = text;
  const range = timeRange(query);
  if (range) where.createdAt = range;
  return where;
}

function ideaWhere(query: SearchQuery, q?: string): Where {
  const where: Where = {};
  if (query.projectId) where.projectId = query.projectId;
  if (query.tag) where.tags = { some: { tag: { name: query.tag } } };
  const text = textWhere(['title', 'body'], q);
  if (text) where.AND = text;
  const range = timeRange(query);
  if (range) where.createdAt = range;
  return where;
}

function eventWhere(query: SearchQuery, q?: string): Where {
  const where: Where = {};
  // Events have no tag relation. Do not ignore the filter: that would return
  // untagged rows in a tag-filtered result and inflate `total`.
  if (query.tag) where.id = { in: [] };
  if (query.projectId) where.projectId = query.projectId;
  const text = textWhere(['title', 'description'], q);
  if (text) where.AND = text;
  const range = timeRange(query);
  if (range) where.startsAt = range;
  return where;
}

function captureWhere(query: SearchQuery, q?: string): Where {
  const where: Where = {};
  if (query.kind) where.kind = query.kind;
  if (!query.includeDeleted) where.deletedAt = null;
  if (query.tag) where.tags = { some: { tag: { name: query.tag } } };
  const text = textWhere(['rawText', 'transcript'], q);
  if (text) where.AND = text;
  const range = timeRange(query);
  if (range) where.capturedAt = range;
  return where;
}

function projectWhere(query: SearchQuery, q?: string): Where {
  const where: Where = {};
  // Projects have no tag relation; see the comment on `eventWhere`.
  if (query.tag) where.id = { in: [] };
  else if (query.projectId) where.id = query.projectId;
  const text = textWhere(['name', 'description'], q);
  if (text) where.AND = text;
  const range = timeRange(query);
  if (range) where.createdAt = range;
  return where;
}

function reminderWhere(query: SearchQuery, q?: string): Where {
  const where: Where = {};
  // Reminders have no tag relation; see the comment on `eventWhere`.
  if (query.tag) where.id = { in: [] };
  const text = textWhere(['title', 'body'], q);
  if (text) where.AND = text;
  const range = timeRange(query);
  if (range) where.remindAt = range;
  return where;
}

/* -------------------------------------------------------------------------- */
/* Ordering                                                                    */
/* -------------------------------------------------------------------------- */

function dbOrderBy(
  type: SearchType,
  sort: SearchQuery['sort'],
  order: SearchQuery['order'],
): Record<string, unknown>[] {
  const direction = order;
  // Every per-type window ends with id so ties are cut at the same place on
  // every request (S4); the merged list breaks ties on type, then id.
  const byId = { id: direction };
  switch (sort) {
    case 'title':
      return [{ [type === 'PROJECT' ? 'name' : 'title']: direction }, byId];
    case 'updatedAt':
      return [{ updatedAt: direction }, byId];
    case 'dueAt':
      // Only tasks and events have a comparable "when"; everything else falls
      // back to its creation time so the window is still meaningful.
      if (type === 'TASK') return [{ dueAt: direction }, byId];
      if (type === 'EVENT') return [{ startsAt: direction }, byId];
      return [{ createdAt: direction }, byId];
    case 'remindAt':
      if (type === 'REMINDER') return [{ remindAt: direction }, byId];
      return [{ createdAt: direction }, byId];
    case 'createdAt':
    case 'relevance':
    default:
      return [{ createdAt: direction }, byId];
  }
}

function compareCandidates(
  a: Candidate,
  b: Candidate,
  sort: SearchQuery['sort'],
  order: SearchQuery['order'],
): number {
  const sign = order === 'asc' ? 1 : -1;
  const byDate = (x: Date | null, y: Date | null): number => {
    const tx = x ? x.getTime() : null;
    const ty = y ? y.getTime() : null;
    if (tx === null && ty === null) return 0;
    if (tx === null) return 1; // undated rows sort last in both directions
    if (ty === null) return -1;
    return sign * (tx - ty);
  };

  if (sort === 'title') return sign * a.item.title.localeCompare(b.item.title);
  if (sort === 'relevance') {
    if (b.score !== a.score) return b.score - a.score;
    return byDate(a.relevantAt, b.relevantAt) || b.createdAt.getTime() - a.createdAt.getTime();
  }
  if (sort === 'updatedAt') return byDate(a.updatedAt, b.updatedAt);
  if (sort === 'dueAt') return byDate(a.relevantAt, b.relevantAt);
  if (sort === 'remindAt') return byDate(a.relevantAt, b.relevantAt);
  return byDate(a.createdAt, b.createdAt);
}

/* -------------------------------------------------------------------------- */
/* Fetching                                                                    */
/* -------------------------------------------------------------------------- */

function titleFromCapture(row: { rawText: string; transcript: string | null }): string {
  const caption = row.rawText === VOICE_PLACEHOLDER ? '' : normalizeWhitespace(row.rawText);
  const firstLine = caption.split('\n')[0] ?? '';
  if (firstLine) return truncate(firstLine, 80);

  const transcript = row.transcript ? normalizeWhitespace(row.transcript) : '';
  const transcriptLine = transcript.split('\n')[0] ?? '';
  if (transcriptLine) return truncate(transcriptLine, 80);

  return row.rawText === VOICE_PLACEHOLDER
    ? 'Voice capture — transcript unavailable'
    : '(empty capture)';
}

/** The stored voice placeholder is internal state, never search-result content. */
export function visibleCaptureText(row: { rawText: string; transcript: string | null }): string {
  if (row.rawText !== VOICE_PLACEHOLDER) return row.rawText;
  return row.transcript ?? 'Transcript unavailable';
}

interface FetchContext {
  query: SearchQuery;
  q?: string;
  take: number;
}

async function fetchTasks(db: Db, { query, q, take }: FetchContext): Promise<Candidate[]> {
  const rows = await db.task.findMany({
    where: taskWhere(query, q),
    orderBy: dbOrderBy('TASK', query.sort, query.order) as never,
    take,
    select: {
      id: true,
      title: true,
      description: true,
      category: true,
      status: true,
      dueAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return rows.map((row) => {
    const match = q ? computeMatch('TASK', row, q) : null;
    return {
      item: {
        type: 'TASK' as const,
        id: row.id,
        title: row.title,
        snippet: buildSnippet(match?.best?.text ?? row.description ?? row.title, q),
        status: row.status,
        timestamp: (row.dueAt ?? row.createdAt).toISOString(),
        matchedOn: match?.matchedOn ?? [],
      },
      score: match?.score ?? 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      relevantAt: row.dueAt ?? row.createdAt,
    };
  });
}

async function fetchNotes(db: Db, { query, q, take }: FetchContext): Promise<Candidate[]> {
  const rows = await db.note.findMany({
    where: noteWhere(query, q),
    orderBy: dbOrderBy('NOTE', query.sort, query.order) as never,
    take,
    select: { id: true, title: true, body: true, url: true, createdAt: true, updatedAt: true },
  });
  return rows.map((row) => {
    const match = q ? computeMatch('NOTE', row, q) : null;
    const title = row.title ?? (truncate(normalizeWhitespace(row.body), 80) || '(untitled note)');
    return {
      item: {
        type: 'NOTE' as const,
        id: row.id,
        title,
        snippet: buildSnippet(match?.best?.text ?? row.body, q),
        timestamp: row.createdAt.toISOString(),
        matchedOn: match?.matchedOn ?? [],
      },
      score: match?.score ?? 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      relevantAt: row.createdAt,
    };
  });
}

async function fetchIdeas(db: Db, { query, q, take }: FetchContext): Promise<Candidate[]> {
  const rows = await db.idea.findMany({
    where: ideaWhere(query, q),
    orderBy: dbOrderBy('IDEA', query.sort, query.order) as never,
    take,
    select: { id: true, title: true, body: true, createdAt: true, updatedAt: true },
  });
  return rows.map((row) => {
    const match = q ? computeMatch('IDEA', row, q) : null;
    return {
      item: {
        type: 'IDEA' as const,
        id: row.id,
        title: row.title,
        snippet: buildSnippet(match?.best?.text ?? row.body ?? row.title, q),
        timestamp: row.createdAt.toISOString(),
        matchedOn: match?.matchedOn ?? [],
      },
      score: match?.score ?? 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      relevantAt: row.createdAt,
    };
  });
}

async function fetchEvents(db: Db, { query, q, take }: FetchContext): Promise<Candidate[]> {
  const rows = await db.event.findMany({
    where: eventWhere(query, q),
    orderBy: dbOrderBy('EVENT', query.sort, query.order) as never,
    take,
    select: {
      id: true,
      title: true,
      description: true,
      startsAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return rows.map((row) => {
    const match = q ? computeMatch('EVENT', row, q) : null;
    return {
      item: {
        type: 'EVENT' as const,
        id: row.id,
        title: row.title,
        snippet: buildSnippet(match?.best?.text ?? row.description ?? row.title, q),
        timestamp: row.startsAt.toISOString(),
        matchedOn: match?.matchedOn ?? [],
      },
      score: match?.score ?? 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      relevantAt: row.startsAt,
    };
  });
}

async function fetchCaptures(db: Db, { query, q, take }: FetchContext): Promise<Candidate[]> {
  const rows = await db.capture.findMany({
    where: captureWhere(query, q),
    orderBy: dbOrderBy('CAPTURE', query.sort, query.order) as never,
    take,
    select: {
      id: true,
      rawText: true,
      transcript: true,
      kind: true,
      status: true,
      capturedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return rows.map((row) => {
    const match = q ? computeMatch('CAPTURE', row, q) : null;
    const visibleText = visibleCaptureText(row);
    const snippetText =
      match?.best?.text === VOICE_PLACEHOLDER ? visibleText : (match?.best?.text ?? visibleText);
    return {
      item: {
        type: 'CAPTURE' as const,
        id: row.id,
        title: titleFromCapture(row),
        snippet: buildSnippet(snippetText, q),
        status: row.status,
        timestamp: row.capturedAt.toISOString(),
        matchedOn: match?.matchedOn ?? [],
      },
      score: match?.score ?? 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      relevantAt: row.capturedAt,
    };
  });
}

async function fetchProjects(db: Db, { query, q, take }: FetchContext): Promise<Candidate[]> {
  const rows = await db.project.findMany({
    where: projectWhere(query, q),
    orderBy: dbOrderBy('PROJECT', query.sort, query.order) as never,
    take,
    select: {
      id: true,
      name: true,
      description: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return rows.map((row) => {
    const match = q ? computeMatch('PROJECT', row, q) : null;
    return {
      item: {
        type: 'PROJECT' as const,
        id: row.id,
        title: row.name,
        snippet: buildSnippet(match?.best?.text ?? row.description ?? row.name, q),
        status: row.status,
        timestamp: row.createdAt.toISOString(),
        matchedOn: match?.matchedOn ?? [],
      },
      score: match?.score ?? 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      relevantAt: row.createdAt,
    };
  });
}

async function fetchReminders(db: Db, { query, q, take }: FetchContext): Promise<Candidate[]> {
  const rows = await db.reminder.findMany({
    where: reminderWhere(query, q),
    orderBy: dbOrderBy('REMINDER', query.sort, query.order) as never,
    take,
    select: {
      id: true,
      title: true,
      body: true,
      status: true,
      remindAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return rows.map((row) => {
    const match = q ? computeMatch('REMINDER', row, q) : null;
    return {
      item: {
        type: 'REMINDER' as const,
        id: row.id,
        title: row.title,
        snippet: buildSnippet(match?.best?.text ?? row.body ?? row.title, q),
        status: row.status,
        timestamp: row.remindAt.toISOString(),
        matchedOn: match?.matchedOn ?? [],
      },
      score: match?.score ?? 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      relevantAt: row.remindAt,
    };
  });
}

const FETCHERS: Record<SearchType, (db: Db, context: FetchContext) => Promise<Candidate[]>> = {
  TASK: fetchTasks,
  NOTE: fetchNotes,
  IDEA: fetchIdeas,
  EVENT: fetchEvents,
  CAPTURE: fetchCaptures,
  PROJECT: fetchProjects,
  REMINDER: fetchReminders,
};

const COUNT_WHERES: Record<SearchType, (query: SearchQuery, q?: string) => Where> = {
  TASK: taskWhere,
  NOTE: noteWhere,
  IDEA: ideaWhere,
  EVENT: eventWhere,
  CAPTURE: captureWhere,
  PROJECT: projectWhere,
  REMINDER: reminderWhere,
};

async function countType(db: Db, type: SearchType, query: SearchQuery, q?: string): Promise<number> {
  const where = COUNT_WHERES[type](query, q) as never;
  switch (type) {
    case 'TASK':
      return db.task.count({ where });
    case 'NOTE':
      return db.note.count({ where });
    case 'IDEA':
      return db.idea.count({ where });
    case 'EVENT':
      return db.event.count({ where });
    case 'CAPTURE':
      return db.capture.count({ where });
    case 'PROJECT':
      return db.project.count({ where });
    case 'REMINDER':
      return db.reminder.count({ where });
  }
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

export async function searchAll(db: Db, query: SearchQuery): Promise<SearchResponse> {
  const q = query.q && query.q.trim().length > 0 ? query.q.trim() : undefined;
  const types = resolveSearchTypes(query);
  const window = Math.min(query.offset + query.limit, SEARCH_WINDOW_CAP);

  const [perType, totals] = await Promise.all([
    Promise.all(types.map((type) => FETCHERS[type](db, { query, q, take: window }))),
    Promise.all(types.map((type) => countType(db, type, query, q))),
  ]);

  const merged = perType.flat();
  merged.sort((a, b) => {
    const primary = compareCandidates(a, b, query.sort, query.order);
    if (primary !== 0) return primary;
    // Stable, deterministic tie-break so identical scores never shuffle between
    // requests.
    if (a.item.type !== b.item.type) return a.item.type.localeCompare(b.item.type);
    return a.item.id.localeCompare(b.item.id);
  });

  return {
    items: merged.slice(query.offset, query.offset + query.limit).map((c) => c.item),
    total: totals.reduce((sum, count) => sum + count, 0),
    limit: query.limit,
    offset: query.offset,
    query: {
      q: q ?? null,
      types,
      status: query.status ?? null,
      kind: query.kind ?? null,
      projectId: query.projectId ?? null,
      tag: query.tag ?? null,
      priority: query.priority ?? null,
      from: query.from ?? null,
      to: query.to ?? null,
      includeDeleted: query.includeDeleted,
      sort: query.sort,
      order: query.order,
    },
  };
}
