/**
 * AI provider transport (R1-04).
 *
 * Every request goes to an injected fetch double: no real provider is ever
 * contacted and no real personal data leaves the test. The Anthropic provider
 * runs through the official SDK; these tests pin what reaches the wire (URL,
 * headers, body), how replies and errors are interpreted, and the privacy
 * guard at the provider boundary.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  ANSWER_MAX_TOKENS,
  AnthropicProvider,
  CLASSIFY_MAX_TOKENS,
  OpenAiCompatibleProvider,
  anthropicBaseUrl,
  type ChatProviderOptions,
} from '../../src/ai/chat-providers.js';
import { DEFAULT_AI_BASE_URLS, resolveAiProvider, resolveBaseUrl } from '../../src/ai/index.js';
import { createAiStatus, failureCode, withAiStatus } from '../../src/ai/status.js';
import type { AiProvider, ClassificationRequest } from '../../src/ai/types.js';
import { ProviderError } from '../../src/lib/errors.js';
import { testConfig, testLogger } from '../helpers/app.js';

interface Sent {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

type Reply = Response | (() => Response) | Error;

/** A fetch double that records requests and plays back scripted replies. */
function scriptedFetch(replies: Reply[]) {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(input instanceof Request ? input.url : input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    const reply = replies[Math.min(sent.length - 1, replies.length - 1)]!;
    if (reply instanceof Error) throw reply;
    return typeof reply === 'function' ? reply() : reply.clone();
  }) as typeof fetch;
  return { sent, fetchImpl };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A Messages API reply (documented shape). */
