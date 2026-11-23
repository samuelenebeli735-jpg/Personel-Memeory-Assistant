/**
 * Questions about time: "What do I have tomorrow?", "When is my next
 * reminder?", "What happened last Friday?", "How many days until my next
 * event?".
 *
 * Word search cannot answer these — no record contains the word "tomorrow" —
 * so this module reads the question's time intent and retrieves records by
 * their own timestamps, in the owner's Settings zone. Answers are written by
 * code from the records themselves (owner decision, R1-03): exact dates, no
 * model call, nothing invented. A question this module does not recognise as
 * clearly temporal returns `null` and Ask falls back to word search.
 *
 * Record types stay distinct: a "next reminder" is never a task, and every
 * listed item is labelled with its type.
 */
import type { AskPeriod, SearchEntityType, SearchResultItem } from '@recall/shared';
import { DateTime } from 'luxon';

import type { Db } from '../db/client.js';
import { parseTemporalExpression } from '../lib/nlp.js';
import { normalizeWhitespace, truncate } from '../lib/text.js';
import { searchAll, visibleCaptureText } from './search-service.js';

/** Most items listed in one answer; the rest are counted, not dropped silently. */
export const TEMPORAL_ITEM_LIMIT = 25;

export type ScheduledType = 'TASK' | 'EVENT' | 'REMINDER';

export interface TemporalRange {
  start: Date;
  end: Date;
  /** "tomorrow (Sun 18 Oct)", "this week (Mon 19 Oct – Sun 25 Oct)". */
  phrase: string;
  /** "Tomorrow, Sun 18 Oct" — the label clients display. */
  label: string;
  singleDay: boolean;
}

export type TemporalIntent =
  | {
      kind: 'range';
      /** agenda = what is scheduled; activity = what happened. */
      mode: 'agenda' | 'activity';
      range: TemporalRange;
      types: ScheduledType[] | null;
      subject: string | null;
    }
  | { kind: 'next'; type: ScheduledType }
  | { kind: 'last'; type: ScheduledType }
  | { kind: 'until'; type: ScheduledType | null; subject: string | null }
  | { kind: 'unclear'; fragment: string };

export interface TemporalAnswer {
  grounded: boolean;
  answer: string;
  evidence: SearchResultItem[];
  period?: AskPeriod;
}

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

const TYPE_WORDS: Record<string, ScheduledType> = {
  reminder: 'REMINDER',
  reminders: 'REMINDER',
  event: 'EVENT',
  events: 'EVENT',
  appointment: 'EVENT',
  appointments: 'EVENT',
  meeting: 'EVENT',
  meetings: 'EVENT',
  task: 'TASK',
  tasks: 'TASK',
  todo: 'TASK',
  todos: 'TASK',
  deadline: 'TASK',
  deadlines: 'TASK',
};
const TYPE_ALTERNATION = Object.keys(TYPE_WORDS).join('|');

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october',
  'november', 'december', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct',
  'nov', 'dec',
];

/** Words that carry the question's shape, not its subject. */
const FILLER = new Set([
  'a', 'about', 'all', 'am', 'an', 'and', 'any', 'anything', 'are', 'at', 'be', 'by', 'calendar',
  'coming', 'could', 'day', 'days', 'did', 'do', 'does', 'done', 'due', 'during', 'else', 'every',
  'everything', 'for', 'from', 'got', 'had', 'happen', 'happened', 'happening', 'has', 'have',
  'how', 'i', 'in', 'is', 'it', 'items', 'last', 'latest', 'left', 'list', 'long', 'many', 'me',
  'month', 'most', 'my', 'next', 'of', 'on', 'or', 'over', 'plan', 'planned', 'plans', 'previous',
  'recent', 'schedule', 'scheduled', 'show', 'tell', 'that', 'the', 'there', 'these', 'things',
  'this', 'till', 'til', 'to', 'today', 'tomorrow', 'tonight', 'until', 'upcoming', 'was', 'week',
  'weeks', 'were', 'what', 'whats', 'when', 'which', 'will', 'with', 'yesterday', 'you', 'agenda',
  'go', 'going', 'on', 'up', 'wrote', 'write', 'save', 'saved', 'capture', 'captured', 'note',
  'noted', 'say', 'said', 'add', 'added', 'complete', 'completed', 'finish', 'finished',
  'notes', 'idea', 'ideas', 'captures', 'record', 'records', 'stuff', 'get', 'need', 'should',
  ...WEEKDAYS,
  ...MONTHS,
  ...Object.keys(TYPE_WORDS),
]);

