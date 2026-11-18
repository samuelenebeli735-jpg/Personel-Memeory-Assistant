/**
 * AI classification caching.
 *
 * The cache exists to avoid paying for the same provider call twice (a retry, a
 * reprocess, a dashboard refresh) without ever turning a transient failure into
 * a permanent one. These tests use an injected provider that counts its calls,
 * so every claim about "called once" or "called again" is observed, not assumed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Classification } from '@recall/shared';

import { testConfig, testLogger } from '../helpers/app.js';
import { createTestDatabase, type TestDb } from '../helpers/db.js';
import { fakeAiProvider, sampleClassification, type FakeAiProvider } from '../helpers/providers.js';
import type { AppContext } from '../../src/context.js';
import { createAppContext } from '../../src/context.js';
import { advanceableClock, type AdvanceableClock } from '../../src/ports.js';
import { ingestCapture, reprocessCapture } from '../../src/services/capture-service.js';
import { classifyCaptureText } from '../../src/services/classification-service.js';

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDatabase('classification-cache');
});

afterAll(async () => {
  await testDb.cleanup();
});

beforeEach(async () => {
  await testDb.reset();
});

function makeCtx(
  provider: FakeAiProvider,
  clock: AdvanceableClock = advanceableClock('2026-10-17T10:00:00.000Z'),
): { ctx: AppContext; clock: AdvanceableClock } {
  const ctx = createAppContext({
    config: testConfig({ AI_PROVIDER: 'openai', AI_API_KEY: 'sk-test-not-real' }),
    db: testDb.db,
    clock,
    logger: testLogger(),
    ai: provider,
    stt: null,
  });
  return { ctx, clock };
}

/** The fake returns UNKNOWN by default so no derived record blocks reprocessing. */
function uncachedClassification(): Classification {
  return sampleClassification({ kind: 'UNKNOWN', title: null, needsReview: true });
}

async function ingest(ctx: AppContext, text: string) {
  return ingestCapture(ctx, { rawText: text, source: 'WEB' });
}

