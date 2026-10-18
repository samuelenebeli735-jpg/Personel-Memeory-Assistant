/**
 * Unit tests for the pure parts of search and the new library formatters.
 *
 * These are the pieces a database test cannot pin down: how a snippet is
 * centred, which types a query resolves to, and exactly what a list looks like
 * in Telegram.
 */
import { describe, expect, it } from 'vitest';
import {
  searchQuerySchema,
  type IdeaDto,
  type NoteDto,
  type ProjectDto,
  type SearchResponse,
  type TaskDto,
} from '@recall/shared';

import { buildSnippet, resolveSearchTypes, wordsOf } from '../../src/services/search-service.js';
import {
  formatIdeaList,
  formatNoteList,
  formatProjectList,
  formatSearchResults,
  formatTaskList,
} from '../../src/telegram/format.js';

const TIME_ZONE = 'Africa/Lagos';

describe('wordsOf', () => {
  it('splits on whitespace and ignores case and empties', () => {
    expect(wordsOf('  Invoice   ADA ')).toEqual(['invoice', 'ada']);
    expect(wordsOf('   ')).toEqual([]);
  });
});

describe('buildSnippet', () => {
  it('returns the start of the text, truncated, when there is no query', () => {
    const snippet = buildSnippet('x'.repeat(300));
    expect(snippet).toHaveLength(160);
    expect(snippet.endsWith('…')).toBe(true);
  });

  it('centres the snippet on the match and marks both cut ends', () => {
    const text = `${'a'.repeat(200)} NEEDLE ${'b'.repeat(200)}`;
    const snippet = buildSnippet(text, 'needle');
    expect(snippet).toContain('NEEDLE');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(162);
  });

  it('does not pad with an ellipsis when the match is at the start', () => {
    const snippet = buildSnippet('needle at the start and then more text', 'needle');
    expect(snippet.startsWith('…')).toBe(false);
  });

  it('centres on the whole phrase when the words are adjacent', () => {
    const text = `${'a'.repeat(100)} boiler pressure ${'b'.repeat(100)}`;
    const snippet = buildSnippet(text, 'boiler pressure');
    expect(snippet).toContain('boiler pressure');
  });

  it('falls back to the first word when the phrase is split across fields', () => {
    const text = `start ${'a'.repeat(100)} boiler something ${'b'.repeat(100)} pressure end`;
    const snippet = buildSnippet(text, 'boiler pressure');
    expect(snippet).toContain('boiler');
  });

  it('collapses whitespace so a multi-line capture renders on one line', () => {
    expect(buildSnippet('first   line\n\nsecond', 'line')).toBe('first line second');
  });

  it('degrades gracefully when nothing matches', () => {
    expect(buildSnippet('some text at all', 'absent')).toBe('some text at all');
  });
});

describe('resolveSearchTypes', () => {
  const query = (input: Record<string, unknown>) => searchQuerySchema.parse(input);

  it('searches everything by default', () => {
    expect(resolveSearchTypes(query({}))).toEqual([
      'TASK',
      'NOTE',
      'IDEA',
      'EVENT',
      'CAPTURE',
      'PROJECT',
      'REMINDER',
    ]);
  });

  it('narrows to tasks when a task-only filter is given', () => {
    expect(resolveSearchTypes(query({ status: 'COMPLETED' }))).toEqual(['TASK']);
    expect(resolveSearchTypes(query({ priority: 'HIGH' }))).toEqual(['TASK']);
  });

  it('narrows to captures when a capture kind is given', () => {
    expect(resolveSearchTypes(query({ kind: 'NOTE' }))).toEqual(['CAPTURE']);
  });

  it('honours an explicit type list, and a task filter inside it', () => {
    expect(resolveSearchTypes(query({ types: ['NOTE', 'IDEA'] }))).toEqual(['NOTE', 'IDEA']);
    expect(resolveSearchTypes(query({ types: ['NOTE', 'TASK'], status: 'PENDING' }))).toEqual([
      'TASK',
    ]);
  });

  it('treats an empty type list as everything', () => {
    expect(resolveSearchTypes(query({ types: [] }))).toHaveLength(7);
  });
});

/* -------------------------------------------------------------------------- */
/* Formatters                                                                  */
/* -------------------------------------------------------------------------- */

function task(overrides: Partial<TaskDto> = {}): TaskDto {
  return {
    id: 'task-123456',
    title: 'Call Ada',
    description: null,
    status: 'PENDING',
    priority: null,
    category: null,
    dueAt: null,
    completedAt: null,
    cancelledAt: null,
    projectId: null,
    projectName: null,
    captureId: null,
    isOverdue: false,
    createdAt: '2026-10-17T10:00:00.000Z',
    updatedAt: '2026-10-17T10:00:00.000Z',
    tags: [],
    ...overrides,
  };
}

