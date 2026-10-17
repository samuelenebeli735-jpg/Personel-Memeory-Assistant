/**
 * OpenAI-compatible speech-to-text (`/audio/transcriptions`, Whisper shape).
 *
 * Uses the global `FormData`/`Blob` available in Node 18+, so no extra HTTP
 * dependency is required.
 */
import { ProviderError } from '../lib/errors.js';
import { withRetry } from '../lib/retry.js';
import type { Transcriber, TranscriptionRequest, TranscriptionResult } from './types.js';

export interface OpenAiTranscriberOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class OpenAiTranscriber implements Transcriber {
  readonly name = 'openai';
  readonly model: string | null;
  private readonly options: Required<Omit<OpenAiTranscriberOptions, 'fetchImpl' | 'sleep'>> &
    Pick<OpenAiTranscriberOptions, 'fetchImpl' | 'sleep'>;

  constructor(options: OpenAiTranscriberOptions) {
    this.model = options.model;
    this.options = {
      apiKey: options.apiKey,
      model: options.model,
      baseUrl: options.baseUrl.replace(/\/+$/, ''),
      timeoutMs: options.timeoutMs ?? 60_000,
      maxRetries: options.maxRetries ?? 1,
      fetchImpl: options.fetchImpl,
      sleep: options.sleep,
    };
  }

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const { value } = await withRetry(
      () => this.call(request),
      {
        attempts: this.options.maxRetries + 1,
        baseDelayMs: 500,
        maxDelayMs: 5_000,
        sleep: this.options.sleep,
        shouldRetry: (error) => !(error instanceof ProviderError) || error.retryable,
      },
    );
    return value;
  }

  private async call(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const form = new FormData();
    // `Uint8Array` must be copied into a fresh view for Blob compatibility.
    const bytes = new Uint8Array(request.audio);
    form.append('file', new Blob([bytes], { type: request.mimeType || 'audio/ogg' }), request.fileName);
    form.append('model', this.options.model);
    form.append('response_format', 'json');
    if (request.language) form.append('language', request.language);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    const doFetch = this.options.fetchImpl ?? fetch;
    try {
      const response = await doFetch(`${this.options.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.options.apiKey}` },
        body: form,
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new ProviderError('stt', `Transcription failed with HTTP ${response.status}`, {
          retryable: response.status === 429 || response.status >= 500,
          details: { status: response.status },
        });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw new ProviderError('stt', 'Transcription response was not JSON', {
          retryable: true,
          cause: error,
        });
      }
      const transcript = (parsed as { text?: unknown }).text;
      if (typeof transcript !== 'string' || transcript.trim().length === 0) {
        throw new ProviderError('stt', 'Transcription was empty', { retryable: false });
      }
      return {
        text: transcript.trim(),
        provider: this.name,
        model: this.options.model,
        language: request.language,
        durationSeconds: request.durationSeconds,
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('stt', controller.signal.aborted ? 'Transcription timed out' : 'Transcription failed', {
        retryable: true,
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
