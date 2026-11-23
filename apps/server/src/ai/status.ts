/**
 * AI provider status for the health report.
 *
 * Records when the provider last answered successfully and when it last failed,
 * with a short machine-readable failure CODE only. Never a message, never
 * request or response content, never a credential: a provider error can echo
 * parts of a request, so nothing from it is stored except a code derived here.
 *
 * Kept in memory (no migration): it resets when the process restarts, which is
 * stated in the health contract.
 */
import { ProviderError } from '../lib/errors.js';
import type { AiAnswer, AiProvider, AnswerRequest, ClassificationRequest } from './types.js';
import type { Classification } from '@recall/shared';

export interface AiStatusSnapshot {
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  /** e.g. "http_429", "timeout", "refused", "max_tokens", "invalid_output". */
  lastFailureCode: string | null;
}

export interface AiStatus {
  recordSuccess(at: Date): void;
  recordFailure(error: unknown, at: Date): void;
  snapshot(): AiStatusSnapshot;
}

const SAFE_CODE = /^[a-z0-9_]{1,40}$/;

/** A short code describing a failure; only fixed vocabulary or HTTP status numbers. */
export function failureCode(error: unknown): string {
  if (error instanceof ProviderError) {
    const details = (error.details ?? {}) as { reason?: unknown; status?: unknown };
    if (typeof details.status === 'number' && Number.isInteger(details.status)) return `http_${details.status}`;
    if (typeof details.reason === 'string') {
      const code = details.reason.toLowerCase().replace(/[^a-z0-9]+/g, '_');
      if (SAFE_CODE.test(code)) return code;
    }
    return 'provider_error';
  }
  return 'unexpected_error';
}

export function createAiStatus(): AiStatus {
  let lastSuccessAt: string | null = null;
  let lastFailureAt: string | null = null;
  let lastFailureCode: string | null = null;
  return {
    recordSuccess(at) {
      lastSuccessAt = at.toISOString();
    },
    recordFailure(error, at) {
      lastFailureAt = at.toISOString();
      lastFailureCode = failureCode(error);
    },
    snapshot: () => ({ lastSuccessAt, lastFailureAt, lastFailureCode }),
  };
}

/**
 * Wraps a provider so every call updates the status. Behaviour is otherwise
 * unchanged: results and errors pass through untouched.
 */
export function withAiStatus(provider: AiProvider, status: AiStatus, now: () => Date): AiProvider {
  async function track<T>(call: () => Promise<T>): Promise<T> {
    try {
      const result = await call();
      status.recordSuccess(now());
      return result;
    } catch (error) {
      status.recordFailure(error, now());
      throw error;
    }
  }
  return {
    get name() {
      return provider.name;
    },
    get model() {
      return provider.model;
    },
    classify: (request: ClassificationRequest): Promise<Classification> => track(() => provider.classify(request)),
    answer: (request: AnswerRequest): Promise<AiAnswer> => track(() => provider.answer(request)),
  };
}
