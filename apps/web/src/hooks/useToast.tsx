/**
 * One notification system (R2-07).
 *
 * - Success and info toasts close themselves after 5 s (8 s when they carry an
 *   action such as "Open note"); the timer pauses while the pointer is over a
 *   toast or focus is inside it.
 * - Errors and warnings stay until dismissed and are announced assertively.
 * - At most three are visible, newest first.
 * - A toast carries at most one action. Round 2 has no Undo toasts.
 *
 * The two live regions are always in the page so screen readers announce the
 * first toast as reliably as later ones.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

export type ToastType = 'success' | 'error' | 'warning' | 'info'

export interface ToastAction {
  label: string
  /** An in-app link (for example to the record just created). */
  to?: string
  onClick?: () => void
}

export interface ToastOptions {
  action?: ToastAction
}

interface Toast {
  id: string
  type: ToastType
  title: string
  message?: string
  action?: ToastAction
}

interface ToastContextValue {
  toasts: Toast[]
  showToast: (type: ToastType, title: string, message?: string, options?: ToastOptions) => void
  dismissToast: (id: string) => void
}

export const MAX_VISIBLE_TOASTS = 3

/** How long a toast stays, or null when it stays until dismissed. */
export function toastLifetimeMs(type: ToastType, hasAction: boolean): number | null {
  if (type === 'error' || type === 'warning') return null
  return hasAction ? 8000 : 5000
}

const ToastContext = createContext<ToastContextValue | null>(null)

let nextToastId = 0

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id))
  }, [])

  const showToast = useCallback(
    (type: ToastType, title: string, message?: string, options?: ToastOptions) => {
      nextToastId += 1
      const toast: Toast = { id: `toast-${nextToastId}`, type, title, message, action: options?.action }
      // Newest first; older ones beyond the limit are dropped.
      setToasts((prev) => [toast, ...prev].slice(0, MAX_VISIBLE_TOASTS))
    },
    [],
  )

  return (
    <ToastContext.Provider value={{ toasts, showToast, dismissToast }}>
      {children}
      <ToastRegion toasts={toasts} onDismiss={dismissToast} />
    </ToastContext.Provider>
  )
}

export function useToast() {
  const context = useContext(ToastContext)
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider')
  }
  return context
}

function ToastRegion({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  const urgent = toasts.filter((toast) => toast.type === 'error' || toast.type === 'warning')
  const polite = toasts.filter((toast) => toast.type === 'success' || toast.type === 'info')
  return (
    <section className="toast-container" aria-label="Notifications">
      <div className="toast-stack" aria-live="assertive" aria-relevant="additions">
        {urgent.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
        ))}
      </div>
      <div className="toast-stack" aria-live="polite" aria-relevant="additions">
        {polite.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
        ))}
      </div>
    </section>
  )
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  const lifetime = toastLifetimeMs(toast.type, Boolean(toast.action))
  const [paused, setPaused] = useState(false)
  const remaining = useRef(lifetime)
  const startedAt = useRef(0)

  useEffect(() => {
    if (remaining.current === null || paused) return undefined
    startedAt.current = Date.now()
    const timer = window.setTimeout(() => onDismiss(toast.id), remaining.current)
    return () => {
      window.clearTimeout(timer)
      if (remaining.current !== null) {
        remaining.current = Math.max(1000, remaining.current - (Date.now() - startedAt.current))
      }
    }
  }, [paused, toast.id, onDismiss])

  const isUrgent = toast.type === 'error' || toast.type === 'warning'
  return (
    <div
      className={`toast toast-${toast.type}`}
      role={isUrgent ? 'alert' : 'status'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPaused(false)
      }}
    >
      <div className="toast-content">
        <div className="toast-title">{toast.title}</div>
        {toast.message && <div className="toast-message">{toast.message}</div>}
      </div>
      {toast.action && (
        <div className="toast-action">
          {toast.action.to ? (
            <Link className="btn btn-secondary btn-sm" to={toast.action.to} onClick={() => onDismiss(toast.id)}>
              {toast.action.label}
            </Link>
          ) : (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => {
                toast.action?.onClick?.()
                onDismiss(toast.id)
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
      <button type="button" className="toast-close" onClick={() => onDismiss(toast.id)} aria-label={`Dismiss: ${toast.title}`}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  )
}
