/**
 * Events and appointments.
 *
 * `startsAt` is mandatory and always a real instant supplied by the user (or
 * extracted from their words). Recall never invents an event time; if the text
 * has no date, the capture is kept for review instead.
 */
import type { EventCreateInput, EventDto, EventUpdateInput } from '@recall/shared';

import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { eventInclude, toEventDto, type EventRow } from '../mappers.js';

export interface EventFilter {
  q?: string;
  projectId?: string | null;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
  order?: 'asc' | 'desc';
}

export async function getEvent(db: Db, id: string): Promise<EventDto> {
  const row = await db.event.findUnique({ where: { id }, include: eventInclude });
  if (!row) throw new NotFoundError('Event', id);
  return toEventDto(row as EventRow);
}

export async function findEvents(db: Db, filter: EventFilter = {}): Promise<EventDto[]> {
  const where: Record<string, unknown> = {};
  if (filter.projectId !== undefined) where.projectId = filter.projectId;
  if (filter.q) where.OR = [{ title: { contains: filter.q } }, { description: { contains: filter.q } }];
  if (filter.from || filter.to) {
    where.startsAt = {
      ...(filter.from ? { gte: filter.from } : {}),
      ...(filter.to ? { lt: filter.to } : {}),
    };
  }
  const rows = await db.event.findMany({
    where,
    include: eventInclude,
    orderBy: { startsAt: filter.order ?? 'asc' },
    take: filter.limit ?? 100,
    skip: filter.offset ?? 0,
  });
  return rows.map((row) => toEventDto(row as EventRow));
}

export async function countEvents(db: Db, filter: EventFilter = {}): Promise<number> {
  const where: Record<string, unknown> = {};
  if (filter.projectId !== undefined) where.projectId = filter.projectId;
  if (filter.q) where.OR = [{ title: { contains: filter.q } }, { description: { contains: filter.q } }];
  if (filter.from || filter.to) {
    where.startsAt = {
      ...(filter.from ? { gte: filter.from } : {}),
      ...(filter.to ? { lt: filter.to } : {}),
    };
  }
  return db.event.count({ where });
}

export async function createEvent(
  ctx: AppContext,
  input: EventCreateInput,
  options: { db?: Db } = {},
): Promise<EventDto> {
  const db = options.db ?? ctx.db;
  const startsAt = new Date(input.startsAt);
  if (Number.isNaN(startsAt.getTime())) throw new ValidationError('startsAt is not a valid date');
  const endsAt = input.endsAt ? new Date(input.endsAt) : null;
  if (endsAt && endsAt.getTime() <= startsAt.getTime()) {
    throw new ValidationError('endsAt must be after startsAt');
  }

  const row = await db.event.create({
    data: {
      title: input.title,
      description: input.description ?? null,
      startsAt,
      endsAt,
      projectId: input.projectId ?? null,
      captureId: input.captureId ?? null,
    },
    include: eventInclude,
  });
  return toEventDto(row as EventRow);
}

export async function updateEvent(ctx: AppContext, id: string, patch: EventUpdateInput): Promise<EventDto> {
  const db = ctx.db;
  const existing = await db.event.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Event', id);

  const startsAt = patch.startsAt ? new Date(patch.startsAt) : undefined;
  const endsAt = patch.endsAt === undefined ? undefined : patch.endsAt ? new Date(patch.endsAt) : null;
  const effectiveStart = startsAt ?? existing.startsAt;
  const effectiveEnd = endsAt === undefined ? existing.endsAt : endsAt;
  if (effectiveEnd && effectiveEnd.getTime() <= effectiveStart.getTime()) {
    throw new ValidationError('endsAt must be after startsAt');
  }

  await db.event.update({
    where: { id },
    data: {
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.description === undefined ? {} : { description: patch.description ?? null }),
      ...(startsAt === undefined ? {} : { startsAt }),
      ...(endsAt === undefined ? {} : { endsAt }),
      ...(patch.projectId === undefined ? {} : { projectId: patch.projectId ?? null }),
    },
  });
  const fresh = await db.event.findUnique({ where: { id }, include: eventInclude });
  return toEventDto(fresh as EventRow);
}

export async function deleteEvent(db: Db, id: string): Promise<void> {
  const existing = await db.event.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Event', id);
  await db.event.delete({ where: { id } });
}
