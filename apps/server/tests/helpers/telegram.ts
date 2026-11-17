/**
 * A fake Telegram Bot API.
 *
 * The adapter talks to Telegram through an injected `fetch`, so tests can drive
 * it without a token, a network call or a real bot. Every call is recorded so a
 * test can assert on exactly what was sent.
 */
import type { AppContext } from '../../src/context.js';
import { TelegramClient } from '../../src/telegram/client.js';
import { createTelegramAdapter, type TelegramAdapter } from '../../src/telegram/handler.js';

export interface BotCall {
  method: string;
  payload: Record<string, unknown>;
}

export interface FakeTelegram {
  fetchImpl: typeof fetch;
  calls: BotCall[];
  /** `text` of every sendMessage call, in order. */
  sent: string[];
  /** `reply_markup` of every sendMessage call, in order (undefined when absent). */
  sentMarkups: (unknown)[];
  /** `text` of every editMessageText call, in order. */
  edits: string[];
  /** `text` of every answerCallbackQuery call, in order ('' when none). */
  answers: string[];
  /** Methods called, in order. */
  methods(): string[];
  callsTo(method: string): BotCall[];
  reset(): void;
}

export interface FakeAudioFile {
  /** Telegram file path, e.g. `voice/file_1.oga`. Defaults to `<fileId>.ogg`. */
  path?: string;
  bytes: Uint8Array;
  /** Simulates a non-200 download response. */
  status?: number;
}

export interface FakeTelegramOptions {
  username?: string;
  /** Voice files keyed by `file_id`, served by `getFile` and the download URL. */
  files?: Record<string, FakeAudioFile>;
  /**
   * Lets a test simulate an API failure. Return `undefined` to accept the call
   * normally.
   */
  onCall?: (method: string, payload: Record<string, unknown>) => { status?: number; body?: unknown } | undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function createFakeTelegram(options: FakeTelegramOptions = {}): FakeTelegram {
  const calls: BotCall[] = [];
  const fake: FakeTelegram = {
    // Assigned below, once the recording fetch exists.
    fetchImpl: (async () => json({ ok: true, result: true })) as typeof fetch,
    calls,
    sent: [],
    sentMarkups: [],
    edits: [],
    answers: [],
    methods: () => calls.map((call) => call.method),
    callsTo: (method) => calls.filter((call) => call.method === method),
    reset() {
      calls.length = 0;
      fake.sent.length = 0;
      fake.sentMarkups.length = 0;
      fake.edits.length = 0;
      fake.answers.length = 0;
    },
  };

  fake.fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = url.split('/').pop() ?? '';
    let payload: Record<string, unknown> = {};
    if (typeof init?.body === 'string') {
      try {
        payload = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        payload = {};
      }
    } else if (typeof FormData !== 'undefined' && init?.body instanceof FormData) {
      // Form bodies are only used for provider calls, never for the Bot API.
      payload = {};
    }
    calls.push({ method, payload });
    if (method === 'sendMessage') {
      fake.sent.push(String(payload.text ?? ''));
      fake.sentMarkups.push(payload.reply_markup);
    } else if (method === 'editMessageText') {
      fake.edits.push(String(payload.text ?? ''));
    } else if (method === 'answerCallbackQuery') {
      fake.answers.push(String(payload.text ?? ''));
    }

    const override = options.onCall?.(method, payload);
    if (override) {
      return json(override.body ?? { ok: false, description: 'injected failure' }, override.status ?? 400);
    }

    if (method === 'getFile') {
      const fileId = String(payload.file_id ?? '');
      const file = options.files?.[fileId];
      if (file) {
        const filePath = file.path ?? `${fileId}.ogg`;
        return json({
          ok: true,
          result: {
            file_id: fileId,
            file_path: filePath,
            file_size: file.bytes.byteLength,
          },
        });
      }
    }

    // Audio downloads land on `/file/bot<token>/<file_path>`; the last segment
    // is enough to find the registered fake file.
    const audio = Object.values(options.files ?? {}).find((file) => {
      const filePath = file.path ?? '';
      return filePath.length > 0 && filePath.split('/').pop() === method;
    });
    if (audio) {
      if (audio.status && audio.status !== 200) {
        return json({ ok: false, description: 'download failed' }, audio.status);
      }
      return new Response(audio.bytes as unknown as BodyInit, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      });
    }

