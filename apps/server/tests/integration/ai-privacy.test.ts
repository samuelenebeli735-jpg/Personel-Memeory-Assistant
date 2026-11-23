/**
 * AI privacy and status (R1-04).
 *
 * Two independent switches guard the owner's personal text:
 *  - `aiEnabled` (the owner's Settings switch);
 *  - `AI_ALLOW_RAW_TEXT` (the server's permission; off by default).
 * The provider may be called only when BOTH allow it, for classification and
 * for Ask alike. The provider here is a recording fake: nothing leaves the test.
 */
import type { HealthDto, SettingsDto } from '@recall/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAppContext, type AppContext } from '../../src/context.js';
import { createLogger } from '../../src/lib/logger.js';
import { ProviderError } from '../../src/lib/errors.js';
import { advanceableClock } from '../../src/ports.js';
import { askQuestion } from '../../src/services/ask-service.js';
import { ingestCapture } from '../../src/services/capture-service.js';
import { updateSettings } from '../../src/services/settings-service.js';
import { createTestApp, testConfig } from '../helpers/app.js';
import { createTestDatabase, type TestDb } from '../helpers/db.js';
import { fakeAiProvider, type FakeAiProvider } from '../helpers/providers.js';
import { createFakeTelegram, createTestTelegramAdapter, textUpdate } from '../helpers/telegram.js';

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDatabase('ai-privacy');
});

afterAll(async () => {
  await testDb.cleanup();
});

beforeEach(async () => {
  await testDb.reset();
});

interface Setup {
  ctx: AppContext;
  ai: FakeAiProvider;
  warnings: string[];
}

async function setup(allowRawText: boolean, aiEnabled: boolean): Promise<Setup> {
  const warnings: string[] = [];
  const ai = fakeAiProvider();
  ai.setAnswer({ answer: 'unused', citedIds: [] });
  const ctx = createAppContext({
    config: testConfig({ AI_ALLOW_RAW_TEXT: allowRawText ? 'true' : 'false' }),
    db: testDb.db,
    clock: advanceableClock('2026-10-17T10:00:00.000Z'),
    logger: createLogger({
      level: 'warn',
      sink: (line, level) => {
        if (level === 'warn' || level === 'error') warnings.push(line);
      },
    }),
    ai,
  });
  await updateSettings(ctx.db, { aiEnabled }, ctx.defaults);
  return { ctx, ai, warnings };
}

const combinations = [
  { allowRawText: true, aiEnabled: true, providerUsed: true },
  { allowRawText: true, aiEnabled: false, providerUsed: false },
  { allowRawText: false, aiEnabled: true, providerUsed: false },
  { allowRawText: false, aiEnabled: false, providerUsed: false },
] as const;

