/**
 * Shared Round 2 patterns: page header, pagination, state views, offline
 * banner, confirmation and form dialogs. Every new and updated screen builds
 * on these so behaviour is the same everywhere.
 */
import { forwardRef, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Button } from './ui'
import { Dialog } from './Dialog'
import { useOnline } from '../hooks/useOnline'
import { pageWindow, rangeLabel, totalPages } from '../lib/pagination'
import { describeError } from '../lib/errors'

/* -------------------------------------------------------------------------- */
/* Page header                                                                 */
/* -------------------------------------------------------------------------- */

export const PageHeader = forwardRef<
  HTMLHeadingElement,
  { title: ReactNode; sub?: ReactNode; actions?: ReactNode }
>(({ title, sub, actions }, ref) => (
  <div className="page-header">
    <div>
      {/* tabIndex -1 lets pagination and deletions move focus to the heading. */}
      <h1 ref={ref} tabIndex={-1}>
        {title}
      </h1>
      {sub && <div className="page-header-sub">{sub}</div>}
    </div>
    {actions && <div className="page-header-actions">{actions}</div>}
  </div>
))
PageHeader.displayName = 'PageHeader'

/* -------------------------------------------------------------------------- */
/* Pagination                                                                  */
/* -------------------------------------------------------------------------- */

export function Pagination({
  page,
  total,
  pageSize,
  onPageChange,
}: {
  page: number
  total: number
  pageSize: number
  onPageChange: (page: number) => void
}) {
  const pages = totalPages(total, pageSize)
  if (total <= pageSize && page === 1) {
    return total > 0 ? (
      <div className="pagination pagination-single">
        <span className="pagination-range tabular">{rangeLabel(1, total, pageSize)}</span>
      </div>
    ) : null
  }
  return (
    <nav className="pagination" aria-label="Pagination">
      <span className="pagination-range tabular">{rangeLabel(page, total, pageSize)}</span>
      <div className="pagination-pages">
        <button
          type="button"
          className="pagination-button"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          <span aria-hidden="true">‹</span>
        </button>
        {pageWindow(page, pages).map((item, index) =>
          item === 'gap' ? (
            <span key={`gap-${index}`} className="pagination-gap" aria-hidden="true">
              …
            </span>
          ) : (
            <button
              key={item}
              type="button"
              className="pagination-button"
              aria-label={`Page ${item}`}
              aria-current={item === page ? 'page' : undefined}
              onClick={() => onPageChange(item)}
            >
              {item}
            </button>
          ),
        )}
        <button
          type="button"
          className="pagination-button"
          aria-label="Next page"
          disabled={page >= pages}
          onClick={() => onPageChange(page + 1)}
        >
          <span aria-hidden="true">›</span>
        </button>
      </div>
      <div className="pagination-compact">
        <Button type="button" variant="secondary" size="sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
          Previous
        </Button>
        <span className="tabular">
          Page {page} of {pages}
        </span>
        <Button type="button" variant="secondary" size="sm" disabled={page >= pages} onClick={() => onPageChange(page + 1)}>
          Next
        </Button>
      </div>
    </nav>
  )
}

/** Toast text for a list that moved because its page no longer exists. */
export function clampedPageMessage(from: number, to: number): string {
  return `Page ${from} no longer exists, so you’re now on page ${to}.`
}

/* -------------------------------------------------------------------------- */
/* State views                                                                 */
/* -------------------------------------------------------------------------- */

export function LoadingState({ label, rows = 4 }: { label: string; rows?: number }) {
  return (
    <div className="state-view">
      <div role="status" className="state-loading-label">
        {label}
      </div>
      <div className="skeleton" aria-hidden="true">
        {Array.from({ length: rows }, (_, i) => (
          <span key={i} style={{ width: `${92 - ((i * 17) % 40)}%` }} />
        ))}
      </div>
    </div>
  )
}

export function ErrorState({
  title,
  message,
  code,
  onRetry,
}: {
  title: string
  message: string
  code?: string
  onRetry?: () => void
}) {
  return (
    <div className="state-view state-error" role="alert">
      <strong>{title}</strong>
      <span>{message}</span>
      {code && <span className="state-code">Code: {code}</span>}
      {onRetry && (
        <div>
          <Button type="button" variant="secondary" size="sm" onClick={onRetry}>
            Try again
          </Button>
        </div>
      )}
    </div>
  )
}

/**
 * The body of a list: first-load skeleton, an error panel with Retry (never a
 * silent console error), the empty state, or the rows. While a later page
 * loads, the previous rows stay visible.
 */
export function ListState<T>({
  status,
  error,
  items,
  noun,
  empty,
  onRetry,
  children,
}: {
  status: 'loading' | 'ready' | 'error'
  error: unknown
  items: T[]
  /** Plural, lower case: "tasks". */
  noun: string
  empty: ReactNode
  onRetry: () => void
  children: (items: T[]) => ReactNode
}) {
  if (status === 'error') {
    const described = describeError(error, `Loading ${noun}`)
    return (
      <div style={{ padding: 16 }}>
        <ErrorState title={`Couldn’t load ${noun}`} message={described.message} code={described.code} onRetry={onRetry} />
      </div>
    )
  }
  if (status === 'loading' && items.length === 0) {
    return (
      <div style={{ padding: 16 }}>
        <LoadingState label={`Loading ${noun}…`} />
      </div>
    )
  }
  if (items.length === 0) return <>{empty}</>
  return <div aria-busy={status === 'loading'}>{children(items)}</div>
}

