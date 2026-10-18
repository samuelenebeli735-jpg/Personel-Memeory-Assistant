/**
 * Notes and saved references.
 *
 * A note is information to keep. It is never a commitment, and nothing about it
 * is ever reported as "overdue".
 */
import type { NoteCreateInput, NoteDto, NoteUpdateInput } from '@recall/shared';

import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import { NotFoundError } from '../lib/errors.js';
import { noteInclude, toNoteDto, type NoteRow } from '../mappers.js';
import { replaceTags } from './tag-service.js';

export interface NoteFilter {
  q?: string;
  projectId?: string | null;
  tag?: string;
  withUrlOnly?: boolean;
  limit?: number;
  offset?: number;
  sort?: 'createdAt' | 'updatedAt' | 'title';
  order?: 'asc' | 'desc';
}

export async function getNote(db: Db, id: string): Promise<NoteDto> {
  const row = await db.note.findUnique({ where: { id }, include: noteInclude });
  if (!row) throw new NotFoundError('Note', id);
  return toNoteDto(row as NoteRow);
}

export async function findNotes(db: Db, filter: NoteFilter = {}): Promise<NoteDto[]> {
  const where: Record<string, unknown> = {};
  if (filter.projectId !== undefined) where.projectId = filter.projectId;
  if (filter.tag) where.tags = { some: { tag: { name: filter.tag.toLowerCase() } } };
  if (filter.withUrlOnly) where.url = { not: null };
  if (filter.q) where.OR = [{ title: { contains: filter.q } }, { body: { contains: filter.q } }];

  const rows = await db.note.findMany({
    where,
    include: noteInclude,
    orderBy: { [filter.sort ?? 'createdAt']: filter.order ?? 'desc' },
    take: filter.limit ?? 100,
    skip: filter.offset ?? 0,
  });
  return rows.map((row) => toNoteDto(row as NoteRow));
}

export async function countNotes(db: Db, filter: NoteFilter = {}): Promise<number> {
  const where: Record<string, unknown> = {};
  if (filter.projectId !== undefined) where.projectId = filter.projectId;
  if (filter.tag) where.tags = { some: { tag: { name: filter.tag.toLowerCase() } } };
  if (filter.withUrlOnly) where.url = { not: null };
  if (filter.q) where.OR = [{ title: { contains: filter.q } }, { body: { contains: filter.q } }];
  return db.note.count({ where });
}

export async function createNote(
  ctx: AppContext,
  input: NoteCreateInput,
  options: { db?: Db } = {},
): Promise<NoteDto> {
  const db = options.db ?? ctx.db;
  const row = await db.note.create({
    data: {
      title: input.title ?? null,
      body: input.body,
      url: input.url ?? null,
      projectId: input.projectId ?? null,
      captureId: input.captureId ?? null,
    },
    include: noteInclude,
  });
  if (input.tags.length > 0) await replaceTags(db, { noteId: row.id }, input.tags);
  const fresh = await db.note.findUnique({ where: { id: row.id }, include: noteInclude });
  return toNoteDto((fresh ?? row) as NoteRow);
}

export async function updateNote(ctx: AppContext, id: string, patch: NoteUpdateInput): Promise<NoteDto> {
  const db = ctx.db;
  const existing = await db.note.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Note', id);

  await db.note.update({
    where: { id },
    data: {
      ...(patch.title === undefined ? {} : { title: patch.title ?? null }),
      ...(patch.body === undefined ? {} : { body: patch.body }),
      ...(patch.url === undefined ? {} : { url: patch.url ?? null }),
      ...(patch.projectId === undefined ? {} : { projectId: patch.projectId ?? null }),
    },
  });
  if (patch.tags !== undefined) await replaceTags(db, { noteId: id }, patch.tags);
  const fresh = await db.note.findUnique({ where: { id }, include: noteInclude });
  return toNoteDto(fresh as NoteRow);
}

export async function deleteNote(db: Db, id: string): Promise<void> {
  const existing = await db.note.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Note', id);
  await db.note.delete({ where: { id } });
}
