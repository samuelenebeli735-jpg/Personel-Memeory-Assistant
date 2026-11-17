/**
 * Daily briefing service.
 *
 * This module is the *single* authoritative implementation of a briefing. Both
 * the HTTP route (`GET /api/briefing`) and the scheduled delivery call
 * `generateBriefing`; there is no second copy of the logic anywhere.
 *
 * Rules the implementation never breaks:
 *
 *  - **Nothing is invented.** Every item in a section is a row that exists in
 *    the database. There is no "suggested" task, no made-up deadline and no
 *    idea the owner did not write. A section that has no rows is empty, not
 *    filled with plausible-looking placeholders.
 *  - **Only configured sections appear**, in the configured order. A section
 *    the owner did not ask for is never added, even when it has content.
 *  - **Day boundaries follow the owner's zone.** "Today" is the local day in
 *    the configured IANA zone, never the server's day.
 *  - **An empty section is still reported.** The owner asked for it, so it is
 *    returned with zero items instead of silently disappearing.
 *
 * Section semantics (all relative to the briefing's reference day):
 *
 *  | Section    | Content                                                        |
 *  |------------|----------------------------------------------------------------|
 *  | `today`    | Open tasks due during the reference local day.                  |
 *  | `overdue`  | Open tasks whose deadline passed before that day started.        |
 *  | `upcoming` | Events starting from the reference day, within the next 7 days. |
 *  | `ideas`    | The most recently created ideas (a fixed, small number).        |
 *  | `deadlines`| Open tasks due after the reference local day ends.              |
 */
import type { Db } from '../db/client.js';
import { normalizeWhitespace, truncate } from '../lib/text.js';
import {
  formatLocalCompact,
  localDateTimeToUtc,
  localDayRange,
  localDayRangeOffset,
} from '../lib/time.js';

/** Section ids the owner may configure. */
export const BRIEFING_SECTION_IDS = ['today', 'overdue', 'upcoming', 'ideas', 'deadlines'] as const;
export type BriefingSectionId = (typeof BRIEFING_SECTION_IDS)[number];

/** Used when the owner has not configured any usable section. */
export const DEFAULT_BRIEFING_SECTIONS: BriefingSectionId[] = ['today', 'overdue', 'upcoming'];

/** Tasks that are still open. Completed and cancelled tasks never appear. */
const OPEN_TASK_STATUSES = ['PENDING', 'IN_PROGRESS'] as const;

/** How many items a single section may contain. */
const SECTION_LIMIT = 20;

/** How many recent ideas the `ideas` section lists. */
const IDEAS_LIMIT = 5;

/** How far ahead the `upcoming` section looks (days). */
const UPCOMING_WINDOW_DAYS = 7;

const SECTION_TITLES: Record<BriefingSectionId, string> = {
  today: 'Today',
  overdue: 'Overdue',
  upcoming: 'Upcoming',
  ideas: 'Ideas',
  deadlines: 'Deadlines',
};

export interface BriefingItem {
  type: 'TASK' | 'NOTE' | 'IDEA' | 'EVENT' | 'REMINDER' | 'CAPTURE' | 'PROJECT';
  id: string;
  title: string;
  snippet: string;
  /** ISO-8601 instant: the deadline for a task, the start for an event. */
  timestamp: string;
  status: string | null;
}

export interface BriefingSection {
  id: BriefingSectionId;
  title: string;
  items: BriefingItem[];
}

export interface BriefingData {
  /** Local calendar date the briefing covers (`YYYY-MM-DD`). */
  date: string;
  /** IANA zone the date and every boundary was resolved in. */
  timeZone: string;
  sections: BriefingSection[];
  /** One-line, human-readable description of the sections. */
  summary: string;
  /** Total number of items across all sections. */
  itemCount: number;
}

export interface BriefingOptions {
  /** IANA zone that defines "today". */
  timeZone: string;
  /** Configured section ids. Unknown ids are ignored; order is preserved. */
  sections: readonly string[];
  /** The instant the briefing is *for*. Defaults to now. */
  referenceDate?: Date;
}

/* -------------------------------------------------------------------------- */
/* Section ids                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Keeps only known section ids, in order and without duplicates.
 *
 * Settings are stored as JSON, so the list can be edited by hand; an unknown
 * id must not become a section with no content and no title.
 */
export function normalizeSectionIds(sections: readonly string[] | undefined | null): BriefingSectionId[] {
  if (!sections || sections.length === 0) return [...DEFAULT_BRIEFING_SECTIONS];
  const seen = new Set<BriefingSectionId>();
  const result: BriefingSectionId[] = [];
  for (const raw of sections) {
    const id = String(raw).trim().toLowerCase();
    if (!(BRIEFING_SECTION_IDS as readonly string[]).includes(id)) continue;
    const typed = id as BriefingSectionId;
    if (seen.has(typed)) continue;
    seen.add(typed);
    result.push(typed);
  }
  return result.length > 0 ? result : [...DEFAULT_BRIEFING_SECTIONS];
}

/* -------------------------------------------------------------------------- */
/* Date resolution                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Resolves the `date` query parameter of the briefing endpoint.
 *
 * Only `YYYY-MM-DD` is accepted; the value is interpreted in the owner's zone.
 * Returns `null` for anything else so the caller can reject it.
 */
export function parseBriefingDate(value: string | undefined | null, timeZone: string): Date | null {
  if (value === undefined || value === null || value.trim().length === 0) return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const instant = localDateTimeToUtc(trimmed, '00:00', timeZone);
  return instant;
}

/* -------------------------------------------------------------------------- */
/* Content                                                                     */
/* -------------------------------------------------------------------------- */

