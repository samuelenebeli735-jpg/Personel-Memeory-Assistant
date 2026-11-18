/**
 * Minimal Telegram Bot API client.
 *
 * Written against `fetch` rather than a framework so the adapter stays small,
 * testable with an injected `fetch`, and free of a dependency we do not fully
 * use. Only the methods Recall needs are implemented.
 */
import { ProviderError } from '../lib/errors.js';

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
}

export interface TelegramVoice {
  file_id: string;
  file_unique_id?: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramAudio {
  file_id: string;
  duration: number;
  mime_type?: string;
  file_name?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  /** Present when the user forwarded a message from another chat. */
  forward_origin?: { type: string; date?: number; sender_user?: TelegramUser; chat?: TelegramChat };
  forward_from?: TelegramUser;
  forward_date?: number;
  voice?: TelegramVoice;
  audio?: TelegramAudio;
  caption?: string;
  sticker?: unknown;
  document?: { file_id: string; file_name?: string; mime_type?: string };
  photo?: unknown[];
  /** Set when this message is a reply, e.g. to a Recall classification. */
  reply_to_message?: TelegramMessage;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export interface ReplyMarkup {
  inline_keyboard: { text: string; callback_data: string }[][];
}

export interface SendMessageOptions {
  chatId: number | string;
  text: string;
  replyMarkup?: ReplyMarkup;
  disableNotification?: boolean;
  linkPreview?: boolean;
}

export interface TelegramClientOptions {
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  onEvent?: (event: { level: 'warn' | 'debug'; msg: string; context?: Record<string, unknown> }) => void;
}

const TELEGRAM_SAFE_LENGTH = 4000;

export function truncateForTelegram(text: string, max = TELEGRAM_SAFE_LENGTH): string {
  return text.length <= max ? text : `${text.slice(0, max - 20)}\n…(truncated)`;
}

export class TelegramApiError extends ProviderError {
  readonly status: number | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    message: string,
    options: { status?: number; retryAfterSeconds?: number; retryable?: boolean; cause?: unknown } = {},
  ) {
    super('telegram', message, { retryable: options.retryable ?? true, cause: options.cause });
    this.name = 'TelegramApiError';
    this.status = options.status;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export class TelegramClient {
  readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly onEvent: TelegramClientOptions['onEvent'];
  private botUsername: string | null = null;

  constructor(options: TelegramClientOptions) {
    this.token = options.token;
    this.baseUrl = (options.baseUrl ?? 'https://api.telegram.org').replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.onEvent = options.onEvent;
  }

  get username(): string | null {
    return this.botUsername;
  }

  private methodUrl(method: string): string {
    return `${this.baseUrl}/bot${this.token}/${method}`;
  }

  private fileUrl(filePath: string): string {
    return `${this.baseUrl}/file/bot${this.token}/${filePath}`;
  }

  /** Masks the token if it ever reaches a log line. */
  get safeDescription(): string {
    return `telegram(bot ${this.botUsername ?? 'unknown'})`;
  }

  private async call<T>(method: string, payload: unknown, timeoutMs?: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.methodUrl(method), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
        signal: controller.signal,
      });
      const raw = await response.text();
      let parsed: TelegramApiResponse<T>;
      try {
        parsed = JSON.parse(raw) as TelegramApiResponse<T>;
      } catch (error) {
        throw new TelegramApiError(`Telegram returned a non-JSON response for ${method}`, {
          status: response.status,
          retryable: true,
          cause: error,
        });
      }
      if (!response.ok || !parsed.ok) {
        const retryAfter = parsed.parameters?.retry_after;
        throw new TelegramApiError(`Telegram ${method} failed: ${parsed.description ?? response.status}`, {
          status: parsed.error_code ?? response.status,
          retryAfterSeconds: retryAfter,
          retryable: response.status === 429 || response.status >= 500,
        });
      }
      return parsed.result as T;
    } catch (error) {
      if (error instanceof TelegramApiError) throw error;
      const aborted = controller.signal.aborted;
      throw new TelegramApiError(aborted ? `Telegram ${method} timed out` : `Telegram ${method} failed`, {
        retryable: true,
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async getMe(): Promise<TelegramUser> {
    const me = await this.call<TelegramUser>('getMe', {});
    this.botUsername = me.username ?? null;
    return me;
  }

  async getUpdates(options: {
    offset?: number;
    limit?: number;
    timeoutSeconds?: number;
    allowedUpdates?: string[];
    /** Long-polling needs a client timeout above the server-side hold. */
    requestTimeoutMs?: number;
  }): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>(
      'getUpdates',
      {
        ...(options.offset === undefined ? {} : { offset: options.offset }),
        limit: options.limit ?? 20,
        timeout: options.timeoutSeconds ?? 25,
        allowed_updates: options.allowedUpdates ?? ['message', 'edited_message', 'callback_query'],
      },
      options.requestTimeoutMs ?? (options.timeoutSeconds ?? 25) * 1000 + 10_000,
    );
  }

  async sendMessage(options: SendMessageOptions): Promise<{ message_id: number }> {
    return this.call<{ message_id: number }>('sendMessage', {
      chat_id: options.chatId,
      text: truncateForTelegram(options.text),
      ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
      ...(options.disableNotification ? { disable_notification: true } : {}),
      link_preview_options: { is_disabled: options.linkPreview !== true },
    });
  }

  async editMessageText(options: {
    chatId: number | string;
    messageId: number;
    text: string;
    replyMarkup?: ReplyMarkup;
  }): Promise<void> {
    try {
      await this.call('editMessageText', {
        chat_id: options.chatId,
        message_id: options.messageId,
        text: truncateForTelegram(options.text),
        ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
        link_preview_options: { is_disabled: true },
      });
    } catch (error) {
      // Editing a message that has not changed is a normal Telegram rejection.
      if (error instanceof TelegramApiError && /not modified/i.test(error.message)) return;
      throw error;
    }
  }

  async answerCallbackQuery(options: { id: string; text?: string }): Promise<void> {
    try {
      await this.call('answerCallbackQuery', {
        callback_query_id: options.id,
        ...(options.text ? { text: options.text.slice(0, 190) } : {}),
      });
    } catch (error) {
      this.onEvent?.({ level: 'warn', msg: 'failed to answer callback query', context: { reason: String(error) } });
    }
  }

  async setWebhook(options: { url: string; secretToken?: string }): Promise<void> {
    await this.call('setWebhook', {
      url: options.url,
      ...(options.secretToken ? { secret_token: options.secretToken } : {}),
      allowed_updates: ['message', 'edited_message', 'callback_query'],
      drop_pending_updates: false,
    });
  }

  async deleteWebhook(): Promise<void> {
    await this.call('deleteWebhook', { drop_pending_updates: false });
  }

  /** Returns the file path needed to download an uploaded file. */
  async getFilePath(fileId: string): Promise<string> {
    const file = await this.call<{ file_id: string; file_path?: string; file_size?: number }>('getFile', {
      file_id: fileId,
    });
    if (!file.file_path) throw new TelegramApiError('Telegram did not return a file path', { retryable: false });
    return file.file_path;
  }

  async downloadFile(filePath: string, maxBytes: number): Promise<Uint8Array> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.fileUrl(filePath), { signal: controller.signal });
      if (!response.ok) {
        throw new TelegramApiError(`Telegram file download failed with ${response.status}`, {
          status: response.status,
          retryable: response.status >= 500,
        });
      }

      // A declared length over the cap can be rejected before reading the body.
      const contentLength = response.headers.get('content-length');
      if (contentLength !== null) {
        const declared = Number(contentLength);
        if (Number.isFinite(declared) && declared > maxBytes) {
          await cancelBody(response.body);
          throw new TelegramApiError('Telegram file is larger than the configured limit', {
            retryable: false,
          });
        }
      }

      // Read incrementally so an oversized or endless body never has to be
      // buffered in full. The cap is enforced per chunk, not after the fact.
      if (!response.body) {
        const buffer = new Uint8Array(await response.arrayBuffer());
        if (buffer.byteLength > maxBytes) {
          throw new TelegramApiError('Telegram file is larger than the configured limit', {
            retryable: false,
          });
        }
        return buffer;
      }
      return await readBodyWithLimit(response.body, maxBytes);
    } catch (error) {
      if (error instanceof TelegramApiError) throw error;
      throw new TelegramApiError('Telegram file download failed', { retryable: true, cause: error });
    } finally {
      clearTimeout(timer);
    }
  }
}

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body) return;
  try {
    await body.cancel();
  } catch {
    // The caller is already reporting the size failure; cancellation is cleanup.
  }
}

async function readBodyWithLimit(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Cancellation is cleanup; the size failure remains the primary error.
        }
        throw new TelegramApiError('Telegram file is larger than the configured limit', {
          retryable: false,
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