/** Clear past forms only: "what will happen tomorrow" is not about the past. */
const PAST_TENSE = /\b(happened|did|was|were|had|captured|wrote|saved|noted|said|added|completed|finished)\b/;

function normalise(question: string): string {
  return question
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}\s:/-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function typesIn(text: string): ScheduledType[] {
  const found = new Set<ScheduledType>();
  for (const word of text.split(' ')) {
    const type = TYPE_WORDS[word];
    if (type) found.add(type);
  }
  return [...found];
}

/** Words left after removing question shape, time words, types and numbers. */
function subjectOf(text: string): string | null {
  const words = text
    .split(/[\s/-]+/)
    .filter((word) => word.length > 1 && !FILLER.has(word) && !/^\d/.test(word) && !/:/.test(word));
  return words.length > 0 ? words.join(' ') : null;
}

/* -------------------------------------------------------------------------- */
/* Periods in the owner's zone                                                 */
/* -------------------------------------------------------------------------- */

function dayLabel(day: DateTime): string {
  return day.toFormat('ccc d LLL');
}

function dayRange(day: DateTime, phrase: string | null, title: string | null): TemporalRange {
  const start = day.startOf('day');
  const end = start.plus({ days: 1 });
  const date = dayLabel(start);
  return {
    start: start.toUTC().toJSDate(),
    end: end.toUTC().toJSDate(),
    phrase: phrase ? `${phrase} (${date})` : date,
    label: title ? `${title}, ${date}` : date,
    singleDay: true,
  };
}

function spanRange(start: DateTime, end: DateTime, phrase: string, title: string): TemporalRange {
  const last = end.minus({ days: 1 });
  const span = `${dayLabel(start)} – ${dayLabel(last)}`;
  return {
    start: start.toUTC().toJSDate(),
    end: end.toUTC().toJSDate(),
    phrase: `${phrase} (${span})`,
    label: `${title}, ${span}`,
    singleDay: false,
  };
}

/**
 * Resolves the period a question names, or `null` when it names none.
 * Returns `'unclear'` when it clearly names a time that cannot be resolved.
 */
