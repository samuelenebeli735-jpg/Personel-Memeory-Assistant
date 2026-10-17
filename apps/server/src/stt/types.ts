/**
 * Speech-to-text contract.
 *
 * Transcription is optional: when no provider is configured, voice messages are
 * stored with a clear "not transcribed" status instead of failing.
 */

export interface TranscriptionRequest {
  audio: Uint8Array;
  fileName: string;
  mimeType: string;
  /** Duration as reported by the messaging platform, when known. */
  durationSeconds?: number;
  /** ISO-639-1 hint. */
  language?: string;
}

export interface TranscriptionResult {
  text: string;
  provider: string;
  model: string;
  language?: string;
  durationSeconds?: number;
}

export interface Transcriber {
  readonly name: string;
  readonly model: string | null;
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
}

export const NOT_TRANSCRIBED_MARKER = '[voice message not transcribed]';
