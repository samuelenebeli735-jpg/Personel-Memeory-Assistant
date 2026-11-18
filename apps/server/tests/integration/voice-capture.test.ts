/**
 * Voice capture integration.
 *
 * The real Telegram adapter runs against a fake Bot API, a fake transcriber and
 * a real SQLite database. These tests prove the whole voice path: replay check →
 * duration/format limits → download → transcription → storage with provenance →
 * classification → reply. No live Telegram, STT or AI call is made.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { testConfig, testLogger } from '../helpers/app.js';
import { createTestDatabase, type TestDb } from '../helpers/db.js';
import {
  createFakeTelegram,
  createTestTelegramAdapter,
  messageUpdate,
  type FakeTelegramOptions,
  type MessageOverrides,
} from '../helpers/telegram.js';
import {
  fakeAiProvider,
  fakeTranscriber,
  sampleClassification,
  type FakeTranscriber,
} from '../helpers/providers.js';
import type { AppContext } from '../../src/context.js';
import { createAppContext } from '../../src/context.js';
import { advanceableClock } from '../../src/ports.js';
import {
  getCapture,
  ingestCapture,
  purgeCapture,
  reprocessCapture,
  undoCapture,
} from '../../src/services/capture-service.js';
import { startTelegramPolling, type PollingController } from '../../src/telegram/polling.js';
import { VOICE_PLACEHOLDER } from '../../src/telegram/handler.js';

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDatabase('voice');
});

afterAll(async () => {
  await testDb.cleanup();
});

beforeEach(async () => {
  await testDb.reset();
});

const AUDIO = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2, 3, 4]);

interface SetupOptions {
  stt?: FakeTranscriber | null;
  ai?: ReturnType<typeof fakeAiProvider> | null;
  overrides?: Record<string, string | undefined>;
  files?: Record<string, { path?: string; bytes: Uint8Array; status?: number }>;
  onCall?: FakeTelegramOptions['onCall'];
}

function setup(options: SetupOptions = {}) {
  const clock = advanceableClock('2026-10-17T10:00:00.000Z');
  const config = testConfig(options.overrides ?? {});
  const transcriber = options.stt === undefined ? fakeTranscriber() : options.stt;
  const ctx: AppContext = createAppContext({
    config,
    db: testDb.db,
    clock,
    logger: testLogger(),
    ai: options.ai === undefined ? null : options.ai,
    stt: transcriber,
  });
  const fake = createFakeTelegram({ files: options.files, onCall: options.onCall });
  const { adapter, client } = createTestTelegramAdapter(ctx, { fake });
  return { ctx, adapter, client, fake, transcriber, clock };
}

const voiceMessage = (overrides: MessageOverrides = {}) =>
  messageUpdate({
    voice: { file_id: 'voice-9', duration: 8, mime_type: 'audio/ogg' },
    ...overrides,
  });

function audioFiles(id = 'voice-9') {
  return { [id]: { path: `voice/file_${id}.oga`, bytes: AUDIO } };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A transcriber that parks after recording its call until the test releases it. */
function gatedTranscriber(initial: { text?: string } = {}) {
  const started = deferred();
  const release = deferred();
  const transcriber = fakeTranscriber({
    ...initial,
    beforeResult: async () => {
      started.resolve();
      await release.promise;
    },
  });
  return { transcriber, started, release };
}

