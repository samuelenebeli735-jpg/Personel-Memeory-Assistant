/**
 * Tag handling.
 *
 * Tag names are normalised to lower case with collapsed whitespace so that
 * "#Finance", "finance" and "Finance " are one tag, not three. Tags are created
 * on demand; they are never imported from anywhere else.
 */
import type { Db } from '../db/client.js';
import { normalizeWhitespace } from '../lib/text.js';

export function normalizeTagName(name: string): string {
  return normalizeWhitespace(name).toLowerCase().slice(0, 40);
}

/** Creates any missing tags and returns the ids of all requested tags. */
export async function ensureTagIds(db: Db, names: readonly string[]): Promise<string[]> {
  const normalised = [...new Set(names.map(normalizeTagName).filter((n) => n.length > 0))];
  if (normalised.length === 0) return [];

  const ids: string[] = [];
  for (const name of normalised) {
    const tag = await db.tag.upsert({
      where: { name },
      update: {},
      create: { name },
      select: { id: true },
    });
    ids.push(tag.id);
  }
  return ids;
}

export interface LinkTargetColumns {
  captureId?: string | null;
  taskId?: string | null;
  noteId?: string | null;
  ideaId?: string | null;
}

/**
 * Replaces the tags on the given entity with exactly `names`.
 * Returns the ids that were linked.
 */
export async function replaceTags(
  db: Db,
  target: LinkTargetColumns,
  names: readonly string[],
): Promise<string[]> {
  const tagIds = await ensureTagIds(db, names);

  if (target.captureId !== undefined) {
    const captureId = target.captureId;
    if (captureId === null) return [];
    await db.captureTag.deleteMany({ where: { captureId } });
    if (tagIds.length > 0) {
      await db.captureTag.createMany({ data: tagIds.map((tagId) => ({ captureId, tagId })) });
    }
  }
  if (target.taskId !== undefined) {
    const taskId = target.taskId;
    if (taskId === null) return tagIds;
    await db.taskTag.deleteMany({ where: { taskId } });
    if (tagIds.length > 0) {
      await db.taskTag.createMany({ data: tagIds.map((tagId) => ({ taskId, tagId })) });
    }
  }
  if (target.noteId !== undefined) {
    const noteId = target.noteId;
    if (noteId === null) return tagIds;
    await db.noteTag.deleteMany({ where: { noteId } });
    if (tagIds.length > 0) {
      await db.noteTag.createMany({ data: tagIds.map((tagId) => ({ noteId, tagId })) });
    }
  }
  if (target.ideaId !== undefined) {
    const ideaId = target.ideaId;
    if (ideaId === null) return tagIds;
    await db.ideaTag.deleteMany({ where: { ideaId } });
    if (tagIds.length > 0) {
      await db.ideaTag.createMany({ data: tagIds.map((tagId) => ({ ideaId, tagId })) });
    }
  }
  return tagIds;
}

export interface TagWithCount {
  id: string;
  name: string;
  captures: number;
  tasks: number;
  notes: number;
  ideas: number;
}

export async function listTags(db: Db, limit = 200): Promise<TagWithCount[]> {
  const rows = await db.tag.findMany({
    take: limit,
    orderBy: { name: 'asc' },
    include: { _count: { select: { captures: true, tasks: true, notes: true, ideas: true } } },
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    captures: row._count.captures,
    tasks: row._count.tasks,
    notes: row._count.notes,
    ideas: row._count.ideas,
  }));
}

/** Removes tags that are no longer attached to anything. */
export async function pruneOrphanTags(db: Db): Promise<number> {
  const orphans = await db.tag.findMany({
    where: {
      captures: { none: {} },
      tasks: { none: {} },
      notes: { none: {} },
      ideas: { none: {} },
    },
    select: { id: true },
  });
  if (orphans.length === 0) return 0;
  const result = await db.tag.deleteMany({ where: { id: { in: orphans.map((o) => o.id) } } });
  return result.count;
}