function resolveRange(
  text: string,
  past: boolean,
  now: Date,
  timeZone: string,
): TemporalRange | 'unclear' | null {
  const today = DateTime.fromJSDate(now, { zone: timeZone }).startOf('day');

  if (/\b(today|tonight)\b/.test(text)) return dayRange(today, 'today', 'Today');
  if (/\btomorrow\b/.test(text)) return dayRange(today.plus({ days: 1 }), 'tomorrow', 'Tomorrow');
  if (/\byesterday\b/.test(text)) return dayRange(today.minus({ days: 1 }), 'yesterday', 'Yesterday');

  // Weeks run Monday to Sunday (owner decision, R1-03); Luxon weeks are ISO weeks.
  const week = /\b(this|next|last|previous) week\b/.exec(text);
  if (week) {
    const offset = week[1] === 'next' ? 1 : week[1] === 'this' ? 0 : -1;
    const start = today.startOf('week').plus({ weeks: offset });
    const title = offset === 1 ? 'Next week' : offset === 0 ? 'This week' : 'Last week';
    return spanRange(start, start.plus({ weeks: 1 }), title.toLowerCase(), title);
  }
  const month = /\b(this|next|last|previous) month\b/.exec(text);
  if (month) {
    const offset = month[1] === 'next' ? 1 : month[1] === 'this' ? 0 : -1;
    const start = today.startOf('month').plus({ months: offset });
    const title = offset === 1 ? 'Next month' : offset === 0 ? 'This month' : 'Last month';
    return spanRange(start, start.plus({ months: 1 }), title.toLowerCase(), title);
  }

  const weekday = new RegExp(`\\b(?:(last|previous|next|this|on|coming)\\s+)?(${WEEKDAYS.join('|')})\\b`).exec(text);
  if (weekday) {
    const target = WEEKDAYS.indexOf(weekday[2]!) + 1; // Luxon: Monday = 1
    const modifier = weekday[1];
    const backwards = modifier === 'last' || modifier === 'previous' || (past && modifier !== 'next' && modifier !== 'coming');
    let day: DateTime;
    if (backwards) {
      // The most recent such day; "last Friday" on a Friday means a week ago.
      const back = (today.weekday - target + 7) % 7 || (modifier === 'last' || modifier === 'previous' ? 7 : 0);
      day = today.minus({ days: back });
    } else {
      // The coming such day; "next Friday" on a Friday means in a week.
      const forward = (target - today.weekday + 7) % 7 || (modifier === 'next' ? 7 : 0);
      day = today.plus({ days: forward });
    }
    return dayRange(day, null, null);
  }

  // An explicit date: "25 December", "dec 25", "2026-12-25".
  const hasDate =
    /\b\d{4}-\d{2}-\d{2}\b/.test(text) ||
    new RegExp(`\\b(${MONTHS.join('|')})\\s+\\d{1,2}(st|nd|rd|th)?\\b|\\b\\d{1,2}(st|nd|rd|th)?\\s+(${MONTHS.join('|')})\\b`).test(text);
  if (hasDate) {
    const parsed = parseTemporalExpression(text, { timeZone, reference: now, forwardDate: !past });
    if (!parsed.instant) return 'unclear';
    return dayRange(DateTime.fromJSDate(parsed.instant, { zone: timeZone }), null, null);
  }

  // Named a period that is not supported above ("next weekend", "in June").
  // "may" and "march" are excluded: they are also ordinary verbs.
  const unclearMonths = MONTHS.filter((m) => m !== 'may' && m !== 'march' && m !== 'mar');
  if (new RegExp(`\\b(week|weekend|month|${unclearMonths.join('|')})\\b`).test(text)) return 'unclear';
  return null;
}

/* -------------------------------------------------------------------------- */
/* Intent                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Reads the time intent of a question, or `null` when the question is not
 * clearly about time (Ask then uses word search, e.g. "When is my dentist
 * appointment?").
 */
export function detectTemporalIntent(question: string, timeZone: string, now: Date): TemporalIntent | null {
  const text = normalise(question);
  const past = PAST_TENSE.test(text);

  // "How many days until my next event / until the dentist?"
  if (/\bhow (many days|many weeks|long)\b/.test(text) || /\bdays (left )?(until|till|til|before)\b/.test(text)) {
    const next = new RegExp(`\\b(next|upcoming|coming)\\s+(${TYPE_ALTERNATION})\\b`).exec(text);
    if (next) return { kind: 'until', type: TYPE_WORDS[next[2]!]!, subject: null };
    const after = /\b(?:until|till|til|before|to)\b(.*)$/.exec(text);
    const subject = after ? subjectOf(after[1]!) : null;
    const types = typesIn(after?.[1] ?? '');
    if (!subject && types.length === 0) return { kind: 'unclear', fragment: question.trim() };
    return { kind: 'until', type: types[0] ?? null, subject };
  }

  const next = new RegExp(`\\b(next|upcoming|coming)\\s+(${TYPE_ALTERNATION})\\b`).exec(text);
  if (next) return { kind: 'next', type: TYPE_WORDS[next[2]!]! };
  const last = new RegExp(`\\b(last|previous|latest|most recent)\\s+(${TYPE_ALTERNATION})\\b`).exec(text);
  if (last) return { kind: 'last', type: TYPE_WORDS[last[2]!]! };

  const range = resolveRange(text, past, now, timeZone);
  if (range === 'unclear') return { kind: 'unclear', fragment: question.trim() };
  if (!range) return null;
  const types = typesIn(text);
  return {
    kind: 'range',
    // A period that has not started yet can only be about what is scheduled.
    mode: past && range.start.getTime() < now.getTime() ? 'activity' : 'agenda',
    range,
    types: types.length > 0 ? types : null,
    subject: subjectOf(text),
  };
}