describe('voice transcription', () => {
  it('downloads, transcribes and classifies a voice-only message', async () => {
    const transcriber = fakeTranscriber({ text: 'remind me to call the plumber tomorrow' });
    const { ctx, adapter, fake } = setup({ stt: transcriber, files: audioFiles() });

    const result = await adapter.handleUpdate(
      voiceMessage({ voice: { file_id: 'voice-9', duration: 8, mime_type: 'audio/ogg' } }),
    );

    expect(result).toMatchObject({ handled: true, duplicate: false });
    expect(transcriber.calls).toHaveLength(1);

    const stored = await ctx.db.capture.findFirstOrThrow();
    // The typed text stays verbatim: a voice note with no caption keeps the
    // neutral placeholder, and the transcript lives in its own column.
    expect(stored.rawText).toBe(VOICE_PLACEHOLDER);
    expect(stored.transcript).toBe('remind me to call the plumber tomorrow');
    expect(stored.transcriptSource).toBe('SPEECH_PROVIDER');
    expect((await getCapture(ctx.db, stored.id)).isVoice).toBe(true);

    const metadata = JSON.parse(stored.metadata ?? '{}');
    expect(metadata.voice).toMatchObject({
      fileId: 'voice-9',
      transcribed: true,
      transcriptSource: 'SPEECH_PROVIDER',
      sttProvider: 'fake-stt',
      sttModel: 'fake-whisper',
      status: 'transcribed',
    });

    // The transcript, not the placeholder, drove classification.
    expect(await ctx.db.task.count()).toBe(1);
    const task = await ctx.db.task.findFirstOrThrow();
    expect(task.title).toMatch(/plumber/i);
    expect(task.dueAt).not.toBeNull();

    expect(fake.sent[0]).toMatch(/Transcribed:/);
    expect(fake.sent[0]).toMatch(/remind me to call the plumber tomorrow/);
  });

  it('keeps the caption and the transcript, and classifies both together', async () => {
    const transcriber = fakeTranscriber({ text: 'her birthday is on Friday' });
    const { ctx, adapter, fake } = setup({ stt: transcriber, files: audioFiles() });

    await adapter.handleUpdate(
      voiceMessage({
        voice: { file_id: 'voice-9', duration: 6, mime_type: 'audio/ogg' },
        caption: 'buy a present for Ada',
      }),
    );

    const stored = await ctx.db.capture.findFirstOrThrow();
    expect(stored.rawText).toBe('buy a present for Ada');
    expect(stored.transcript).toBe('her birthday is on Friday');

    // "Friday" is only in the transcript, so a resolved date proves the
    // classifier saw the combined caption + transcript text.
    const tasks = await ctx.db.task.findMany();
    const events = await ctx.db.event.findMany();
    const dated = [...tasks.map((t) => t.dueAt), ...events.map((e) => e.startsAt)].filter(Boolean);
    expect(dated.length).toBeGreaterThan(0);

    expect(fake.sent[0]).toMatch(/Transcribed:/);
    expect(fake.sent[0]).toMatch(/her birthday is on Friday/);
  });

  it('does not transcribe a replay, and does not store a second capture', async () => {
    const transcriber = fakeTranscriber();
    const { ctx, adapter, fake } = setup({ stt: transcriber, files: audioFiles() });

    await adapter.handleUpdate(voiceMessage());
    fake.reset();
    const second = await adapter.handleUpdate(voiceMessage());

    expect(second.duplicate).toBe(true);
    expect(await ctx.db.capture.count()).toBe(1);
    expect(transcriber.calls).toHaveLength(1);
    expect(fake.callsTo('getFile')).toHaveLength(0);
    expect(fake.sent[0]).toMatch(/Already saved/);
  });
});

