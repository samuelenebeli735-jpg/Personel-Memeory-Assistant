import { describe, expect, it } from 'vitest'
import { captureContent, captureDisplayTitle, isVoicePlaceholder, VOICE_PLACEHOLDER } from './capture-content'
import { captureFixture } from '../test/fixtures'

describe('capture content', () => {
  it('labels speech-provider output distinctly from a user caption', () => {
    const content = captureContent(captureFixture({
      isVoice: true,
      rawText: 'Call Ada about the launch',
      transcript: 'remind me to call Ada about the launch tomorrow',
      transcriptSource: 'SPEECH_PROVIDER',
    }))

    expect(content).toEqual({
      kind: 'transcript',
      transcript: 'remind me to call Ada about the launch tomorrow',
      transcriptLabel: 'Speech-to-text transcript',
      caption: 'Call Ada about the launch',
    })
  })

  it('labels a manually supplied transcript as manual', () => {
    const content = captureContent(captureFixture({
      isVoice: true,
      rawText: VOICE_PLACEHOLDER,
      transcript: 'A corrected transcript',
      transcriptSource: 'MANUAL',
    }))

    expect(content).toMatchObject({
      kind: 'transcript',
      transcriptLabel: 'Manual transcript',
      caption: null,
    })
  })

  it('keeps a caption-only voice capture honest about the missing transcript', () => {
    const content = captureContent(captureFixture({
      isVoice: true,
      rawText: 'Call Ada tomorrow',
      transcript: null,
      transcriptSource: null,
    }))

    expect(content).toEqual({ kind: 'caption-only', caption: 'Call Ada tomorrow' })
  })

  it('never returns the stored placeholder as voice content', () => {
    const content = captureContent(captureFixture({
      isVoice: true,
      rawText: VOICE_PLACEHOLDER,
      transcript: null,
      transcriptSource: null,
    }))

    expect(content).toEqual({ kind: 'unavailable' })
    expect(isVoicePlaceholder(VOICE_PLACEHOLDER)).toBe(true)
    expect(captureDisplayTitle(captureFixture({
      isVoice: true,
      rawText: VOICE_PLACEHOLDER,
      transcript: null,
    }))).toBe('Voice capture — transcript unavailable')
  })

  it('treats the stored placeholder as unavailable even without voice metadata', () => {
    const capture = captureFixture({
      isVoice: false,
      rawText: VOICE_PLACEHOLDER,
      transcript: null,
    })

    expect(captureContent(capture)).toEqual({ kind: 'unavailable' })
    expect(captureDisplayTitle(capture)).toBe('Voice capture — transcript unavailable')
  })

  it('renders an ordinary typed capture as captured text, not a caption', () => {
    const content = captureContent(captureFixture({
      isVoice: false,
      rawText: 'Remember the launch checklist',
    }))

    expect(content).toEqual({ kind: 'text', text: 'Remember the launch checklist' })
  })
})