/* -------------------------------------------------------------------------- */
/* Offline banner                                                              */
/* -------------------------------------------------------------------------- */

export function OfflineBanner() {
  const { online, reason, checkNow } = useOnline()
  if (online) return null
  return (
    <div className="offline-banner" role="status">
      <strong>{reason === 'device' ? 'You’re offline.' : 'Can’t reach Recall.'}</strong>{' '}
      Changes are paused; what you’ve already loaded is still here.
      {reason === 'unreachable' && (
        <>
          {' '}
          <Button type="button" variant="secondary" size="sm" onClick={checkNow}>
            Check again
          </Button>
        </>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Form errors                                                                 */
/* -------------------------------------------------------------------------- */

export interface FieldError {
  fieldId: string
  message: string
}

/** Summary at the top of a form; each item links to its field. */
export function FormErrorSummary({
  errors,
  serverError,
}: {
  errors?: FieldError[]
  serverError?: string | null
}) {
  const list = errors ?? []
  if (list.length === 0 && !serverError) return null
  return (
    <div className="form-summary" role="alert">
      {serverError && <p className="form-summary-server">{serverError}</p>}
      {list.length > 0 && (
        <>
          <p>
            {list.length === 1 ? 'Fix 1 field to continue:' : `Fix ${list.length} fields to continue:`}
          </p>
          <ul>
            {list.map((error) => (
              <li key={error.fieldId}>
                <a
                  href={`#${error.fieldId}`}
                  onClick={(event) => {
                    event.preventDefault()
                    document.getElementById(error.fieldId)?.focus()
                  }}
                >
                  {error.message}
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Confirmation dialog                                                         */
/* -------------------------------------------------------------------------- */

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'danger',
  typedConfirmation,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  children: ReactNode
  confirmLabel: string
  cancelLabel?: string
  tone?: 'danger' | 'default'
  /** When set (for example "delete"), the user must type it before confirming. */
  typedConfirmation?: string
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const typedRef = useRef<HTMLInputElement>(null)
  const bodyId = useId()
  const inputId = useId()
  const [typed, setTyped] = useState('')
  useEffect(() => {
    if (open) setTyped('')
  }, [open])
  const ready = !typedConfirmation || typed.trim().toLowerCase() === typedConfirmation.toLowerCase()

  return (
    <Dialog
      open={open}
      title={title}
      role="alertdialog"
      describedById={bodyId}
      showCloseButton={false}
      // The safe choice takes focus; a typed confirmation focuses its field.
      initialFocusRef={typedConfirmation ? typedRef : cancelRef}
      onRequestClose={() => {
        if (!busy) onCancel()
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (ready && !busy) onConfirm()
        }}
      >
        <div className="modal-body">
          <div id={bodyId} className="confirm-body">
            {children}
          </div>
          {typedConfirmation && (
            <div className="form-group">
              <label htmlFor={inputId} className="form-label">
                Type <strong>{typedConfirmation}</strong> to confirm
              </label>
              <input
                ref={typedRef}
                id={inputId}
                autoComplete="off"
                spellCheck={false}
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
              />
            </div>
          )}
        </div>
        <div className="modal-footer">
          <Button ref={cancelRef} type="button" variant="secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button type="submit" variant={tone === 'danger' ? 'danger' : 'primary'} disabled={!ready} loading={busy}>
            {confirmLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

/* -------------------------------------------------------------------------- */
/* Form dialog                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Create and edit forms share this shell: one submit path, a busy state that
 * disables the button, a field-error summary, server errors that keep the
 * typed text, writes paused while offline, and an unsaved-changes guard on
 * Cancel, Close, Escape and the backdrop.
 */
export function FormDialog({
  open,
  title,
  submitLabel,
  dirty,
  busy,
  errors,
  serverError,
  onSubmit,
  onClose,
  children,
}: {
  open: boolean
  title: string
  submitLabel: string
  dirty: boolean
  busy: boolean
  errors?: FieldError[]
  serverError?: string | null
  onSubmit: () => void
  onClose: () => void
  children: ReactNode
}) {
  const { online } = useOnline()
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)
  const keepEditingRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) setConfirmingDiscard(false)
  }, [open])
  useEffect(() => {
    if (confirmingDiscard) keepEditingRef.current?.focus()
  }, [confirmingDiscard])

  const requestClose = () => {
    if (busy) return
    if (confirmingDiscard) {
      // Escape while the question is showing means "keep editing".
      setConfirmingDiscard(false)
      return
    }
    if (dirty) setConfirmingDiscard(true)
    else onClose()
  }

  return (
    <Dialog open={open} title={title} onRequestClose={requestClose}>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          if (!busy && online) onSubmit()
        }}
      >
        <div className="modal-body">
          <FormErrorSummary errors={errors} serverError={serverError} />
          {children}
        </div>
        {confirmingDiscard ? (
          <div className="modal-footer inline-confirm" role="group" aria-label="Discard your changes?">
            <span className="inline-confirm-text">Discard your changes?</span>
            <Button ref={keepEditingRef} type="button" variant="secondary" onClick={() => setConfirmingDiscard(false)}>
              Keep editing
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={() => {
                setConfirmingDiscard(false)
                onClose()
              }}
            >
              Discard
            </Button>
          </div>
        ) : (
          <div className="modal-footer">
            {!online && <span className="form-offline-note">Offline: saving is paused.</span>}
            <Button type="button" variant="secondary" onClick={requestClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={!online}>
              {submitLabel}
            </Button>
          </div>
        )}
      </form>
    </Dialog>
  )
}