describe('concurrent voice deliveries', () => {
  it('coalesces the same voice update before download and transcription', async () => {
    const { transcriber, started, release } = gatedTranscriber();
    const { ctx, adapter, fake } = setup({ stt: transcriber, files: audioFiles() });
    const update = voiceMessage({ messageId: 21 });

    const first = adapter.handleUpdate(update);
    const second = adapter.handleUpdate(update);

    await started.promise;
    expect(transcriber.calls).toHaveLength(1);
    expect(fake.callsTo('getFile')).toHaveLength(1);
    expect(await ctx.db.capture.count()).toBe(0);

    release.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toMatchObject({ handled: true, duplicate: false });
    expect(secondResult).toMatchObject({ handled: true, duplicate: true });
    expect(secondResult.captureId).toBe(firstResult.captureId);
    expect(await ctx.db.capture.count()).toBe(1);
    expect(transcriber.calls).toHaveLength(1);
    expect(fake.sent).toHaveLength(1);
  });

  it('coalesces concurrent webhook retries and keeps both responses successful', async () => {
    const { transcriber, started, release } = gatedTranscriber();
    const { ctx, adapter, fake } = setup({
      stt: transcriber,
      files: audioFiles(),
      overrides: { TELEGRAM_WEBHOOK_SECRET: 'secret-abc' },
    });
    const update = voiceMessage({ messageId: 22 });

    const first = adapter.handleWebhook({ secretHeader: 'secret-abc', body: update });
    const second = adapter.handleWebhook({ secretHeader: 'secret-abc', body: update });

    await started.promise;
    release.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.status).toBe(200);
    expect(secondResult.status).toBe(200);
    expect(await ctx.db.capture.count()).toBe(1);
    expect(transcriber.calls).toHaveLength(1);
    expect(fake.sent).toHaveLength(1);
  });

  it('does not coalesce different voice messages', async () => {
    const gate = deferred();
    const bothStarted = deferred();
    let startedCount = 0;
    const transcriber = fakeTranscriber({
      beforeResult: async () => {
        startedCount += 1;
        if (startedCount === 2) bothStarted.resolve();
        await gate.promise;
      },
    });
    const { ctx, adapter } = setup({ stt: transcriber, files: audioFiles() });

    const first = adapter.handleUpdate(voiceMessage({ messageId: 31 }));
    const second = adapter.handleUpdate(voiceMessage({ messageId: 32 }));
    await bothStarted.promise;
    gate.resolve();

    const results = await Promise.all([first, second]);

    expect(results.every((result) => result.duplicate === false)).toBe(true);
    expect(await ctx.db.capture.count()).toBe(2);
    expect(transcriber.calls).toHaveLength(2);
  });

  it('clears the in-flight claim after a failed attempt so a retry can proceed', async () => {
    const transcriber = fakeTranscriber();
    const { ctx, adapter, fake } = setup({ stt: transcriber, files: audioFiles() });
    const update = voiceMessage({ messageId: 23 });

    await ctx.db.$executeRawUnsafe('DROP TRIGGER IF EXISTS fail_voice_insert');
    await ctx.db.$executeRawUnsafe(`
      CREATE TRIGGER fail_voice_insert
      BEFORE INSERT ON captures
      BEGIN
        SELECT RAISE(ABORT, 'simulated capture persistence failure');
      END
    `);

    try {
      const outcomes = await Promise.allSettled([
        adapter.handleUpdate(update),
        adapter.handleUpdate(update),
      ]);

      expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected']);
      expect(transcriber.calls).toHaveLength(1);
      expect(await ctx.db.capture.count()).toBe(0);
    } finally {
      await ctx.db.$executeRawUnsafe('DROP TRIGGER IF EXISTS fail_voice_insert');
    }

    const retry = await adapter.handleUpdate(update);

    expect(retry).toMatchObject({ handled: true, duplicate: false });
    expect(await ctx.db.capture.count()).toBe(1);
    expect(transcriber.calls).toHaveLength(2);
    expect(fake.sent).toHaveLength(1);
  });

  it('keeps the database uniqueness constraint as the final persistence safeguard', async () => {
    const { ctx } = setup({ stt: null });
    const input = {
      rawText: 'buy milk',
      source: 'TELEGRAM' as const,
      externalId: 'telegram:555000111:40',
    };

    const [first, second] = await Promise.all([
      ingestCapture(ctx, input, { captureOnly: true }),
      ingestCapture(ctx, input, { captureOnly: true }),
    ]);

    expect(await ctx.db.capture.count()).toBe(1);
    expect(first.capture.id).toBe(second.capture.id);
    expect(first.duplicate || second.duplicate).toBe(true);
    expect(first.duplicate && second.duplicate).toBe(false);
  });
});

