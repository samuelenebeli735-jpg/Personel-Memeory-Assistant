/**
 * Telegram message handler: the bridge between an update from Telegram and the
 * capture services.
 *
 * Guarantees, in order of importance:
 *  1. Only the configured owner(s) are served. Anyone else gets one neutral
 *     refusal and nothing is written.
 *  2. Every message is idempotent on `(source, externalId)` where the external id
 *     is `telegram:<chatId>:<messageId>`. Telegram delivers updates at least
 *     once, so a replay must never create a second capture.
 *  3. A failure while replying never loses the captured words: the capture is
 *     written first, the reply second, and a broken reply is logged, not thrown.
 *  4. `edited_message` updates are deliberately ignored — `rawText` is immutable
 *     once stored, so a later edit must not rewrite history.
 */
import { CAPTURE_KINDS, type CaptureKind } from '@recall/shared';

import type { AppContext } from '../context.js';
import { ValidationError } from '../lib/errors.js';
import { timingSafeEqualStrings } from '../lib/crypto.js';
import { getSettings } from '../services/settings-service.js';
import {
  convertCaptureKind,
  getCapture,
  ingestCapture,
  undoCapture,
  type IngestOutcome,
} from '../services/capture-service.js';
import { parseCommand, runCommand } from './commands.js';
import type {
  ReplyMarkup,
  TelegramCallbackQuery,
  TelegramClient,
  TelegramMessage,
  TelegramUpdate,
} from './client.js';
import {
  formatCallbackProblem,
  formatCaptureConfirmation,
  formatKept,
  formatKindUpdated,
  formatNeedsText,
  formatUnauthorized,
  formatUndone,
  formatUnsupportedMessage,
  formatVoiceStored,
  kindCorrectionButtons,
  undoConfirmButtons,
} from './format.js';

/** Stored as `rawText` when a voice message arrives without a caption. */
export const VOICE_PLACEHOLDER = '[voice message — not transcribed yet]';

/** Telegram media the adapter acknowledges but does not store. */
const UNSUPPORTED_MEDIA: [key: string, label: string][] = [
  ['sticker', 'stickers'],
  ['document', 'documents'],
  ['photo', 'photos'],
  ['audio', 'audio files'],
  ['video', 'videos'],
];

export type IgnoreReason = 'non-owner' | 'group-chat' | 'edited' | 'unsupported' | 'empty';

export interface HandleResult {
  /** True when the update produced a reply and/or a stored capture. */
  handled: boolean;
  reason?: IgnoreReason;
  captureId?: string;
  duplicate?: boolean;
}

export interface TelegramAdapterOptions {
  client: TelegramClient;
  /** Refuse voice longer than this (seconds); 0 disables the check. */
  maxVoiceSeconds?: number;
}

export interface WebhookResult {
  status: number;
  body: unknown;
}

export interface TelegramAdapter {
  readonly client: TelegramClient;
  isOwner(userId: number | undefined): boolean;
  handleUpdate(update: TelegramUpdate): Promise<HandleResult>;
  handleWebhook(input: { secretHeader: string | undefined; body: unknown }): Promise<WebhookResult>;
  /** Sends a message as the bot; used by the polling/webhook bootstrap. */
  sendText(chatId: number | string, text: string, markup?: ReplyMarkup): Promise<void>;
}

