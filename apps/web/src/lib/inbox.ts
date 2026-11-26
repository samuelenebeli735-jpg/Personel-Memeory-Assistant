/**
 * Inbox review rules (R2-03, refinement 1), kept pure for unit tests.
 */
import type { CaptureDto } from './api'

/** The server allows a one-click Undo for 15 minutes from the capture's creation. */
export const UNDO_WINDOW_MS = 15 * 60 * 1000

export const INBOX_CHANGED_EVENT = 'recall:inbox-changed'

/** Lets the navigation badge refresh after any inbox action. */
export function notifyInboxChanged(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(INBOX_CHANGED_EVENT))
}

/**
 * Whole minutes of the Undo window left (rounded up), or 0 once it has passed.
 * The server decides in the end: if the clocks disagree, the refusal leads to
 * the confirmation instead of an error.
 */
export function undoMinutesLeft(createdAt: string, now: number = Date.now()): number {
  const created = Date.parse(createdAt)
  if (Number.isNaN(created)) return 0
  const left = created + UNDO_WINDOW_MS - now
  return left > 0 ? Math.ceil(left / 60_000) : 0
}

export function confidenceLabel(confidence: number): 'low' | 'medium' | 'high' {
  if (confidence < 0.5) return 'low'
  if (confidence < 0.8) return 'medium'
  return 'high'
}

export type ConvertKind = 'TASK' | 'NOTE' | 'IDEA' | 'EVENT'
export const CONVERT_KINDS: ConvertKind[] = ['TASK', 'NOTE', 'IDEA', 'EVENT']

/** The kind Recall guessed, when it is one the owner can keep. */
export function guessedKind(capture: Pick<CaptureDto, 'kind'>): ConvertKind | null {
  return (CONVERT_KINDS as string[]).includes(capture.kind) ? (capture.kind as ConvertKind) : null
}

export function kindLabel(kind: string): string {
  return kind.charAt(0) + kind.slice(1).toLowerCase()
}

/**
 * J and K move through the list only when nothing else wants the key: no
 * modifier is held and focus is not in a field, an editable element or a dialog.
 */
export function isListShortcut(event: {
  key: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  target: { tagName?: string; isContentEditable?: boolean; closest?: (selector: string) => unknown } | null
}): 'next' | 'previous' | null {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null
  const key = event.key.toLowerCase()
  if (key !== 'j' && key !== 'k') return null
  const target = event.target
  const tag = target?.tagName?.toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return null
  if (target?.closest?.('[role="dialog"], [role="alertdialog"]')) return null
  return key === 'j' ? 'next' : 'previous'
}

/** After a capture leaves the list, select the one that took its place. */
export function selectionAfterRemoval(ids: string[], removedId: string): string | null {
  const index = ids.indexOf(removedId)
  const remaining = ids.filter((id) => id !== removedId)
  if (remaining.length === 0) return null
  if (index < 0) return remaining[0] ?? null
  return remaining[Math.min(index, remaining.length - 1)] ?? null
}
