/**
 * Task management.
 *
 * Two rules matter most here:
 *  1. State changes are explicit and guarded. A task is never completed as a
 *     side effect of discussing it — only an explicit transition does that.
 *  2. Completing or cancelling a task cancels its pending reminders, so a
 *     finished task can never produce a notification afterwards.
 */
import {
  TASK_TRANSITIONS,
  type TaskCreateInput,
  type TaskDto,
  type TaskStatus,
  type TaskUpdateInput,
} from '@recall/shared';

import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { taskInclude, toTaskDto, type TaskRow } from '../mappers.js';
import { replaceTags } from './tag-service.js';

export interface TaskFilter {
  status?: TaskStatus | TaskStatus[];
  priority?: string;
  projectId?: string | null;
  tag?: string;
  q?: string;
  dueBefore?: Date;
  dueAfter?: Date;
  overdueOnly?: boolean;
  openOnly?: boolean;
  limit?: number;
  offset?: number;
  sort?: 'dueAt' | 'createdAt' | 'updatedAt' | 'priority' | 'title';
  order?: 'asc' | 'desc';
}

const PRIORITY_RANK: Record<string, number> = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  const allowed = TASK_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new ValidationError(`Cannot change a task from ${from} to ${to}`);
  }
}

function statusIsOpen(status: TaskStatus | undefined): boolean {
  return status === undefined || status === 'PENDING' || status === 'IN_PROGRESS';
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

export async function getTask(db: Db, id: string): Promise<TaskDto> {
  const row = await db.task.findUnique({ where: { id }, include: taskInclude });
  if (!row) throw new NotFoundError('Task', id);
  return toTaskDto(row as TaskRow, new Date());
}

export async function findTasks(db: Db, filter: TaskFilter, now: Date): Promise<TaskDto[]> {
  const where: Record<string, unknown> = {};

  if (filter.status !== undefined) {
    where.status = Array.isArray(filter.status) ? { in: filter.status } : filter.status;
  } else if (filter.openOnly) {
    where.status = { in: ['PENDING', 'IN_PROGRESS'] };
  }
  if (filter.priority) where.priority = filter.priority;
  if (filter.projectId !== undefined) where.projectId = filter.projectId;
  if (filter.tag) where.tags = { some: { tag: { name: filter.tag.toLowerCase() } } };
  if (filter.dueBefore || filter.dueAfter) {
    where.dueAt = {
      ...(filter.dueAfter ? { gte: filter.dueAfter } : {}),
      ...(filter.dueBefore ? { lt: filter.dueBefore } : {}),
    };
  }
  if (filter.q) {
    where.OR = [
      { title: { contains: filter.q } },
      { description: { contains: filter.q } },
      { category: { contains: filter.q } },
    ];
  }
  if (filter.overdueOnly) {
    where.dueAt = { ...(where.dueAt as object | undefined), lt: now };
    where.status = { in: ['PENDING', 'IN_PROGRESS'] };
  }

  const order = filter.order ?? 'asc';
  const sort = filter.sort ?? 'dueAt';
  const orderBy: Record<string, unknown>[] =
    sort === 'priority'
      ? [{ priority: order }, { dueAt: 'asc' }]
      : [{ [sort]: order }, { createdAt: 'desc' }];

  const rows = await db.task.findMany({
    where,
    include: taskInclude,
    orderBy,
    take: filter.limit ?? 100,
    skip: filter.offset ?? 0,
  });

  const tasks = rows.map((row) => toTaskDto(row as TaskRow, now));
  if (sort === 'priority') {
    // Prisma sorts strings alphabetically, which is meaningless for priorities.
    tasks.sort((a, b) => {
      const rankA = a.priority ? (PRIORITY_RANK[a.priority] ?? 9) : 9;
      const rankB = b.priority ? (PRIORITY_RANK[b.priority] ?? 9) : 9;
      return order === 'asc' ? rankA - rankB : rankB - rankA;
    });
  }
  return tasks;
}

export async function countTasks(db: Db, filter: TaskFilter, now: Date): Promise<number> {
  const where: Record<string, unknown> = {};
  if (filter.status !== undefined) {
    where.status = Array.isArray(filter.status) ? { in: filter.status } : filter.status;
  } else if (filter.openOnly) {
    where.status = { in: ['PENDING', 'IN_PROGRESS'] };
  }
  if (filter.priority) where.priority = filter.priority;
  if (filter.projectId !== undefined) where.projectId = filter.projectId;
  if (filter.tag) where.tags = { some: { tag: { name: filter.tag.toLowerCase() } } };
  if (filter.q) {
    where.OR = [{ title: { contains: filter.q } }, { description: { contains: filter.q } }];
  }
  if (filter.dueBefore || filter.dueAfter) {
    where.dueAt = {
      ...(filter.dueAfter ? { gte: filter.dueAfter } : {}),
      ...(filter.dueBefore ? { lt: filter.dueBefore } : {}),
    };
  }
  if (filter.overdueOnly) {
    where.dueAt = { ...(where.dueAt as object | undefined), lt: now };
    where.status = { in: ['PENDING', 'IN_PROGRESS'] };
  }
  return db.task.count({ where });
}

export interface TaskCounts {
  open: number;
  pending: number;
  inProgress: number;
  completed: number;
  cancelled: number;
  overdue: number;
  dueToday: number;
}

export async function taskCounts(
  db: Db,
  now: Date,
  range: { startUtc: Date; endUtc: Date },
): Promise<TaskCounts> {
  const [pending, inProgress, completed, cancelled, overdue, dueToday] = await Promise.all([
    db.task.count({ where: { status: 'PENDING' } }),
    db.task.count({ where: { status: 'IN_PROGRESS' } }),
    db.task.count({ where: { status: 'COMPLETED' } }),
    db.task.count({ where: { status: 'CANCELLED' } }),
    db.task.count({ where: { status: { in: ['PENDING', 'IN_PROGRESS'] }, dueAt: { lt: now } } }),
    db.task.count({
      where: {
        status: { in: ['PENDING', 'IN_PROGRESS'] },
        dueAt: { gte: range.startUtc, lt: range.endUtc },
      },
    }),
  ]);
  return {
    open: pending + inProgress,
    pending,
    inProgress,
    completed,
    cancelled,
    overdue,
    dueToday,
  };
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                      */
/* -------------------------------------------------------------------------- */

export async function createTask(
  ctx: AppContext,
  input: TaskCreateInput,
  options: { db?: Db } = {},
): Promise<TaskDto> {
  const db = options.db ?? ctx.db;
  const status = input.status as TaskStatus;
  const now = ctx.clock.now();

  const row = await db.task.create({
    data: {
      title: input.title,
      description: input.description ?? null,
      status,
      priority: input.priority ?? null,
      category: input.category ?? null,
      dueAt: input.dueAt ? new Date(input.dueAt) : null,
      projectId: input.projectId ?? null,
      captureId: input.captureId ?? null,
      completedAt: status === 'COMPLETED' ? now : null,
      cancelledAt: status === 'CANCELLED' ? now : null,
    },
    include: taskInclude,
  });
  if (input.tags.length > 0) await replaceTags(db, { taskId: row.id }, input.tags);
  const fresh = await db.task.findUnique({ where: { id: row.id }, include: taskInclude });
  return toTaskDto((fresh ?? row) as TaskRow, now);
}

export async function updateTask(
  ctx: AppContext,
  id: string,
  patch: TaskUpdateInput,
): Promise<TaskDto> {
  const db = ctx.db;
  const existing = await db.task.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Task', id);

  const data: Record<string, unknown> = {};
  if (patch.title !== undefined) data.title = patch.title;
  if (patch.description !== undefined) data.description = patch.description ?? null;
  if (patch.category !== undefined) data.category = patch.category ?? null;
  if (patch.priority !== undefined) data.priority = patch.priority ?? null;
  if (patch.dueAt !== undefined) data.dueAt = patch.dueAt ? new Date(patch.dueAt) : null;
  if (patch.projectId !== undefined) {
    if (patch.projectId) {
      const project = await db.project.findUnique({ where: { id: patch.projectId } });
      if (!project) throw new NotFoundError('Project', patch.projectId);
    }
    data.projectId = patch.projectId ?? null;
  }
  if (patch.status !== undefined) {
    assertTaskTransition(existing.status as TaskStatus, patch.status);
    data.status = patch.status;
    if (patch.status === 'COMPLETED') data.completedAt = ctx.clock.now();
    if (patch.status !== 'COMPLETED') data.completedAt = null;
    if (patch.status === 'CANCELLED') data.cancelledAt = ctx.clock.now();
    if (patch.status !== 'CANCELLED') data.cancelledAt = null;
  }

  await db.task.update({ where: { id }, data });
  if (patch.tags !== undefined) await replaceTags(db, { taskId: id }, patch.tags);

  // A finished task must never fire a reminder afterwards.
  if (patch.status === 'COMPLETED' || patch.status === 'CANCELLED') {
    await cancelTaskReminders(db, id, ctx.clock.now());
  }

  const fresh = await db.task.findUnique({ where: { id }, include: taskInclude });
  return toTaskDto(fresh as TaskRow, ctx.clock.now());
}

export async function setTaskStatus(ctx: AppContext, id: string, status: TaskStatus): Promise<TaskDto> {
  return updateTask(ctx, id, { status });
}

/** Cancels every still-scheduled reminder attached to a task. */
export async function cancelTaskReminders(db: Db, taskId: string, now: Date): Promise<number> {
  const result = await db.reminder.updateMany({
    where: { taskId, status: 'SCHEDULED' },
    data: { status: 'CANCELLED' },
  });
  if (result.count > 0) {
    await db.reminderDelivery.updateMany({
      where: { reminder: { taskId }, status: 'PENDING' },
      data: { status: 'SKIPPED', error: 'task completed or cancelled', attemptedAt: now },
    });
  }
  return result.count;
}

export async function deleteTask(db: Db, id: string): Promise<{ remindersRemoved: number }> {
  const existing = await db.task.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Task', id);
  // Reminders cascade at the database level (onDelete: Cascade on delivery rows)
  // but a reminder pointing at a deleted task would be meaningless, so remove them.
  const reminders = await db.reminder.deleteMany({ where: { taskId: id } });
  await db.task.delete({ where: { id } });
  return { remindersRemoved: reminders.count };
}

/** Ids of open tasks, used by the dashboard for bulk suggestions. */
export async function openTaskIds(db: Db, limit = 50): Promise<string[]> {
  const rows = await db.task.findMany({
    where: { status: { in: ['PENDING', 'IN_PROGRESS'] } },
    orderBy: [{ dueAt: 'asc' }, { createdAt: 'asc' }],
    take: limit,
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

export { statusIsOpen };
