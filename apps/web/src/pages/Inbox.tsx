/**
 * Inbox review (R2-03, refinement 1).
 *
 * Captures Recall wasn't sure about wait here for a decision: keep them as a
 * task, note, idea or event; reprocess; Undo (removes what the capture created
 * and hides it; one click inside 15 minutes, confirmed after); or delete
 * permanently (typed confirmation). Two panes on wide screens, list then
 * detail on narrow ones. J and K move through the list.
 */
import { useEffect, useRef, useState } from 'react'
import {
  capturesApi,
  requiresConfirmation,
  type CaptureDto,
} from '../lib/api'
import { usePagedQuery } from '../hooks/usePagedQuery'
import { useToast } from '../hooks/useToast'
import { useOnline } from '../hooks/useOnline'
import { useTimeZone } from '../hooks/useTimeZone'
import { describeError } from '../lib/errors'
import { formatLocalDateTime, formatRelative } from '../lib/date'
import { detailPath } from '../lib/routes'
import { captureContent, captureDisplayTitle } from '../lib/capture-content'
import {
  confidenceLabel,
  CONVERT_KINDS,
  guessedKind,
  isListShortcut,
  kindLabel,
  notifyInboxChanged,
  selectionAfterRemoval,
  undoMinutesLeft,
  type ConvertKind,
} from '../lib/inbox'
import { Button, Card, EmptyState } from '../components/ui'
import { clampedPageMessage, ConfirmDialog, ListState, PageHeader, Pagination } from '../components/patterns'
import { CaptureIcon } from '../components/Layout'

const SOURCE_LABELS: Record<string, string> = {
  TELEGRAM: 'Telegram',
  WEB: 'Dashboard',
  API: 'API',
  CLI: 'Command line',
}

const LINK_TYPES = { TASK: 'task', NOTE: 'note', IDEA: 'idea', EVENT: 'event' } as const

type PendingConfirm =
  | { type: 'convert'; kind: ConvertKind; reason: string }
  | { type: 'undo'; reasons: string[] }
  | { type: 'purge' }

