/**
 * Projects group related tasks, ideas, notes and events.
 *
 * Decision: a project is only ever *matched* by name, never created from an AI
 * guess. Classification may suggest `projectName`; if no existing project matches
 * case-insensitively the suggestion is recorded as a note on the capture rather
 * than silently creating a project the user never asked for.
 */
import type { ProjectCreateInput, ProjectDto, ProjectUpdateInput } from '@recall/shared';

import type { Db } from '../db/client.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import { projectCountInclude, toProjectDto, type ProjectRow } from '../mappers.js';

/**
 * Case-insensitive project lookup.
 *
 * SQLite has no `mode: 'insensitive'` in Prisma, so the comparison is done in
 * application code. A single owner has a small number of projects, so listing
 * them is cheap and the behaviour is explicit rather than collation-dependent.
 */
export async function findProjectByName(
  db: Db,
  name: string,
): Promise<{ id: string; name: string } | null> {
  const trimmed = name.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  const projects = await db.project.findMany({ select: { id: true, name: true } });
  const exact = projects.find((p) => p.name.trim().toLowerCase() === trimmed);
  if (exact) return exact;
  // Fall back to a containment match so "PostgreSQL research" finds a
  // "PostgreSQL" project, but never invent a new one.
  const partial = projects.find((p) => {
    const candidate = p.name.trim().toLowerCase();
    return candidate.length >= 3 && (trimmed.includes(candidate) || candidate.includes(trimmed));
  });
  return partial ?? null;
}

function projectListWhere(options: { includeArchived?: boolean }): Record<string, unknown> {
  return options.includeArchived ? {} : { status: 'ACTIVE' };
}

/** Counts with the same filter as `listProjects` (S2). */
export async function countProjects(db: Db, options: { includeArchived?: boolean } = {}): Promise<number> {
  return db.project.count({ where: projectListWhere(options) });
}

export async function listProjects(
  db: Db,
  options: { includeArchived?: boolean; limit?: number; offset?: number } = {},
): Promise<ProjectDto[]> {
  const rows = await db.project.findMany({
    where: projectListWhere(options),
    orderBy: [{ status: 'asc' }, { name: 'asc' }, { id: 'asc' }],
    skip: options.offset ?? 0,
    take: options.limit ?? 200,
    include: projectCountInclude,
  });
  const openCounts = await db.task.groupBy({
    by: ['projectId'],
    where: { status: { in: ['PENDING', 'IN_PROGRESS'] }, projectId: { not: null } },
    _count: { _all: true },
  });
  const openByProject = new Map(
    openCounts.map((row) => [row.projectId as string, row._count._all]),
  );
  return rows.map((row) => toProjectDto(row, openByProject.get(row.id) ?? 0));
}

export async function getProject(db: Db, id: string): Promise<ProjectDto> {
  const row = await db.project.findUnique({ where: { id }, include: projectCountInclude });
  if (!row) throw new NotFoundError('Project', id);
  const openTasks = await db.task.count({
    where: { projectId: id, status: { in: ['PENDING', 'IN_PROGRESS'] } },
  });
  return toProjectDto(row as ProjectRow, openTasks);
}

export async function createProject(db: Db, input: ProjectCreateInput): Promise<ProjectDto> {
  const existing = await db.project.findUnique({ where: { name: input.name } });
  if (existing) throw new ConflictError(`A project named "${input.name}" already exists`);
  const created = await db.project.create({
    data: {
      name: input.name,
      description: input.description ?? null,
      status: input.status,
    },
    include: projectCountInclude,
  });
  return toProjectDto(created as ProjectRow, 0);
}

export async function updateProject(
  db: Db,
  id: string,
  patch: ProjectUpdateInput,
): Promise<ProjectDto> {
  const existing = await db.project.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Project', id);

  if (patch.name !== undefined && patch.name !== existing.name) {
    const clash = await db.project.findUnique({ where: { name: patch.name } });
    if (clash) throw new ConflictError(`A project named "${patch.name}" already exists`);
  }

  await db.project.update({
    where: { id },
    data: {
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.description === undefined ? {} : { description: patch.description }),
      ...(patch.status === undefined
        ? {}
        : { status: patch.status, archivedAt: patch.status === 'ARCHIVED' ? new Date() : null }),
    },
  });
  return getProject(db, id);
}

/**
 * Deleting a project never deletes its contents: the members are detached
 * (`projectId = NULL`) so tasks, notes, ideas and events survive.
 */
export async function deleteProject(db: Db, id: string): Promise<{ detached: number }> {
  const existing = await db.project.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Project', id);

  const [tasks, notes, ideas, events] = await db.$transaction([
    db.task.updateMany({ where: { projectId: id }, data: { projectId: null } }),
    db.note.updateMany({ where: { projectId: id }, data: { projectId: null } }),
    db.idea.updateMany({ where: { projectId: id }, data: { projectId: null } }),
    db.event.updateMany({ where: { projectId: id }, data: { projectId: null } }),
  ]);
  await db.project.delete({ where: { id } });
  return { detached: tasks.count + notes.count + ideas.count + events.count };
}