function anthropicReply(text: string, stopReason = 'end_turn', extraBlocks: unknown[] = []): Response {
  return json(200, {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    content: [...extraBlocks, { type: 'text', text }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

const CLASSIFICATION = JSON.stringify({
  kind: 'TASK',
  title: 'Call the plumber',
  description: null,
  category: null,
  tags: [],
  priority: null,
  dueAt: null,
  remindAt: null,
  projectName: null,
  confidence: 0.9,
  needsReview: false,
  rationale: null,
});

const REQUEST: ClassificationRequest = {
  text: 'call the plumber',
  capturedAt: new Date('2026-10-17T10:00:00.000Z'),
  referenceNow: new Date('2026-10-17T10:00:00.000Z'),
  timeZone: 'Africa/Lagos',
  morningDefaultTime: '09:00',
  eveningDefaultTime: '19:00',
};

function options(fetchImpl: typeof fetch, overrides: Partial<ChatProviderOptions> = {}): ChatProviderOptions {
  return {
    apiKey: 'not-a-real-key',
    model: 'claude-test-model',
    baseUrl: 'https://api.anthropic.com',
    timeoutMs: 2_000,
    maxRetries: 2,
    allowRawText: true,
    fetchImpl,
    sleep: async () => {},
    ...overrides,
  };
}

async function failure(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderError);
    return error as ProviderError;
  }
  throw new Error('expected a ProviderError');
}

describe('Anthropic provider (official SDK)', () => {
  afterEach(() => {
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_API_KEY;
  });

  for (const base of [
    'https://api.anthropic.com',
    'https://api.anthropic.com/',
    'https://api.anthropic.com/v1',
    'https://api.anthropic.com/v1/',
  ]) {
    it(`posts to /v1/messages exactly once for base "${base}"`, async () => {
      const { sent, fetchImpl } = scriptedFetch([anthropicReply(CLASSIFICATION)]);
      await new AnthropicProvider(options(fetchImpl, { baseUrl: base })).classify(REQUEST);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    });
  }

  it('normalises a gateway base the same way', () => {
    expect(anthropicBaseUrl('https://gateway.example/anthropic/v1/')).toBe('https://gateway.example/anthropic');
  });

  it('sends the current API version, a bearer key, and no sampling parameters', async () => {
    const { sent, fetchImpl } = scriptedFetch([anthropicReply(CLASSIFICATION)]);
    await new AnthropicProvider(options(fetchImpl)).classify(REQUEST);
    const { headers, body } = sent[0]!;
    expect(headers.get('anthropic-version')).toBe('2026-10-21');
    expect(headers.get('authorization')).toBe('Bearer not-a-real-key');
    expect(body.model).toBe('claude-test-model');
    expect(body.max_tokens).toBe(CLASSIFY_MAX_TOKENS);
    expect(typeof body.system).toBe('string');
    expect(body.messages).toEqual([{ role: 'user', content: expect.stringContaining('call the plumber') }]);
    // The 2026-10-21 API rejects these on every model.
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
    expect(body).not.toHaveProperty('top_k');
  });

  it('ignores ANTHROPIC_* environment variables (explicit configuration only)', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://elsewhere.example';
    process.env.ANTHROPIC_API_KEY = 'env-key';
    const { sent, fetchImpl } = scriptedFetch([anthropicReply(CLASSIFICATION)]);
    await new AnthropicProvider(options(fetchImpl)).classify(REQUEST);
    expect(sent[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(sent[0]!.headers.get('authorization')).toBe('Bearer not-a-real-key');
  });

  it('reads only text blocks, skipping thinking blocks', async () => {
    const { fetchImpl } = scriptedFetch([
      anthropicReply(CLASSIFICATION, 'end_turn', [{ type: 'thinking', thinking: '', signature: 'sig' }]),
    ]);
    const result = await new AnthropicProvider(options(fetchImpl)).classify(REQUEST);
    expect(result.kind).toBe('TASK');
    expect(result.title).toBe('Call the plumber');
  });

  it('answers with the answer token ceiling and keeps only supplied citations', async () => {
    const { sent, fetchImpl } = scriptedFetch([
      anthropicReply(JSON.stringify({ answer: 'The plumber is booked.', citedIds: ['t1', 'invented'] })),
    ]);
    const result = await new AnthropicProvider(options(fetchImpl)).answer({
      question: 'plumber?',
      timeZone: 'UTC',
      referenceNow: new Date('2026-10-17T10:00:00.000Z'),
      evidence: [{ type: 'TASK', id: 't1', title: 'Call the plumber', snippet: 'booked', timestamp: '2026-10-17T09:00:00.000Z' }],
    });
    expect(sent[0]!.body.max_tokens).toBe(ANSWER_MAX_TOKENS);
    expect(result).toEqual({ answer: 'The plumber is booked.', citedIds: ['t1'] });
  });

  it('reports a refusal once, without retrying', async () => {
    const { sent, fetchImpl } = scriptedFetch([anthropicReply('', 'refusal')]);
    const error = await failure(new AnthropicProvider(options(fetchImpl)).classify(REQUEST));
    expect(error.retryable).toBe(false);
    expect(failureCode(error)).toBe('refused');
    expect(sent).toHaveLength(1);
  });

  for (const stop of ['max_tokens', 'model_context_window_exceeded']) {
    it(`reports a "${stop}" cut-off once, without retrying`, async () => {
      const { sent, fetchImpl } = scriptedFetch([anthropicReply('{"kind":', stop)]);
      const error = await failure(new AnthropicProvider(options(fetchImpl)).classify(REQUEST));
      expect(failureCode(error)).toBe('max_tokens');
      expect(sent).toHaveLength(1);
    });
  }

  it('does not retry a 400 (bad request, e.g. unknown model)', async () => {
    const { sent, fetchImpl } = scriptedFetch([
      json(400, { type: 'error', error: { type: 'invalid_request_error', message: 'model: not found' } }),
    ]);
    const error = await failure(new AnthropicProvider(options(fetchImpl)).classify(REQUEST));
    expect(error.retryable).toBe(false);
    expect(failureCode(error)).toBe('http_400');
    // The provider's own message is not copied into the error.
    expect(error.message).not.toContain('not found');
    expect(sent).toHaveLength(1);
  });

  it('retries 429 and 529 (overloaded), then succeeds', async () => {
    const { sent, fetchImpl } = scriptedFetch([
      json(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }),
      json(529, { type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } }),
      anthropicReply(CLASSIFICATION),
    ]);
    const result = await new AnthropicProvider(options(fetchImpl)).classify(REQUEST);
    expect(result.kind).toBe('TASK');
    expect(sent).toHaveLength(3);
  });

  it('retries a network failure within the configured attempts, then reports it', async () => {
    const { sent, fetchImpl } = scriptedFetch([new TypeError('fetch failed')]);
    const error = await failure(new AnthropicProvider(options(fetchImpl, { maxRetries: 1 })).classify(REQUEST));
    expect(failureCode(error)).toBe('network');
    expect(sent).toHaveLength(2);
  });

  it('times out a request that never answers', async () => {
    const hanging = (async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as typeof fetch;
    const error = await failure(
      new AnthropicProvider(options(hanging, { timeoutMs: 50, maxRetries: 0 })).classify(REQUEST),
    );
    expect(failureCode(error)).toBe('timeout');
  });

  it('refuses to send personal text when AI_ALLOW_RAW_TEXT is off (no request made)', async () => {
    const { sent, fetchImpl } = scriptedFetch([anthropicReply(CLASSIFICATION)]);
    const provider = new AnthropicProvider(options(fetchImpl, { allowRawText: false }));
    expect(failureCode(await failure(provider.classify(REQUEST)))).toBe('raw_text_disabled');
    expect(
      failureCode(
        await failure(
          provider.answer({ question: 'q', timeZone: 'UTC', referenceNow: new Date(), evidence: [] }),
        ),
      ),
    ).toBe('raw_text_disabled');
    expect(sent).toHaveLength(0);
  });
});

describe('OpenAI-compatible provider', () => {
  function openAiReply(content: string, finishReason = 'stop') {
    return json(200, { choices: [{ message: { content }, finish_reason: finishReason }] });
  }

  it('posts to <base>/chat/completions with or without a trailing slash', async () => {
    for (const base of ['https://provider.test/v1', 'https://provider.test/v1/']) {
      const { sent, fetchImpl } = scriptedFetch([openAiReply(CLASSIFICATION)]);
      await new OpenAiCompatibleProvider(options(fetchImpl, { baseUrl: base })).classify(REQUEST);
      expect(sent[0]!.url).toBe('https://provider.test/v1/chat/completions');
    }
  });

  it('reports a length cut-off and a content filter once, without retrying', async () => {
    for (const [finish, code] of [['length', 'max_tokens'], ['content_filter', 'refused']] as const) {
      const { sent, fetchImpl } = scriptedFetch([openAiReply('{"kind":', finish)]);
      const error = await failure(new OpenAiCompatibleProvider(options(fetchImpl)).classify(REQUEST));
      expect(failureCode(error)).toBe(code);
      expect(sent).toHaveLength(1);
    }
  });

  it('also refuses personal text when AI_ALLOW_RAW_TEXT is off', async () => {
    const { sent, fetchImpl } = scriptedFetch([openAiReply(CLASSIFICATION)]);
    const provider = new OpenAiCompatibleProvider(options(fetchImpl, { allowRawText: false }));
    expect(failureCode(await failure(provider.classify(REQUEST)))).toBe('raw_text_disabled');
    expect(sent).toHaveLength(0);
  });
});

/**
 * Gemini through its OpenAI-compatible endpoint (R4-03 preparation).
 *
 * Google documents the base URL https://generativelanguage.googleapis.com/v1beta/openai/
 * with a Bearer key and POST .../chat/completions. These tests pin that Recall's
 * `openai-compatible` provider builds exactly that request from the documented
 * configuration. They do NOT prove that Gemini accepts every field Recall sends
 * (`temperature`, `max_tokens`, `response_format: json_object`): the docs do not
 * say, and only a supervised live call can confirm it (see OPERATIONS, "Gemini").
 */
describe('Gemini via the OpenAI-compatible provider (request shape only)', () => {
  const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai/';
  const env = {
    AI_PROVIDER: 'openai-compatible',
    AI_API_KEY: 'gm-test-abcdefghijklmnop',
    AI_MODEL: 'gemini-test-model',
    AI_BASE_URL: GEMINI_BASE,
  };

  it('the documented Gemini base URL is accepted by configuration, also in production', () => {
    expect(testConfig(env).ai.baseUrl).toBe(GEMINI_BASE);
    // Production also demands HTTPS cookies and strong secrets; supply them so the
    // only thing under test is the provider URL rule (https, no credentials).
    const production = {
      ...env,
      NODE_ENV: 'production',
      COOKIE_SECURE: 'true',
      DASHBOARD_PASSWORD: 'a-long-production-test-password-1234',
      SESSION_SECRET: 'q7Lx2Vn9Rk4Tp1Wz8Hc6Jm3Bs5Df0Ga2YeU', // test-only value
    };
    expect(testConfig(production as never).ai.baseUrl).toBe(GEMINI_BASE);
  });

  it('the factory builds the OpenAI-compatible provider pointed at Gemini', () => {
    const provider = resolveAiProvider(testConfig(env), testLogger());
    expect(provider).toBeInstanceOf(OpenAiCompatibleProvider);
    expect(provider?.model).toBe('gemini-test-model');
  });

  it('posts one request to .../v1beta/openai/chat/completions with a Bearer key and the JSON-mode body', async () => {
    const { sent, fetchImpl } = scriptedFetch([
      json(200, { choices: [{ message: { role: 'assistant', content: CLASSIFICATION }, finish_reason: 'stop' }] }),
    ]);
    const provider = new OpenAiCompatibleProvider(
      options(fetchImpl, { baseUrl: GEMINI_BASE, model: 'gemini-test-model', apiKey: 'gm-test-abcdefghijklmnop' }),
      'openai-compatible',
    );
    const result = await provider.classify(REQUEST);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    expect(sent[0]!.headers.get('authorization')).toBe('Bearer gm-test-abcdefghijklmnop');
    expect(sent[0]!.body).toMatchObject({
      model: 'gemini-test-model',
      temperature: 0,
      max_tokens: CLASSIFY_MAX_TOKENS,
      response_format: { type: 'json_object' },
    });
    const roles = (sent[0]!.body.messages as Array<{ role: string }>).map((m) => m.role);
    expect(roles).toEqual(['system', 'user']);
    expect(result.kind).toBeDefined();
  });
});

describe('provider factory', () => {
  it('uses each provider’s own endpoint when AI_BASE_URL is empty', () => {
    expect(DEFAULT_AI_BASE_URLS.anthropic).toBe('https://api.anthropic.com');
    expect(DEFAULT_AI_BASE_URLS.openai).toBe('https://api.openai.com/v1');
  });

  it('never sends Anthropic requests to an OpenAI address left over from an old template', () => {
    const base = { AI_PROVIDER: 'anthropic', AI_API_KEY: 'sk-test-abcdefghijklmnop', AI_MODEL: 'm' };
    expect(resolveBaseUrl(testConfig({ ...base, AI_BASE_URL: 'https://api.openai.com/v1' }))).toBe('https://api.anthropic.com');
    expect(resolveBaseUrl(testConfig({ ...base, AI_BASE_URL: 'https://gateway.example/anthropic' }))).toBe(
      'https://gateway.example/anthropic',
    );
    // OpenAI itself keeps its address.
    expect(
      resolveBaseUrl(testConfig({ AI_PROVIDER: 'openai', AI_API_KEY: 'sk-test-abcdefghijklmnop', AI_MODEL: 'm', AI_BASE_URL: 'https://api.openai.com/v1' })),
    ).toBe('https://api.openai.com/v1');
  });

  it('builds the configured provider with its model, and nothing without one', () => {
    const config = testConfig({ AI_PROVIDER: 'anthropic', AI_API_KEY: 'sk-test-abcdefghijklmnop', AI_MODEL: 'claude-opus-5-5' });
    const provider = resolveAiProvider(config, testLogger());
    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect(provider?.model).toBe('claude-opus-5-5');
    expect(resolveAiProvider({ ...config, ai: { ...config.ai, model: null } }, testLogger())).toBeNull();
  });
});

describe('AI status for the health report', () => {
  function stub(outcome: 'ok' | Error): AiProvider {
    return {
      name: 'stub',
      model: 'm',
      classify: async () => {
        if (outcome instanceof Error) throw outcome;
        return JSON.parse(CLASSIFICATION);
      },
      answer: async () => ({ answer: 'a', citedIds: [] }),
    };
  }

  it('records the last success and the last failure as timestamps and a code only', async () => {
    const status = createAiStatus();
    let now = new Date('2026-11-23T10:00:00.000Z');
    const ok = withAiStatus(stub('ok'), status, () => now);
    await ok.classify(REQUEST);
    expect(status.snapshot()).toEqual({ lastSuccessAt: '2026-11-23T10:00:00.000Z', lastFailureAt: null, lastFailureCode: null });

    now = new Date('2026-11-23T11:00:00.000Z');
    const secret = new ProviderError('ai', 'Provider responded with HTTP 429 for "my private note"', {
      retryable: true,
      details: { status: 429 },
    });
    await expect(withAiStatus(stub(secret), status, () => now).classify(REQUEST)).rejects.toBe(secret);
    const snapshot = status.snapshot();
    expect(snapshot).toEqual({
      lastSuccessAt: '2026-11-23T10:00:00.000Z',
      lastFailureAt: '2026-11-23T11:00:00.000Z',
      lastFailureCode: 'http_429',
    });
    expect(JSON.stringify(snapshot)).not.toContain('private');
  });

  it('never turns arbitrary text into a code', () => {
    expect(failureCode(new Error('secret: hunter2'))).toBe('unexpected_error');
    expect(failureCode(new ProviderError('ai', 'x', { retryable: false, details: { reason: 'a'.repeat(80) } }))).toBe(
      'provider_error',
    );
  });
});
