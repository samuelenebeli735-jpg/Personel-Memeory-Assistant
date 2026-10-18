/**
 * Ideas.
 *
 * An idea is deliberately not a task: it has no status, no deadline and never
 * appears in an overdue list. Promotion to a task is an explicit user action
 * (`promoteIdea`) and always links the new task back to the original capture.
 */
import type { IdeaCreateInput, IdeaDto, IdeaUpdateInput, TaskCreateInput } from '@recall/shared';

import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import { NotFoundError } from '../lib/errors.js';
import { ideaInclude, toIdeaDto, type IdeaRow } from '../mappers.js';
import { replaceTags } from './tag-service.js';
import { createTask } from './task-service.js';

export interface IdeaFilter {
  q?: string;
  projectId?: string | null;
  tag?: string;
  limit?: number;
  offset?: number;
  sort?: 'createdAt' | 'updatedAt' | 'title';
  order?: 'asc' | 'desc';
}

export async function getIdea(db: Db, id: string): Promise<IdeaDto> {
  const row = await db.idea.findUnique({ where: { id }, include: ideaInclude });
  if (!row) throw new NotFoundError('Idea', id);
  return toIdeaDto(row as IdeaRow);
}

export async function findIdeas(db: Db, filter: IdeaFilter = {}): Promise<IdeaDto[]> {
  const where: Record<string, unknown> = {};
  if (filter.projectId !== undefined) where.projectId = filter.projectId;
  if (filter.tag) where.tags = { some: { tag: { name: filter.tag.toLowerCase() } } };
  if (filter.q) where.OR = [{ title: { contains: filter.q } }, { body: { contains: filter.q } }];

  const rows = await db.idea.findMany({
    where,
    include: ideaInclude,
    orderBy: { [filter.sort ?? 'createdAt']: filter.order ?? 'desc' },
    take: filter.limit ?? 100,
    skip: filter.offset ?? 0,
  });
  return rows.map((row) => toIdeaDto(row as IdeaRow));
}

export async function countIdeas(db: Db, filter: IdeaFilter = {}): Promise<number> {
  const where: Record<string, unknown> = {};
  if (filter.projectId !== undefined) where.projectId = filter.projectId;
  if (filter.tag) where.tags = { some: { tag: { name: filter.tag.toLowerCase() } } };
  if (filter.q) where.OR = [{ title: { contains: filter.q } }, { body: { contains: filter.q } }];
  return db.idea.count({ where });
}

export async function createIdea(
  ctx: AppContext,
  input: IdeaCreateInput,
  options: { db?: Db } = {},
): Promise<IdeaDto> {
  const db = options.db ?? ctx.db;
  const row = await db.idea.create({
    data: {
      title: input.title,
      body: input.body ?? null,
      projectId: input.projectId ?? null,
      captureId: input.captureId ?? null,
    },
    include: ideaInclude,
  });
  if (input.tags.length > 0) await replaceTags(db, { ideaId: row.id }, input.tags);
  const fresh = await db.idea.findUnique({ where: { id: row.id }, include: ideaInclude });
  return toIdeaDto((fresh ?? row) as IdeaRow);
}

export async function updateIdea(ctx: AppContext, id: string, patch: IdeaUpdateInput): Promise<IdeaDto> {
  const db = ctx.db;
  const existing = await db.idea.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Idea', id);

  await db.idea.update({
    where: { id },
    data: {
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.body === undefined ? {} : { body: patch.body ?? null }),
      ...(patch.projectId === undefined ? {} : { projectId: patch.projectId ?? null }),
    },
  });
  if (patch.tags !== undefined) await replaceTags(db, { ideaId: id }, patch.tags);
  const fresh = await db.idea.findUnique({ where: { id }, include: ideaInclude });
  return toIdeaDto(fresh as IdeaRow);
}

export async function deleteIdea(db: Db, id: string): Promise<void> {
  const existing = await db.idea.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Idea', id);
  await db.idea.delete({ where: { id } });
}

/**
 * Explicit promotion of an idea into a task. The idea is kept (an idea can lead
 * to more than one task) and the task links back to the same capture.
 */
export async function promoteIdea(
  ctx: AppContext,
  ideaId: string,
  overrides: Partial<TaskCreateInput> = {},
): Promise<{ idea: IdeaDto; taskId: string }> {
  const idea = await getIdea(ctx.db, ideaId);
  const task = await createTask(ctx, {
    title: overrides.title ?? idea.title,
    description: overrides.description ?? idea.body ?? null,
    status: overrides.status ?? 'PENDING',
    priority: overrides.priority ?? null,
    dueAt: overrides.dueAt ?? null,
    projectId: overrides.projectId ?? idea.projectId ?? null,
    category: overrides.category ?? null,
    tags: overrides.tags ?? idea.tags.map((tag) => tag.name),
    captureId: idea.captureId ?? null,
  });
  return { idea, taskId: task.id };
}
