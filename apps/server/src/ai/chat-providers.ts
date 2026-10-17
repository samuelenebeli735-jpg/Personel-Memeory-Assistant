/**
 * Chat-completion based AI providers.
 *
 * Supports the OpenAI chat-completions shape (OpenAI, and any
 * "openai-compatible" endpoint such as a local server) and Anthropic's
 * Messages API. Only the transport differs: prompt, validation and error
 * handling are shared.
 *
 * Model names are never hard-coded; they come from configuration.
 */
import { classifyCaptureSchema, type Classification } from '@recall/shared';

import { ProviderError } from '../lib/errors.js';
import { withRetry } from '../lib/retry.js';
import { formatLocalHuman, toUtcIso } from '../lib/time.js';
import type { AiAnswer, AiProvider, AnswerRequest, ClassificationRequest, EvidenceRecord } from './types.js';

export interface ChatProviderOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  /** Sends the raw capture text to the provider. Required for classification. */
  allowRawText: boolean;
  fetchImpl?: typeof fetch;
  /** Injectable sleep for retry tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Structured log sink; never receives message content. */
  onEvent?: (event: { level: 'warn' | 'info' | 'debug'; msg: string; context?: Record<string, unknown> }) => void;
}

const CLASSIFY_SYSTEM_PROMPT = `You turn a person's captured note into structured data for a personal memory assistant.
Reply with a single JSON object and nothing else. Never wrap it in prose or code fences.

Schema:
{
  "kind": "TASK" | "IDEA" | "NOTE" | "EVENT" | "OTHER" | "UNKNOWN",
  "title": string | null,
  "description": string | null,
  "category": string | null,
  "tags": string[],
  "priority": "LOW" | "MEDIUM" | "HIGH" | "URGENT" | null,
  "dueAt": string | null,     // ISO-8601 UTC, e.g. "2026-10-18T08:00:00.000Z"
  "remindAt": string | null,  // ISO-8601 UTC
  "projectName": string | null,
  "confidence": number,       // 0..1, your own certainty
  "needsReview": boolean,     // true when a human should confirm
  "rationale": string | null
}

Rules you must follow:
- NEVER invent dates, times, people, places or commitments. If the text does not
  clearly contain a date or time, set "dueAt" and "remindAt" to null.
- "kind" reflects intent: TASK = something to do, IDEA = a thought to keep,
  NOTE = information or a link to keep, EVENT = a scheduled happening,
  OTHER = unclear but worth keeping, UNKNOWN = you cannot tell.
- Resolve relative dates against the supplied local time and time zone. Output UTC.
- Titles must be drawn from the user's own words; do not embellish.
- Keep "description" short and factual; prefer null when the title says it all.
- "projectName" only when the text names a project; otherwise null.`;

function classifyUserPrompt(request: ClassificationRequest): string {
  const lines = [
    `Local now: ${formatLocalHuman(request.referenceNow, request.timeZone)} (${request.timeZone})`,
    `UTC now: ${toUtcIso(request.referenceNow)}`,
    `Capture time (UTC): ${toUtcIso(request.capturedAt)}`,
    `If a date has no time of day, assume the start of that local day and say so in "rationale".`,
  ];
  if (request.hintKind) lines.push(`The user explicitly marked this as: ${request.hintKind}`);
  if (request.knownProjects && request.knownProjects.length > 0) {
    lines.push(`Existing projects (reuse one of these if it fits): ${request.knownProjects.join(', ')}`);
  }
  lines.push('', 'Captured text (verbatim, between the markers):', '<<<CAPTURE', request.text, 'CAPTURE;>>');
  return lines.join('\n');
}

const ANSWER_SYSTEM_PROMPT = `You answer questions about a person's own saved notes.
You are given a list of records retrieved from their database. Rules:
- Use ONLY the supplied records. Never add outside knowledge about the person.
- If the records do not answer the question, say so plainly and suggest a narrower search.
- Cite the record ids you used in "citedIds". Only cite ids that appear in the records.
Reply with a single JSON object: {"answer": string, "citedIds": string[]}. Nothing else.`;