export function InboxPage() {
  const { showToast } = useToast()
  const { online } = useOnline()
  const { timeZone } = useTimeZone()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const query = usePagedQuery<CaptureDto>((page) => capturesApi.inbox(page), [], {
    headingRef,
    onClamp: (from, to) => showToast('info', clampedPageMessage(from, to)),
  })
  const items = query.items
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null)
  const focusRowNext = useRef<string | null>(null)
  // Re-render twice a minute so "Undo · n min left" stays true.
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => setTick((n) => n + 1), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  // Keep a valid selection as pages load and captures leave.
  useEffect(() => {
    if (!items.some((c) => c.id === selectedId)) setSelectedId(items[0]?.id ?? null)
    const pending = focusRowNext.current
    if (pending && items.some((c) => c.id === pending)) {
      focusRowNext.current = null
      document.querySelector<HTMLElement>(`[data-capture-id="${CSS.escape(pending)}"]`)?.focus()
    }
  }, [items, selectedId])

  const selected = items.find((c) => c.id === selectedId) ?? null

  // J / K move the selection (never in a field, a dialog, or with a modifier).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const move = isListShortcut({
        key: event.key,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        target: event.target as HTMLElement | null,
      })
      if (!move || items.length === 0) return
      event.preventDefault()
      const index = Math.max(0, items.findIndex((c) => c.id === selectedId))
      const next = items[Math.min(items.length - 1, Math.max(0, index + (move === 'next' ? 1 : -1)))]
      if (!next) return
      setSelectedId(next.id)
      document.querySelector<HTMLElement>(`[data-capture-id="${CSS.escape(next.id)}"]`)?.focus()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [items, selectedId])

  /** A capture left the inbox: select the next one and refresh the count. */
  const removed = (id: string) => {
    const next = selectionAfterRemoval(
      items.map((c) => c.id),
      id,
    )
    setSelectedId(next)
    focusRowNext.current = next
    if (!next) setDetailOpen(false)
    notifyInboxChanged()
    query.afterRemoval(1, next === null)
  }

  const fail = (error: unknown, action: string, title: string) => {
    const described = describeError(error, action, true)
    showToast(described.retryAfter !== undefined ? 'warning' : 'error', title, described.message)
  }

  const convert = async (capture: CaptureDto, kind: ConvertKind, force = false) => {
    if (busy) return
    setBusy(`convert-${kind}`)
    try {
      const result = await capturesApi.convert(capture.id, kind, force)
      setConfirm(null)
      const made = result.created[0]
      showToast('success', `Kept as ${kind.toLowerCase()}`, captureDisplayTitle(capture), made
        ? { action: { label: `Open ${kind.toLowerCase()}`, to: detailPath(LINK_TYPES[made.type], made.id) } }
        : undefined)
      removed(capture.id)
    } catch (error) {
      if (!force && requiresConfirmation(error)) {
        setConfirm({ type: 'convert', kind, reason: error instanceof Error ? error.message : '' })
      } else {
        fail(error, 'Converting the capture', 'Capture not converted')
      }
    } finally {
      setBusy(null)
    }
  }

  const reprocess = async (capture: CaptureDto) => {
    if (busy) return
    setBusy('reprocess')
    try {
      const ack = await capturesApi.reprocess(capture.id)
      if (ack.needsReview) {
        showToast('info', 'Reprocessed: still needs a decision', ack.message)
        query.reload()
      } else {
        showToast('success', 'Reprocessed', ack.message)
        removed(capture.id)
      }
    } catch (error) {
      fail(error, 'Reprocessing', 'Capture not reprocessed')
    } finally {
      setBusy(null)
    }
  }

  const undo = async (capture: CaptureDto, force = false) => {
    if (busy) return
    if (!force && undoMinutesLeft(capture.createdAt) === 0) {
      setConfirm({ type: 'undo', reasons: ['This capture is older than 15 minutes.'] })
      return
    }
    setBusy('undo')
    try {
      await capturesApi.undo(capture.id, force)
      setConfirm(null)
      showToast('success', 'Capture removed', 'What it created was deleted. You can’t bring it back from the dashboard.')
      removed(capture.id)
    } catch (error) {
      if (!force && requiresConfirmation(error)) {
        // The server's clock or an edit decided: ask instead of failing.
        setConfirm({ type: 'undo', reasons: [error instanceof Error ? error.message : ''] })
      } else {
        fail(error, 'Undo', 'Capture not removed')
      }
    } finally {
      setBusy(null)
    }
  }

  const purge = async (capture: CaptureDto) => {
    if (busy) return
    setBusy('purge')
    try {
      await capturesApi.delete(capture.id, true)
      setConfirm(null)
      showToast(
        'success',
        'Capture deleted permanently',
        capture.isVoice ? 'Its voice recording was deleted too.' : undefined,
      )
      removed(capture.id)
    } catch (error) {
      fail(error, 'Deleting the capture', 'Capture not deleted')
    } finally {
      setBusy(null)
    }
  }

  const minutesLeft = selected ? undoMinutesLeft(selected.createdAt) : 0
  const guess = selected ? guessedKind(selected) : null
  // Buttons stay focusable while an action runs; the handlers ignore clicks.
  const disabled = !online

  return (
    <div>
      <PageHeader
        ref={headingRef}
        title="Inbox"
        sub={
          query.status === 'ready' && query.total > 0 ? (
            <>
              {query.total} capture{query.total === 1 ? '' : 's'} need{query.total === 1 ? 's' : ''} a decision ·{' '}
              <span className="kbd">J</span> <span className="kbd">K</span> move
            </>
          ) : undefined
        }
      />

      <ListState
        status={query.status}
        error={query.error}
        items={items}
        noun="captures"
        onRetry={query.reload}
        empty={
          <Card>
            <EmptyState
              icon={<CaptureIcon />}
              title="All caught up"
              text="New captures that Recall isn’t sure about will appear here."
            />
          </Card>
        }
      >
        {(captures) => (
          <div className="inbox-layout">
            <div className={`inbox${detailOpen ? ' detail-open' : ''}`}>
              <div className="inbox-list-wrap card">
                <ul className="inbox-list" aria-label="Captures needing review">
                  {captures.map((capture) => (
                    <li key={capture.id}>
                      <button
                        type="button"
                        className="inbox-row"
                        data-capture-id={capture.id}
                        aria-current={capture.id === selectedId ? 'true' : undefined}
                        onClick={() => {
                          setSelectedId(capture.id)
                          setDetailOpen(true)
                        }}
                      >
                        <span className="inbox-dot" aria-hidden="true" />
                        <span className="inbox-row-text">{captureDisplayTitle(capture)}</span>
                        <span className="inbox-row-time tabular">{formatRelative(capture.capturedAt, timeZone)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>

              {selected && (
                <section className="inbox-detail card" aria-label="Selected capture">
                  <div>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="inbox-back"
                      onClick={() => {
                        setDetailOpen(false)
                        focusRowNext.current = selected.id
                        window.setTimeout(() => {
                          document.querySelector<HTMLElement>(`[data-capture-id="${CSS.escape(selected.id)}"]`)?.focus()
                        }, 0)
                      }}
                    >
                      ← All captures
                    </Button>
                  </div>
                  <div className="kind-label">
                    {SOURCE_LABELS[selected.source] ?? selected.source} · {formatLocalDateTime(selected.capturedAt, timeZone)} ·{' '}
                    {selected.status === 'FAILED' ? 'Processing failed' : 'Needs review'}
                  </div>
                  <CaptureWords capture={selected} />
                  <p className="inbox-reason">
                    Recall’s guess: <strong>{guess ? kindLabel(guess) : 'not sure'}</strong> · confidence{' '}
                    {confidenceLabel(selected.confidence)}.
                    {selected.classificationRationale ? ` ${selected.classificationRationale}` : ''}
                  </p>
                  {selected.links.length > 0 && (
                    <p className="inbox-reason">
                      Created so far:{' '}
                      {selected.links.map((link, i) => (
                        <span key={link.id}>
                          {i > 0 ? ', ' : ''}
                          {kindLabel(link.type)} “{link.title}”
                        </span>
                      ))}
                    </p>
                  )}
                  <div className="inbox-actions" role="group" aria-label="Keep as">
                    {(guess ? [guess, ...CONVERT_KINDS.filter((k) => k !== guess)] : CONVERT_KINDS).map((kind) => (
                      <Button
                        key={kind}
                        variant={kind === guess ? 'primary' : 'secondary'}
                        size="sm"
                        disabled={disabled}
                        loading={busy === `convert-${kind}`}
                        onClick={() => void convert(selected, kind)}
                      >
                        {kind === guess ? `Keep as ${kind.toLowerCase()}` : kindLabel(kind)}
                      </Button>
                    ))}
                  </div>
                  <div className="inbox-actions">
                    <Button variant="secondary" size="sm" disabled={disabled} loading={busy === 'reprocess'} onClick={() => void reprocess(selected)}>
                      Reprocess
                    </Button>
                    <Button variant="secondary" size="sm" disabled={disabled} loading={busy === 'undo'} onClick={() => void undo(selected)}>
                      {minutesLeft > 0 ? `Undo · ${minutesLeft} min left` : 'Remove (older than 15 min)…'}
                    </Button>
                    <Button variant="danger" size="sm" disabled={disabled} onClick={() => setConfirm({ type: 'purge' })}>
                      Delete permanently…
                    </Button>
                  </div>
                </section>
              )}
            </div>
          </div>
        )}
      </ListState>

      <Pagination page={query.page} total={query.total} pageSize={query.pageSize} onPageChange={query.setPage} />

      {selected && (
        <>
          <ConfirmDialog
            open={confirm?.type === 'convert'}
            title={`Convert to ${confirm?.type === 'convert' ? confirm.kind.toLowerCase() : ''} anyway?`}
            confirmLabel={`Convert to ${confirm?.type === 'convert' ? confirm.kind.toLowerCase() : ''}`}
            cancelLabel="Keep it as it is"
            busy={busy !== null}
            onCancel={() => setConfirm(null)}
            onConfirm={() => confirm?.type === 'convert' && void convert(selected, confirm.kind, true)}
          >
            <p>{confirm?.type === 'convert' ? confirm.reason : ''}</p>
          </ConfirmDialog>

          <ConfirmDialog
            open={confirm?.type === 'undo'}
            title="Remove this capture?"
            confirmLabel="Remove capture"
            cancelLabel="Keep capture"
            busy={busy !== null}
            onCancel={() => setConfirm(null)}
            onConfirm={() => void undo(selected, true)}
          >
            {confirm?.type === 'undo' && confirm.reasons.map((reason) => <p key={reason}>{reason}</p>)}
            <p>
              Recall deletes what it created from this capture and hides the capture. The capture is kept for your
              records, but you can’t bring it back from the dashboard.
            </p>
          </ConfirmDialog>

          <ConfirmDialog
            open={confirm?.type === 'purge'}
            title={`Delete “${captureDisplayTitle(selected)}” permanently?`}
            confirmLabel="Delete permanently"
            cancelLabel="Keep capture"
            typedConfirmation="delete"
            busy={busy !== null}
            onCancel={() => setConfirm(null)}
            onConfirm={() => void purge(selected)}
          >
            <p>This erases:</p>
            <ul>
              <li>the capture and its original words</li>
              {selected.links.length > 0 && <li>what was created from it ({selected.links.map((l) => kindLabel(l.type).toLowerCase()).join(', ')})</li>}
              <li>its reminders and links to other captures</li>
              {selected.isVoice && <li>the retained voice recording, if one was kept</li>}
            </ul>
            <p>It won’t appear in future exports. This can’t be undone.</p>
          </ConfirmDialog>
        </>
      )}
    </div>
  )
}

function CaptureWords({ capture }: { capture: CaptureDto }) {
  const content = captureContent(capture)
  if (content.kind === 'text') return <blockquote className="inbox-raw">{content.text}</blockquote>
  if (content.kind === 'transcript') {
    return (
      <div>
        <blockquote className="inbox-raw">{content.transcript}</blockquote>
        <div className="page-header-sub">
          {content.transcriptLabel}
          {content.caption ? ` · caption: ${content.caption}` : ''}
        </div>
      </div>
    )
  }
  if (content.kind === 'caption-only') {
    return (
      <div>
        <blockquote className="inbox-raw">{content.caption}</blockquote>
        <div className="page-header-sub">Voice note caption; no transcript yet.</div>
      </div>
    )
  }
  return <blockquote className="inbox-raw">Voice note (no transcript)</blockquote>
}
