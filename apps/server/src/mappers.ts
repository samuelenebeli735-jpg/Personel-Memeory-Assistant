/**
 * Prisma rows → wire DTOs.
 *
 * Kept in one module so the JSON shape of every entity is defined exactly once
 * and the dashboard types in `@recall/shared` stay authoritative.
 */
import type { Prisma } from '@prisma/client';
import type {
  CaptureDto,
  EventDto,
  IdeaDto,
  NoteDto,
  ProjectDto,
  ReminderDeliveryDto,
  ReminderDto,
  TagDto,
  TaskDto,
} from '@recall/shared';
import type { Priority, TaskStatus } from '@recall/shared';
import { zRecurrenceFrequency, type ReminderRecurrence } from '@recall/shared';

import type { ReminderStatus, CaptureKind, CaptureSource, CaptureStatus, ProjectStatus, DeliveryStatus } from '@recall/shared';

/* -------------------------------------------------------------------------- */
/* Includes                                                                    */
/* -------------------------------------------------------------------------- */

export const captureInclude = {
  tags: { include: { tag: true } },
  tasks: { select: { id: true, title: true } },
  notes: { select: { id: true, title: true } },
  ideas: { select: { id: true, title: true } },
  events: { select: { id: true, title: true } },
} satisfies Prisma.CaptureInclude;

export const taskInclude = {
  tags: { include: { tag: true } },
  project: { select: { id: true, name: true } },
} satisfies Prisma.TaskInclude;

export const noteInclude = {
  tags: { include: { tag: true } },
  project: { select: { id: true, name: true } },
} satisfies Prisma.NoteInclude;

export const ideaInclude = {
  tags: { include: { tag: true } },
  project: { select: { id: true, name: true } },
} satisfies Prisma.IdeaInclude;

export const eventInclude = {
  project: { select: { id: true, name: true } },
} satisfies Prisma.EventInclude;

export const projectCountInclude = {
  _count: { select: { tasks: true, notes: true, ideas: true, events: true } },
} satisfies Prisma.ProjectInclude;

export type CaptureRow = Prisma.CaptureGetPayload<{ include: typeof captureInclude }>;
export type TaskRow = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;
export type NoteRow = Prisma.NoteGetPayload<{ include: typeof noteInclude }>;
export type IdeaRow = Prisma.IdeaGetPayload<{ include: typeof ideaInclude }>;
export type EventRow = Prisma.EventGetPayload<{ include: typeof eventInclude }>;
export type ProjectRow = Prisma.ProjectGetPayload<{ include: typeof projectCountInclude }>;
export type ReminderRow = Prisma.ReminderGetPayload<Record<string, never>>;
export type ReminderDeliveryRow = Prisma.ReminderDeliveryGetPayload<Record<string, never>>;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function tagsOf(rows: { tag: { id: string; name: string } }[]): TagDto[] {
  return rows
    .map((row) => ({ id: row.tag.id, name: row.tag.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function isTaskOverdue(
  task: { status: string; dueAt: Date | null },
  now: Date,
): boolean {
  if (!task.dueAt) return false;
  if (task.status === 'COMPLETED' || task.status === 'CANCELLED') return false;
  return task.dueAt.getTime() < now.getTime();
}

export function parseRecurrence(value: string | null): ReminderRecurrence | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const frequency = zRecurrenceFrequency.safeParse(record.frequency);
    if (!frequency.success) return null;
    return {
      frequency: frequency.data,
      weekdays: Array.isArray(record.weekdays)
        ? record.weekdays.filter((d): d is number => typeof d === 'number' && d >= 0 && d <= 6)
        : [],
      until: typeof record.until === 'string' ? record.until : null,
      maxOccurrences:
        typeof record.maxOccurrences === 'number' && record.maxOccurrences > 0
          ? Math.min(500, Math.floor(record.maxOccurrences))
          : 52,
    };
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Mappers                                                                     */
/* -------------------------------------------------------------------------- */

export function toCaptureDto(row: CaptureRow): CaptureDto {
  const links: CaptureDto['links'] = [
    ...row.tasks.map((t) => ({ type: 'TASK' as const, id: t.id, title: t.title })),
    ...row.notes.map((n) => ({ type: 'NOTE' as const, id: n.id, title: n.title ?? '(untitled note)' })),
    ...row.ideas.map((i) => ({ type: 'IDEA' as const, id: i.id, title: i.title })),
    ...row.events.map((e) => ({ type: 'EVENT' as const, id: e.id, title: e.title })),
  ];
  return {
    id: row.id,
    source: row.source as CaptureSource,
    externalId: row.externalId,
    rawText: row.rawText,
    kind: row.kind as CaptureKind,
    status: row.status as CaptureStatus,
    confidence: row.confidence,
    needsReview: row.needsReview,
    classificationRationale: row.classificationRationale,
    transcript: row.transcript,
    transcriptSource: (row.transcriptSource as CaptureDto['transcriptSource']) ?? null,
    capturedAt: row.capturedAt.toISOString(),
    processedAt: row.processedAt?.toISOString() ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    tags: tagsOf(row.tags),
    links,
  };
}

export function toTaskDto(row: TaskRow, now: Date): TaskDto {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status as TaskStatus,
    priority: (row.priority as Priority | null) ?? null,
    category: row.category,
    dueAt: row.dueAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    projectId: row.projectId,
    projectName: row.project?.name ?? null,
    captureId: row.captureId,
    isOverdue: isTaskOverdue(row, now),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    tags: tagsOf(row.tags),
  };
}

export function toNoteDto(row: NoteRow): NoteDto {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    url: row.url,
    projectId: row.projectId,
    projectName: row.project?.name ?? null,
    captureId: row.captureId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    tags: tagsOf(row.tags),
  };
}

export function toIdeaDto(row: IdeaRow): IdeaDto {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    projectId: row.projectId,
    projectName: row.project?.name ?? null,
    captureId: row.captureId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    tags: tagsOf(row.tags),
  };
}

export function toEventDto(row: EventRow): EventDto {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt?.toISOString() ?? null,
    projectId: row.projectId,
    projectName: row.project?.name ?? null,
    captureId: row.captureId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toProjectDto(
  row: ProjectRow,
  openTasks: number,
): ProjectDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status as ProjectStatus,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    counts: {
      tasks: row._count.tasks,
      openTasks,
      notes: row._count.notes,
      ideas: row._count.ideas,
      events: row._count.events,
    },
  };
}

export function toReminderDto(row: ReminderRow): ReminderDto {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    remindAt: row.remindAt.toISOString(),
    status: row.status as ReminderStatus,
    attempts: row.attempts,
    lastError: row.lastError,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    taskId: row.taskId,
    captureId: row.captureId,
    recurrence: parseRecurrence(row.recurrence),
    parentId: row.parentId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toReminderDeliveryDto(row: ReminderDeliveryRow): ReminderDeliveryDto {
  return {
    id: row.id,
    reminderId: row.reminderId,
    attempt: row.attempt,
    status: row.status as DeliveryStatus,
    scheduledFor: row.scheduledFor.toISOString(),
    attemptedAt: row.attemptedAt?.toISOString() ?? null,
    error: row.error,
    idempotencyKey: row.idempotencyKey,
  };
}
