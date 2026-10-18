/**
 * Library API integration: tasks, notes, ideas, events, projects and tags.
 *
 * The point of these tests is the *rules*, not the plumbing: a task can only
 * move through the states the roadmap allows, an idea stays an idea until the
 * owner promotes it, and deleting a project detaches its members instead of
 * destroying them.
 */
import type {
  EventDto,
  IdeaDto,
  NoteDto,
  Paginated,
  ProjectDto,
  TaskDto,
} from '@recall/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestApp, type TestApp } from '../helpers/app.js';
import { createTestDatabase, type TestDb } from '../helpers/db.js';

let testDb: TestDb;
let app: TestApp;
let cookie: string;

beforeAll(async () => {
  testDb = await createTestDatabase('library-api');
  app = await createTestApp(testDb.db);
  cookie = await app.login();
});

afterAll(async () => {
  await app.close();
  await testDb.cleanup();
});

beforeEach(async () => {
  await testDb.reset();
});

function authed(url: string, init: Record<string, unknown> = {}) {
  return app.app.inject({
    url,
    headers: { cookie, ...(init.headers as Record<string, string> | undefined) },
    ...init,
  });
}

async function post<T>(url: string, payload: unknown): Promise<T> {
  const response = await authed(url, { method: 'POST', payload });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as T;
}

async function patch<T>(url: string, payload: unknown): Promise<T> {
  const response = await authed(url, { method: 'PATCH', payload });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as T;
}

async function get<T>(url: string): Promise<T> {
  const response = await authed(url);
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as T;
}

const createTask = (payload: Record<string, unknown> = {}) =>
  post<TaskDto>('/api/tasks', { title: 'Call Ada', ...payload });

