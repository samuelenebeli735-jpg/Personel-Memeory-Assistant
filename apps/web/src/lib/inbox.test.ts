import { describe, expect, it } from 'vitest'
import { confidenceLabel, guessedKind, isListShortcut, selectionAfterRemoval, undoMinutesLeft } from './inbox'

const key = (k: string, extra: Partial<Parameters<typeof isListShortcut>[0]> = {}) => ({
  key: k,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  target: { tagName: 'BUTTON', closest: () => null },
  ...extra,
})

describe('inbox rules', () => {
  it('counts the Undo minutes left from the capture’s creation', () => {
    const created = '2026-11-24T10:00:00.000Z'
    const at = (iso: string) => Date.parse(iso)
    expect(undoMinutesLeft(created, at('2026-11-24T10:00:00.000Z'))).toBe(15)
    expect(undoMinutesLeft(created, at('2026-11-24T10:06:00.000Z'))).toBe(9)
    expect(undoMinutesLeft(created, at('2026-11-24T10:14:30.000Z'))).toBe(1)
    expect(undoMinutesLeft(created, at('2026-11-24T10:15:00.000Z'))).toBe(0)
    expect(undoMinutesLeft(created, at('2026-11-24T12:00:00.000Z'))).toBe(0)
    expect(undoMinutesLeft('not a date', at('2026-11-24T10:00:00.000Z'))).toBe(0)
  })

  it('describes confidence in words', () => {
    expect(confidenceLabel(0.3)).toBe('low')
    expect(confidenceLabel(0.6)).toBe('medium')
    expect(confidenceLabel(0.95)).toBe('high')
  })

  it('offers "Keep as" only for kinds that can be kept', () => {
    expect(guessedKind({ kind: 'EVENT' })).toBe('EVENT')
    expect(guessedKind({ kind: 'UNKNOWN' })).toBeNull()
    expect(guessedKind({ kind: 'OTHER' })).toBeNull()
  })

  it('fires J and K only outside fields and dialogs, with no modifier', () => {
    expect(isListShortcut(key('j'))).toBe('next')
    expect(isListShortcut(key('K'))).toBe('previous')
    expect(isListShortcut(key('x'))).toBeNull()
    expect(isListShortcut(key('j', { ctrlKey: true }))).toBeNull()
    expect(isListShortcut(key('j', { shiftKey: true }))).toBeNull()
    expect(isListShortcut(key('j', { target: { tagName: 'INPUT' } }))).toBeNull()
    expect(isListShortcut(key('j', { target: { tagName: 'TEXTAREA' } }))).toBeNull()
    expect(isListShortcut(key('j', { target: { tagName: 'DIV', isContentEditable: true } }))).toBeNull()
    expect(isListShortcut(key('j', { target: { tagName: 'BUTTON', closest: () => ({}) } }))).toBeNull()
  })

  it('selects the capture that took the removed one’s place', () => {
    expect(selectionAfterRemoval(['a', 'b', 'c'], 'b')).toBe('c')
    expect(selectionAfterRemoval(['a', 'b', 'c'], 'c')).toBe('b')
    expect(selectionAfterRemoval(['a'], 'a')).toBeNull()
  })
})