/* -------------------------------------------------------------------------- */
/* Retrieval                                                                   */
/* -------------------------------------------------------------------------- */

const OPEN_TASK = ['PENDING', 'IN_PROGRESS'];

function snippet(text: string | null | undefined, fallback: string): string {
  const flat = normalizeWhitespace(text ?? '');
  return truncate(flat.length > 0 ? flat : fallback, 160);
}

function taskItem(
  row: { id: string; title: string; description: string | null; status: string },
  at: Date,
  field: 'dueAt' | 'completedAt',
): SearchResultItem {
  return {
    type: 'TASK',
    id: row.id,
    title: row.title,
    snippet: snippet(row.description, row.title),
    status: row.status,
    timestamp: at.toISOString(),
    matchedOn: [field],
  };
}

function eventItem(row: { id: string; title: string; description: string | null; startsAt: Date }): SearchResultItem {
  return {
    type: 'EVENT',
    id: row.id,
    title: row.title,
    snippet: snippet(row.description, row.title),
    timestamp: row.startsAt.toISOString(),
    matchedOn: ['startsAt'],
  };
}

function reminderItem(row: {
  id: string;
  title: string;
  body: string | null;
  status: string;
  remindAt: Date;
}): SearchResultItem {
  return {
    type: 'REMINDER',
    id: row.id,
    title: row.title,
    snippet: snippet(row.body, row.title),
    status: row.status,
    timestamp: row.remindAt.toISOString(),
    matchedOn: ['remindAt'],
  };
}

function captureItem(row: {
  id: string;
  rawText: string;
  transcript: string | null;
  status: string;
  capturedAt: Date;
}): SearchResultItem {
  const text = normalizeWhitespace(visibleCaptureText(row));
  return {
    type: 'CAPTURE',
    id: row.id,
    title: truncate(text.split('\n')[0] ?? text, 80) || '(empty capture)',
    snippet: snippet(text, '(empty capture)'),
    status: row.status,
    timestamp: row.capturedAt.toISOString(),
    matchedOn: ['capturedAt'],
  };
}

const TAKE = TEMPORAL_ITEM_LIMIT + 1;
const taskSelect = { id: true, title: true, description: true, status: true, dueAt: true, completedAt: true } as const;
const eventSelect = { id: true, title: true, description: true, startsAt: true } as const;
const reminderSelect = { id: true, title: true, body: true, status: true, remindAt: true } as const;

async function agendaItems(db: Db, range: TemporalRange, types: ScheduledType[]): Promise<SearchResultItem[]> {
  const between = { gte: range.start, lt: range.end };
  const [tasks, events, reminders] = await Promise.all([
    types.includes('TASK')
      ? db.task.findMany({ where: { status: { in: OPEN_TASK }, dueAt: between }, orderBy: { dueAt: 'asc' }, take: TAKE, select: taskSelect })
      : [],
    types.includes('EVENT')
      ? db.event.findMany({ where: { startsAt: between }, orderBy: { startsAt: 'asc' }, take: TAKE, select: eventSelect })
      : [],
    types.includes('REMINDER')
      ? db.reminder.findMany({ where: { status: 'SCHEDULED', remindAt: between }, orderBy: { remindAt: 'asc' }, take: TAKE, select: reminderSelect })
      : [],
  ]);
  return [
    ...events.map(eventItem),
    ...tasks.map((row) => taskItem(row, row.dueAt!, 'dueAt')),
    ...reminders.map(reminderItem),
  ];
}

