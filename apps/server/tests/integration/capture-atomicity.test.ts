/**
 * Atomicity of capture derivation.
 *
 * `ingestCapture` writes the derived records *and* the capture's classification
 * state inside one transaction, so a failure part-way through must leave nothing
 * behind. This file injects a genuine database-level write failure in the middle
 * of the derivation (after the task row has already been created) and asserts
 * that the whole derivation rolled back, not just the failing statement.
 *
 * The failure is injected through a Prisma client extension, which applies to the
 * transaction client as well, so the rollback exercised here is SQLite's own.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAppContext, type AppContext } from '../../src/context.js';
import type { Db } from '../../src/db/client.js';
import { advanceableClock } from '../../src/ports.js';
import { ingestCapture } from '../../src/services/capture-service.js';
import { testConfig, testLogger } from '../helpers/app.js';
import { createTestDatabase, type TestDb } from '../helpers/db.js';

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDatabase('capture-atomicity');
});

afterAll(async () => {
  await testDb.cleanup();
});

beforeEach(async () => {
  await testDb.reset();
});

/** A context whose `reminder.create` fails, and whose db applies that inside transactions. */
function contextWithFailingReminderCreate(): AppContext {
  const extended = (testDb.db as unknown as {
    $extends: (definition: unknown) => unknown;
  }).$extends({
    query: {
      reminder: {
        create() {
          throw new Error('injected: reminder write failed');
        },
      },
    },
  });

  return createAppContext({
    config: testConfig(),
    db: extended as Db,
    clock: advanceableClock('2026-10-17T10:00:00.000Z'),
    logger: testLogger(),
    ai: null,
    stt: null,
  });
}

describe('derivation is atomic', () => {
  it('leaves no derived record and keeps the capture reprocessable when a later write fails', async () => {
    const ctx = contextWithFailingReminderCreate();

    // This text yields a TASK *and* a reminder: the task row is written first, so
    // by the time the reminder write fails the task already exists. Without a
    // real transaction the task would survive.
    const outcome = await ingestCapture(ctx, {
      rawText: 'remind me to call Ada at 4pm',
      source: 'API',
      sourceRef: 'test',
    });

    expect(outcome.processingError).toMatch(/injected/);
    expect(await testDb.db.task.count()).toBe(0);
    expect(await testDb.db.reminder.count()).toBe(0);

    const capture = await testDb.db.capture.findFirstOrThrow();
    expect(capture.status).toBe('RECEIVED');
    expect(capture.kind).toBe('UNKNOWN');
    expect(outcome.created).toEqual([]);
    expect(outcome.needsReview).toBe(false);
  });

  it('rolls the derivation back even when the capture was already tagged', async () => {
    const ctx = contextWithFailingReminderCreate();

    await ingestCapture(ctx, {
      rawText: 'remind me to pay the rent tomorrow at 9am #home',
      source: 'API',
      sourceRef: 'test',
    });

    // Tags are linked after the task is created; a partial commit would leave them.
    expect(await testDb.db.captureTag.count()).toBe(0);
    expect(await testDb.db.taskTag.count()).toBe(0);
    expect(await testDb.db.tag.count()).toBe(0);
  });

  it('still stores the capture, so nothing the user sent is lost', async () => {
    const ctx = contextWithFailingReminderCreate();
    const text = 'remind me to call Ada tomorrow at 9am';
    const outcome = await ingestCapture(ctx, { rawText: text, source: 'API', sourceRef: 'test' });

    expect(outcome.processingError).toMatch(/injected/);
    const capture = await testDb.db.capture.findFirstOrThrow();
    expect(capture.rawText).toBe(text);
    expect(capture.deletedAt).toBeNull();
    expect(capture.status).toBe('RECEIVED');
    expect(await testDb.db.task.count()).toBe(0);
  });
});
