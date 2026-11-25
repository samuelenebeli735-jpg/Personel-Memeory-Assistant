/**
 * Edit and delete for a detail page (R2-04).
 *
 * - Edit opens the same form used to create, pre-filled; saving updates the
 *   page in place with a "… updated" toast.
 * - Delete opens a confirmation that names the record and states what
 *   happens; the safe button has focus. Deletes are permanent (decision D3):
 *   there is no Undo, and the copy says so. After deleting, the owner returns
 *   to the list with a toast.
 * - While offline both actions are paused.
 */
import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useToast } from '../hooks/useToast'
import { useOnline } from '../hooks/useOnline'
import { describeError } from '../lib/errors'
import { Button } from './ui'
import { ConfirmDialog } from './patterns'
import { RecordFormDialog, type RecordFormSpec } from './record-forms'

export interface DeleteCopy {
  title: string
  body: ReactNode
  confirmLabel: string
  cancelLabel: string
}

export function EditableDetail<R extends { id: string }, D = unknown>({
  record: initialRecord,
  spec,
  remove,
  deleteCopy,
  deletedMessage,
  listPath,
  render,
  extraActions,
}: {
  record: R
  spec: RecordFormSpec<R>
  remove: (record: R) => Promise<D>
  deleteCopy: (record: R) => DeleteCopy
  /** Toast detail after a delete; defaults to nothing. */
  deletedMessage?: (record: R, result: D) => string | undefined
  listPath: string
  render: (record: R, actions: ReactNode) => ReactNode
  extraActions?: (record: R, setRecord: (record: R) => void) => ReactNode
}) {
  const navigate = useNavigate()
  const { showToast } = useToast()
  const { online } = useOnline()
  const [record, setRecord] = useState(initialRecord)
  const [editOpen, setEditOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const noun = spec.noun.toLowerCase()
  const copy = deleteCopy(record)

  const confirmDelete = async () => {
    setDeleting(true)
    try {
      const result = await remove(record)
      showToast('success', `${spec.noun} deleted`, deletedMessage?.(record, result))
      navigate(listPath)
    } catch (error) {
      const described = describeError(error, `Deleting the ${noun}`, true)
      showToast(described.retryAfter !== undefined ? 'warning' : 'error', `${spec.noun} not deleted`, described.message)
      setDeleting(false)
    }
  }

  const actions = (
    <>
      {extraActions?.(record, setRecord)}
      <Button variant="secondary" onClick={() => setEditOpen(true)} disabled={!online}>
        Edit
      </Button>
      <Button variant="danger" onClick={() => setDeleteOpen(true)} disabled={!online}>
        Delete
      </Button>
    </>
  )

  return (
    <>
      {render(record, actions)}
      <RecordFormDialog
        spec={spec}
        open={editOpen}
        record={record}
        onClose={() => setEditOpen(false)}
        onSaved={(saved) => {
          setRecord(saved)
          setEditOpen(false)
        }}
      />
      <ConfirmDialog
        open={deleteOpen}
        title={copy.title}
        confirmLabel={copy.confirmLabel}
        cancelLabel={copy.cancelLabel}
        busy={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteOpen(false)}
      >
        {copy.body}
      </ConfirmDialog>
    </>
  )
}

/** Detail-page action row, right-aligned under the heading. */
export function DetailActions({ children }: { children?: ReactNode }) {
  if (!children) return null
  return <div className="detail-actions">{children}</div>
}