describe('voice fallbacks', () => {
  it('stores the message untouched when transcription is not configured', async () => {
    const { ctx, adapter, fake } = setup({ stt: null });

    const result = await adapter.handleUpdate(voiceMessage());

    expect(result.handled).toBe(true);
    const stored = await ctx.db.capture.findFirstOrThrow();
    expect(stored.rawText).toBe(VOICE_PLACEHOLDER);
    expect(stored.transcript).toBeNull();
    expect(stored.status).toBe('NEEDS_REVIEW');
    expect(JSON.parse(stored.metadata ?? '{}').voice.transcribed).toBe(false);
    expect(await ctx.db.task.count()).toBe(0);
    expect(fake.callsTo('getFile')).toHaveLength(0);
    expect(fake.sent[0]).toMatch(/Transcription is not configured/i);
  });

  it('tells the owner the audio was not transcribed when only a caption was classified', async () => {
    const { ctx, adapter, fake } = setup({ stt: null });

    await adapter.handleUpdate(
      voiceMessage({
        voice: { file_id: 'voice-9', duration: 6, mime_type: 'audio/ogg' },
        caption: 'remind me to call Ada tomorrow',
      }),
    );

    const stored = await ctx.db.capture.findFirstOrThrow();
    expect(stored.transcript).toBeNull();
    expect((await getCapture(ctx.db, stored.id)).isVoice).toBe(true);
    expect(await ctx.db.task.count()).toBe(1);
    expect(fake.sent[0]).toMatch(/Not configured|not configured/i);
    expect(fake.sent[0]).toMatch(/organised your caption/i);
  });

  it('stores the message when the provider fails', async () => {
    const transcriber = fakeTranscriber({ error: new Error('provider exploded') });
    const { ctx, adapter, fake } = setup({ stt: transcriber, files: audioFiles() });

    const result = await adapter.handleUpdate(voiceMessage());

    expect(result.handled).toBe(true);
    const stored = await ctx.db.capture.findFirstOrThrow();
    expect(stored.rawText).toBe(VOICE_PLACEHOLDER);
    expect(stored.transcript).toBeNull();
    expect(stored.status).toBe('NEEDS_REVIEW');
    expect(await ctx.db.task.count()).toBe(0);
    expect(fake.sent[0]).toMatch(/could not transcribe/i);
    expect(transcriber.calls).toHaveLength(1);
  });

  it('classifies the caption when transcription fails but a caption exists', async () => {
    const transcriber = fakeTranscriber({ error: new Error('provider exploded') });
    const { ctx, adapter, fake } = setup({ stt: transcriber, files: audioFiles() });

    await adapter.handleUpdate(
      voiceMessage({
        voice: { file_id: 'voice-9', duration: 6, mime_type: 'audio/ogg' },
        caption: 'remind me to call Ada tomorrow',
      }),
    );

    const stored = await ctx.db.capture.findFirstOrThrow();
    expect(stored.rawText).toBe('remind me to call Ada tomorrow');
    expect(stored.transcript).toBeNull();
    expect(await ctx.db.task.count()).toBe(1);
    expect(fake.sent[0]).toMatch(/organised your caption/i);
  });

  it('treats an empty transcript as a failure and keeps the capture', async () => {
    const transcriber = fakeTranscriber({ text: '   ' });
    const { ctx, adapter, fake } = setup({ stt: transcriber, files: audioFiles() });

    await adapter.handleUpdate(voiceMessage());

    const stored = await ctx.db.capture.findFirstOrThrow();
    expect(stored.transcript).toBeNull();
    expect(stored.status).toBe('NEEDS_REVIEW');
    expect(fake.sent[0]).toMatch(/no words/i);
  });

  it('refuses a clip longer than the configured limit without downloading it', async () => {
    const transcriber = fakeTranscriber();
    const { ctx, adapter, fake } = setup({ stt: transcriber, files: audioFiles() });

    await adapter.handleUpdate(
      voiceMessage({ voice: { file_id: 'voice-9', duration: 600, mime_type: 'audio/ogg' } }),
    );

    expect(transcriber.calls).toHaveLength(0);
    expect(fake.callsTo('getFile')).toHaveLength(0);
    expect((await ctx.db.capture.findFirstOrThrow()).status).toBe('NEEDS_REVIEW');
    expect(fake.sent[0]).toMatch(/longer than the configured transcription limit/i);
  });

  it('refuses an unsupported audio format before downloading it', async () => {
    const transcriber = fakeTranscriber();
    const { ctx, adapter, fake } = setup({
      stt: transcriber,
      files: { 'voice-9': { path: 'voice/file_9.amr', bytes: AUDIO } },
    });

    await adapter.handleUpdate(
      voiceMessage({ voice: { file_id: 'voice-9', duration: 6, mime_type: 'audio/amr' } }),
    );

    expect(transcriber.calls).toHaveLength(0);
    expect(fake.callsTo('getFile')).toHaveLength(0);
    expect((await ctx.db.capture.findFirstOrThrow()).status).toBe('NEEDS_REVIEW');
    expect(fake.sent[0]).toMatch(/format is not supported/i);
  });

  it('refuses a download larger than the byte cap', async () => {
    const transcriber = fakeTranscriber();
    const { ctx, adapter, fake } = setup({
      stt: transcriber,
      overrides: { STT_MAX_AUDIO_BYTES: '1024' },
      files: { 'voice-9': { path: 'voice/file_9.oga', bytes: new Uint8Array(4096) } },
    });

    await adapter.handleUpdate(voiceMessage());

    expect(transcriber.calls).toHaveLength(0);
    expect((await ctx.db.capture.findFirstOrThrow()).transcript).toBeNull();
    expect(fake.sent[0]).toMatch(/could not transcribe/i);
  });
});