async function activityItems(db: Db, range: TemporalRange, now: Date): Promise<SearchResultItem[]> {
  // "What happened" (owner decision, R1-03): captures from that period, events
  // that took place, and tasks completed then. Nothing after `now` happened yet.
  const end = range.end.getTime() < now.getTime() ? range.end : now;
  const between = { gte: range.start, lt: end };
  const [captures, events, completed] = await Promise.all([
    db.capture.findMany({
      where: { deletedAt: null, capturedAt: between },
      orderBy: { capturedAt: 'asc' },
      take: TAKE,
      select: { id: true, rawText: true, transcript: true, status: true, capturedAt: true },
    }),
    db.event.findMany({ where: { startsAt: between }, orderBy: { startsAt: 'asc' }, take: TAKE, select: eventSelect }),
    db.task.findMany({
      where: { status: 'COMPLETED', completedAt: between },
      orderBy: { completedAt: 'asc' },
      take: TAKE,
      select: taskSelect,
    }),
  ]);
  return [
    ...captures.map(captureItem),
    ...events.map(eventItem),
    ...completed.map((row) => taskItem(row, row.completedAt!, 'completedAt')),
  ];
}

async function nextOf(db: Db, type: ScheduledType, now: Date): Promise<SearchResultItem | null> {
  if (type === 'TASK') {
    const row = await db.task.findFirst({ where: { status: { in: OPEN_TASK }, dueAt: { gte: now } }, orderBy: { dueAt: 'asc' }, select: taskSelect });
    return row ? taskItem(row, row.dueAt!, 'dueAt') : null;
  }
  if (type === 'EVENT') {
    const row = await db.event.findFirst({ where: { startsAt: { gte: now } }, orderBy: { startsAt: 'asc' }, select: eventSelect });
    return row ? eventItem(row) : null;
  }
  const row = await db.reminder.findFirst({ where: { status: 'SCHEDULED', remindAt: { gte: now } }, orderBy: { remindAt: 'asc' }, select: reminderSelect });
  return row ? reminderItem(row) : null;
}

async function lastOf(db: Db, type: ScheduledType, now: Date): Promise<SearchResultItem | null> {
  if (type === 'TASK') {
    const row = await db.task.findFirst({ where: { dueAt: { lt: now }, status: { not: 'CANCELLED' } }, orderBy: { dueAt: 'desc' }, select: taskSelect });
    return row ? taskItem(row, row.dueAt!, 'dueAt') : null;
  }
  if (type === 'EVENT') {
    const row = await db.event.findFirst({ where: { startsAt: { lt: now } }, orderBy: { startsAt: 'desc' }, select: eventSelect });
    return row ? eventItem(row) : null;
  }
  const row = await db.reminder.findFirst({ where: { remindAt: { lt: now }, status: { not: 'CANCELLED' } }, orderBy: { remindAt: 'desc' }, select: reminderSelect });
  return row ? reminderItem(row) : null;
}

/** Records matching a subject in a period or in the future, on each type's own time field. */
async function subjectItems(
  db: Db,
  subject: string,
  from: Date,
  to: Date | null,
  types: SearchEntityType[],
): Promise<SearchResultItem[]> {
  const result = await searchAll(db, {
    q: subject,
    types,
    from: from.toISOString(),
    ...(to ? { to: new Date(to.getTime() - 1).toISOString() } : {}),
    includeDeleted: false,
    sort: 'dueAt',
    order: 'asc',
    limit: TAKE,
    offset: 0,
  });
  return result.items.filter(
    (item) =>
      !(item.type === 'TASK' && (item.status === 'COMPLETED' || item.status === 'CANCELLED')) &&
      !(item.type === 'REMINDER' && item.status !== 'SCHEDULED'),
  );
}

/* -------------------------------------------------------------------------- */
/* Answers                                                                     */
/* -------------------------------------------------------------------------- */

