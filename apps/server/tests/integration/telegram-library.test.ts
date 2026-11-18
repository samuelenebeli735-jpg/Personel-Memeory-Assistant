/**
 * Telegram library commands: /tasks, /today, /overdue, /search, /ideas,
 * /notes, /projects.
 *
 * These run the real command handlers against a real database and a fake Bot
 * API, so the assertions cover the text a user actually receives.
 */
import { ideaCreateSchema, noteCreateSchema, projectCreateSchema, taskCreateSchema } from '@recall/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { testConfig, testLogger } from '../helpers/app.js';
import { createTestDatabase, type TestDb } from '../helpers/db.js';
import {
  createFakeTelegram,
  createTestTelegramAdapter,
  textUpdate,
  type FakeTelegram,
  type TestTelegramAdapter,
} from '../helpers/telegram.js';
import type { AppContext } from '../../src/context.js';
import { createAppContext } from '../../src/context.js';
import { advanceableClock } from '../../src/ports.js';
import { ingestCapture } from '../../src/services/capture-service.js';
import { createIdea } from '../../src/services/idea-service.js';
import { createNote } from '../../src/services/note-service.js';
import { createProject } from '../../src/services/project-service.js';
import { createTask, updateTask } from '../../src/services/task-service.js';

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDatabase('telegram-library');
});

afterAll(async () => {
  await testDb.cleanup();
});

beforeEach(async () => {
  await testDb.reset();
});

function setup(): {
  ctx: AppContext;
  adapter: TestTelegramAdapter['adapter'];
  fake: FakeTelegram;
} {
  const ctx = createAppContext({
    config: testConfig(),
    db: testDb.db,
    clock: advanceableClock('2026-10-17T10:00:00.000Z'),
    logger: testLogger(),
    ai: null,
    stt: null,
  });
  const fake = createFakeTelegram();
  const { adapter } = createTestTelegramAdapter(ctx, { fake });
  return { ctx, adapter, fake };
}

/** Sends a command from the owner and returns the single reply text. */
async function command(
  adapter: TestTelegramAdapter['adapter'],
  fake: FakeTelegram,
  text: string,
): Promise<string> {
  fake.reset();
  await adapter.handleUpdate(textUpdate(text, { messageId: 20 }));
  expect(fake.sent, `no reply to ${text}`).toHaveLength(1);
  return fake.sent[0]!;
}

const task = (ctx: AppContext, input: Record<string, unknown>) =>
  createTask(ctx, taskCreateSchema.parse(input));

describe('command registration', () => {
  it('advertises the library commands as available', async () => {
    const { adapter, fake } = setup();
    const reply = await command(adapter, fake, '/help');
    for (const name of ['/tasks', '/today', '/overdue', '/search', '/ideas', '/notes', '/projects']) {
      expect(reply, name).toContain(name);
    }
    expect(reply).not.toMatch(/Task lists, search/);
  });

  it('answers /ask from the owner records', async () => {
    const { ctx, adapter, fake } = setup();
    await task(ctx, {
      title: 'Order kitchen tiles',
      description: 'I said the tiles should be blue',
    });

    const reply = await command(adapter, fake, '/ask tiles');

    expect(reply).toContain('Order kitchen tiles');
    expect(reply).toContain('Based on:');
  });

  it('ignores a command-shaped message from a non-owner', async () => {
    const { ctx, adapter, fake } = setup();
    fake.reset();
    const result = await adapter.handleUpdate(
      textUpdate('/tasks', { fromId: 999999999, chatId: 999999999 }),
    );
    expect(result).toMatchObject({ handled: false, reason: 'non-owner' });
    expect(fake.answers.concat(fake.sent)).toHaveLength(1);
    expect(await ctx.db.task.count()).toBe(0);
  });
});

