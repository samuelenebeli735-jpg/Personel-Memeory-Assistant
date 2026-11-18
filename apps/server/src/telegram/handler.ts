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
import fs from 'node:fs/promises';
import path from 'node:path';

import { CAPTURE_KINDS, type CaptureDto, type CaptureKind } from '@recall/shared';

import type { AppContext } from '../context.js';
import { ValidationError, toAppError } from '../lib/errors.js';
import { timingSafeEqualStrings } from '../lib/crypto.js';
import { audioFileExtension, isSupportedAudioMime } from '../lib/audio.js';
import { composeVoiceText, normaliseTranscription, VOICE_PLACEHOLDER } from '../lib/voice.js';
import { getSettings } from '../services/settings-service.js';
import {
  convertCaptureKind,
  findCaptureByExternalId,
  getCapture,
  ingestCapture,
  undoCapture,
  type IngestOutcome,
} from '../services/capture-service.js';
import { parseCommand, runCommand, type CommandReply } from './commands.js';
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
  type VoiceStoreReason,
} from './format.js';

/** Stored as `rawText` when a voice message arrives without a caption. */
export { VOICE_PLACEHOLDER };

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

  /**
   * Voice attempts currently running in this adapter.
   *
   * Keyed by the same `telegram:<chatId>:<messageId>` identity as the persistent
   * uniqueness constraint. A duplicate delivery joins the running attempt instead
   * of downloading and transcribing again. This is intentionally process-local:
   * Recall is a single-server deployment and this does not provide distributed
   * locking across processes.
   */
  const voiceInFlight = new Map<string, Promise<HandleResult>>();

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
        let reply: CommandReply;
        try {
          reply = await runCommand({
            ctx,
            command: command.command,
            args: command.args,
            chatId,
          });
        } catch (error) {
          // A command failure (a cancelled reminder, a missing record) is
          // reported as its safe user message; it never becomes a stack trace.
          const appError = toAppError(error);
          ctx.logger.warn('telegram command failed', {
            command: command.command,
            code: appError.code,
            reason: appError.message,
          });
          reply = { text: formatCallbackProblem(appError.userMessage) };
        }
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
   * Voice ingestion.
   *
   * A message is claimed by `telegram:<chatId>:<messageId>` before the replay
   * check. A concurrent duplicate joins that promise, so only one download and
   * one transcription can run. The claim is removed as soon as the attempt
   * settles, whether it succeeds or fails, so a later retry can start cleanly.
   *
   * The attempt itself orders work as: replay check → duration/format checks →
   * download → transcribe → store. A replayed update never downloads or
   * transcribes again, and every failure after download still stores the capture.
   * The audio bytes never touch the disk unless `STT_RETAIN_AUDIO=true`; the
   * transcript is stored separately from the caption with explicit provenance.
   */
  async function ingestVoice(
    message: TelegramMessage,
    voice: NonNullable<TelegramMessage['voice']>,
  ): Promise<HandleResult> {
    const externalId = externalIdFor(message);

    const running = voiceInFlight.get(externalId);
    if (running) {
      ctx.logger.debug('joined in-flight voice delivery', {
        chatId: message.chat.id,
        messageId: message.message_id,
      });
      const shared = await running;
      return { ...shared, duplicate: true };
    }

    const attempt = ingestVoiceAttempt(message, voice, externalId);
    voiceInFlight.set(externalId, attempt);

    // Remove the claim as soon as the attempt settles. Registering this before
    // returning means a retry started from a failure handler sees a clean map.
    const clear = () => {
      if (voiceInFlight.get(externalId) === attempt) voiceInFlight.delete(externalId);
    };
    void attempt.then(clear, clear);
    return attempt;
  }

  async function ingestVoiceAttempt(
    message: TelegramMessage,
    voice: NonNullable<TelegramMessage['voice']>,
    externalId: string,
  ): Promise<HandleResult> {
    const chatId = message.chat.id;
    const caption = message.caption?.trim() ?? '';

    // Cheapest possible replay handling: no Bot API call, no provider call.
    const existing = await findCaptureByExternalId(ctx.db, 'TELEGRAM', externalId);
    if (existing) {
      ctx.logger.debug('duplicate voice capture ignored before download', { captureId: existing.id });
      await sendText(
        chatId,
        formatCaptureConfirmation(outcomeForExistingCapture(existing), {
          timeZone: await displayZone(),
          referenceNow: ctx.clock.now(),
        }),
      );
      return { handled: true, captureId: existing.id, duplicate: true };
    }

    const tooLong = maxVoiceSeconds > 0 && voice.duration > maxVoiceSeconds;
    const mimeType = voice.mime_type ?? 'audio/ogg';
    const transcriber = ctx.stt;

    let audio: Uint8Array | null = null;
    let transcript: string | null = null;
    let sttProvider: string | null = null;
    let sttModel: string | null = null;
    let voiceReason: VoiceStoreReason | null = null;

    if (tooLong) {
      voiceReason = 'too-long';
    } else if (!transcriber) {
      voiceReason = 'disabled';
    } else if (!isSupportedAudioMime(voice.mime_type)) {
      voiceReason = 'unsupported';
    } else {
      try {
        const filePath = await client.getFilePath(voice.file_id);
        audio = await client.downloadFile(filePath, ctx.config.stt.maxAudioBytes);
        const result = await transcriber.transcribe({
          audio,
          fileName: `voice-${message.message_id}${audioFileExtension(voice.mime_type)}`,
          mimeType,
          durationSeconds: voice.duration,
        });
        // Overflow policy: reject an over-limit transcript rather than truncate
        // it silently. The capture is still stored below with the caption or the
        // voice placeholder; only the transcript is omitted.
        const normalised = normaliseTranscription(result.text);
        transcript = normalised.transcript;
        sttProvider = result.provider;
        sttModel = result.model;
        if (normalised.overflow) voiceReason = 'transcript-too-long';
        else if (!transcript) voiceReason = 'empty';
      } catch (error) {
        voiceReason = 'failed';
        // Never log audio, file ids or provider credentials — only the reason.
        ctx.logger.warn('voice transcription failed', {
          chatId,
          messageId: message.message_id,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Caption first (the owner's own framing), transcript second (untrusted
    // speech output). `composeVoiceText` removes exact duplication.
    const classificationText = composeVoiceText(caption, transcript);

    const outcome = await ingestCapture(
      ctx,
      {
        rawText: caption || VOICE_PLACEHOLDER,
        source: 'TELEGRAM',
        externalId,
        occurredAt: occurredAtFor(message),
        sourceRef: String(chatId),
        metadata: {
          ...telegramMetadata(message),
          voice: {
            fileId: voice.file_id,
            durationSeconds: voice.duration,
            mimeType: voice.mime_type ?? null,
            transcribed: transcript !== null,
            transcriptSource: transcript ? 'SPEECH_PROVIDER' : null,
            sttProvider,
            sttModel,
            status: transcript ? 'transcribed' : (voiceReason ?? 'disabled'),
          },
        },
        transcript,
        transcriptSource: transcript ? 'SPEECH_PROVIDER' : null,
      },
      // With no caption and no transcript there is nothing to interpret: the
      // placeholder must never be classified into a bogus task.
      classificationText ? { classificationText } : { captureOnly: true, skipAi: true },
    );

    if (!classificationText && !outcome.duplicate) {
      await ctx.db.capture.update({
        where: { id: outcome.capture.id },
        data: {
          kind: 'UNKNOWN',
          status: 'NEEDS_REVIEW',
          needsReview: true,
          classificationRationale: `Voice message stored without a transcript (${voiceReason ?? 'disabled'})`,
          processedAt: ctx.clock.now(),
        },
      });
    }

    if (audio && ctx.config.stt.retainAudio) {
      const mediaRef = await retainAudio(outcome.capture.id, audio, voice.mime_type);
      if (mediaRef) {
        try {
          await ctx.db.capture.update({
            where: { id: outcome.capture.id },
            data: { mediaRef },
          });
        } catch (error) {
          ctx.logger.warn('failed to record retained audio path', {
            captureId: outcome.capture.id,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    if (classificationText) {
      const note = transcript === null ? voiceCaptionNote(voiceReason) : null;
      await sendConfirmation(chatId, outcome, note ?? undefined);
    } else {
      await sendText(chatId, formatVoiceStored(voice.duration, voiceReason ?? 'disabled'));
    }

    return { handled: true, captureId: outcome.capture.id, duplicate: outcome.duplicate };
  }

  /**
   * A caption can always be classified, but the owner should still know that the
   * audio itself was not transcribed and why. The reply never pretends the text
   * came from speech.
   */
  function voiceCaptionNote(reason: VoiceStoreReason | null): string | null {
    switch (reason) {
      case 'disabled':
        return 'Transcription is not configured, so I organised your caption instead. Your audio message is stored, untranscribed.';
      case 'too-long':
        return 'The clip is longer than the transcription limit, so I organised your caption instead. Your audio message is stored, untranscribed.';
      case 'unsupported':
        return 'That audio format is not supported for transcription, so I organised your caption instead. Your audio message is stored.';
      case 'failed':
        return 'The audio could not be transcribed, so I organised your caption instead. Your audio message is still stored.';
      case 'empty':
        return 'The audio contained no recognisable speech, so I organised your caption instead.';
      case 'transcript-too-long':
        return 'The transcript was longer than the 8,000-character limit, so I did not store it. I organised your caption instead.';
      default:
        return null;
    }
  }

  /**
   * Persists audio only when the owner explicitly opted in.
   *
   * Returns the stored reference, or null when retention failed (which must not
   * fail the capture). The path is relative to the working directory when
   * possible so exports and logs do not leak absolute machine paths.
   */
  async function retainAudio(
    captureId: string,
    bytes: Uint8Array,
    mimeType: string | null | undefined,
  ): Promise<string | null> {
    try {
      const directory = path.resolve(ctx.config.stt.audioDir);
      await fs.mkdir(directory, { recursive: true });
      const file = path.join(directory, `${captureId}${audioFileExtension(mimeType)}`);
      await fs.writeFile(file, bytes, { flag: 'wx' });
      const relative = path.relative(process.cwd(), file);
      return relative.startsWith('..') || path.isAbsolute(relative) ? file : relative;
    } catch (error) {
      ctx.logger.warn('failed to retain voice audio', {
        captureId,
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
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

  /**
   * Builds a duplicate outcome for an already-stored capture, so replay replies
   * use exactly the same confirmation format without re-running ingestion.
   */
  function outcomeForExistingCapture(capture: CaptureDto): IngestOutcome {
    return {
      capture,
      created: capture.links,
      duplicate: true,
      classification: null,
      provider: null,
      aiError: null,
      needsReview: capture.needsReview,
      processingError: null,
      remindersScheduled: 0,
      dedupeSuspicion: null,
      clarification: null,
      transcript: capture.transcript,
      transcriptSource: capture.transcriptSource,
    };
  }

  async function sendConfirmation(
    chatId: number,
    outcome: IngestOutcome,
    note?: string,
  ): Promise<void> {
    const confirmation = formatCaptureConfirmation(outcome, {
      timeZone: await displayZone(),
      referenceNow: ctx.clock.now(),
    });
    const text = note ? `${confirmation}\n\n${note}` : confirmation;
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