describe('authorization', () => {
  it('refuses every library route without a session', async () => {
    for (const [method, url] of [
      ['GET', '/api/tasks'],
      ['POST', '/api/tasks'],
      ['GET', '/api/tasks/today'],
      ['GET', '/api/tasks/overdue'],
      ['GET', '/api/tasks/counts'],
      ['GET', '/api/notes'],
      ['POST', '/api/notes'],
      ['GET', '/api/ideas'],
      ['GET', '/api/events'],
      ['GET', '/api/projects'],
      ['GET', '/api/tags'],
      ['GET', '/api/search'],
      ['GET', '/api/export'],
      ['POST', '/api/restore'],
    ] as const) {
      const response = await app.app.inject({ method, url, payload: {} });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});

describe('tasks', () => {
  it('creates a task with the documented defaults', async () => {
    const task = await createTask();
    expect(task.status).toBe('PENDING');
    expect(task.priority).toBeNull();
    expect(task.dueAt).toBeNull();
    expect(task.completedAt).toBeNull();
    expect(task.isOverdue).toBe(false);
  });

  it('rejects a task with no title', async () => {
    const response = await authed('/api/tasks', { method: 'POST', payload: { title: '  ' } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('walks the allowed state transitions and records the timestamps', async () => {
    const task = await createTask();
    const started = await patch<TaskDto>(`/api/tasks/${task.id}`, { status: 'IN_PROGRESS' });
    expect(started.status).toBe('IN_PROGRESS');

    const done = await patch<TaskDto>(`/api/tasks/${task.id}`, { status: 'COMPLETED' });
    expect(done.status).toBe('COMPLETED');
    expect(done.completedAt).not.toBeNull();
  });

  it('refuses a transition the table does not allow', async () => {
    const task = await createTask();
    await patch<TaskDto>(`/api/tasks/${task.id}`, { status: 'COMPLETED' });

    // COMPLETED → IN_PROGRESS is not a valid transition.
    const response = await authed(`/api/tasks/${task.id}`, {
      method: 'PATCH',
      payload: { status: 'IN_PROGRESS' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(
      /Cannot change a task from COMPLETED to IN_PROGRESS/,
    );
  });

  it('allows reopening a completed task and clears completedAt', async () => {
    const task = await createTask();
    const completed = await patch<TaskDto>(`/api/tasks/${task.id}`, { status: 'COMPLETED' });
    expect(completed.completedAt).not.toBeNull();

    const reopened = await patch<TaskDto>(`/api/tasks/${task.id}`, { status: 'PENDING' });
    expect(reopened.status).toBe('PENDING');
    expect(reopened.completedAt).toBeNull();
  });

  it('allows cancelling a pending task but not a completed one', async () => {
    const task = await createTask();
    const cancelled = await patch<TaskDto>(`/api/tasks/${task.id}`, { status: 'CANCELLED' });
    expect(cancelled.cancelledAt).not.toBeNull();

    const other = await createTask({ title: 'Second' });
    await patch<TaskDto>(`/api/tasks/${other.id}`, { status: 'COMPLETED' });
    const response = await authed(`/api/tasks/${other.id}`, {
      method: 'PATCH',
      payload: { status: 'CANCELLED' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses an unknown status rather than storing it', async () => {
    const task = await createTask();
    const response = await authed(`/api/tasks/${task.id}`, {
      method: 'PATCH',
      payload: { status: 'DONE' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('never completes a task as a side effect of editing it', async () => {
    const task = await createTask();
    const edited = await patch<TaskDto>(`/api/tasks/${task.id}`, { title: 'Call Ada tomorrow' });
    expect(edited.status).toBe('PENDING');
    expect(edited.completedAt).toBeNull();
  });

  it('filters, sorts and paginates', async () => {
    await createTask({ title: 'A', dueAt: '2026-10-18T09:00:00.000Z', status: 'PENDING' });
    await createTask({ title: 'B', dueAt: '2026-10-19T09:00:00.000Z', status: 'PENDING' });
    await createTask({ title: 'C', dueAt: '2026-10-20T09:00:00.000Z', status: 'COMPLETED' });
    await createTask({ title: 'D', priority: 'URGENT' });

    const open = await get<Paginated<TaskDto>>('/api/tasks?open=true&sort=dueAt&order=asc');
    expect(open.total).toBe(3);
    expect(open.items.map((t) => t.title)).toEqual(['A', 'B', 'D']);

    const completed = await get<Paginated<TaskDto>>('/api/tasks?status=COMPLETED');
    expect(completed.total).toBe(1);

    const urgent = await get<Paginated<TaskDto>>('/api/tasks?priority=URGENT');
    expect(urgent.items.map((t) => t.title)).toEqual(['D']);

    const firstPage = await get<Paginated<TaskDto>>('/api/tasks?limit=2&offset=0&open=true');
    const secondPage = await get<Paginated<TaskDto>>('/api/tasks?limit=2&offset=2&open=true');
    expect(firstPage.items).toHaveLength(2);
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.total).toBe(3);
  });

  it('rejects an unknown status filter with a readable error', async () => {
    const response = await authed('/api/tasks?status=NOT_A_STATUS');
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/Unknown task status/);
  });

  it('reports counters and the today/overdue views against the owner clock', async () => {
    // The injected test clock reads 2026-10-17T10:00:00Z = 11:00 on Saturday
    // 17 October in Africa/Lagos, so "today" is that local day.
    await createTask({ title: 'today', dueAt: '2026-10-17T20:00:00.000Z' });
    await createTask({ title: 'yesterday', dueAt: '2026-10-16T09:00:00.000Z' });
    await createTask({ title: 'next week', dueAt: '2026-10-24T09:00:00.000Z' });

    const today = await get<TaskDto[]>('/api/tasks/today');
    expect(today.map((t) => t.title)).toEqual(['today']);

    const overdue = await get<TaskDto[]>('/api/tasks/overdue');
    expect(overdue.map((t) => t.title)).toEqual(['yesterday']);

    const counts = await get<{ open: number; overdue: number; dueToday: number }>(
      '/api/tasks/counts',
    );
    expect(counts.open).toBe(3);
    expect(counts.overdue).toBe(1);
    expect(counts.dueToday).toBe(1);
  });

  it('deletes a task and reports it as gone', async () => {
    const task = await createTask();
    const deleted = await authed(`/api/tasks/${task.id}`, { method: 'DELETE' });
    expect(deleted.statusCode).toBe(200);

    const missing = await authed(`/api/tasks/${task.id}`);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('NOT_FOUND');
  });

  it('rejects a task in a project that does not exist', async () => {
    const response = await authed('/api/tasks', {
      method: 'POST',
      payload: { title: 'Orphan', projectId: 'no-such-project' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/does not exist/);
  });
});

describe('notes, ideas and events stay distinct', () => {
  it('stores each kind in its own collection with its own fields', async () => {
    const note = await post<NoteDto>('/api/notes', {
      body: 'The landlord said the boiler is serviced in June.',
      url: 'https://example.com/boiler',
    });
    const idea = await post<IdeaDto>('/api/ideas', { title: 'A site for students' });
    const event = await post<EventDto>('/api/events', {
      title: 'Dentist',
      startsAt: '2026-11-02T09:30:00.000Z',
    });

    expect(note.url).toBe('https://example.com/boiler');
    expect(idea.body).toBeNull();
    expect(event.endsAt).toBeNull();

    // An idea is not a task: nothing appears in the task collection.
    const tasks = await get<Paginated<TaskDto>>('/api/tasks');
    expect(tasks.total).toBe(0);
  });

  it('only turns an idea into a task when asked, and keeps the idea', async () => {
    const idea = await post<IdeaDto>('/api/ideas', {
      title: 'Write a book about memory',
      body: 'Maybe one chapter a month.',
      tags: ['writing'],
    });

    const promoted = await post<{ idea: IdeaDto; taskId: string }>(
      `/api/ideas/${idea.id}/promote`,
      {},
    );
    const task = await get<TaskDto>(`/api/tasks/${promoted.taskId}`);

    expect(task.title).toBe('Write a book about memory');
    expect(task.status).toBe('PENDING');
    expect(task.tags.map((t) => t.name)).toEqual(['writing']);

    const stillThere = await get<IdeaDto>(`/api/ideas/${idea.id}`);
    expect(stillThere.id).toBe(idea.id);
  });

  it('validates a note url instead of storing junk', async () => {
    const response = await authed('/api/notes', {
      method: 'POST',
      payload: { body: 'see this', url: 'not-a-url' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('requires an event to have a start time', async () => {
    const response = await authed('/api/events', { method: 'POST', payload: { title: 'No date' } });
    expect(response.statusCode).toBe(400);
  });

  it('finds a note with a url only when asked', async () => {
    await post<NoteDto>('/api/notes', { body: 'plain note' });
    await post<NoteDto>('/api/notes', { body: 'linked note', url: 'https://example.com/x' });

    const linked = await get<Paginated<NoteDto>>('/api/notes?withUrlOnly=true');
    expect(linked.total).toBe(1);
    expect(linked.items[0]?.url).toBe('https://example.com/x');
  });
});

describe('projects', () => {
  it('groups members, counts open tasks, and detaches them on delete', async () => {
    const project = await post<ProjectDto>('/api/projects', { name: 'Kitchen' });
    await createTask({ title: 'Measure the wall', projectId: project.id });
    await post<NoteDto>('/api/notes', { body: 'Tiles cost 40 per sqm', projectId: project.id });
    await post<IdeaDto>('/api/ideas', { title: 'Warm floor heating', projectId: project.id });

    const withMembers = await get<ProjectDto>(`/api/projects/${project.id}`);
    expect(withMembers.counts).toEqual({ tasks: 1, openTasks: 1, notes: 1, ideas: 1, events: 0 });

    const deleted = await authed(`/api/projects/${project.id}`, { method: 'DELETE' });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().detached).toBe(3);

    // The contents survive; only the grouping is gone.
    const tasks = await get<Paginated<TaskDto>>('/api/tasks');
    expect(tasks.total).toBe(1);
    expect(tasks.items[0]?.projectId).toBeNull();
  });

  it('refuses a duplicate project name', async () => {
    await post<ProjectDto>('/api/projects', { name: 'Kitchen' });
    const response = await authed('/api/projects', { method: 'POST', payload: { name: 'Kitchen' } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CONFLICT');
  });
});

describe('tags', () => {
  it('lists tags with a per-kind breakdown and prunes orphans', async () => {
    const task = await createTask({ tags: ['home', 'urgent'] });
    const tags = await get<{ name: string; count: number }[]>('/api/tags');
    expect(tags.map((t) => t.name).sort()).toEqual(['home', 'urgent']);

    // Removing the last user of a tag leaves the tag row behind until pruned.
    await authed(`/api/tasks/${task.id}`, { method: 'DELETE' });
    const pruned = await authed('/api/tags/prune', { method: 'POST' });
    expect(pruned.statusCode).toBe(200);
    expect(pruned.json().removed).toBe(2);

    const after = await get<{ name: string }[]>('/api/tags');
    expect(after).toEqual([]);
  });
});