describe('oversized transcripts', () => {
  const OVERSIZED = 'x'.repeat(9_000);

  it('rejects the transcript but keeps a voice-only capture', async () => {
    const transcriber = fakeTranscriber({ text: OVERSIZED });
    const { ctx, adapter, fake } = setup({ stt: transcriber, files: audioFiles() });

    const result = await adapter.handleUpdate(voiceMessage());

    expect(result.handled).toBe(true);
    const stored = await ctx.db.capture.findFirstOrThrow();
    expect(stored.rawText).toBe(VOICE_PLACEHOLDER);
    expect(stored.transcript).toBeNull();
    expect(stored.transcriptSource).toBeNull();
    expect(stored.status).toBe('NEEDS_REVIEW');
    expect(JSON.parse(stored.metadata ?? '{}').voice).toMatchObject({
      transcribed: false,
      transcriptSource: null,
      sttProvider: 'fake-stt',
      sttModel: 'fake-whisper',
      status: 'transcript-too-long',
    });
    expect(await ctx.db.task.count()).toBe(0);
    expect(fake.sent[0]).toMatch(/8,000-character limit/i);
    expect(fake.sent[0]).toMatch(/not transcribed/i);
    expect(fake.sent[0]).not.toMatch(/Transcribed:/);
  });

  it('keeps the caption and classifies it when the transcript is too long', async () => {
    const transcriber = fakeTranscriber({ text: OVERSIZED });
    const { ctx, adapter, fake } = setup({ stt: transcriber, files: audioFiles() });

    await adapter.handleUpdate(
      voiceMessage({
        caption: 'remind me to call Ada tomorrow',
        voice: { file_id: 'voice-9', duration: 8, mime_type: 'audio/ogg' },
      }),
    );

    const stored = await ctx.db.capture.findFirstOrThrow();
    expect(stored.rawText).toBe('remind me to call Ada tomorrow');
    expect(stored.transcript).toBeNull();
    expect(stored.transcriptSource).toBeNull();
    expect(JSON.parse(stored.metadata ?? '{}').voice.status).toBe('transcript-too-long');
    expect(await ctx.db.task.count()).toBe(1);
    expect(fake.sent[0]).toMatch(/8,000-character limit/i);
    expect(fake.sent[0]).toMatch(/organised your caption/i);
    expect(fake.sent[0]).not.toMatch(/Transcribed:/);
  });

  it('persists the capture through the webhook path and handles a retry idempotently', async () => {
    const transcriber = fakeTranscriber({ text: OVERSIZED });
    const { ctx, adapter } = setup({
      stt: transcriber,
      files: audioFiles(),
      overrides: { TELEGRAM_WEBHOOK_SECRET: 'secret-abc' },
    });
    const update = voiceMessage({ messageId: 17 });

    const first = await adapter.handleWebhook({ secretHeader: 'secret-abc', body: update });
    expect(first.status).toBe(200);
    const stored = await ctx.db.capture.findFirstOrThrow();
    expect(stored.transcript).toBeNull();
    expect(stored.status).toBe('NEEDS_REVIEW');
    expect(await ctx.db.capture.count()).toBe(1);

    const retry = await adapter.handleWebhook({ secretHeader: 'secret-abc', body: update });
    expect(retry.status).toBe(200);
    expect(await ctx.db.capture.count()).toBe(1);
    expect(transcriber.calls).toHaveLength(1);
  });

  it('persists the capture through polling and advances past the update safely', async () => {
    const transcriber = fakeTranscriber({ text: OVERSIZED });
    const update = voiceMessage({ messageId: 18 });
    const offsets: (number | undefined)[] = [];
    let polls = 0;
    let controller!: PollingController;

    const { ctx, adapter, client } = setup({
      stt: transcriber,
      files: audioFiles(),
      onCall: (method, payload) => {
        if (method !== 'getUpdates') return undefined;
        polls += 1;
        offsets.push(payload.offset as number | undefined);
        if (polls === 1) {
          return { status: 200, body: { ok: true, result: [update] } };
        }
        controller.stop();
        return { status: 200, body: { ok: true, result: [] } };
      },
    });

    controller = startTelegramPolling(ctx, client, adapter, { sleep: async () => undefined });
    await controller.done;

    expect(polls).toBe(2);
    expect(offsets).toEqual([undefined, 182]);
    expect(controller.currentOffset()).toBe(182);
    expect(await ctx.db.capture.count()).toBe(1);
    expect((await ctx.db.capture.findFirstOrThrow()).transcript).toBeNull();
    expect(transcriber.calls).toHaveLength(1);

    // A later at-least-once redelivery must be answered as a duplicate, not
    // re-transcribed. The transcript being absent must not make it replayable.
    const replay = await adapter.handleUpdate(update);
    expect(replay.duplicate).toBe(true);
    expect(await ctx.db.capture.count()).toBe(1);
    expect(transcriber.calls).toHaveLength(1);
  });
});