const TYPE_NAMES: Record<string, [string, string]> = {
  TASK: ['task', 'tasks'],
  EVENT: ['event', 'events'],
  REMINDER: ['reminder', 'reminders'],
  CAPTURE: ['capture', 'captures'],
  NOTE: ['note', 'notes'],
  IDEA: ['idea', 'ideas'],
  PROJECT: ['project', 'projects'],
};

function when(item: SearchResultItem, timeZone: string, singleDay: boolean): string {
  const local = DateTime.fromISO(item.timestamp, { zone: timeZone });
  return singleDay ? local.toFormat('h:mm a') : local.toFormat('ccc d LLL, h:mm a');
}

function itemLine(item: SearchResultItem, timeZone: string, singleDay: boolean): string {
  const at = when(item, timeZone, singleDay);
  const detail =
    item.matchedOn.includes('completedAt')
      ? `completed ${at}`
      : item.type === 'TASK'
        ? `due ${at}`
        : item.type === 'CAPTURE'
          ? `captured ${at}`
          : at;
  return `• ${item.title} — ${detail}`;
}

/** Items grouped by type, each group labelled, so types never blur together. */
function groupedLines(items: SearchResultItem[], timeZone: string, singleDay: boolean): string[] {
  const order: string[] = [];
  const groups = new Map<string, SearchResultItem[]>();
  for (const item of items) {
    const key = item.matchedOn.includes('completedAt') ? 'COMPLETED' : item.type;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(item);
  }
  const lines: string[] = [];
  for (const key of order) {
    const group = groups.get(key)!;
    const heading = key === 'COMPLETED' ? 'Completed tasks' : (TYPE_NAMES[key]?.[1] ?? key.toLowerCase());
    lines.push(`${heading.charAt(0).toUpperCase()}${heading.slice(1)}:`);
    for (const item of group) lines.push(itemLine(item, timeZone, singleDay));
  }
  return lines;
}

function plural(count: number, [one, many]: [string, string]): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "nothing", "no events", "no events or tasks". */
function nothingOf(types: ScheduledType[] | null): string {
  if (!types || types.length === 0) return 'nothing';
  return `no ${types.map((type) => TYPE_NAMES[type]![1]).join(' or ')}`;
}

function periodOf(range: TemporalRange, timeZone: string): AskPeriod {
  return { start: range.start.toISOString(), end: range.end.toISOString(), label: range.label, timeZone };
}

function relativeDays(target: Date, now: Date, timeZone: string): number {
  const from = DateTime.fromJSDate(now, { zone: timeZone }).startOf('day');
  const to = DateTime.fromJSDate(target, { zone: timeZone }).startOf('day');
  // Calendar days: compare local dates, so a DST change cannot add or lose a day.
  return Math.round(
    (Date.UTC(to.year, to.month - 1, to.day) - Date.UTC(from.year, from.month - 1, from.day)) / 86_400_000,
  );
}