function answerUserPrompt(request: AnswerRequest): string {
  const records = request.evidence
    .map(
      (item: EvidenceRecord) =>
        `- id=${item.id} type=${item.type} when=${item.timestamp}${item.status ? ` status=${item.status}` : ''}\n  title: ${item.title}\n  snippet: ${item.snippet}`,
    )
    .join('\n');
  return [
    `Local now: ${formatLocalHuman(request.referenceNow, request.timeZone)} (${request.timeZone})`,
    'Retrieved records:',
    records.length > 0 ? records : '(none)',
    '',
    `Question: ${request.question}`,
  ].join('\n');
}

/** Extracts the first JSON object from a model response, tolerating fences. */
export function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new ProviderError('ai', 'Model did not return a JSON object', {
      retryable: false,
      details: { reason: 'no-json-object' },
    });
  }
  const candidate = withoutFence.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch (error) {
    throw new ProviderError('ai', 'Model returned malformed JSON', {
      retryable: true,
      cause: error,
      details: { reason: 'invalid-json' },
    });
  }
}

/** Validates raw model output against the strict classification schema. */
export function parseClassification(raw: string): Classification {
  const parsed = extractJsonObject(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ProviderError('ai', 'Classification was not an object', { retryable: true });
  }
  const record = parsed as Record<string, unknown>;
  // Normalise loosely-typed model output before strict validation.
  const normalised = {
    ...record,
    tags: Array.isArray(record.tags) ? record.tags.filter((t) => typeof t === 'string') : [],
    confidence: typeof record.confidence === 'number' ? Math.min(1, Math.max(0, record.confidence)) : 0,
    needsReview: record.needsReview === true,
    dueAt: normaliseTimestamp(record.dueAt),
    remindAt: normaliseTimestamp(record.remindAt),
  };
  const result = classifyCaptureSchema.safeParse(normalised);
  if (!result.success) {
    throw new ProviderError('ai', 'Classification failed schema validation', {
      retryable: false,
      details: {
        reason: 'schema',
        issues: result.error.issues.slice(0, 8).map((i) => `${i.path.join('.')}: ${i.message}`),
      },
    });
  }
  return result.data;
}