export function createTelegramAdapter(
  ctx: AppContext,
  options: TelegramAdapterOptions,
): TelegramAdapter {
  const { client } = options;
  const ownerIds = new Set(ctx.config.telegram.ownerIds.map((id) => String(id)));
  const defaultChatId = ctx.config.telegram.ownerIds[0] ?? '';
  const maxVoiceSeconds = options.maxVoiceSeconds ?? ctx.config.stt.maxAudioSeconds;

  function isOwner(userId: number | undefined): boolean {
    if (userId === undefined) return false;
    return ownerIds.has(String(userId));
  }

  /** Sends a reply. A failure is logged, never thrown: the capture is safe. */
  async function sendText(chatId: number | string, text: string, markup?: ReplyMarkup): Promise<void> {
    try {
      await client.sendMessage({ chatId, text, ...(markup ? { replyMarkup: markup } : {}) });
    } catch (error) {
      ctx.logger.warn('failed to send a telegram reply', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function displayZone(): Promise<string> {
    try {
      const settings = await getSettings(ctx.db, ctx.defaults);
      return settings.timeZone;
    } catch {
      return ctx.defaults.timeZone;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Messages                                                               */
  /* ---------------------------------------------------------------------- */

  async function handleMessage(message: TelegramMessage): Promise<HandleResult> {
    const chatId = message.chat.id;

    if (!isOwner(message.from?.id)) {
      ctx.logger.warn('telegram message from a non-owner ignored', { chatId });
      await sendText(chatId, formatUnauthorized());
      return { handled: false, reason: 'non-owner' };
    }
    if (message.chat.type !== 'private') {
      await sendText(chatId, 'I only work in a private chat with you. Message me directly.');
      return { handled: false, reason: 'group-chat' };
    }

    const text = message.text;
    if (typeof text === 'string') {
      const command = parseCommand(text);
      if (command) {
        const reply = await runCommand({
          ctx,
          command: command.command,
          args: command.args,
          chatId,
        });
        await sendText(chatId, reply.text, reply.markup);
        return { handled: true };
      }
      if (text.trim().length === 0) {
        await sendText(chatId, formatNeedsText());
        return { handled: false, reason: 'empty' };
      }
      return ingestText(message, text);
    }

    if (message.voice) {
      return ingestVoice(message, message.voice);
    }

    const unsupported = UNSUPPORTED_MEDIA.find(([key]) => key in message);
    if (unsupported) {
      ctx.logger.info('telegram media ignored', { chatId, kind: unsupported[0] });
      await sendText(chatId, formatUnsupportedMessage(unsupported[1]));
      return { handled: false, reason: 'unsupported' };
    }

    ctx.logger.info('telegram update contained nothing actionable', { chatId });
    await sendText(chatId, formatNeedsText());
    return { handled: false, reason: 'empty' };
  }

  /** `telegram:<chatId>:<messageId>`, the idempotency key for a message. */
  function externalIdFor(message: TelegramMessage): string {
    return `telegram:${message.chat.id}:${message.message_id}`;
  }

  function occurredAtFor(message: TelegramMessage): Date {
    // Telegram `date` is Unix seconds; absent values fall back to the clock.
    return typeof message.date === 'number' && Number.isFinite(message.date)
      ? new Date(message.date * 1000)
      : ctx.clock.now();
  }

  async function ingestText(message: TelegramMessage, text: string): Promise<HandleResult> {
    const outcome = await ingestCapture(ctx, {
      rawText: text,
      source: 'TELEGRAM',
      externalId: externalIdFor(message),
      occurredAt: occurredAtFor(message),
      sourceRef: String(message.chat.id),
      metadata: telegramMetadata(message),
    });
    await sendConfirmation(message.chat.id, outcome);
    return { handled: true, captureId: outcome.capture.id, duplicate: outcome.duplicate };
  }

  /**
   * Voice is stored, never silently dropped, but transcription is a Milestone 6
   * feature. The capture is written in `captureOnly` mode so the placeholder text
   * is never classified into a bogus task.
   */
  async function ingestVoice(
    message: TelegramMessage,
    voice: NonNullable<TelegramMessage['voice']>,
  ): Promise<HandleResult> {
    const caption = message.caption?.trim() ?? '';
    const tooLong = maxVoiceSeconds > 0 && voice.duration > maxVoiceSeconds;
    const rawText = caption.length > 0 ? caption : VOICE_PLACEHOLDER;

    const outcome = await ingestCapture(
      ctx,
      {
        rawText,
        source: 'TELEGRAM',
        externalId: externalIdFor(message),
        occurredAt: occurredAtFor(message),
        sourceRef: String(message.chat.id),
        metadata: {
          ...telegramMetadata(message),
          voice: {
            fileId: voice.file_id,
            durationSeconds: voice.duration,
            mimeType: voice.mime_type ?? null,
            transcribed: false,
          },
        },
      },
      { captureOnly: true, skipAi: true },
    );

    if (!outcome.duplicate) {
      await ctx.db.capture.update({
        where: { id: outcome.capture.id },
        data: {
          kind: 'UNKNOWN',
          status: 'NEEDS_REVIEW',
          needsReview: true,
          classificationRationale:
            'Voice message stored without a transcript (transcription arrives in a later milestone)',
          processedAt: ctx.clock.now(),
        },
      });
    }

    if (outcome.duplicate) {
      await sendText(message.chat.id, formatCaptureConfirmation(outcome, {
        timeZone: await displayZone(),
        referenceNow: ctx.clock.now(),
      }));
    } else if (tooLong) {
      await sendText(
        message.chat.id,
        `${formatVoiceStored(voice.duration)} It is longer than the configured transcription limit, so it will need a shorter re-send once transcription is available.`,
      );
    } else {
      await sendText(message.chat.id, formatVoiceStored(voice.duration));
    }

    return { handled: true, captureId: outcome.capture.id, duplicate: outcome.duplicate };
  }

  function telegramMetadata(message: TelegramMessage): Record<string, unknown> {
    return {
      telegram: {
        chatId: message.chat.id,
        messageId: message.message_id,
        fromId: message.from?.id ?? null,
        forwarded: message.forward_origin !== undefined || message.forward_from !== undefined,
      },
    };
  }

  async function sendConfirmation(chatId: number, outcome: IngestOutcome): Promise<void> {
    const text = formatCaptureConfirmation(outcome, {
      timeZone: await displayZone(),
      referenceNow: ctx.clock.now(),
    });
    const markup = outcome.duplicate ? undefined : kindCorrectionButtons(outcome.capture.id);
    await sendText(chatId, text, markup);
  }

  /* ---------------------------------------------------------------------- */
  /* Callback queries (inline keyboard buttons)                             */
  /* ---------------------------------------------------------------------- */

  async function handleCallback(query: TelegramCallbackQuery): Promise<HandleResult> {
    if (!isOwner(query.from?.id)) {
      ctx.logger.warn('telegram callback from a non-owner ignored', {});
      await client.answerCallbackQuery({ id: query.id, text: 'This bot is private.' });
      return { handled: false, reason: 'non-owner' };
    }

    const [action, captureId, argument] = (query.data ?? '').split(':');
    if (!action || !captureId) {
      await client.answerCallbackQuery({ id: query.id, text: 'I do not understand that button.' });
      return { handled: false };
    }

    switch (action) {
      case 'k':
        return correctKind(query, captureId, argument);
      case 'u':
        return promptUndo(query, captureId);
      case 'U':
        return confirmUndo(query, captureId);
      case 'K':
        return keepCapture(query, captureId);
      default:
        await client.answerCallbackQuery({ id: query.id, text: 'I do not understand that button.' });
        return { handled: false };
    }
  }

  async function correctKind(
    query: TelegramCallbackQuery,
    captureId: string,
    argument: string | undefined,
  ): Promise<HandleResult> {
    const kind = argument as CaptureKind | undefined;
    if (!kind || !CAPTURE_KINDS.includes(kind)) {
      await client.answerCallbackQuery({ id: query.id, text: 'That is not a kind I know.' });
      return { handled: false };
    }
    try {
      await convertCaptureKind(ctx, captureId, kind);
    } catch (error) {
      await client.answerCallbackQuery({ id: query.id, text: callbackError(error) });
      return { handled: false };
    }
    await replaceMessage(query, formatKindUpdated(kind), kindCorrectionButtons(captureId));
    await client.answerCallbackQuery({ id: query.id, text: 'Updated' });
    return { handled: true, captureId };
  }

  async function promptUndo(
    query: TelegramCallbackQuery,
    captureId: string,
  ): Promise<HandleResult> {
    const capture = await safeGetCapture(captureId);
    if (!capture) {
      await client.answerCallbackQuery({ id: query.id, text: 'That capture no longer exists.' });
      return { handled: false };
    }
    const text = [
      'Undo this capture?',
      '',
      `${capture.kind.toLowerCase()} · ${(capture.links[0]?.title ?? capture.rawText).slice(0, 120)}`,
      '',
      'This removes it and anything created from it.',
    ].join('\n');
    await sendText(query.message?.chat.id ?? defaultChatId, text, undoConfirmButtons(captureId));
    await client.answerCallbackQuery({ id: query.id });
    return { handled: true, captureId };
  }

  async function confirmUndo(
    query: TelegramCallbackQuery,
    captureId: string,
  ): Promise<HandleResult> {
    try {
      // The user has already seen the confirmation, so undo runs without a
      // second prompt; the 15-minute window still applies to anything else.
      const result = await undoCapture(ctx, captureId, { force: true });
      await replaceMessage(query, formatUndone(result.removed.length), { inline_keyboard: [] });
      await client.answerCallbackQuery({ id: query.id, text: 'Undone' });
      return { handled: true, captureId };
    } catch (error) {
      await client.answerCallbackQuery({ id: query.id, text: callbackError(error) });
      return { handled: false };
    }
  }

  async function keepCapture(
    query: TelegramCallbackQuery,
    captureId: string,
  ): Promise<HandleResult> {
    await replaceMessage(query, formatKept(), { inline_keyboard: [] });
    await client.answerCallbackQuery({ id: query.id, text: 'Kept' });
    return { handled: true, captureId };
  }

  async function safeGetCapture(captureId: string) {
    try {
      return await getCapture(ctx.db, captureId);
    } catch {
      return null;
    }
  }

  function callbackError(error: unknown): string {
    if (error instanceof ValidationError) return formatCallbackProblem(error.userMessage);
    return 'Something went wrong with that. Please try again.';
  }

  /** Edits the message a button was attached to, dropping the keyboard when asked. */
  async function replaceMessage(
    query: TelegramCallbackQuery,
    text: string,
    markup: ReplyMarkup | undefined,
  ): Promise<void> {
    const chatId = query.message?.chat.id;
    const messageId = query.message?.message_id;
    if (chatId === undefined || messageId === undefined) {
      await sendText(defaultChatId, text, markup);
      return;
    }
    try {
      await client.editMessageText({
        chatId,
        messageId,
        text,
        ...(markup ? { replyMarkup: markup } : {}),
      });
    } catch (error) {
      ctx.logger.warn('failed to edit a telegram message', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Update + webhook entry points                                          */
  /* ---------------------------------------------------------------------- */

  async function handleUpdate(update: TelegramUpdate): Promise<HandleResult> {
    if (update.callback_query) return handleCallback(update.callback_query);
    if (update.message) return handleMessage(update.message);
    if (update.edited_message) {
      // rawText is immutable; an edited message must never rewrite a capture.
      ctx.logger.info('telegram edited_message ignored', {});
      return { handled: false, reason: 'edited' };
    }
    return { handled: false };
  }

  async function handleWebhook(input: {
    secretHeader: string | undefined;
    body: unknown;
  }): Promise<WebhookResult> {
    const expected = ctx.config.telegram.webhookSecret;
    if (!expected) {
      ctx.logger.error('telegram webhook called but no secret is configured', {});
      return { status: 503, body: { ok: false, error: 'webhook is not configured' } };
    }
    if (!input.secretHeader || !timingSafeEqualStrings(input.secretHeader, expected)) {
      ctx.logger.warn('telegram webhook rejected: bad secret', {});
      return { status: 401, body: { ok: false, error: 'unauthorized' } };
    }
    const update = input.body as TelegramUpdate | undefined;
    if (!update || typeof update.update_id !== 'number') {
      ctx.logger.warn('telegram webhook rejected: malformed update', {});
      return { status: 400, body: { ok: false, error: 'malformed update' } };
    }
    try {
      await handleUpdate(update);
      return { status: 200, body: { ok: true } };
    } catch (error) {
      // A 500 makes Telegram retry; idempotency means that retry is safe.
      ctx.logger.error('telegram webhook failed to process the update', {
        reason: error instanceof Error ? error.message : String(error),
        updateId: update.update_id,
      });
      return { status: 500, body: { ok: false, error: 'processing failed' } };
    }
  }

  return {
    client,
    isOwner,
    handleUpdate,
    handleWebhook,
    sendText,
  };
}
