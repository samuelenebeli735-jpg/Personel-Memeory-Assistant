import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

/**
 * The one dialog primitive (R2-07, refinement 6).
 *
 * - Focus moves in: `initialFocusRef`, else the first form field, else the
 *   first focusable control. It returns to the opener when the dialog closes.
 * - Tab and Shift+Tab are trapped inside.
 * - Escape, the Close button and a click on the backdrop all call
 *   `onRequestClose`; the owner decides (for example, to ask about unsaved
 *   changes first).
 * - Dialogs stack: only the top one reacts to the keyboard, so a confirmation
 *   opened from a form dialog behaves on its own.
 * - Rendered into `document.body` so a parent's transform or overflow can never
 *   clip or reposition it.
 */

const FIELD_SELECTOR =
  'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled])'
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

const openDialogs: symbol[] = []

export interface DialogProps {
  open: boolean
  title: string
  onRequestClose: () => void
  children: ReactNode
  initialFocusRef?: RefObject<HTMLElement | null>
  /** Confirmations use `alertdialog`. */
  role?: 'dialog' | 'alertdialog'
  describedById?: string
  showCloseButton?: boolean
  className?: string
}

export function Dialog({
  open,
  title,
  onRequestClose,
  children,
  initialFocusRef,
  role = 'dialog',
  describedById,
  showCloseButton = true,
  className = '',
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const token = useRef(Symbol('dialog'))
  const requestClose = useRef(onRequestClose)
  requestClose.current = onRequestClose

  useEffect(() => {
    if (!open) return undefined
    const opener = document.activeElement as HTMLElement | null
    const me = token.current
    openDialogs.push(me)

    const panel = panelRef.current
    const target =
      initialFocusRef?.current ??
      panel?.querySelector<HTMLElement>(FIELD_SELECTOR) ??
      panel?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ??
      panel
    target?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (openDialogs[openDialogs.length - 1] !== me || !panel) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        requestClose.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (element) => element.offsetParent !== null || element === document.activeElement,
      )
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!first || !last) {
        event.preventDefault()
        return
      }
      const active = document.activeElement
      if (event.shiftKey) {
        if (active === first || !panel.contains(active)) {
          event.preventDefault()
          last.focus()
        }
      } else if (active === last || !panel.contains(active)) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      const index = openDialogs.lastIndexOf(me)
      if (index >= 0) openDialogs.splice(index, 1)
      // The opener may have gone (for example, a deleted row); the caller then
      // moves focus somewhere sensible itself.
      if (opener && opener.isConnected) opener.focus()
    }
    // Focus handling runs once per opening; the latest close handler is read
    // through the ref.
  }, [open])

  if (!open) return null

  const content = (
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose.current()
      }}
    >
      <div
        ref={panelRef}
        className={`modal ${className}`.trim()}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedById}
        tabIndex={-1}
      >
        <div className="modal-header">
          <h2 id={titleId} className="modal-title">
            {title}
          </h2>
          {showCloseButton && (
            <button
              type="button"
              className="modal-close"
              onClick={() => requestClose.current()}
              aria-label="Close"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
        {children}
      </div>
    </div>
  )

  return typeof document === 'undefined' ? content : createPortal(content, document.body)
}