function snippetOf(text: string | null | undefined, fallback: string): string {
  const source = normalizeWhitespace(text ?? '');
  if (source.length === 0) return truncate(fallback, 160);
  return truncate(source, 160);
}

async function tasksDueBetween(
  db: Db,
  from: Date,
  to: Date,
): Promise<BriefingItem[]> {
  // A `gte`/`lt` comparison never matches a NULL column, so tasks without a
  // deadline are excluded without a second query.
  const rows = await db.task.findMany({
    where: { status: { in: [...OPEN_TASK_STATUSES] }, dueAt: { gte: from, lt: to } },
    orderBy: { dueAt: 'asc' },
    take: SECTION_LIMIT,
    select: { id: true, title: true, description: true, status: true, dueAt: true },
  });
  return rows.map((row) => ({
    type: 'TASK' as const,
    id: row.id,
    title: row.title,
    snippet: snippetOf(row.description, row.title),
    timestamp: row.dueAt!.toISOString(),
    status: row.status,
  }));
}

async function eventsStartingBetween(db: Db, from: Date, to: Date): Promise<BriefingItem[]> {
  const rows = await db.event.findMany({
    where: { startsAt: { gte: from, lt: to } },
    orderBy: { startsAt: 'asc' },
    take: SECTION_LIMIT,
    select: { id: true, title: true, description: true, startsAt: true },
  });
  return rows.map((row) => ({
    type: 'EVENT' as const,
    id: row.id,
    title: row.title,
    snippet: snippetOf(row.description, row.title),
    timestamp: row.startsAt.toISOString(),
    status: null,
  }));
}

async function recentIdeas(db: Db): Promise<BriefingItem[]> {
  const rows = await db.idea.findMany({
    orderBy: { createdAt: 'desc' },
    take: IDEAS_LIMIT,
    select: { id: true, title: true, body: true, createdAt: true },
  });
  return rows.map((row) => ({
    type: 'IDEA' as const,
    id: row.id,
    title: row.title,
    snippet: snippetOf(row.body, row.title),
    timestamp: row.createdAt.toISOString(),
    status: null,
  }));
}

interface DayBounds {
  /** Start of the reference local day (inclusive). */
  dayStart: Date;
  /** Start of the next local day (exclusive): the end of the reference day. */
  dayEnd: Date;
}

async function buildSection(
  db: Db,
  id: BriefingSectionId,
  bounds: DayBounds,
  timeZone: string,
): Promise<BriefingItem[]> {
  switch (id) {
    case 'today':
      return tasksDueBetween(db, bounds.dayStart, bounds.dayEnd);
    case 'overdue':
      // Everything whose deadline passed before the reference day began.
      return tasksDueBetween(db, new Date(0), bounds.dayStart);
    case 'deadlines':
      return tasksDueBetween(db, bounds.dayEnd, new Date(8_640_000_000_000_000));
    case 'upcoming': {
      // Seven *local* days, not seven fixed 24-hour periods: a DST transition
      // must not move the window boundary into the previous or next evening.
      const windowEnd = localDayRangeOffset(
        bounds.dayStart,
        timeZone,
        UPCOMING_WINDOW_DAYS,
      ).startUtc;
      return eventsStartingBetween(db, bounds.dayStart, windowEnd);
    }
    case 'ideas':
      return recentIdeas(db);
  }
}

/* -------------------------------------------------------------------------- */
/* Entry points                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Generates a briefing for the reference day.
 *
 * All content is read from the database; nothing is inferred or invented.
 */
export async function generateBriefing(db: Db, options: BriefingOptions): Promise<BriefingData> {
  const timeZone = options.timeZone;
  const referenceDate = options.referenceDate ?? new Date();
  const range = localDayRange(referenceDate, timeZone);
  const ids = normalizeSectionIds(options.sections);

  const sections: BriefingSection[] = [];
  for (const id of ids) {
    sections.push({
      id,
      title: SECTION_TITLES[id],
      items: await buildSection(
        db,
        id,
        { dayStart: range.startUtc, dayEnd: range.endUtc },
        timeZone,
      ),
    });
  }

  const itemCount = sections.reduce((sum, section) => sum + section.items.length, 0);
  return {
    date: range.localDate,
    timeZone,
    sections,
    summary: formatBriefingSummary(sections),
    itemCount,
  };
}

/** One-line description of the briefing, used in the API and in the message. */
export function formatBriefingSummary(sections: BriefingSection[]): string {
  const total = sections.reduce((sum, section) => sum + section.items.length, 0);
  if (total === 0) return 'Nothing scheduled for this day.';

  const parts = sections
    .filter((section) => section.items.length > 0)
    .map((section) => `${section.title} ${section.items.length}`);
  return `${total} item${total === 1 ? '' : 's'}: ${parts.join(', ')}.`;
}

/**
 * Plain-text rendering used for the scheduled delivery.
 *
 * Every line corresponds to a row in the database; the text never adds a
 * deadline, an owner or an item that is not in the sections above. A task or
 * an event shows the local time of its own timestamp, so the time on the
 * message is the time stored with the record.
 */
export function formatBriefingText(data: BriefingData): string {
  const lines: string[] = [`Daily briefing — ${data.date}`, data.summary];
  for (const section of data.sections) {
    if (section.items.length === 0) continue;
    lines.push('', section.title);
    for (const item of section.items) {
      const when = item.type === 'TASK' || item.type === 'EVENT'
        ? formatLocalCompact(new Date(item.timestamp), data.timeZone)
        : null;
      lines.push(when ? `• ${item.title} — ${when}` : `• ${item.title}`);
    }
  }
  return lines.join('\n');
}
