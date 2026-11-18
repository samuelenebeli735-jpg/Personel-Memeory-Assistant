/**
 * Telegram capture integration.
 *
 * The real adapter runs against a fake Bot API and a real SQLite database, so
 * these tests exercise the whole path: owner check → idempotent ingest →
 * classification → derived records → reply.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { AiProvider } from '../../src/ai/types.js';
import { testConfig, testLogger } from '../helpers/app.js';
import { createTestDatabase, type TestDb } from '../helpers/db.js';
import { fakeAiProvider } from '../helpers/providers.js';
import {
  callbackUpdate,
  createFakeTelegram,
  createTestTelegramAdapter,
  failingAiProvider,
  messageUpdate,
  textUpdate,
  type FakeTelegram,
  type TestTelegramAdapter,
} from '../helpers/telegram.js';
import type { AppContext } from '../../src/context.js';
import { createAppContext } from '../../src/context.js';
import { advanceableClock } from '../../src/ports.js';
import { updateSettings } from '../../src/services/settings-service.js';
import { VOICE_PLACEHOLDER } from '../../src/telegram/handler.js';

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDatabase('telegram');
});

afterAll(async () => {
  await testDb.cleanup();
});

beforeEach(async () => {
  await testDb.reset();
});

describe('owner-only access', () => {
  it('stores an owner message once and confirms what it understood', async () => {
    const { ctx, adapter, fake } = setup();

    const result = await adapter.handleUpdate(textUpdate('I need to finish the report tomorrow'));

    expect(result.handled).toBe(true);
    expect(result.duplicate).toBe(false);
    expect(await ctx.db.capture.count()).toBe(1);

    const stored = await ctx.db.capture.findFirstOrThrow();
    expect(stored.rawText).toBe('I need to finish the report tomorrow');
    expect(stored.source).toBe('TELEGRAM');
    expect(stored.externalId).toBe('telegram:555000111:7');

    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toMatch(/Saved as a/);
    expect(fake.sentMarkups[0]).toBeDefined();
  });

  it('refuses a non-owner and writes nothing', async () => {
    const { ctx, adapter, fake } = setup();

    const result = await adapter.handleUpdate(
      textUpdate('remember I owe Ada money', { fromId: 999999999, chatId: 999999999 }),
    );

    expect(result).toMatchObject({ handled: false, reason: 'non-owner' });
    expect(await ctx.db.capture.count()).toBe(0);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toMatch(/private/i);
    // The refusal is neutral: it discloses nothing about the owner or the bot.
    expect(fake.sent[0]).not.toContain('555000111');
  });

  it('refuses an owner who messages from a group', async () => {
    const { ctx, adapter } = setup();
    const result = await adapter.handleUpdate(textUpdate('hello', { chatType: 'group', chatId: -100 }));
    expect(result).toMatchObject({ handled: false, reason: 'group-chat' });
    expect(await ctx.db.capture.count()).toBe(0);
  });

  it('refuses a callback query from a non-owner', async () => {
    const { ctx, adapter, fake } = setup();
    await adapter.handleUpdate(textUpdate('water the plants'));
    const capture = await ctx.db.capture.findFirstOrThrow();

    fake.reset();
    const result = await adapter.handleUpdate(
      callbackUpdate(`k:${capture.id}:IDEA`, { fromId: 999999999, chatId: 999999999 }),
    );

    expect(result).toMatchObject({ handled: false, reason: 'non-owner' });
    expect(fake.methods()).toContain('answerCallbackQuery');
    expect(fake.edits).toHaveLength(0);
    // The capture is untouched.
    expect((await ctx.db.capture.findFirstOrThrow()).kind).not.toBe('IDEA');
  });
});

describe('idempotency', () => {
  it('stores nothing extra when Telegram replays the same update', async () => {
    const { ctx, adapter, fake } = setup();

    const first = await adapter.handleUpdate(textUpdate('buy milk', { messageId: 11 }));
    const second = await adapter.handleUpdate(textUpdate('buy milk', { messageId: 11 }));

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(await ctx.db.capture.count()).toBe(1);

    // The second reply says it was already saved, and offers no buttons.
    expect(fake.sent[1]).toMatch(/Already saved/);
    expect(fake.sentMarkups[1]).toBeUndefined();
  });

  it('treats each new message id as a new capture', async () => {
    const { ctx, adapter } = setup();
    await adapter.handleUpdate(textUpdate('buy milk', { messageId: 1 }));
    await adapter.handleUpdate(textUpdate('buy milk', { messageId: 2 }));
    expect(await ctx.db.capture.count()).toBe(2);
  });

  it('ignores an edited message rather than rewriting the original', async () => {
    const { ctx, adapter } = setup();
    await adapter.handleUpdate(textUpdate('buy milk', { messageId: 3 }));

    const result = await adapter.handleUpdate({
      update_id: 99,
      edited_message: {
        message_id: 3,
        date: 1_760_000_000,
        chat: { id: 555000111, type: 'private' },
        from: { id: 555000111 },
        text: 'buy oat milk',
      },
    } as never);

    expect(result).toMatchObject({ handled: false, reason: 'edited' });
    const stored = await ctx.db.capture.findFirstOrThrow();
    expect(stored.rawText).toBe('buy milk');
  });
});

describe('resilience', () => {
  it('stores the capture even when the AI provider throws', async () => {
    const { ctx, adapter, fake } = setup({ ai: failingAiProvider('simulated outage') });

    const result = await adapter.handleUpdate(textUpdate('I need to review the budget on Friday'));

    expect(result.handled).toBe(true);
    const stored = await ctx.db.capture.findFirstOrThrow();
    expect(stored.rawText).toBe('I need to review the budget on Friday');
    expect(stored.kind).not.toBe('UNKNOWN');
    expect(fake.sent[0]).toMatch(/AI provider was unavailable/);
  });

  it('acknowledges unsupported media without storing anything', async () => {
    const { ctx, adapter, fake } = setup();
    const result = await adapter.handleUpdate(messageUpdate({ sticker: true }));
    expect(result).toMatchObject({ handled: false, reason: 'unsupported' });
    expect(await ctx.db.capture.count()).toBe(0);
    expect(fake.sent[0]).toMatch(/cannot store/i);
  });

  it('keeps a voice message with an explicit not-transcribed marker', async () => {
    const { ctx, adapter, fake } = setup();

    const result = await adapter.handleUpdate(
      messageUpdate({ voice: { file_id: 'voice-1', duration: 12 } }),
    );

    expect(result.handled).toBe(true);
    const stored = await ctx.db.capture.findFirstOrThrow();
    expect(stored.rawText).toBe(VOICE_PLACEHOLDER);
    expect(stored.status).toBe('NEEDS_REVIEW');
    expect(stored.needsReview).toBe(true);
    expect(stored.kind).toBe('UNKNOWN');
    expect(JSON.parse(stored.metadata ?? '{}')).toMatchObject({
      voice: { fileId: 'voice-1', transcribed: false },
    });
    // A voice capture must not fabricate a task from the placeholder.
    expect(await ctx.db.task.count()).toBe(0);
    expect(fake.sent[0]).toMatch(/not transcribed|transcribe/i);
  });

  it('uses a voice caption as the text when one is supplied', async () => {
    const { ctx, adapter } = setup();
    await adapter.handleUpdate(
      messageUpdate({
        voice: { file_id: 'voice-2', duration: 5 },
        caption: 'remind me to email the landlord',
      }),
    );
    const stored = await ctx.db.capture.findFirstOrThrow();
    expect(stored.rawText).toBe('remind me to email the landlord');
  });

  it('asks for text when a message carries none', async () => {
    const { ctx, adapter, fake } = setup();
    const result = await adapter.handleUpdate(messageUpdate({}));
    expect(result).toMatchObject({ handled: false, reason: 'empty' });
    expect(await ctx.db.capture.count()).toBe(0);
    expect(fake.sent[0]).toMatch(/did not find any text/i);
  });
});

describe('correction and undo', () => {
  it('converts the kind from an inline button and keeps the raw capture', async () => {
    const { ctx, adapter, fake } = setup();
    await adapter.handleUpdate(textUpdate('a website that helps students find study groups'));
    const capture = await ctx.db.capture.findFirstOrThrow();

    fake.reset();
    const result = await adapter.handleUpdate(callbackUpdate(`k:${capture.id}:IDEA`));

    expect(result.handled).toBe(true);
    expect(await ctx.db.idea.count()).toBe(1);
    expect(await ctx.db.note.count()).toBe(0);
    const updated = await ctx.db.capture.findUniqueOrThrow({ where: { id: capture.id } });
    expect(updated.kind).toBe('IDEA');
    expect(updated.rawText).toBe(capture.rawText);
    expect(fake.edits[0]).toMatch(/treat this as idea/i);
  });

  it('prompts before undoing and only deletes after confirmation', async () => {
    const { ctx, adapter, fake } = setup();
    await adapter.handleUpdate(textUpdate('I need to call Ada tomorrow'));
    const capture = await ctx.db.capture.findFirstOrThrow();
    expect(await ctx.db.task.count()).toBe(1);

    fake.reset();
    // Step 1: /undo offers a confirmation, deleting nothing.
    await adapter.handleUpdate(textUpdate('/undo', { messageId: 21 }));
    expect(fake.sent[0]).toMatch(/Undo the most recent capture/i);
    expect(fake.sentMarkups[0]).toMatchObject({
      inline_keyboard: [[{ callback_data: `U:${capture.id}` }, { callback_data: `K:${capture.id}` }]],
    });
    expect(await ctx.db.task.count()).toBe(1);

    // Step 2: "Keep it" removes the prompt and keeps everything.
    await adapter.handleUpdate(callbackUpdate(`K:${capture.id}`));
    expect(fake.edits.at(-1)).toMatch(/Kept it/);
    expect(await ctx.db.task.count()).toBe(1);
  });

  it('removes the capture and its derived records after confirmation', async () => {
    const { ctx, adapter, fake } = setup();
    await adapter.handleUpdate(textUpdate('I need to call Ada tomorrow'));
    const capture = await ctx.db.capture.findFirstOrThrow();

    fake.reset();
    const result = await adapter.handleUpdate(callbackUpdate(`U:${capture.id}`));

    expect(result.handled).toBe(true);
    expect(await ctx.db.task.count()).toBe(0);
    const after = await ctx.db.capture.findUniqueOrThrow({ where: { id: capture.id } });
    // Soft-deleted: the audit trail survives, the items are gone.
    expect(after.deletedAt).not.toBeNull();
    expect(after.status).toBe('DELETED');
    expect(fake.edits.at(-1)).toMatch(/Undone/);
    expect(await ctx.db.task.count()).toBe(0);
  });

  it('explains when a capture was already deleted', async () => {
    const { ctx, adapter, fake } = setup();
    fake.reset();
    await adapter.handleUpdate(callbackUpdate('u:missing-capture'));
    expect(fake.answers.at(-1)).toMatch(/no longer exists/i);
  });

  it('rejects an unknown kind on a correction button', async () => {
    const { ctx, adapter, fake } = setup();
    await adapter.handleUpdate(textUpdate('something'));
    const capture = await ctx.db.capture.findFirstOrThrow();
    fake.reset();
    await adapter.handleUpdate(callbackUpdate(`k:${capture.id}:BANANA`));
    expect(fake.answers.at(-1)).toMatch(/not a kind I know/i);
    expect(await ctx.db.idea.count()).toBe(0);
  });
});

describe('commands', () => {
  it('answers /help without creating a capture', async () => {
    const { ctx, adapter, fake } = setup();
    const result = await adapter.handleUpdate(textUpdate('/help'));
    expect(result.handled).toBe(true);
    expect(fake.sent[0]).toContain('/inbox');
    expect(await ctx.db.capture.count()).toBe(0);
  });

  it('lists reviewable captures with /inbox', async () => {
    const { ctx, adapter, fake } = setup();
    await adapter.handleUpdate(textUpdate('hmm', { messageId: 30 }));
    const before = await ctx.db.capture.count();
    fake.reset();
    await adapter.handleUpdate(textUpdate('/inbox', { messageId: 31 }));
    expect(await ctx.db.capture.count()).toBe(before);
    expect(fake.sent[0]).toMatch(/Inbox/);
  });

  it('asks for a question instead of storing /ask', async () => {
    const { ctx, adapter, fake } = setup();
    await adapter.handleUpdate(textUpdate('/ask'));
    expect(fake.sent[0]).toMatch(/What would you like to ask/);
    expect(await ctx.db.capture.count()).toBe(0);
  });

  it('answers /ask from stored records without an AI provider', async () => {
    const { ctx, adapter, fake } = setup();
    await ctx.db.task.create({
      data: {
        title: 'Call the plumber',
        description: 'the plumber is booked for tomorrow morning',
      },
    });

    await adapter.handleUpdate(textUpdate('/ask plumber', { messageId: 32 }));

    expect(fake.sent[0]).toContain('Call the plumber');
    expect(fake.sent[0]).toContain('Based on:');
    expect(await ctx.db.capture.count()).toBe(0);
  });

  it('answers /ask through the configured AI provider', async () => {
    const ai = fakeAiProvider();
    const { ctx, adapter, fake } = setup({ ai });
    const task = await ctx.db.task.create({
      data: {
        title: 'Call the plumber',
        description: 'the plumber is booked for tomorrow morning',
      },
    });
    ai.setAnswer({
      answer: 'The plumber is booked for tomorrow morning.',
      citedIds: [task.id],
    });

    await adapter.handleUpdate(textUpdate('/ask plumber', { messageId: 33 }));

    expect(ai.answerCalls).toHaveLength(1);
    expect(fake.sent[0]).toContain('The plumber is booked for tomorrow morning.');
    expect(fake.sent[0]).toContain(`#${task.id.slice(0, 6)}`);
    expect(await ctx.db.capture.count()).toBe(0);
  });

  it('does not call the AI provider when the owner disabled AI', async () => {
    const ai = fakeAiProvider();
    const { ctx, adapter, fake } = setup({ ai });
    await ctx.db.task.create({
      data: {
        title: 'Call the plumber',
        description: 'the plumber is booked for tomorrow morning',
      },
    });
    await updateSettings(ctx.db, { aiEnabled: false }, ctx.defaults);

    await adapter.handleUpdate(textUpdate('/ask plumber', { messageId: 34 }));

    expect(ai.answerCalls).toHaveLength(0);
    expect(fake.sent[0]).toContain('Call the plumber');
    expect(fake.sent[0]).toContain('Based on:');
    expect(await ctx.db.capture.count()).toBe(0);
  });

  it('answers a library command that is wired up', async () => {
    const { ctx, adapter, fake } = setup();
    await adapter.handleUpdate(textUpdate('/tasks'));
    expect(fake.sent[0]).toMatch(/Open tasks/);
    expect(fake.sent[0]).not.toMatch(/not available yet/);
    expect(await ctx.db.capture.count()).toBe(0);
  });

  it('explains an unknown command instead of silently ignoring it', async () => {
    const { adapter, fake } = setup();
    await adapter.handleUpdate(textUpdate('/nonsense'));
    expect(fake.sent[0]).toMatch(/do not know \/nonsense/);
  });
});

describe('webhook mode', () => {
  it('rejects a request with the wrong secret and stores nothing', async () => {
    const { ctx, adapter } = setup({ overrides: { TELEGRAM_WEBHOOK_SECRET: 'secret-abc' } });
    const result = await adapter.handleWebhook({
      secretHeader: 'wrong',
      body: textUpdate('sneaky'),
    });
    expect(result.status).toBe(401);
    expect(await ctx.db.capture.count()).toBe(0);
  });

  it('accepts a correctly signed update', async () => {
    const { ctx, adapter, fake } = setup({ overrides: { TELEGRAM_WEBHOOK_SECRET: 'secret-abc' } });
    const result = await adapter.handleWebhook({
      secretHeader: 'secret-abc',
      body: textUpdate('buy bread'),
    });
    expect(result.status).toBe(200);
    expect(await ctx.db.capture.count()).toBe(1);
    expect(fake.sent).toHaveLength(1);
  });

  it('refuses to run without a configured secret', async () => {
    const { adapter } = setup();
    const result = await adapter.handleWebhook({ secretHeader: 'anything', body: textUpdate('x') });
    expect(result.status).toBe(503);
  });

  it('rejects a malformed body', async () => {
    const { adapter } = setup({ overrides: { TELEGRAM_WEBHOOK_SECRET: 'secret-abc' } });
    const result = await adapter.handleWebhook({ secretHeader: 'secret-abc', body: { nope: true } });
    expect(result.status).toBe(400);
  });

  it('returns 200 for a refusal so Telegram does not retry forever', async () => {
    const { adapter } = setup({ overrides: { TELEGRAM_WEBHOOK_SECRET: 'secret-abc' } });
    const result = await adapter.handleWebhook({
      secretHeader: 'secret-abc',
      body: textUpdate('hello', { fromId: 1, chatId: 1 }),
    });
    expect(result.status).toBe(200);
  });
});

describe('reminders', () => {
  it('says a reminder is set only when the user asked for one', async () => {
    const { ctx, adapter, fake } = setup();
    await adapter.handleUpdate(textUpdate('remind me to call Ada at 4pm'));
    expect(await ctx.db.reminder.count()).toBe(1);
    expect(fake.sent[0]).toMatch(/reminder/i);

    fake.reset();
    await adapter.handleUpdate(
      textUpdate('I need to finish the report by Friday', { messageId: 41 }),
    );
    expect(await ctx.db.reminder.count()).toBe(1);
    expect(fake.sent[0]).not.toContain('A reminder is set.');
  });
});

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function setup(
  options: {
    overrides?: Record<string, string | undefined>;
    ai?: AiProvider | null;
  } = {},
): { ctx: AppContext; adapter: TestTelegramAdapter['adapter']; client: TestTelegramAdapter['client']; fake: FakeTelegram } {
  const clock = advanceableClock('2026-10-17T10:00:00.000Z');
  const config = testConfig({
    ...(options.ai ? { AI_PROVIDER: 'openai', AI_API_KEY: 'sk-test-not-real' } : {}),
    ...options.overrides,
  });
  const ctx = createAppContext({
    config,
    db: testDb.db,
    clock,
    logger: testLogger(),
    ai: options.ai ?? null,
    stt: null,
  });
  const fake = createFakeTelegram();
  const { adapter, client } = createTestTelegramAdapter(ctx, { fake });
  return { ctx, adapter, client, fake };
}