/** Accepts ISO strings with or without a zone; rejects anything else. */
function normaliseTimestamp(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

abstract class BaseChatProvider implements AiProvider {
  abstract readonly name: string;
  protected readonly options: ChatProviderOptions;

  constructor(options: ChatProviderOptions) {
    this.options = options;
  }

  get model(): string | null {
    return this.options.model || null;
  }

  /** Sends one chat request and returns the assistant text. */
  protected abstract callChat(messages: ChatMessage[], maxTokens: number): Promise<string>;

  protected async withProviderRetry<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      const { value } = await withRetry(fn, {
        attempts: this.options.maxRetries + 1,
        baseDelayMs: 400,
        maxDelayMs: 8_000,
        sleep: this.options.sleep,
        shouldRetry: (error, attempt) => {
          if (attempt >= this.options.maxRetries + 1) return false;
          if (error instanceof ProviderError) return error.retryable;
          return true;
        },
        onRetry: ({ attempt, delayMs, error }) => {
          this.options.onEvent?.({
            level: 'warn',
            msg: 'ai request retry',
            context: {
              operation,
              attempt,
              delayMs,
              reason: error instanceof Error ? error.message : 'unknown',
            },
          });
        },
      });
      return value;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('ai', `${operation} failed`, {
        retryable: true,
        cause: error,
      });
    }
  }

  async classify(request: ClassificationRequest): Promise<Classification> {
    if (!this.options.allowRawText) {
      throw new ProviderError('ai', 'AI classification is disabled for raw capture text', {
        retryable: false,
        details: { reason: 'raw-text-disabled' },
      });
    }
    const raw = await this.withProviderRetry('classify', () =>
      this.callChat(
        [
          { role: 'system', content: CLASSIFY_SYSTEM_PROMPT },
          { role: 'user', content: classifyUserPrompt(request) },
        ],
        900,
      ),
    );
    return parseClassification(raw);
  }

  async answer(request: AnswerRequest): Promise<AiAnswer> {
    const raw = await this.withProviderRetry('answer', () =>
      this.callChat(
        [
          { role: 'system', content: ANSWER_SYSTEM_PROMPT },
          { role: 'user', content: answerUserPrompt(request) },
        ],
        700,
      ),
    );
    const parsed = extractJsonObject(raw) as { answer?: unknown; citedIds?: unknown };
    const answer = typeof parsed.answer === 'string' ? parsed.answer.trim() : '';
    if (answer.length === 0) {
      throw new ProviderError('ai', 'Answer was empty', { retryable: true });
    }
    const allowed = new Set(request.evidence.map((item) => item.id));
    const cited = Array.isArray(parsed.citedIds)
      ? parsed.citedIds.filter((id): id is string => typeof id === 'string' && allowed.has(id))
      : [];
    return { answer, citedIds: cited };
  }

  protected async postJson(url: string, body: unknown, headers: Record<string, string>): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    const doFetch = this.options.fetchImpl ?? fetch;
    try {
      const response = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        throw new ProviderError('ai', `Provider responded with HTTP ${response.status}`, {
          retryable,
          details: { status: response.status, body: safeSnippet(text) },
        });
      }
      try {
        return JSON.parse(text) as unknown;
      } catch (error) {
        throw new ProviderError('ai', 'Provider returned a non-JSON response', {
          retryable: true,
          cause: error,
        });
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      const aborted = controller.signal.aborted;
      throw new ProviderError('ai', aborted ? 'Provider request timed out' : 'Provider request failed', {
        retryable: true,
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

function safeSnippet(text: string): string {
  return text.replace(/\s+/g, ' ').slice(0, 200);
}

/** OpenAI and any OpenAI-compatible `/chat/completions` server. */
export class OpenAiCompatibleProvider extends BaseChatProvider {
  readonly name: string;

  constructor(options: ChatProviderOptions, name = 'openai') {
    super(options);
    this.name = name;
  }

  protected override async callChat(messages: ChatMessage[], maxTokens: number): Promise<string> {
    const base = this.options.baseUrl.replace(/\/+$/, '');
    const payload = await this.postJson(
      `${base}/chat/completions`,
      {
        model: this.options.model,
        messages,
        temperature: 0,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
      },
      { authorization: `Bearer ${this.options.apiKey}` },
    );
    const choices = (payload as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new ProviderError('ai', 'Provider returned no choices', { retryable: true });
    }
    const first = choices[0] as { message?: { content?: unknown } };
    const content = first.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new ProviderError('ai', 'Provider returned an empty message', { retryable: true });
    }
    return content;
  }
}

/** Anthropic Messages API. */
export class AnthropicProvider extends BaseChatProvider {
  readonly name = 'anthropic';

  protected override async callChat(messages: ChatMessage[], maxTokens: number): Promise<string> {
    const base = this.options.baseUrl.replace(/\/+$/, '');
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const userMessages = messages
      .filter((m) => m.role === 'user')
      .map((m) => ({ role: 'user' as const, content: m.content }));
    const payload = await this.postJson(
      `${base}/v1/messages`,
      {
        model: this.options.model,
        max_tokens: maxTokens,
        temperature: 0,
        system,
        messages: userMessages,
      },
      { 'x-api-key': this.options.apiKey, 'anthropic-version': '2023-06-01' },
    );
    const content = (payload as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      throw new ProviderError('ai', 'Provider returned no content blocks', { retryable: true });
    }
    const text = content
      .map((block) => (block as { type?: string; text?: unknown }))
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('\n')
      .trim();
    if (text.length === 0) {
      throw new ProviderError('ai', 'Provider returned an empty message', { retryable: true });
    }
    return text;
  }
}
