/**
 * Telegram file downloads.
 *
 * The byte cap must be enforced while reading the body, not after buffering it.
 * These tests drive a deliberately chunked stream so a regression back to
 * `arrayBuffer()` is observable rather than hidden by a small fixture.
 */
import { describe, expect, it } from 'vitest';

import { TelegramApiError, TelegramClient } from '../../src/telegram/client.js';

function clientWith(fetchImpl: typeof fetch): TelegramClient {
  return new TelegramClient({
    token: 'test-token',
    fetchImpl,
    timeoutMs: 1_000,
  });
}

function streamOf(
  chunks: Uint8Array[],
  hooks: { onPull?: () => void; onCancel?: () => void } = {},
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      hooks.onPull?.();
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index++]!);
    },
    cancel() {
      hooks.onCancel?.();
    },
  });
}

describe('TelegramClient.downloadFile', () => {
  it('reassembles a streamed body and accepts a body exactly at the cap', async () => {
    const chunks = [Uint8Array.of(1, 2), Uint8Array.of(3, 4), Uint8Array.of(5, 6)];
    const client = clientWith(async () => new Response(streamOf(chunks), { status: 200 }));

    const result = await client.downloadFile('voice/file.oga', 6);

    expect([...result]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('stops reading as soon as the streamed total exceeds the cap', async () => {
    let pulls = 0;
    let cancelled = false;
    const chunks = Array.from({ length: 100 }, () => new Uint8Array(8));
    const client = clientWith(async () =>
      new Response(
        streamOf(chunks, {
          onPull: () => {
            pulls += 1;
          },
          onCancel: () => {
            cancelled = true;
          },
        }),
        { status: 200 },
      ),
    );

    await expect(client.downloadFile('voice/file.oga', 10)).rejects.toMatchObject({
      retryable: false,
      message: expect.stringMatching(/larger than the configured limit/i),
    } satisfies Partial<TelegramApiError>);

    // A buffering implementation would consume all 100 chunks. The bounded
    // reader rejects on the second 8-byte chunk and cancels the stream.
    expect(pulls).toBeLessThan(chunks.length);
    expect(cancelled).toBe(true);
  });

  it('rejects an oversized declared Content-Length before reading the body', async () => {
    let readerRequested = false;
    let cancelled = false;
    const body = {
      getReader() {
        readerRequested = true;
        throw new Error('the body should not be read');
      },
      cancel() {
        cancelled = true;
        return Promise.resolve();
      },
    } as unknown as ReadableStream<Uint8Array>;
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': '4096' }),
      body,
    } as unknown as Response;
    const client = clientWith(async () => response);

    await expect(client.downloadFile('voice/file.oga', 1024)).rejects.toMatchObject({
      retryable: false,
      message: expect.stringMatching(/larger than the configured limit/i),
    } satisfies Partial<TelegramApiError>);
    expect(readerRequested).toBe(false);
    expect(cancelled).toBe(true);
  });
});