describe('/tasks, /today and /overdue', () => {
  it('lists open tasks and hides finished ones until asked', async () => {
    const { ctx, adapter, fake } = setup();
    await task(ctx, { title: 'Call Ada', dueAt: '2026-10-20T09:00:00.000Z' });
    const done = await task(ctx, { title: 'Post the letter' });
    await updateTask(ctx, done.id, { status: 'COMPLETED' });

    const open = await command(adapter, fake, '/tasks');
    expect(open).toContain('Open tasks');
    expect(open).toContain('Call Ada');
    expect(open).not.toContain('Post the letter');

    const all = await command(adapter, fake, '/tasks all');
    expect(all).toContain('All tasks');
    expect(all).toContain('Post the letter');
    expect(all).toContain('✓');
  });

  it('shows today against the owner local day, not UTC', async () => {
    const { ctx, adapter, fake } = setup();
    // The clock reads 11:00 on Saturday 17 October in Africa/Lagos (UTC+1).
    await task(ctx, { title: 'Today in Lagos', dueAt: '2026-10-17T22:30:00.000Z' });
    await task(ctx, { title: 'Tomorrow', dueAt: '2026-10-18T09:00:00.000Z' });

    const reply = await command(adapter, fake, '/today');
    expect(reply).toContain('Due today (2026-10-17)');
    expect(reply).toContain('Today in Lagos');
    expect(reply).not.toContain('Tomorrow');
  });

  it('shows only past-due open tasks as overdue', async () => {
    const { ctx, adapter, fake } = setup();
    await task(ctx, { title: 'Late', dueAt: '2026-10-15T09:00:00.000Z' });
    await task(ctx, { title: 'Fine', dueAt: '2026-10-25T09:00:00.000Z' });
    const dontCare = await task(ctx, { title: 'Late but done', dueAt: '2026-10-15T09:00:00.000Z' });
    await updateTask(ctx, dontCare.id, { status: 'COMPLETED' });

    const reply = await command(adapter, fake, '/overdue');
    expect(reply).toContain('Late');
    expect(reply).toContain('OVERDUE');
    expect(reply).not.toContain('Fine');
    expect(reply).not.toContain('Late but done');
  });

  it('says so plainly when there is nothing to show', async () => {
    const { adapter, fake } = setup();
    const reply = await command(adapter, fake, '/tasks');
    expect(reply).toMatch(/Open tasks[\s\S]*Nothing here/);
  });
});

describe('/search', () => {
  it('finds rows across kinds and states which field matched', async () => {
    const { ctx, adapter, fake } = setup();
    await task(ctx, { title: 'Call the tiler', description: 'about the kitchen tiles' });
    await ingestCapture(ctx, {
      rawText: 'the tiler said the wall is uneven',
      source: 'TELEGRAM',
    });

    const reply = await command(adapter, fake, '/search tiler');
    expect(reply).toContain('Search — "tiler"');
    expect(reply).toContain('task · Call the tiler');
    expect(reply).toContain('capture ·');
    expect(reply).toContain('matched: title');
  });

  it('explains how to use it when no words are given', async () => {
    const { adapter, fake } = setup();
    const reply = await command(adapter, fake, '/search');
    expect(reply).toMatch(/What should I look for/);
  });

  it('reports an empty result honestly', async () => {
    const { ctx, adapter, fake } = setup();
    await task(ctx, { title: 'Call the tiler' });
    const reply = await command(adapter, fake, '/search thermodynamics');
    expect(reply).toMatch(/Nothing matched/);
  });

  it('also answers to /find', async () => {
    const { ctx, adapter, fake } = setup();
    await task(ctx, { title: 'Call the tiler' });
    expect(await command(adapter, fake, '/find tiler')).toContain('Call the tiler');
  });
});

describe('/ideas, /notes and /projects', () => {
  it('lists ideas separately from tasks', async () => {
    const { ctx, adapter, fake } = setup();
    await task(ctx, { title: 'A task, not an idea' });
    await createIdea(ctx, ideaCreateSchema.parse({ title: 'A website for students' }));

    const reply = await command(adapter, fake, '/ideas');
    expect(reply).toContain('Your ideas');
    expect(reply).toContain('A website for students');
    expect(reply).not.toContain('A task, not an idea');
  });

  it('lists notes with their saved link', async () => {
    const { ctx, adapter, fake } = setup();
    await createNote(
      ctx,
      noteCreateSchema.parse({ body: 'Boiler service notes', url: 'https://example.com/boiler' }),
    );

    const reply = await command(adapter, fake, '/notes');
    expect(reply).toContain('Your notes');
    expect(reply).toContain('https://example.com/boiler');
  });

  it('lists projects with their open task count', async () => {
    const { ctx, adapter, fake } = setup();
    const project = await createProject(ctx.db, projectCreateSchema.parse({ name: 'Kitchen' }));
    await task(ctx, { title: 'Measure the wall', projectId: project.id });

    const reply = await command(adapter, fake, '/projects');
    expect(reply).toContain('Your projects');
    expect(reply).toContain('Kitchen');
    expect(reply).toContain('1 open');
  });

  it('says when there is nothing yet instead of showing an empty list', async () => {
    const { adapter, fake } = setup();
    expect(await command(adapter, fake, '/ideas')).toMatch(/No ideas saved yet/);
    expect(await command(adapter, fake, '/notes')).toMatch(/No notes saved yet/);
    expect(await command(adapter, fake, '/projects')).toMatch(/No projects yet/);
  });
});
