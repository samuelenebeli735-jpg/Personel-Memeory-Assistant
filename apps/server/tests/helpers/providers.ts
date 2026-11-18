/**
 * Provider doubles used by tests.
 *
 * Every test that touches AI or speech-to-text uses one of these: the suite must
 * never make a live provider call, and a fake makes the exact call count and the
 * exact payload observable.
 */
import type { Classification } from '@recall/shared';

import type {
  AiProvider,
  AnswerRequest,
  ClassificationRequest,
} from '../../src/ai/types.js';
import type { Transcriber, TranscriptionRequest, TranscriptionResult } from '../../src/stt/types.js';

/* -------------------------------------------------------------------------- */
/* AI                                                                          */
/* -------------------------------------------------------------------------- */

export interface FakeAiProvider extends AiProvider {
  /** Every classification request, in order. */
  calls: ClassificationRequest[];
  /** Every answer request, in order. */
  answerCalls: AnswerRequest[];
  /** Makes the next calls fail instead of returning `result`. */
  failWith(error: Error | null): void;
  /** Replaces the classification returned on success. */
  setResult(classification: Classification): void;
  /** Replaces the answer returned on success. */
  setAnswer(answer: { answer: string; citedIds: string[] }): void;
  /** Makes `answer()` fail instead of returning the configured answer. */
  failAnswerWith(error: Error | null): void;
}

/** A well-formed classification a fake provider can return. */
export function sampleClassification(overrides: Partial<Classification> = {}): Classification {
  return {
    kind: 'TASK',
    title: 'Review the budget',
    description: null,
    category: null,
    tags: [],
    priority: null,
    dueAt: null,
    remindAt: null,
    projectName: null,
    confidence: 0.8,
    needsReview: false,
    rationale: 'fake provider',
    ...overrides,
  };
}

export function fakeAiProvider(initial: {
  classification?: Classification;
  error?: Error;
  name?: string;
  model?: string | null;
  answer?: { answer: string; citedIds: string[] };
  answerError?: Error;
} = {}): FakeAiProvider {
  let result = initial.classification ?? sampleClassification();
  let failure = initial.error ?? null;
  let answerResult = initial.answer ?? { answer: '', citedIds: [] };
  let answerFailure = initial.answerError ?? null;
  const provider: FakeAiProvider = {
    name: initial.name ?? 'fake-ai',
    model: initial.model === undefined ? 'fake-model' : initial.model,
    calls: [],
    answerCalls: [],
    failWith(error) {
      failure = error;
    },
    setResult(classification) {
      result = classification;
    },
    setAnswer(answer) {
      answerResult = answer;
    },
    failAnswerWith(error) {
      answerFailure = error;
    },
    async classify(request: ClassificationRequest): Promise<Classification> {
      provider.calls.push(request);
      if (failure) throw failure;
      return result;
    },
    async answer(request: AnswerRequest) {
      provider.answerCalls.push(request);
      if (answerFailure) throw answerFailure;
      return answerResult;
    },
  };
  return provider;
}

/* -------------------------------------------------------------------------- */
/* Speech-to-text                                                              */
/* -------------------------------------------------------------------------- */

export interface FakeTranscriber extends Transcriber {
  /** Every transcription request, in order. */
  calls: TranscriptionRequest[];
  failWith(error: Error | null): void;
  setResult(result: TranscriptionResult | null): void;
}

export function fakeTranscriber(initial: {
  text?: string;
  error?: Error;
  name?: string;
  model?: string | null;
  /** Awaited after the call is recorded, before a result is returned. */
  beforeResult?: (request: TranscriptionRequest) => Promise<void>;
} = {}): FakeTranscriber {
  let result: TranscriptionResult | null =
    initial.error !== undefined
      ? null
      : {
          text: initial.text ?? 'remind me to call the plumber tomorrow at ten',
          provider: initial.name ?? 'fake-stt',
          model: (initial.model === undefined ? 'fake-whisper' : initial.model) ?? 'fake-whisper',
        };
  let failure = initial.error ?? null;
  const transcriber: FakeTranscriber = {
    name: initial.name ?? 'fake-stt',
    model: initial.model === undefined ? 'fake-whisper' : initial.model,
    calls: [],
    failWith(error) {
      failure = error;
    },
    setResult(next) {
      result = next;
    },
    async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
      transcriber.calls.push(request);
      if (initial.beforeResult) await initial.beforeResult(request);
      if (failure) throw failure;
      if (!result) throw new Error('fake transcriber has no result');
      return { ...result, durationSeconds: request.durationSeconds };
    },
  };
  return transcriber;
}
