/**
 * Ask API integration.
 *
 * The acceptance criterion is that an answer is only ever returned together
 * with the records that support it. These tests drive the real HTTP endpoint
 * against an isolated database; the AI provider is always a fake, so no live
 * provider call is made.
 */
import type { AskResponse } from '@recall/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestApp, type TestApp } from '../helpers/app.js';
import { createTestDatabase, type TestDb } from '../helpers/db.js';
import { fakeAiProvider, type FakeAiProvider } from '../helpers/providers.js';
import { updateSettings } from '../../src/services/settings-service.js';

const NO_EVIDENCE_ANSWER = 'I could not find anything about that.';

let testDb: TestDb;
let app: TestApp;
let cookie: string;

beforeAll(async () => {
  testDb = await createTestDatabase('ask-api');
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

async function ask(payload: unknown): Promise<AskResponse> {
  const response = await authed('/api/ask', { method: 'POST', payload });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as AskResponse;
}

async function createTask(input: Record<string, unknown>): Promise<{ id: string; title: string }> {
  const response = await authed('/api/tasks', { method: 'POST', payload: input });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as { id: string; title: string };
}

/** A task whose title and description are both meaningful. */
async function createPlumberTask(): Promise<{ id: string; title: string }> {
  return createTask({
    title: 'Call the plumber',
    description: 'the plumber is booked for tomorrow morning',
  });
}

describe('POST /api/ask — access', () => {
  it('requires an owner session', async () => {
    const response = await app.app.inject({
      method: 'POST',
      url: '/api/ask',
      payload: { question: 'plumber' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a tampered session cookie', async () => {
    const response = await app.app.inject({
      method: 'POST',
      url: '/api/ask',
      headers: { cookie: 'recall_session=not-a-real-session' },
      payload: { question: 'plumber' },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('POST /api/ask — grounding', () => {
  it('returns the evidence the answer was derived from', async () => {
    const task = await createPlumberTask();

    const result = await ask({ question: 'plumber' });

    expect(result.grounded).toBe(true);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]!.id).toBe(task.id);
    expect(result.evidence[0]!.type).toBe('TASK');
    expect(result.answer.length).toBeGreaterThan(0);
  });

  it('returns the record text as evidence so an answer can be checked', async () => {
    await createPlumberTask();

    const result = await ask({ question: 'plumber' });

    expect(result.evidence[0]!.snippet).toContain('the plumber is booked for tomorrow morning');
    expect(result.evidence[0]!.matchedOn.length).toBeGreaterThan(0);
  });

  it('finds records for a natural question about a two-letter term', async () => {
    const task = await createTask({
      title: 'AI notes',
      description: 'the AI project is due Friday',
    });

    const result = await ask({ question: 'what did I say about AI' });

    expect(result.evidence.map((item) => item.id)).toContain(task.id);
    expect(result.answer.length).toBeGreaterThan(0);
  });

  it('answers with an explicit no-evidence answer when nothing matches', async () => {
    const result = await ask({ question: 'zeppelin' });

    expect(result.grounded).toBe(false);
    expect(result.answer).toBe(NO_EVIDENCE_ANSWER);
    expect(result.evidence).toEqual([]);
    expect(result.deterministic).toBe(true);
  });

  it('falls back to a deterministic, cited summary without an AI provider', async () => {
    await createPlumberTask();

    const result = await ask({ question: 'plumber' });

    expect(result.grounded).toBe(true);
    expect(result.deterministic).toBe(true);
    expect(result.provider).toBe('deterministic');
    expect(result.answer).toContain('Call the plumber');
    expect(result.evidence).toHaveLength(1);
  });

  it('does not call the provider when the owner disabled AI', async () => {
    const ai = fakeAiProvider();
    const withAi = await createTestApp(testDb.db, { ai });
    try {
      await updateSettings(withAi.ctx.db, { aiEnabled: false }, withAi.ctx.defaults);
      const cookieForAi = await withAi.login();
      const created = await withAi.app.inject({
        method: 'POST',
        url: '/api/tasks',
        headers: { cookie: cookieForAi },
        payload: {
          title: 'Call the plumber',
          description: 'the plumber is booked for tomorrow morning',
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      ai.setAnswer({
        answer: 'The plumber is booked for tomorrow morning.',
        citedIds: [(created.json() as { id: string }).id],
      });

      const response = await withAi.app.inject({
        method: 'POST',
        url: '/api/ask',
        headers: { cookie: cookieForAi },
        payload: { question: 'plumber' },
      });

      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as AskResponse;
      expect(ai.answerCalls).toHaveLength(0);
      expect(body.deterministic).toBe(true);
      expect(body.provider).toBe('deterministic');
      expect(body.answer).toContain('Call the plumber');
      expect(body.evidence).toHaveLength(1);
    } finally {
      await withAi.close();
    }
  });

  it('falls back to the deterministic summary when the AI provider fails', async () => {
    await createPlumberTask();
    const ai = fakeAiProvider();
    ai.failAnswerWith(new Error('provider unreachable'));
    const withAi = await createTestApp(testDb.db, { ai });
    try {
      const response = await withAi.app.inject({
        method: 'POST',
        url: '/api/ask',
        headers: { cookie: await withAi.login() },
        payload: { question: 'plumber' },
      });
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as AskResponse;
      expect(body.deterministic).toBe(true);
      expect(body.provider).toBe('deterministic');
      expect(body.evidence.length).toBeGreaterThan(0);
    } finally {
      await withAi.close();
    }
  });
});

describe('POST /api/ask — citations', () => {
  let ai: FakeAiProvider;

  beforeEach(async () => {
    ai = fakeAiProvider();
  });

  async function askWithAi(payload: unknown): Promise<AskResponse> {
    const withAi = await createTestApp(testDb.db, { ai });
    try {
      const response = await withAi.app.inject({
        method: 'POST',
        url: '/api/ask',
        headers: { cookie: await withAi.login() },
        payload,
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json() as AskResponse;
    } finally {
      await withAi.close();
    }
  }

  it('ignores a citation that is not part of the evidence', async () => {
    const task = await createPlumberTask();
    ai.setAnswer({ answer: 'The plumber is booked.', citedIds: ['invented-id'] });

    const result = await askWithAi({ question: 'plumber' });

    expect(result.deterministic).toBe(true);
    expect(result.provider).toBe('deterministic');
    expect(result.evidence.map((item) => item.id)).toEqual([task.id]);
  });

  it('keeps only the citations that are part of the evidence', async () => {
    const task = await createPlumberTask();
    ai.setAnswer({ answer: 'The plumber is booked.', citedIds: [task.id, 'invented-id'] });

    const result = await askWithAi({ question: 'plumber' });

    expect(result.deterministic).toBe(false);
    expect(result.provider).toBe('fake-ai');
    expect(result.evidence.map((item) => item.id)).toEqual([task.id]);
    expect(result.answer).toContain('The plumber is booked.');
  });

  it('removes a statement the evidence does not support', async () => {
    const task = await createPlumberTask();
    ai.setAnswer({
      answer: 'The plumber is booked. The house is on fire.',
      citedIds: [task.id],
    });

    const result = await askWithAi({ question: 'plumber' });

    expect(result.deterministic).toBe(false);
    expect(result.answer).toContain('The plumber is booked.');
    expect(result.answer).not.toContain('on fire');
    expect(result.grounded).toBe(true);
  });

  it('falls back to the deterministic summary when no statement can be grounded', async () => {
    const task = await createPlumberTask();
    ai.setAnswer({ answer: 'The house is on fire.', citedIds: [task.id] });

    const result = await askWithAi({ question: 'plumber' });

    expect(result.deterministic).toBe(true);
    expect(result.provider).toBe('deterministic');
    expect(result.answer).not.toContain('on fire');
    expect(result.evidence.map((item) => item.id)).toEqual([task.id]);
  });

  it('uses a correct, cited AI answer that frames the fact with "you noted" (R4-03)', async () => {
    const task = await createPlumberTask();
    ai.setAnswer({ answer: 'You noted to call the plumber.', citedIds: [task.id] });

    const result = await askWithAi({ question: 'plumber' });

    expect(result.deterministic).toBe(false);
    expect(result.provider).toBe('fake-ai');
    expect(result.answer).toBe('You noted to call the plumber.');
    expect(result.evidence.map((item) => item.id)).toEqual([task.id]);
  });

  it('still falls back when a framed answer adds an unsupported detail', async () => {
    const task = await createPlumberTask();
    ai.setAnswer({ answer: 'You noted to call the electrician.', citedIds: [task.id] });

    const result = await askWithAi({ question: 'plumber' });

    expect(result.deterministic).toBe(true);
    expect(result.answer).not.toContain('electrician');
  });

  /** A task and a note that both mention the stationery shop; neither text names its own type. */
  async function createShopRecords(): Promise<{ taskId: string; noteId: string }> {
    const task = await createTask({ title: 'Buy blue printer ink', description: 'from the stationery shop' });
    const note = await authed('/api/notes', {
      method: 'POST',
      payload: { title: 'Stationery shop hours', body: 'The stationery shop opens at 9am', tags: [] },
    });
    expect(note.statusCode, note.body).toBe(201);
    return { taskId: task.id, noteId: (note.json() as { id: string }).id };
  }

  it('uses a cited answer that names each cited record by its own type (R4-03, lvi1e5)', async () => {
    const { taskId, noteId } = await createShopRecords();
    ai.setAnswer({
      answer: 'You have a note about the stationery shop and a task to buy blue printer ink.',
      citedIds: [taskId, noteId],
    });

    const result = await askWithAi({ question: 'stationery' });

    expect(result.deterministic).toBe(false);
    expect(result.provider).toBe('fake-ai');
    expect(result.answer).toBe('You have a note about the stationery shop and a task to buy blue printer ink.');
    expect(result.evidence.map((item) => item.id).sort()).toEqual([taskId, noteId].sort());
  });

  it('falls back when a type word is backed only by a record that was not cited', async () => {
    const { taskId, noteId } = await createShopRecords();
    // The note is in the evidence but not cited, so "note" is unsupported.
    ai.setAnswer({ answer: 'You have a note to buy blue printer ink.', citedIds: [taskId] });

    const result = await askWithAi({ question: 'stationery' });

    expect(result.deterministic).toBe(true);
    expect(result.provider).toBe('deterministic');
    expect(result.evidence.map((item) => item.id)).toContain(noteId);
  });

  it('discards an answer that cites nothing at all', async () => {
    const task = await createPlumberTask();
    ai.setAnswer({ answer: 'The plumber is booked.', citedIds: [] });

    const result = await askWithAi({ question: 'plumber' });

    expect(result.deterministic).toBe(true);
    expect(result.answer).toContain('Call the plumber');
    expect(result.evidence.map((item) => item.id)).toEqual([task.id]);
  });
});

describe('POST /api/ask — request validation', () => {
  it('rejects an empty question', async () => {
    const response = await authed('/api/ask', { method: 'POST', payload: { question: '   ' } });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a question that is too long', async () => {
    const response = await authed('/api/ask', {
      method: 'POST',
      payload: { question: 'x'.repeat(501) },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a limit outside the allowed range', async () => {
    const tooSmall = await authed('/api/ask', { method: 'POST', payload: { question: 'a', limit: 0 } });
    expect(tooSmall.statusCode).toBe(400);

    const tooLarge = await authed('/api/ask', { method: 'POST', payload: { question: 'a', limit: 99 } });
    expect(tooLarge.statusCode).toBe(400);
  });

  it('rejects an unknown record type', async () => {
    const response = await authed('/api/ask', {
      method: 'POST',
      payload: { question: 'a', types: ['NOT_A_TYPE'] },
    });
    expect(response.statusCode).toBe(400);
  });

  it('honours a type filter', async () => {
    await createPlumberTask();

    const result = await ask({ question: 'plumber', types: ['NOTE'] });

    expect(result.grounded).toBe(false);
    expect(result.evidence).toEqual([]);
  });
});