function idea(overrides: Partial<IdeaDto> = {}): IdeaDto {
  return {
    id: 'idea-123456',
    title: 'A site for students',
    body: null,
    projectId: null,
    projectName: null,
    captureId: null,
    createdAt: '2026-10-17T10:00:00.000Z',
    updatedAt: '2026-10-17T10:00:00.000Z',
    tags: [],
    ...overrides,
  };
}

function note(overrides: Partial<NoteDto> = {}): NoteDto {
  return {
    id: 'note-123456',
    title: null,
    body: 'Boiler service notes',
    url: null,
    projectId: null,
    projectName: null,
    captureId: null,
    createdAt: '2026-10-17T10:00:00.000Z',
    updatedAt: '2026-10-17T10:00:00.000Z',
    tags: [],
    ...overrides,
  };
}

function project(overrides: Partial<ProjectDto> = {}): ProjectDto {
  return {
    id: 'project-123456',
    name: 'Kitchen',
    description: null,
    status: 'ACTIVE',
    createdAt: '2026-10-17T10:00:00.000Z',
    updatedAt: '2026-10-17T10:00:00.000Z',
    counts: { tasks: 1, openTasks: 1, notes: 0, ideas: 0, events: 0 },
    ...overrides,
  };
}

describe('library list formatters', () => {
  it('says "nothing here" for an empty task list instead of showing a header alone', () => {
    expect(formatTaskList([], TIME_ZONE, 'Open tasks')).toMatch(/Open tasks[\s\S]*Nothing here/);
  });

  it('marks an overdue task so the list cannot mislead', () => {
    const text = formatTaskList([task({ isOverdue: true, dueAt: '2026-10-15T09:00:00.000Z' })], TIME_ZONE, 'Open tasks');
    expect(text).toContain('OVERDUE');
    expect(text).toContain('#task-1');
  });

  it('shows an idea with its body and project', () => {
    const text = formatIdeaList(
      [idea({ body: 'Maybe one chapter a month', projectName: 'Book' })],
      TIME_ZONE,
      'Your ideas',
    );
    expect(text).toContain('A site for students');
    expect(text).toContain('Maybe one chapter a month');
    expect(text).toContain('[Book]');
  });

  it('falls back to the body when a note has no title', () => {
    const text = formatNoteList([note()], TIME_ZONE, 'Your notes');
    expect(text).toContain('Boiler service notes');
  });

  it('shows a saved link for a note', () => {
    const text = formatNoteList(
      [note({ title: 'Boiler', url: 'https://example.com/boiler' })],
      TIME_ZONE,
      'Your notes',
    );
    expect(text).toContain('https://example.com/boiler');
  });

  it('summarises a project by what it contains', () => {
    const text = formatProjectList(
      [project({ counts: { tasks: 3, openTasks: 2, notes: 1, ideas: 0, events: 1 } })],
      'Your projects',
    );
    expect(text).toContain('Kitchen');
    expect(text).toContain('2 open');
    expect(text).toContain('1 notes');
    expect(text).toContain('1 appointments');
  });

  it('marks an archived project', () => {
    const text = formatProjectList([project({ status: 'ARCHIVED' })], 'Your projects');
    expect(text).toContain('(archived)');
  });
});

describe('formatSearchResults', () => {
  const response = (overrides: Partial<SearchResponse> = {}): SearchResponse => ({
    items: [],
    total: 0,
    limit: 10,
    offset: 0,
    query: {},
    ...overrides,
  });

  it('says nothing matched rather than returning an empty message', () => {
    expect(formatSearchResults(response(), 'Search — "x"')).toMatch(/Nothing matched/);
  });

  it('numbers results, names the type and reports the matched field', () => {
    const text = formatSearchResults(
      response({
        items: [
          {
            type: 'TASK',
            id: 'task-123456',
            title: 'Call Ada',
            snippet: '…the invoice call…',
            status: 'PENDING',
            timestamp: '2026-10-17T10:00:00.000Z',
            matchedOn: ['title', 'description'],
          },
        ],
        total: 1,
      }),
      'Search — "ada"',
    );
    expect(text).toContain('1. task · Call Ada (pending)');
    expect(text).toContain('matched: title, description');
    expect(text).toContain('#task-1');
  });

  it('does not repeat the title as a snippet', () => {
    const text = formatSearchResults(
      response({
        items: [
          {
            type: 'IDEA',
            id: 'idea-123456',
            title: 'A site for students',
            snippet: 'A site for students',
            timestamp: '2026-10-17T10:00:00.000Z',
            matchedOn: ['title'],
          },
        ],
        total: 1,
      }),
      'Search',
    );
    expect(text.match(/A site for students/g)).toHaveLength(1);
  });

  it('says how many more results there are', () => {
    const text = formatSearchResults(
      response({
        items: [
          {
            type: 'NOTE',
            id: 'note-1',
            title: 'n',
            snippet: 'body',
            timestamp: '2026-10-17T10:00:00.000Z',
            matchedOn: ['body'],
          },
        ],
        total: 4,
      }),
      'Search',
    );
    expect(text).toContain('…3 more');
  });
});
