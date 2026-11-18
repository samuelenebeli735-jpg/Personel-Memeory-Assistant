import { TRANSCRIPT_MAX_CHARS } from '@recall/shared';

/**
 * Voice-capture text composition.
 *
 * A Telegram voice message has two independent content sources:
 *  - the caption the user typed (user-authored, trustworthy as intent);
 *  - the transcript produced by a speech-to-text provider (untrusted input).
 *
 * Recall keeps them separate in storage: `rawText` stays exactly what the user
 * typed (or a neutral placeholder when they typed nothing), and the transcript
 * lives in `transcript` with explicit provenance. For classification the two are
 * combined here, caption first, so neither source is silently dropped.
 */

export const VOICE_PLACEHOLDER = '[voice message — not transcribed yet]';

/**
 * Explicit overflow policy: reject the transcript, keep the capture.
 *
 * A transcript longer than the shared schema allows is not stored at all. It is
 * never silently truncated and never labelled as a successful transcription;
 * the caption (or the voice placeholder) remains the capture's raw text and the
 * caller tells the owner that the transcript was too long.
 */
export function normaliseTranscription(text: string): {
  transcript: string | null;
  overflow: boolean;
} {
  const trimmed = text.trim();
  if (trimmed.length > TRANSCRIPT_MAX_CHARS) {
    return { transcript: null, overflow: true };
  }
  return { transcript: trimmed || null, overflow: false };
}

function normalise(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Combines a caption and a transcript without duplicating content.
 *
 * If one already contains the other (the provider repeated the caption, or the
 * user typed the same words), the longer text wins. Otherwise the caption is
 * kept first because it carries the user's own framing.
 */
export function composeVoiceText(caption: string | null | undefined, transcript: string | null | undefined): string {
  const typed = (caption ?? '').trim();
  const spoken = (transcript ?? '').trim();
  if (!typed) return spoken;
  if (!spoken) return typed;
  const a = normalise(typed);
  const b = normalise(spoken);
  if (a === b || b.includes(a)) return spoken;
  if (a.includes(b)) return typed;
  return `${typed}\n\n${spoken}`;
}

/** The text Recall may classify for a stored capture (caption + transcript). */
export function contentTextForCapture(capture: {
  rawText: string;
  transcript: string | null;
}): string {
  const caption = capture.rawText === VOICE_PLACEHOLDER ? '' : capture.rawText;
  return composeVoiceText(caption, capture.transcript) || capture.rawText;
}