describe('ai classification cache', () => {
  it('reuses a cached classification instead of calling the provider again', async () => {
    const provider = fakeAiProvider({ classification: uncachedClassification() });
    const { ctx } = makeCtx(provider);

    const outcome = await ingest(ctx, 'tell me about quantum widgets');
    expect(provider.calls).toHaveLength(1);
    expect(outcome.provider).toBe('fake-ai');

    const stored = await testDb.db.capture.findUniqueOrThrow({ where: { id: outcome.capture.id } });
    expect(stored.classificationCache).toBeTruthy();
    expect(stored.classificationCacheKey).toBeTruthy();

    const reprocessed = await reprocessCapture(ctx, outcome.capture.id);
    expect(reprocessed.provider).toBe('fake-ai');
    // Still one call: the second pass read the cache.
    expect(provider.calls).toHaveLength(1);
  });

  it('invalidates the cache when the provider or model changes', async () => {
    const first = fakeAiProvider({ classification: uncachedClassification() });
    const { ctx } = makeCtx(first);
    const outcome = await ingest(ctx, 'tell me about quantum widgets');
    expect(first.calls).toHaveLength(1);

    const second = fakeAiProvider({
      classification: uncachedClassification(),
      name: 'fake-ai',
      model: 'a-different-model',
    });
    const other = makeCtx(second).ctx;
    await reprocessCapture(other, outcome.capture.id);

    expect(second.calls).toHaveLength(1);
  });

  it('anchors relative-time interpretation to capturedAt across same-day reprocessing', async () => {
    const provider = fakeAiProvider({ classification: uncachedClassification() });
    const { ctx, clock } = makeCtx(provider);
    const outcome = await ingest(ctx, 'remind me in two hours');
    const stored = await testDb.db.capture.findUniqueOrThrow({ where: { id: outcome.capture.id } });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.referenceNow.toISOString()).toBe(stored.capturedAt.toISOString());

    // Eight hours later the wall clock has moved, but the capture's original
    // reference time has not. The cache entry must still describe that instant,
    // not silently move "in two hours" to the evening.
    clock.advanceMs(8 * 60 * 60 * 1000);
    await reprocessCapture(ctx, outcome.capture.id);

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.referenceNow.toISOString()).toBe(stored.capturedAt.toISOString());
  });

  it('does not share a cache entry between same-day captures at different times', async () => {
    const provider = fakeAiProvider({ classification: uncachedClassification() });
    const clock = advanceableClock('2026-10-17T09:00:00.000Z');
    const { ctx } = makeCtx(provider, clock);

    const first = await ingest(ctx, 'remind me in two hours');
    clock.advanceMs(6 * 60 * 60 * 1000);
    const second = await ingest(ctx, 'remind me in two hours');

    // Same local day, same text, different reference instants. Reusing the first
    // answer would move the second reminder to the first capture's time.
    expect(provider.calls).toHaveLength(2);
    const firstRow = await testDb.db.capture.findUniqueOrThrow({ where: { id: first.capture.id } });
    const secondRow = await testDb.db.capture.findUniqueOrThrow({ where: { id: second.capture.id } });
    expect(firstRow.classificationCacheKey).not.toBe(secondRow.classificationCacheKey);
  });

  it('resolves duration-relative phrases from capturedAt, not the reprocessing time', async () => {
    const provider = fakeAiProvider({ classification: uncachedClassification() });
    const clock = advanceableClock('2026-10-17T09:00:00.000Z');
    const { ctx } = makeCtx(provider, clock);
    const capturedAt = clock.now();

    const first = await classifyCaptureText(ctx, {
      text: 'remind me in two hours',
      capturedAt,
      forceRules: true,
    });
    // 09:00Z is 10:00 in Lagos, so the reminder is 12:00 local (11:00Z).
    expect(first.classification.remindAt).toBe('2026-10-17T11:00:00.000Z');

    // Move the wall clock to 19:00Z (20:00 local). Reinterpreting the phrase
    // now would produce 21:00Z; it must stay anchored to the capture.
    clock.advanceMs(10 * 60 * 60 * 1000);
    const second = await classifyCaptureText(ctx, {
      text: 'remind me in two hours',
      capturedAt,
      forceRules: true,
    });

    expect(second.classification.remindAt).toBe('2026-10-17T11:00:00.000Z');
  });

  it('keeps a relative deadline when reprocessing more than 30 days later', async () => {
    const provider = fakeAiProvider({ classification: uncachedClassification() });
    const clock = advanceableClock('2026-10-17T09:00:00.000Z');
    const { ctx } = makeCtx(provider, clock);
    const capturedAt = clock.now();

    clock.advanceMs(40 * 24 * 60 * 60 * 1000);
    const outcome = await classifyCaptureText(ctx, {
      text: 'remind me in two hours',
      capturedAt,
      forceRules: true,
    });

    // Plausibility bounds are anchored to capturedAt too; a 40-day-old capture
    // must not lose a deadline that was valid when it was made.
    expect(outcome.classification.remindAt).toBe('2026-10-17T11:00:00.000Z');
  });

  it('keeps date-only and clock-time expressions stable when the wall clock advances', async () => {
    const provider = fakeAiProvider({ classification: uncachedClassification() });
    const { ctx, clock } = makeCtx(provider);
    const capturedAt = new Date('2026-10-17T09:00:00.000Z');

    const first = await classifyCaptureText(ctx, {
      text: 'finish the report tomorrow',
      capturedAt,
      forceRules: true,
    });
    const firstClock = await classifyCaptureText(ctx, {
      text: 'call Ada at 4 PM',
      capturedAt,
      forceRules: true,
    });

    expect(first.classification.dueAt).toBe('2026-10-18T22:59:59.999Z');
    expect(firstClock.classification.dueAt).toBe('2026-10-17T15:00:00.000Z');

    clock.advanceMs(10 * 60 * 60 * 1000);
    const second = await classifyCaptureText(ctx, {
      text: 'finish the report tomorrow',
      capturedAt,
      forceRules: true,
    });
    const secondClock = await classifyCaptureText(ctx, {
      text: 'call Ada at 4 PM',
      capturedAt,
      forceRules: true,
    });

    expect(first.classification.dueAt).toBe(second.classification.dueAt);
    expect(firstClock.classification.dueAt).toBe(secondClock.classification.dueAt);
  });

  it('never caches a transient provider failure', async () => {
    const provider = fakeAiProvider({
      classification: uncachedClassification(),
      error: new Error('simulated outage'),
    });
    const { ctx } = makeCtx(provider);

    const outcome = await ingest(ctx, 'tell me about quantum widgets');
    expect(outcome.provider).toBe('rules');
    expect(outcome.aiError).toContain('simulated outage');

    const stored = await testDb.db.capture.findUniqueOrThrow({ where: { id: outcome.capture.id } });
    expect(stored.classificationCache).toBeNull();
    expect(stored.classificationCacheKey).toBeNull();

    // The next attempt goes back to the provider instead of replaying the failure.
    provider.failWith(null);
    const retried = await classifyCaptureText(ctx, {
      text: stored.rawText,
      capturedAt: stored.capturedAt,
      captureId: stored.id,
    });
    expect(retried.provider).toBe('fake-ai');
    expect(retried.cached).toBe(false);
    expect(provider.calls).toHaveLength(2);

    const after = await testDb.db.capture.findUniqueOrThrow({ where: { id: stored.id } });
    expect(after.classificationCache).toBeTruthy();
  });

  it('rejects malformed provider output and records no cache entry', async () => {
    const provider = fakeAiProvider();
    provider.setResult({ kind: 'NOT_A_KIND', title: null } as unknown as Classification);
    const { ctx } = makeCtx(provider);

    const outcome = await ingest(ctx, 'tell me about quantum widgets');

    expect(outcome.provider).toBe('rules');
    expect(outcome.aiError).toContain('schema validation');
    const stored = await testDb.db.capture.findUniqueOrThrow({ where: { id: outcome.capture.id } });
    expect(stored.classificationCache).toBeNull();
  });

  it('does not reuse a cache entry written for different text', async () => {
    const provider = fakeAiProvider({ classification: uncachedClassification() });
    const { ctx } = makeCtx(provider);
    const first = await ingest(ctx, 'tell me about quantum widgets');
    expect(provider.calls).toHaveLength(1);

    const second = await ingest(ctx, 'a completely different thought');
    expect(provider.calls).toHaveLength(2);
    const firstRow = await testDb.db.capture.findUniqueOrThrow({ where: { id: first.capture.id } });
    const secondRow = await testDb.db.capture.findUniqueOrThrow({ where: { id: second.capture.id } });
    expect(firstRow.classificationCacheKey).not.toBe(secondRow.classificationCacheKey);
  });

  it('refuses to reprocess the same capture twice at once', async () => {
    const provider = fakeAiProvider({ classification: uncachedClassification() });
    const { ctx } = makeCtx(provider);
    const outcome = await ingest(ctx, 'tell me about quantum widgets');

    const inFlight = reprocessCapture(ctx, outcome.capture.id);
    await expect(reprocessCapture(ctx, outcome.capture.id)).rejects.toThrow(
      /already being processed/i,
    );
    const result = await inFlight;
    expect(result.capture.id).toBe(outcome.capture.id);
    // The guard is released afterwards, so a later reprocess works normally.
    await expect(reprocessCapture(ctx, outcome.capture.id)).resolves.toBeTruthy();
  });
});
