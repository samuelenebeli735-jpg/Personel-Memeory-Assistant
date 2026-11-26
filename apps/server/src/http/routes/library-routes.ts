/**
 * Library API: tasks, notes, ideas, events, projects and tags.
 *
 * The dashboard and the Telegram commands both call the services behind these
 * routes, so a rule (state transitions, project matching, promotion) is enforced
 * once. Nothing here re-implements authentication; every route sits behind the
 * session hook in `http/server.ts`.
 *
 * Route order matters in Fastify: literal paths (`/tasks/today`) are registered
 * before parameterised ones (`/tasks/:id`).
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  PRIORITIES,
  TASK_STATUSES,
  ideaCreateSchema,
  ideaUpdateSchema,
  noteCreateSchema,
  noteUpdateSchema,
  projectCreateSchema,
  projectUpdateSchema,
  taskCreateSchema,
  taskUpdateSchema,
  eventCreateSchema,
  eventUpdateSchema,
  type EventDto,
  type IdeaDto,
  type NoteDto,
  type Paginated,
  type ProjectDto,
  type TaskDto,
} from '@recall/shared';

import type { AppContext } from '../../context.js';
import { localDayRange } from '../../lib/time.js';
import {
  dateParam,
  enumListParam,
  parseBody,
  parseIdParam,
  parseQuery,
} from '../validation.js';
import {
  countTasks,
  createTask,
  deleteTask,
  findTasks,
  getTask,
  taskCounts,
  updateTask,
  type TaskCounts,
  type TaskFilter,
} from '../../services/task-service.js';
import {
  countNotes,
  createNote,
  deleteNote,
  findNotes,
  getNote,
  updateNote,
} from '../../services/note-service.js';
import {
  countIdeas,
  createIdea,
  deleteIdea,
  findIdeas,
  getIdea,
  promoteIdea,
  updateIdea,
} from '../../services/idea-service.js';
import {
  countEvents,
  createEvent,
  deleteEvent,
  findEvents,
  getEvent,
  updateEvent,
} from '../../services/event-service.js';
import {
  createProject,
  deleteProject,
  getProject,
  countProjects,
  listProjects,
  updateProject,
} from '../../services/project-service.js';
import { listTags, pruneOrphanTags } from '../../services/tag-service.js';

const pageSchema = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
};

const taskListQuery = z.object({
  status: z.union([z.string(), z.array(z.string())]).optional(),
  priority: z.enum(PRIORITIES).optional(),
  projectId: z.string().max(64).optional(),
  tag: z.string().max(40).optional(),
  q: z.string().max(200).optional(),
  dueBefore: z.string().optional(),
  dueAfter: z.string().optional(),
  overdue: z.enum(['true', 'false']).optional(),
  open: z.enum(['true', 'false']).optional(),
  sort: z.enum(['dueAt', 'createdAt', 'updatedAt', 'priority', 'title']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
  ...pageSchema,
});

const noteListQuery = z.object({
  q: z.string().max(200).optional(),
  projectId: z.string().max(64).optional(),
  tag: z.string().max(40).optional(),
  withUrlOnly: z.enum(['true', 'false']).optional(),
  sort: z.enum(['createdAt', 'updatedAt', 'title']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
  ...pageSchema,
});

const ideaListQuery = z.object({
  q: z.string().max(200).optional(),
  projectId: z.string().max(64).optional(),
  tag: z.string().max(40).optional(),
  sort: z.enum(['createdAt', 'updatedAt', 'title']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
  ...pageSchema,
});

const eventListQuery = z.object({
  q: z.string().max(200).optional(),
  projectId: z.string().max(64).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  order: z.enum(['asc', 'desc']).default('asc'),
  ...pageSchema,
});

const projectListQuery = z.object({
  includeArchived: z.enum(['true', 'false']).optional(),
  ...pageSchema,
});

export async function registerLibraryRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  /* ---------------------------------------------------------------------- */
  /* Tasks                                                                   */
  /* ---------------------------------------------------------------------- */

  function taskFilterFrom(query: z.infer<typeof taskListQuery>): TaskFilter {
    const dueBefore = dateParam(query.dueBefore, 'dueBefore');
    const dueAfter = dateParam(query.dueAfter, 'dueAfter');
    return {
      ...(query.status === undefined
        ? {}
        : { status: enumListParam(query.status, TASK_STATUSES, 'task status') }),
      ...(query.priority === undefined ? {} : { priority: query.priority }),
      ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
      ...(query.tag === undefined ? {} : { tag: query.tag }),
      ...(query.q === undefined ? {} : { q: query.q }),
      ...(dueBefore === undefined ? {} : { dueBefore }),
      ...(dueAfter === undefined ? {} : { dueAfter }),
      ...(query.overdue === undefined ? {} : { overdueOnly: query.overdue === 'true' }),
      ...(query.open === undefined ? {} : { openOnly: query.open === 'true' }),
      limit: query.limit,
      offset: query.offset,
      sort: query.sort,
      order: query.order,
    };
  }

  /** Open tasks due inside the owner's current local day. */
  app.get('/tasks/today', async (): Promise<TaskDto[]> => {
    const settings = await ctx.db.userSettings.findUnique({ where: { id: 'singleton' } });
    const timeZone = settings?.timeZone ?? ctx.defaults.timeZone;
    const now = ctx.clock.now();
    const range = localDayRange(now, timeZone);
    return findTasks(
      ctx.db,
      {
        status: ['PENDING', 'IN_PROGRESS'],
        dueAfter: range.startUtc,
        dueBefore: range.endUtc,
        sort: 'dueAt',
        order: 'asc',
        limit: 100,
      },
      now,
    );
  });

  /** Open tasks whose deadline has passed. */
  app.get('/tasks/overdue', async (): Promise<TaskDto[]> => {
    const now = ctx.clock.now();
    return findTasks(ctx.db, { overdueOnly: true, sort: 'dueAt', order: 'asc', limit: 100 }, now);
  });

  app.get('/tasks/counts', async (): Promise<TaskCounts> => {
    const settings = await ctx.db.userSettings.findUnique({ where: { id: 'singleton' } });
    const timeZone = settings?.timeZone ?? ctx.defaults.timeZone;
    const now = ctx.clock.now();
    return taskCounts(ctx.db, now, localDayRange(now, timeZone));
  });

  app.get('/tasks', async (request): Promise<Paginated<TaskDto>> => {
    const query = parseQuery(taskListQuery, request.query);
    const filter = taskFilterFrom(query);
    const now = ctx.clock.now();
    const [items, total] = await Promise.all([
      findTasks(ctx.db, filter, now),
      countTasks(ctx.db, filter, now),
    ]);
    return { items, total, limit: query.limit, offset: query.offset };
  });

  app.post('/tasks', async (request, reply): Promise<TaskDto> => {
    const input = parseBody(taskCreateSchema, request.body, 'Invalid task');
    const task = await createTask(ctx, input);
    reply.status(201);
    return task;
  });

  app.get('/tasks/:id', async (request): Promise<TaskDto> =>
    getTask(ctx.db, parseIdParam(request.params)),
  );

  app.patch('/tasks/:id', async (request): Promise<TaskDto> => {
    const id = parseIdParam(request.params);
    const patch = parseBody(taskUpdateSchema, request.body, 'Invalid task update');
    return updateTask(ctx, id, patch);
  });

  app.delete('/tasks/:id', async (request): Promise<{ deleted: true }> => {
    const id = parseIdParam(request.params);
    await deleteTask(ctx.db, id);
    return { deleted: true };
  });

  /* ---------------------------------------------------------------------- */
  /* Notes                                                                   */
  /* ---------------------------------------------------------------------- */

  app.get('/notes', async (request): Promise<Paginated<NoteDto>> => {
    const query = parseQuery(noteListQuery, request.query);
    const filter = {
      ...(query.q === undefined ? {} : { q: query.q }),
      ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
      ...(query.tag === undefined ? {} : { tag: query.tag }),
      ...(query.withUrlOnly === undefined ? {} : { withUrlOnly: query.withUrlOnly === 'true' }),
      sort: query.sort,
      order: query.order,
      limit: query.limit,
      offset: query.offset,
    };
    const [items, total] = await Promise.all([
      findNotes(ctx.db, filter),
      countNotes(ctx.db, filter),
    ]);
    return { items, total, limit: query.limit, offset: query.offset };
  });

  app.post('/notes', async (request, reply): Promise<NoteDto> => {
    const input = parseBody(noteCreateSchema, request.body, 'Invalid note');
    const note = await createNote(ctx, input);
    reply.status(201);
    return note;
  });

  app.get('/notes/:id', async (request): Promise<NoteDto> =>
    getNote(ctx.db, parseIdParam(request.params)),
  );

  app.patch('/notes/:id', async (request): Promise<NoteDto> => {
    const id = parseIdParam(request.params);
    const patch = parseBody(noteUpdateSchema, request.body, 'Invalid note update');
    return updateNote(ctx, id, patch);
  });

  app.delete('/notes/:id', async (request): Promise<{ deleted: true }> => {
    await deleteNote(ctx.db, parseIdParam(request.params));
    return { deleted: true };
  });

  /* ---------------------------------------------------------------------- */
  /* Ideas                                                                   */
  /* ---------------------------------------------------------------------- */

  app.get('/ideas', async (request): Promise<Paginated<IdeaDto>> => {
    const query = parseQuery(ideaListQuery, request.query);
    const filter = {
      ...(query.q === undefined ? {} : { q: query.q }),
      ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
      ...(query.tag === undefined ? {} : { tag: query.tag }),
      sort: query.sort,
      order: query.order,
      limit: query.limit,
      offset: query.offset,
    };
    const [items, total] = await Promise.all([
      findIdeas(ctx.db, filter),
      countIdeas(ctx.db, filter),
    ]);
    return { items, total, limit: query.limit, offset: query.offset };
  });

  app.post('/ideas', async (request, reply): Promise<IdeaDto> => {
    const input = parseBody(ideaCreateSchema, request.body, 'Invalid idea');
    const idea = await createIdea(ctx, input);
    reply.status(201);
    return idea;
  });

  app.get('/ideas/:id', async (request): Promise<IdeaDto> =>
    getIdea(ctx.db, parseIdParam(request.params)),
  );

  app.patch('/ideas/:id', async (request): Promise<IdeaDto> => {
    const id = parseIdParam(request.params);
    const patch = parseBody(ideaUpdateSchema, request.body, 'Invalid idea update');
    return updateIdea(ctx, id, patch);
  });

  /**
   * Promoting an idea into a task is an explicit, user-initiated action. The
   * idea is kept: one idea can lead to more than one task.
   */
  app.post('/ideas/:id/promote', async (request, reply) => {
    const id = parseIdParam(request.params);
    const overrides = parseBody(taskCreateSchema.partial(), request.body, 'Invalid promotion');
    const result = await promoteIdea(ctx, id, overrides);
    reply.status(201);
    return result;
  });

  app.delete('/ideas/:id', async (request): Promise<{ deleted: true }> => {
    await deleteIdea(ctx.db, parseIdParam(request.params));
    return { deleted: true };
  });

  /* ---------------------------------------------------------------------- */
  /* Events                                                                  */
  /* ---------------------------------------------------------------------- */

  app.get('/events', async (request): Promise<Paginated<EventDto>> => {
    const query = parseQuery(eventListQuery, request.query);
    const from = dateParam(query.from, 'from');
    const to = dateParam(query.to, 'to');
    const filter = {
      ...(query.q === undefined ? {} : { q: query.q }),
      ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
      order: query.order,
      limit: query.limit,
      offset: query.offset,
    };
    const [items, total] = await Promise.all([
      findEvents(ctx.db, filter),
      countEvents(ctx.db, filter),
    ]);
    return { items, total, limit: query.limit, offset: query.offset };
  });

  app.post('/events', async (request, reply): Promise<EventDto> => {
    const input = parseBody(eventCreateSchema, request.body, 'Invalid event');
    const event = await createEvent(ctx, input);
    reply.status(201);
    return event;
  });

  app.get('/events/:id', async (request): Promise<EventDto> =>
    getEvent(ctx.db, parseIdParam(request.params)),
  );

  app.patch('/events/:id', async (request): Promise<EventDto> => {
    const id = parseIdParam(request.params);
    const patch = parseBody(eventUpdateSchema, request.body, 'Invalid event update');
    return updateEvent(ctx, id, patch);
  });

  app.delete('/events/:id', async (request): Promise<{ deleted: true }> => {
    await deleteEvent(ctx.db, parseIdParam(request.params));
    return { deleted: true };
  });

  /* ---------------------------------------------------------------------- */
  /* Projects                                                                */
  /* ---------------------------------------------------------------------- */

  /** Paginated like every other list (S2, decision D4). */
  app.get('/projects', async (request): Promise<Paginated<ProjectDto>> => {
    const query = parseQuery(projectListQuery, request.query);
    const includeArchived = query.includeArchived === 'true';
    const [items, total] = await Promise.all([
      listProjects(ctx.db, { includeArchived, limit: query.limit, offset: query.offset }),
      countProjects(ctx.db, { includeArchived }),
    ]);
    return { items, total, limit: query.limit, offset: query.offset };
  });

  app.post('/projects', async (request, reply): Promise<ProjectDto> => {
    const input = parseBody(projectCreateSchema, request.body, 'Invalid project');
    const project = await createProject(ctx.db, input);
    reply.status(201);
    return project;
  });

  app.get('/projects/:id', async (request): Promise<ProjectDto> =>
    getProject(ctx.db, parseIdParam(request.params)),
  );

  app.patch('/projects/:id', async (request): Promise<ProjectDto> => {
    const id = parseIdParam(request.params);
    const patch = parseBody(projectUpdateSchema, request.body, 'Invalid project update');
    return updateProject(ctx.db, id, patch);
  });

  /** Members are detached, never deleted. */
  app.delete('/projects/:id', async (request): Promise<{ deleted: true; detached: number }> => {
    const id = parseIdParam(request.params);
    const result = await deleteProject(ctx.db, id);
    return { deleted: true, detached: result.detached };
  });

  /* ---------------------------------------------------------------------- */
  /* Tags                                                                    */
  /* ---------------------------------------------------------------------- */

  app.get('/tags', async () => {
    const tags = await listTags(ctx.db, 500);
    return tags.map((tag) => ({
      id: tag.id,
      name: tag.name,
      count: tag.captures + tag.tasks + tag.notes + tag.ideas,
      breakdown: {
        captures: tag.captures,
        tasks: tag.tasks,
        notes: tag.notes,
        ideas: tag.ideas,
      },
    }));
  });

  /**
   * Removes tags that no longer label anything. Safe to call at any time: it
   * only deletes rows whose join tables are already empty.
   */
  app.post('/tags/prune', async (): Promise<{ removed: number }> => ({
    removed: await pruneOrphanTags(ctx.db),
  }));
}
