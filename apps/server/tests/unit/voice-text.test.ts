/**
 * Unit tests for the voice/AI text helpers.
 *
 * These cover the pieces the Telegram integration tests rely on: how a caption
 * and a transcript are combined, which audio formats are allowed through, and
 * the properties the AI cache key must have (stable for equal inputs, different
 * across content, configuration and reference instant).
 */
import { describe, expect, it } from 'vitest';

import { captureInputSchema, TRANSCRIPT_MAX_CHARS } from '@recall/shared';

import { audioFileExtension, isSupportedAudioMime } from '../../src/lib/audio.js';
import {
  composeVoiceText,
  contentTextForCapture,
  normaliseTranscription,
  VOICE_PLACEHOLDER,
} from '../../src/lib/voice.js';
import { classificationCacheKey } from '../../src/services/classification-service.js';

describe('composeVoiceText', () => {
  it('returns the transcript when there is no caption', () => {
    expect(composeVoiceText('', 'call the plumber')).toBe('call the plumber');
    expect(composeVoiceText(null, 'call the plumber')).toBe('call the plumber');
  });

  it('returns the caption when there is no transcript', () => {
    expect(composeVoiceText('call the plumber', null)).toBe('call the plumber');
  });

  it('keeps the caption first and the transcript second', () => {
    expect(composeVoiceText('landlord', 'email about the broken boiler')).toBe(
      'landlord\n\nemail about the broken boiler',
    );
  });

  it('does not duplicate identical content', () => {
    expect(composeVoiceText('buy milk', 'Buy milk!')).toBe('Buy milk!');
  });

  it('collapses the shorter text when one contains the other', () => {
    expect(composeVoiceText('buy', 'buy milk tomorrow')).toBe('buy milk tomorrow');
    expect(composeVoiceText('buy milk tomorrow please', 'buy milk')).toBe(
      'buy milk tomorrow please',
    );
  });

  it('returns an empty string when neither source has content', () => {
    expect(composeVoiceText('', null)).toBe('');
    expect(composeVoiceText('   ', '  ')).toBe('');
  });
});

describe('contentTextForCapture', () => {
  it('uses the caption plus transcript for a voice capture', () => {
    expect(contentTextForCapture({ rawText: 'landlord', transcript: 'email about the boiler' })).toBe(
      'landlord\n\nemail about the boiler',
    );
  });

  it('ignores the placeholder and uses the transcript', () => {
    expect(contentTextForCapture({ rawText: VOICE_PLACEHOLDER, transcript: 'call mum' })).toBe(
      'call mum',
    );
  });

  it('falls back to the raw text when there is no transcript', () => {
    expect(contentTextForCapture({ rawText: 'a plain note', transcript: null })).toBe('a plain note');
    expect(contentTextForCapture({ rawText: VOICE_PLACEHOLDER, transcript: null })).toBe(
      VOICE_PLACEHOLDER,
    );
  });
});

describe('normaliseTranscription', () => {
  it('trims and accepts a transcript at the schema limit', () => {
    const atLimit = 'a'.repeat(TRANSCRIPT_MAX_CHARS);
    expect(normaliseTranscription(`  ${atLimit}  `)).toEqual({
      transcript: atLimit,
      overflow: false,
    });
  });

  it('rejects an oversized transcript instead of truncating it', () => {
    expect(normaliseTranscription('a'.repeat(TRANSCRIPT_MAX_CHARS + 1))).toEqual({
      transcript: null,
      overflow: true,
    });
  });

  it('treats an all-whitespace transcript as empty', () => {
    expect(normaliseTranscription('   ')).toEqual({ transcript: null, overflow: false });
  });
});

describe('audio format guards', () => {
  it('accepts the formats the speech provider supports', () => {
    for (const mime of ['audio/ogg', 'audio/opus', 'audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/webm']) {
      expect(isSupportedAudioMime(mime)).toBe(true);
    }
  });

  it('treats a missing mime type as the default OGG (voice notes are Opus)', () => {
    expect(isSupportedAudioMime(undefined)).toBe(true);
    expect(isSupportedAudioMime(null)).toBe(true);
    expect(audioFileExtension(undefined)).toBe('.ogg');
  });

  it('rejects formats it cannot send to the provider', () => {
    expect(isSupportedAudioMime('audio/amr')).toBe(false);
    expect(isSupportedAudioMime('video/mp4')).toBe(false);
    expect(isSupportedAudioMime('application/octet-stream')).toBe(false);
  });

  it('maps known mime types to safe extensions and falls back to .ogg', () => {
    expect(audioFileExtension('audio/ogg')).toBe('.ogg');
    expect(audioFileExtension('audio/mpeg')).toBe('.mp3');
    expect(audioFileExtension('audio/x-m4a')).toBe('.m4a');
    expect(audioFileExtension('audio/unknown')).toBe('.ogg');
  });
});

describe('classificationCacheKey', () => {
  const base = {
    text: 'remind me to call Ada tomorrow',
    hintKind: null,
    timeZone: 'Africa/Lagos',
    morningDefaultTime: '09:00',
    eveningDefaultTime: '19:00',
    knownProjects: ['Home', 'Work'],
    provider: 'openai',
    model: 'gpt-4o-mini',
    referenceNow: new Date('2026-10-17T10:00:00.000Z'),
  };

  it('is stable for equal inputs, including project order', () => {
    expect(classificationCacheKey(base)).toBe(
      classificationCacheKey({ ...base, knownProjects: ['Work', 'Home'] }),
    );
  });

  it('changes when the text changes', () => {
    expect(classificationCacheKey(base)).not.toBe(
      classificationCacheKey({ ...base, text: 'remind me to call Ada today' }),
    );
  });

  it('changes when the classifier configuration changes', () => {
    for (const patch of [
      { hintKind: 'TASK' as const },
      { timeZone: 'Europe/London' },
      { morningDefaultTime: '08:00' },
      { eveningDefaultTime: '20:00' },
      { knownProjects: ['Home'] },
      { provider: 'anthropic' },
      { model: 'claude-3-5-haiku' },
    ]) {
      expect(classificationCacheKey({ ...base, ...patch })).not.toBe(classificationCacheKey(base));
    }
  });

  it('changes when the reference instant changes, even within the same local day', () => {
    const laterSameDay = new Date('2026-10-17T18:00:00.000Z');
    expect(classificationCacheKey({ ...base, referenceNow: laterSameDay })).not.toBe(
      classificationCacheKey(base),
    );
  });

  it('changes across local days as well', () => {
    const nextDay = new Date('2026-10-18T10:00:00.000Z');
    expect(classificationCacheKey({ ...base, referenceNow: nextDay })).not.toBe(
      classificationCacheKey(base),
    );
  });
});

describe('captureInputSchema transcript provenance', () => {
  it('accepts a transcript with an explicit source', () => {
    const parsed = captureInputSchema.safeParse({
      rawText: 'hello',
      source: 'TELEGRAM',
      transcript: 'hello there',
      transcriptSource: 'SPEECH_PROVIDER',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a transcript with no provenance', () => {
    const parsed = captureInputSchema.safeParse({
      rawText: 'hello',
      source: 'TELEGRAM',
      transcript: 'hello there',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown provenance value', () => {
    const parsed = captureInputSchema.safeParse({
      rawText: 'hello',
      source: 'TELEGRAM',
      transcript: 'hello there',
      transcriptSource: 'SPEECH_PROVIDER:openai',
    });
    expect(parsed.success).toBe(false);
  });
});