    switch (method) {
      case 'getMe':
        return json({
          ok: true,
          result: { id: 42, is_bot: true, username: options.username ?? 'recall_test_bot' },
        });
      case 'sendMessage':
        return json({ ok: true, result: { message_id: 1000 + calls.length } });
      case 'getUpdates':
        return json({ ok: true, result: [] });
      default:
        return json({ ok: true, result: true });
    }
  }) as typeof fetch;

  return fake;
}

export interface TestTelegramAdapter {
  adapter: TelegramAdapter;
  client: TelegramClient;
  fake: FakeTelegram;
}

/** Builds the real client + adapter against a fake Bot API. */
export function createTestTelegramAdapter(
  ctx: AppContext,
  options: { fake: FakeTelegram; token?: string },
): TestTelegramAdapter {
  const { fake } = options;
  const client = new TelegramClient({
    token: options.token ?? 'test-token',
    fetchImpl: fake.fetchImpl,
  });
  const adapter = createTelegramAdapter(ctx, { client });
  return { adapter, client, fake };
}

export interface MessageOverrides {
  messageId?: number;
  chatId?: number;
  fromId?: number;
  text?: string;
  date?: number;
  chatType?: 'private' | 'group';
  caption?: string;
  voice?: { file_id: string; duration: number; mime_type?: string };
  sticker?: boolean;
  document?: boolean;
  photo?: boolean;
}

/** Builds an update carrying a text message from the owner by default. */
export function textUpdate(text: string, overrides: MessageOverrides = {}) {
  return messageUpdate({ ...overrides, text });
}

export function messageUpdate(overrides: MessageOverrides = {}) {
  const chatId = overrides.chatId ?? 555000111;
  const fromId = overrides.fromId ?? 555000111;
  const messageId = overrides.messageId ?? 7;
  const message: Record<string, unknown> = {
    message_id: messageId,
    date: overrides.date ?? Math.floor(Date.UTC(2026, 9, 17, 10, 0, 0) / 1000),
    chat: { id: chatId, type: overrides.chatType ?? 'private' },
    from: { id: fromId, is_bot: false, first_name: 'Owner' },
  };
  if (overrides.text !== undefined) message.text = overrides.text;
  if (overrides.caption !== undefined) message.caption = overrides.caption;
  if (overrides.voice) message.voice = overrides.voice;
  if (overrides.sticker) message.sticker = { file_id: 'sticker-1' };
  if (overrides.document) message.document = { file_id: 'doc-1', file_name: 'notes.pdf' };
  if (overrides.photo) message.photo = [{ file_id: 'photo-1' }];
  return {
    update_id: messageId * 10 + 1,
    message,
  } as unknown as import('../../src/telegram/client.js').TelegramUpdate;
}

export function callbackUpdate(
  data: string,
  overrides: MessageOverrides & { callbackId?: string } = {},
) {
  const chatId = overrides.chatId ?? 555000111;
  const fromId = overrides.fromId ?? 555000111;
  const messageId = overrides.messageId ?? 7;
  return {
    update_id: messageId * 10 + 5,
    callback_query: {
      id: overrides.callbackId ?? 'cb-1',
      from: { id: fromId, is_bot: false, first_name: 'Owner' },
      message: {
        message_id: messageId,
        date: Math.floor(Date.UTC(2026, 9, 17, 10, 0, 0) / 1000),
        chat: { id: chatId, type: 'private' },
        from: { id: 42, is_bot: true, first_name: 'Recall' },
        text: 'Saved as a task:',
      },
      data,
    },
  } as unknown as import('../../src/telegram/client.js').TelegramUpdate;
}

/** A provider that always fails, used to prove a capture survives an AI outage. */
export function failingAiProvider(message = 'simulated outage') {
  return {
    name: 'fake-ai',
    model: 'fake-model',
    async classify(): Promise<never> {
      throw new Error(message);
    },
    async answer(): Promise<never> {
      throw new Error(message);
    },
  };
}