describe('both switches must allow it before personal text reaches the provider', () => {
  for (const { allowRawText, aiEnabled, providerUsed } of combinations) {
    const label = `AI_ALLOW_RAW_TEXT=${allowRawText}, aiEnabled=${aiEnabled}`;

    it(`classification: ${label} → ${providerUsed ? 'provider' : 'rules only'}`, async () => {
      const { ctx, ai, warnings } = await setup(allowRawText, aiEnabled);
      const outcome = await ingestCapture(ctx, { rawText: 'Call the plumber tomorrow at 9am', source: 'API' });

      expect(ai.calls).toHaveLength(providerUsed ? 1 : 0);
      expect(outcome.provider).toBe(providerUsed ? 'fake-ai' : 'rules');
      // Policy, not failure: no AI error and no warning per capture.
      expect(outcome.aiError).toBeNull();
      expect(warnings).toEqual([]);
      // The capture is stored and classified either way.
      expect(outcome.capture.kind).not.toBe('UNKNOWN');
    });

    it(`Ask: ${label} → ${providerUsed ? 'provider' : 'deterministic summary'}`, async () => {
      const { ctx, ai, warnings } = await setup(allowRawText, aiEnabled);
      await ctx.db.task.create({ data: { title: 'Call the plumber', description: 'the plumber is booked' } });

      const result = await askQuestion(ctx, { question: 'plumber' });

      expect(ai.answerCalls).toHaveLength(providerUsed ? 1 : 0);
      if (!providerUsed) {
        expect(result.deterministic).toBe(true);
        expect(result.provider).toBe('deterministic');
        expect(result.answer).toContain('Call the plumber');
      }
      expect(warnings).toEqual([]);
    });
  }

  for (const { allowRawText, aiEnabled, providerUsed } of combinations) {
    it(`Telegram /settings tells the truth: AI_ALLOW_RAW_TEXT=${allowRawText}, aiEnabled=${aiEnabled}`, async () => {
      const ctx = createAppContext({
        config: testConfig({
          AI_PROVIDER: 'openai',
          AI_API_KEY: 'sk-test-not-real',
          AI_MODEL: 'fake-model',
          AI_ALLOW_RAW_TEXT: allowRawText ? 'true' : 'false',
        }),
        db: testDb.db,
        clock: advanceableClock('2026-10-17T10:00:00.000Z'),
        logger: createLogger({ level: 'silent', sink: () => undefined }),
        ai: fakeAiProvider(),
      });
      await updateSettings(ctx.db, { aiEnabled }, ctx.defaults);
      const fake = createFakeTelegram();
      const { adapter } = createTestTelegramAdapter(ctx, { fake });

      await adapter.handleUpdate(textUpdate('/settings'));

      const aiLine = (fake.sent[0] ?? '').split('\n').find((line) => line.startsWith('AI classification:'));
      if (providerUsed) {
        expect(aiLine).toBe('AI classification: openai');
      } else {
        expect(aiLine).toContain('built-in parsing');
        // The rule checks the Settings switch before the server switch.
        expect(aiLine).toContain(aiEnabled ? 'AI_ALLOW_RAW_TEXT is off' : 'switched off in Settings');
      }
    });
  }

  it('never sends evidence text for a time question, whatever the switches', async () => {
    const { ctx, ai } = await setup(true, true);
    await ctx.db.task.create({ data: { title: 'Private appointment', dueAt: new Date('2026-10-18T08:00:00.000Z') } });
    await askQuestion(ctx, { question: 'What do I have tomorrow?' });
    expect(ai.answerCalls).toHaveLength(0);
  });
});

describe('visibility: health report and Settings', () => {
  async function get<T>(app: Awaited<ReturnType<typeof createTestApp>>, url: string): Promise<T> {
    const response = await app.app.inject({ method: 'GET', url, headers: { cookie: await app.login() } });
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as T;
  }

  it('reports the raw-text permission in health and Settings', async () => {
    for (const allowed of [false, true]) {
      const app = await createTestApp(testDb.db, {
        overrides: { AI_ALLOW_RAW_TEXT: allowed ? 'true' : 'false' },
        ai: fakeAiProvider(),
      });
      try {
        const health = await get<HealthDto>(app, '/api/health');
        expect(health.providers.ai.rawTextAllowed).toBe(allowed);
        expect(health.providers.ai.model).toBe('fake-model');
        const settings = await get<SettingsDto>(app, '/api/settings');
        expect(settings.aiRawTextAllowed).toBe(allowed);
      } finally {
        await app.close();
      }
    }
  });

  it('records the last success and the last failure (code and time only)', async () => {
    const ai = fakeAiProvider();
    const app = await createTestApp(testDb.db, { ai });
    try {
      const cookie = await app.login();
      const capture = (text: string) =>
        app.app.inject({ method: 'POST', url: '/api/captures', headers: { cookie }, payload: { rawText: text, source: 'API' } });

      const before = await get<HealthDto>(app, '/api/health');
      expect(before.providers.ai).toMatchObject({ lastSuccessAt: null, lastFailureAt: null, lastFailureCode: null });

      await capture('first note to classify');
      const afterSuccess = await get<HealthDto>(app, '/api/health');
      expect(afterSuccess.providers.ai.lastSuccessAt).toBe('2026-10-17T10:00:00.000Z');

      ai.failWith(
        new ProviderError('ai', 'Provider responded with HTTP 503 about "my private text"', {
          retryable: true,
          details: { status: 503 },
        }),
      );
      app.clock.advanceMs(60_000);
      const stored = await capture('second note, provider down');
      // The capture still succeeds through the rules.
      expect(stored.statusCode).toBe(201);

      const afterFailure = await get<HealthDto>(app, '/api/health');
      expect(afterFailure.providers.ai.lastFailureAt).toBe('2026-10-17T10:01:00.000Z');
      expect(afterFailure.providers.ai.lastFailureCode).toBe('http_503');
      expect(JSON.stringify(afterFailure)).not.toContain('private');
    } finally {
      await app.close();
    }
  });
});