function inDays(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

/**
 * Answers a question about time from the owner's records, or returns `null`
 * when the question is not clearly about time.
 */
export async function answerTemporalQuestion(
  db: Db,
  question: string,
  options: { timeZone: string; now: Date; types?: SearchEntityType[] },
): Promise<TemporalAnswer | null> {
  const { timeZone, now } = options;
  const intent = detectTemporalIntent(question, timeZone, now);
  if (!intent) return null;
  const allowed = (type: SearchEntityType) => !options.types || options.types.includes(type);
  const fmt = (iso: string) => DateTime.fromISO(iso, { zone: timeZone }).toFormat("ccc d LLL 'at' h:mm a");

  if (intent.kind === 'unclear') {
    return {
      grounded: false,
      answer: `I could not tell which day or period you mean in “${truncate(intent.fragment, 120)}”. Try “tomorrow”, “last Friday”, “this week”, “next month” or a date such as “25 December”.`,
      evidence: [],
    };
  }

  if (intent.kind === 'next' || intent.kind === 'last') {
    const name = TYPE_NAMES[intent.type]!;
    const item = allowed(intent.type)
      ? await (intent.kind === 'next' ? nextOf(db, intent.type, now) : lastOf(db, intent.type, now))
      : null;
    if (!item) {
      return {
        grounded: false,
        answer: intent.kind === 'next' ? `You have no upcoming ${name[1]}.` : `You have no past ${name[1]}.`,
        evidence: [],
      };
    }
    const days = relativeDays(new Date(item.timestamp), now, timeZone);
    const answer =
      intent.kind === 'next'
        ? `Your next ${name[0]} is “${item.title}” on ${fmt(item.timestamp)} (${inDays(days)}).`
        : `Your last ${name[0]} was “${item.title}” on ${fmt(item.timestamp)}.`;
    return { grounded: true, answer, evidence: [item] };
  }

  if (intent.kind === 'until') {
    let item: SearchResultItem | null = null;
    let missing: string;
    if (intent.subject) {
      const types = (intent.type ? [intent.type] : (['EVENT', 'TASK', 'REMINDER'] as ScheduledType[])).filter(allowed);
      const items = types.length > 0 ? await subjectItems(db, intent.subject, now, null, types) : [];
      item = items.sort((a, b) => a.timestamp.localeCompare(b.timestamp))[0] ?? null;
      missing = `I could not find anything upcoming matching “${intent.subject}”.`;
    } else {
      const type = intent.type!;
      item = allowed(type) ? await nextOf(db, type, now) : null;
      missing = `You have no upcoming ${TYPE_NAMES[type]![1]}.`;
    }
    if (!item) return { grounded: false, answer: missing, evidence: [] };
    const days = relativeDays(new Date(item.timestamp), now, timeZone);
    const label = intent.subject ? `“${item.title}”` : `your next ${TYPE_NAMES[item.type]![0]}, “${item.title}”,`;
    const sentence = days === 0
      ? `${label.charAt(0).toUpperCase()}${label.slice(1)} is today, ${fmt(item.timestamp)}.`
      : `${label.charAt(0).toUpperCase()}${label.slice(1)} is ${inDays(days)}: ${fmt(item.timestamp)}.`;
    return { grounded: true, answer: sentence, evidence: [item] };
  }

  // A period: what is scheduled, or what happened.
  const { range, mode } = intent;
  const types = (intent.types ?? (['EVENT', 'TASK', 'REMINDER'] as ScheduledType[])).filter(allowed);
  let items: SearchResultItem[];
  if (intent.subject) {
    const searchTypes: SearchEntityType[] = intent.types ?? ['EVENT', 'TASK', 'REMINDER', 'CAPTURE', 'NOTE', 'IDEA'];
    items = await subjectItems(db, intent.subject, range.start, range.end, searchTypes.filter(allowed));
  } else if (mode === 'activity') {
    items = (await activityItems(db, range, now)).filter((item) => allowed(item.type));
  } else {
    items = types.length > 0 ? await agendaItems(db, range, types) : [];
  }

  const period = periodOf(range, timeZone);
  if (items.length === 0) {
    const about = intent.subject ? ` about “${intent.subject}”` : '';
    const answer =
      mode === 'activity'
        ? `I have nothing recorded${about} for ${range.phrase}.`
        : intent.subject
          ? `I found nothing${about} for ${range.phrase}.`
          : `You have ${nothingOf(intent.types)} scheduled for ${range.phrase}.`;
    return { grounded: false, answer, evidence: [], period };
  }

  const shown = items.slice(0, TEMPORAL_ITEM_LIMIT);
  const extra = items.length - shown.length;
  const total = plural(items.length > TEMPORAL_ITEM_LIMIT ? TEMPORAL_ITEM_LIMIT : items.length, ['item', 'items']);
  const intro =
    mode === 'activity'
      ? `For ${range.phrase} I have ${total} recorded:`
      : `For ${range.phrase} you have ${total}:`;
  const lines = [intro, ...groupedLines(shown, timeZone, range.singleDay)];
  if (extra > 0) lines.push(`…and more not shown. Narrow the question (a type such as “events”, or a shorter period) to see them.`);
  return { grounded: true, answer: lines.join('\n'), evidence: shown, period };
}
