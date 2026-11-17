/**
 * Capture content presentation.
 *
 * The server keeps the owner's words (`rawText`) separate from speech-to-text
 * output (`transcript` + `transcriptSource`). `isVoice` is the safe flag that
 * lets the dashboard tell a caption-only voice note from a typed message without
 * exposing adapter metadata.
 */
import type { CaptureDto } from '../types/api'

/** Mirrors the server's stored placeholder; it is never rendered as content. */
export const VOICE_PLACEHOLDER = '[voice message — not transcribed yet]'

export type CaptureContent =
  | {
      kind: 'transcript'
      transcript: string
      transcriptLabel: string
      caption: string | null
    }
  | { kind: 'caption-only'; caption: string }
  | { kind: 'text'; text: string }
  | { kind: 'unavailable' }

export function isVoicePlaceholder(rawText: string | null | undefined): boolean {
  return (rawText ?? '').trim() === VOICE_PLACEHOLDER
}

function transcriptLabel(source: CaptureDto['transcriptSource']): string {
  if (source === 'SPEECH_PROVIDER') return 'Speech-to-text transcript'
  if (source === 'MANUAL') return 'Manual transcript'
  return 'Transcript'
}

/** A safe one-line title; the stored placeholder is never used as content. */
export function captureDisplayTitle(
  capture: Pick<CaptureDto, 'rawText' | 'transcript' | 'isVoice'>,
): string {
  if (!isVoicePlaceholder(capture.rawText) && capture.rawText.trim()) {
    return capture.rawText.trim().split('\n')[0]?.slice(0, 120) || 'Capture'
  }
  if (capture.transcript?.trim()) {
    return capture.transcript.trim().split('\n')[0]?.slice(0, 120) || 'Voice capture'
  }
  return isVoicePlaceholder(capture.rawText) || capture.isVoice
    ? 'Voice capture — transcript unavailable'
    : 'Capture'
}

export function captureContent(
  capture: Pick<CaptureDto, 'rawText' | 'transcript' | 'transcriptSource' | 'isVoice'>,
): CaptureContent {
  const transcript = capture.transcript?.trim() ? capture.transcript : null
  const caption = isVoicePlaceholder(capture.rawText) || !capture.rawText.trim()
    ? null
    : capture.rawText

  if (transcript) {
    return {
      kind: 'transcript',
      transcript,
      transcriptLabel: transcriptLabel(capture.transcriptSource),
      caption,
    }
  }

  if (isVoicePlaceholder(capture.rawText)) {
    return { kind: 'unavailable' }
  }

  if (capture.isVoice) {
    return caption ? { kind: 'caption-only', caption } : { kind: 'unavailable' }
  }

  return { kind: 'text', text: capture.rawText }
}
