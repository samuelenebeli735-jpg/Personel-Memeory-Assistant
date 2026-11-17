/**
 * Unit tests for the OpenAI-compatible transcriber.
 *
 * The provider is driven entirely through an injected `fetch` and `sleep`, so
 * these tests prove the transport behaviour (multipart shape, retry policy,
 * timeout, empty output, provider failures) without a network call or a key.
 */
import { describe, expect, it } from 'vitest';

import { OpenAiTranscriber } from '../../src/stt/openai-transcriber.js';
import { resolveTranscriber } from '../../src/stt/index.js';
import { testConfig, testLogger } from '../helpers/app.js';
import { ProviderError } from '../../src/lib/errors.js';

const AUDIO = new Uint8Array([1, 2, 3, 4]);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function transcriber(
  fetchImpl: typeof fetch,
  overrides: { timeoutMs?: number; maxRetries?: number } = {},
): OpenAiTranscriber {
  return new OpenAiTranscriber({
    apiKey: 'sk-test-not-real',
    model: 'whisper-1',
    baseUrl: 'https://stt.example/v1/',
    timeoutMs: overrides.timeoutMs ?? 1_000,
    maxRetries: overrides.maxRetries ?? 1,
    fetchImpl,
    sleep: async () => undefined,
  });
}

describe('OpenAiTranscriber', () => {
  it('posts the audio as multipart and returns the trimmed transcript', async () => {
    let seenUrl = '';
    let seenAuth: string | null = null;
    let form: FormData | null = null;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      seenUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      seenAuth = (init?.headers as Record<string, string> | undefined)?.authorization ?? null;
      form = init?.body as FormData;
      return jsonResponse({ text: '  call the plumber  ' });
    }) as typeof fetch;

    const result = await transcriber(fetchImpl).transcribe({
      audio: AUDIO,
      fileName: 'voice-7.ogg',
      mimeType: 'audio/ogg',
      durationSeconds: 12,
    });

    expect(seenUrl).toBe('https://stt.example/v1/audio/transcriptions');
    expect(seenAuth).toBe('Bearer sk-test-not-real');
    expect(form).toBeInstanceOf(FormData);
    expect((form as unknown as FormData).get('model')).toBe('whisper-1');
    expect((form as unknown as FormData).get('response_format')).toBe('json');
    const file = (form as unknown as FormData).get('file');
    expect(file).toBeInstanceOf(Blob);
    expect((file as Blob).type).toBe('audio/ogg');
    expect(result).toMatchObject({ text: 'call the plumber', provider: 'openai', model: 'whisper-1' });
    expect(result.durationSeconds).toBe(12);
  });

  it('rejects an empty transcript without retrying', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return jsonResponse({ text: '   ' });
    }) as typeof fetch;

    await expect(
      transcriber(fetchImpl).transcribe({ audio: AUDIO, fileName: 'v.ogg', mimeType: 'audio/ogg' }),
    ).rejects.toThrow('Transcription was empty');
    expect(calls).toBe(1);
  });

  it('does not retry a non-retryable HTTP error', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return jsonResponse({ error: 'unsupported' }, 400);
    }) as typeof fetch;

    const error = await transcriber(fetchImpl)
      .transcribe({ audio: AUDIO, fileName: 'v.ogg', mimeType: 'audio/ogg' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).retryable).toBe(false);
    expect((error as Error).message).toContain('HTTP 400');
    expect(calls).toBe(1);
  });

  it('retries a 429 and succeeds on the second attempt', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({ error: 'slow down' }, 429);
      return jsonResponse({ text: 'second time lucky' });
    }) as typeof fetch;

    const result = await transcriber(fetchImpl).transcribe({
      audio: AUDIO,
      fileName: 'v.ogg',
      mimeType: 'audio/ogg',
    });
    expect(result.text).toBe('second time lucky');
    expect(calls).toBe(2);
  });

  it('retries a server error up to the configured limit, then fails', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return jsonResponse({ error: 'boom' }, 503);
    }) as typeof fetch;

    await expect(
      transcriber(fetchImpl, { maxRetries: 2 }).transcribe({
        audio: AUDIO,
        fileName: 'v.ogg',
        mimeType: 'audio/ogg',
      }),
    ).rejects.toThrow('HTTP 503');
    expect(calls).toBe(3);
  });

  it('reports a timeout as a retryable provider error', async () => {
    const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      })) as typeof fetch;

    const error = await transcriber(fetchImpl, { timeoutMs: 10, maxRetries: 0 })
      .transcribe({ audio: AUDIO, fileName: 'v.ogg', mimeType: 'audio/ogg' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as Error).message).toContain('timed out');
  });

  it('reports a non-JSON response as a provider error', async () => {
    const fetchImpl = (async () => new Response('<html>nope</html>', { status: 200 })) as typeof fetch;
    await expect(
      transcriber(fetchImpl).transcribe({ audio: AUDIO, fileName: 'v.ogg', mimeType: 'audio/ogg' }),
    ).rejects.toThrow('was not JSON');
  });
});

describe('resolveTranscriber', () => {
  it('returns null when speech-to-text is not configured', () => {
    expect(resolveTranscriber(testConfig(), testLogger())).toBeNull();
  });

  it('builds a transcriber when a provider and key are present', () => {
    const config = testConfig({ STT_PROVIDER: 'openai', STT_API_KEY: 'sk-test-not-real' });
    const resolved = resolveTranscriber(config, testLogger());
    expect(resolved).not.toBeNull();
    expect(resolved?.name).toBe('openai');
    expect(resolved?.model).toBe('whisper-1');
  });
});