describe('reprocessing an untranscribed voice capture', () => {
  it('keeps it in review without calling the classifier or creating records', async () => {
    const ai = fakeAiProvider({
      classification: sampleClassification({ title: 'Ghost task from placeholder' }),
    });
    const { ctx, adapter } = setup({ stt: null, ai });

    await adapter.handleUpdate(voiceMessage());
    const stored = await ctx.db.capture.findFirstOrThrow();
    expect(stored.transcript).toBeNull();
    expect(stored.status).toBe('NEEDS_REVIEW');
    expect(ai.calls).toHaveLength(0);

    const outcome = await reprocessCapture(ctx, stored.id);

    expect(ai.calls).toHaveLength(0);
    expect(outcome.classification).toBeNull();
    expect(outcome.provider).toBeNull();
    expect(outcome.created).toEqual([]);
    expect(outcome.needsReview).toBe(true);
    expect(outcome.clarification).toMatch(/no transcript/i);
    expect(await ctx.db.task.count()).toBe(0);
    expect(await ctx.db.note.count()).toBe(0);
    expect(await ctx.db.idea.count()).toBe(0);
    expect(await ctx.db.event.count()).toBe(0);
    expect(await ctx.db.reminder.count()).toBe(0);

    const refreshed = await ctx.db.capture.findUniqueOrThrow({ where: { id: stored.id } });
    expect(refreshed.status).toBe('NEEDS_REVIEW');
    expect(refreshed.needsReview).toBe(true);
    expect(refreshed.classificationRationale).toMatch(/nothing to classify/i);
  });
});

