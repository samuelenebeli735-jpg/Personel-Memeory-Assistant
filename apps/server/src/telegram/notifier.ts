/**
 * Telegram delivery for proactive messages (reminders, briefings, digests).
 *
 * This is the one place that turns an `OutboundMessage` into a Bot API call. It
 * never throws: a failed delivery is reported as an `ok: false` outcome so the
 * scheduler can record the attempt and retry, rather than losing it to a crash.
 */
import type { Logger } from '../lib/logger.js';
import type { DeliveryOutcome, Notifier, OutboundMessage } from '../ports.js';
import { TelegramApiError, type ReplyMarkup, type TelegramClient } from './client.js';

export interface TelegramNotifierOptions {
  client: TelegramClient;
  /** Chat ids the owner can be reached on. The first is the default. */
  ownerIds: readonly string[];
  logger?: Logger;
}

/**
 * Builds an inline keyboard from `OutboundMessage.buttons`.
 *
 * Each inner array is one keyboard row whose entries alternate
 * `label, callbackData, label, callbackData, …`, which allows two buttons
 * side by side without inventing a richer type for a case we do not have yet.
 */
export function buttonsToReplyMarkup(buttons: string[][] | undefined): ReplyMarkup | undefined {
  if (!buttons || buttons.length === 0) return undefined;
  const rows: ReplyMarkup['inline_keyboard'] = [];
  for (const row of buttons) {
    const cells: ReplyMarkup['inline_keyboard'][number] = [];
    for (let i = 0; i + 1 < row.length; i += 2) {
      const text = row[i];
      const callbackData = row[i + 1];
      if (text === undefined || callbackData === undefined) continue;
      cells.push({ text, callback_data: callbackData });
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows.length > 0 ? { inline_keyboard: rows } : undefined;
}

export function createTelegramNotifier(options: TelegramNotifierOptions): Notifier {
  const { client, ownerIds, logger } = options;
  const defaultChatId = ownerIds[0] ?? null;

  return {
    channel: 'telegram',

    isAvailable() {
      return client.token.length > 0 && defaultChatId !== null;
    },

    async send(message: OutboundMessage): Promise<DeliveryOutcome> {
      const chatId = message.chatId ?? defaultChatId;
      if (!chatId) {
        return { ok: false, error: 'no owner chat is configured', retryable: false };
      }
      try {
        const sent = await client.sendMessage({
          chatId,
          text: message.text,
          replyMarkup: buttonsToReplyMarkup(message.buttons),
          disableNotification: message.proactive === true,
        });
        return { ok: true, messageId: String(sent.message_id) };
      } catch (error) {
        const permanent = isPermanent(error);
        // Telegram answers a rate limit with `retry_after`; passing that on lets
        // the scheduler wait exactly as long as asked instead of guessing.
        const retryAfterMs =
          error instanceof TelegramApiError && typeof error.retryAfterSeconds === 'number'
            ? Math.max(0, error.retryAfterSeconds * 1000)
            : undefined;
        logger?.warn('telegram delivery failed', {
          reason: error instanceof Error ? error.message : String(error),
          permanent,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        });
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'telegram delivery failed',
          retryable: !permanent,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        };
      }
    },
  };
}

/**
 * Telegram rejects a message the same way whether the bot is blocked, the chat
 * no longer exists or the request is malformed. Treating those as retryable
 * would spin forever once the owner blocks the bot, so they stop the attempt.
 */
function isPermanent(error: unknown): boolean {
  if (!(error instanceof TelegramApiError)) return false;
  if (typeof error.status === 'number' && error.status >= 400 && error.status < 500) {
    // 429 is a soft failure: it comes back with retry_after and should be retried.
    return error.status !== 429;
  }
  return false;
}