describe('stored transcript classification', () => {
  it('classifies a transcript even when the caller sends no composite text', async () => {
    const { ctx } = setup({ stt: null });

    const outcome = await ingestCapture(ctx, {
      rawText: VOICE_PLACEHOLDER,
      source: 'TELEGRAM',
      transcript: 'remind me to call the plumber tomorrow',
      transcriptSource: 'SPEECH_PROVIDER',
    });

    expect(outcome.capture.transcript).toBe('remind me to call the plumber tomorrow');
    expect(outcome.capture.transcriptSource).toBe('SPEECH_PROVIDER');
    expect(await ctx.db.task.count()).toBe(1);
    expect((await ctx.db.task.findFirstOrThrow()).title).toMatch(/plumber/i);
  });

  it('rejects a transcript that declares no provenance', async () => {
    const { ctx } = setup({ stt: null });
    await expect(
      ingestCapture(ctx, {
        rawText: 'hello',
        source: 'WEB',
        transcript: 'hello there',
      }),
    ).rejects.toThrow(/Invalid capture/i);
  });
});

describe('audio retention', () => {
  async function tempDir(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), 'recall-audio-'));
  }

  async function retainedFile(dir: string, captureId: string): Promise<string> {
    return path.join(dir, `${captureId}.ogg`);
  }

  it('does not write audio to disk by default', async () => {
    const dir = await tempDir();
    const transcriber = fakeTranscriber();
    const { ctx, adapter } = setup({
      stt: transcriber,
      overrides: { STT_AUDIO_DIR: dir },
      files: audioFiles(),
    });

    await adapter.handleUpdate(voiceMessage());

    const stored = await ctx.db.capture.findFirstOrThrow();
    expect(stored.mediaRef).toBeNull();
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('retains audio and records a reference only when explicitly enabled', async () => {
    const dir = await tempDir();
    const transcriber = fakeTranscriber();
    const { ctx, adapter } = setup({
      stt: transcriber,
      overrides: { STT_RETAIN_AUDIO: 'true', STT_AUDIO_DIR: dir },
      files: audioFiles(),
    });

    await adapter.handleUpdate(voiceMessage());

    const stored = await ctx.db.capture.findFirstOrThrow();
    expect(stored.mediaRef).toBeTruthy();
    expect(await fs.readFile(path.join(dir, `${stored.id}.ogg`))).toEqual(Buffer.from(AUDIO));
  });

  it('deletes retained audio on permanent purge', async () => {
    const dir = await tempDir();
    const { ctx, adapter } = setup({
      stt: fakeTranscriber(),
      overrides: { STT_RETAIN_AUDIO: 'true', STT_AUDIO_DIR: dir },
      files: audioFiles(),
    });
    await adapter.handleUpdate(voiceMessage());
    const stored = await ctx.db.capture.findFirstOrThrow();
    const file = await retainedFile(dir, stored.id);
    expect(await fs.stat(file)).toBeTruthy();

    await purgeCapture(ctx, stored.id);

    expect(await ctx.db.capture.count()).toBe(0);
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('treats an already-missing retained file as a successful purge', async () => {
    const dir = await tempDir();
    const { ctx, adapter } = setup({
      stt: fakeTranscriber(),
      overrides: { STT_RETAIN_AUDIO: 'true', STT_AUDIO_DIR: dir },
      files: audioFiles(),
    });
    await adapter.handleUpdate(voiceMessage());
    const stored = await ctx.db.capture.findFirstOrThrow();
    const file = await retainedFile(dir, stored.id);
    await fs.unlink(file);

    await expect(purgeCapture(ctx, stored.id)).resolves.toMatchObject({
      captureId: stored.id,
    });
    expect(await ctx.db.capture.count()).toBe(0);
  });

  it('purges a capture with no retained audio as a no-op', async () => {
    const dir = await tempDir();
    const { ctx, adapter } = setup({
      stt: fakeTranscriber(),
      overrides: { STT_RETAIN_AUDIO: 'false', STT_AUDIO_DIR: dir },
      files: audioFiles(),
    });
    await adapter.handleUpdate(voiceMessage());
    const stored = await ctx.db.capture.findFirstOrThrow();
    expect(stored.mediaRef).toBeNull();

    await expect(purgeCapture(ctx, stored.id)).resolves.toMatchObject({
      captureId: stored.id,
    });
    expect(await ctx.db.capture.count()).toBe(0);
  });

  it('keeps retained audio on undo and removes it only on permanent purge', async () => {
    const dir = await tempDir();
    const { ctx, adapter } = setup({
      stt: fakeTranscriber(),
      overrides: { STT_RETAIN_AUDIO: 'true', STT_AUDIO_DIR: dir },
      files: audioFiles(),
    });
    await adapter.handleUpdate(voiceMessage());
    const stored = await ctx.db.capture.findFirstOrThrow();
    const file = await retainedFile(dir, stored.id);

    await undoCapture(ctx, stored.id, { force: true });

    const undone = await ctx.db.capture.findUniqueOrThrow({ where: { id: stored.id } });
    expect(undone.deletedAt).not.toBeNull();
    expect(undone.mediaRef).toBe(stored.mediaRef);
    expect(await fs.stat(file)).toBeTruthy();

    await purgeCapture(ctx, stored.id);

    expect(await ctx.db.capture.count()).toBe(0);
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses to delete an absolute path outside STT_AUDIO_DIR', async () => {
    const dir = await tempDir();
    const outsideDir = await tempDir();
    const { ctx, adapter } = setup({
      stt: fakeTranscriber(),
      overrides: { STT_RETAIN_AUDIO: 'false', STT_AUDIO_DIR: dir },
      files: audioFiles(),
    });
    await adapter.handleUpdate(voiceMessage());
    const stored = await ctx.db.capture.findFirstOrThrow();
    const outside = path.join(outsideDir, 'not-ours.ogg');
    await fs.writeFile(outside, 'secret');
    await ctx.db.capture.update({ where: { id: stored.id }, data: { mediaRef: outside } });

    await expect(purgeCapture(ctx, stored.id)).rejects.toThrow(/outside/i);

    expect(await fs.readFile(outside, 'utf8')).toBe('secret');
    expect(await ctx.db.capture.count()).toBe(1);
  });

  it('rejects a traversal path without touching the target', async () => {
    const dir = await tempDir();
    const outsideDir = await tempDir();
    const { ctx, adapter } = setup({
      stt: fakeTranscriber(),
      overrides: { STT_RETAIN_AUDIO: 'false', STT_AUDIO_DIR: dir },
      files: audioFiles(),
    });
    await adapter.handleUpdate(voiceMessage());
    const stored = await ctx.db.capture.findFirstOrThrow();
    const outside = path.join(outsideDir, 'not-ours.ogg');
    await fs.writeFile(outside, 'secret');
    const traversal = path.join(dir, '..', path.basename(outsideDir), 'not-ours.ogg');
    await ctx.db.capture.update({ where: { id: stored.id }, data: { mediaRef: traversal } });

    await expect(purgeCapture(ctx, stored.id)).rejects.toThrow(/outside/i);

    expect(await fs.readFile(outside, 'utf8')).toBe('secret');
    expect(await ctx.db.capture.count()).toBe(1);
  });

  it('rolls the purge back when unlink fails for a reason other than ENOENT', async () => {
    const dir = await tempDir();
    const { ctx, adapter } = setup({
      stt: fakeTranscriber(),
      overrides: { STT_RETAIN_AUDIO: 'true', STT_AUDIO_DIR: dir },
      files: audioFiles(),
    });
    await adapter.handleUpdate(voiceMessage());
    const stored = await ctx.db.capture.findFirstOrThrow();
    const pathAsDirectory = await retainedFile(dir, stored.id);

    // Make the mediaRef point at a directory. unlink must fail (EPERM/EISDIR)
    // instead of deleting the directory or purging the capture.
    await fs.unlink(pathAsDirectory);
    await fs.mkdir(pathAsDirectory);

    await expect(purgeCapture(ctx, stored.id)).rejects.toThrow();

    expect(await ctx.db.capture.count()).toBe(1);
    expect((await fs.stat(pathAsDirectory)).isDirectory()).toBe(true);
  });
});
