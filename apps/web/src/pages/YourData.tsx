/**
 * Settings → Your data (R2-06): export everything, and restore from an export.
 *
 * Restore is a three-step wizard: choose a file → check (server dry run) →
 * restore. The browser reads the chosen file once and keeps those exact bytes;
 * the check and the restore both send them. The server hashes what it
 * receives, and the restore must carry the hash and check token the server
 * returned for the dry run, so it refuses anything but the checked file.
 * Choosing any file, even the same one again, discards the previous check.
 */
import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError, exportApi, restoreApi, type RestoreFileReportDto } from '../lib/api'
import { useTimeZone } from '../hooks/useTimeZone'
import { useOnline } from '../hooks/useOnline'
import { useToast } from '../hooks/useToast'
import { describeError } from '../lib/errors'
import { formatLocalDateTime, localDateKey } from '../lib/date'
import {
  checkExportFile,
  formatBytes,
  sha256Hex,
  shortFingerprint,
  tableLabel,
  totalToAdd,
  type ExportFileSummary,
} from '../lib/restore-file'
import { Button, Card } from '../components/ui'
import { ConfirmDialog, PageHeader } from '../components/patterns'

interface ChosenFile {
  name: string
  size: number
  bytes: ArrayBuffer
  sha256: string
  summary: ExportFileSummary
}

type RestoreStage =
  | { stage: 'choose' }
  | { stage: 'refused'; name: string; size: number; message: string }
  | { stage: 'ready'; file: ChosenFile }
  | { stage: 'checking'; file: ChosenFile }
  | { stage: 'checked'; file: ChosenFile; report: RestoreFileReportDto }
  | { stage: 'restoring'; file: ChosenFile; report: RestoreFileReportDto }
  | { stage: 'done'; file: ChosenFile; report: RestoreFileReportDto }
  | { stage: 'unconfirmed'; file: ChosenFile }

export function YourDataPage() {
  const { timeZone } = useTimeZone()
  const { online } = useOnline()
  const { showToast } = useToast()
  const [exporting, setExporting] = useState(false)
  const [state, setState] = useState<RestoreStage>({ stage: 'choose' })
  const [error, setError] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const resultHeading = useRef<HTMLHeadingElement>(null)

  const download = async () => {
    setExporting(true)
    try {
      const bundle = await exportApi.export()
      const name = `recall-export-${localDateKey(new Date(), timeZone)}.json`
      const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }))
      const link = document.createElement('a')
      link.href = url
      link.download = name
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
      showToast('success', 'Export ready', `${name} contains all your data. Keep it somewhere private.`)
    } catch (err) {
      const described = describeError(err, 'Exporting')
      showToast(described.retryAfter !== undefined ? 'warning' : 'error', 'Export failed', described.message)
    } finally {
      setExporting(false)
    }
  }

  /** Any choice, even the same file again, starts over at step 2. */
  const choose = async (picked: File | undefined) => {
    setError(null)
    if (!picked) {
      setState({ stage: 'choose' })
      return
    }
    const bytes = await picked.arrayBuffer()
    const check = checkExportFile(new Uint8Array(bytes))
    if (!check.ok) {
      setState({ stage: 'refused', name: picked.name, size: picked.size, message: check.message })
      return
    }
    const sha256 = await sha256Hex(bytes)
    setState({ stage: 'ready', file: { name: picked.name, size: picked.size, bytes, sha256, summary: check.summary } })
  }

  const runCheck = async (file: ChosenFile) => {
    setError(null)
    setState({ stage: 'checking', file })
    try {
      const report = await restoreApi.check(file.bytes, file.sha256)
      setState({ stage: 'checked', file, report })
    } catch (err) {
      setState({ stage: 'ready', file })
      setError(describeError(err, 'Checking the file').message)
    }
  }

  const runRestore = async (file: ChosenFile, report: RestoreFileReportDto) => {
    setConfirmOpen(false)
    setError(null)
    setState({ stage: 'restoring', file, report })
    try {
      const result = await restoreApi.apply(file.bytes, report.file.sha256, report.file.checkToken ?? '')
      setState({ stage: 'done', file, report: result })
      showToast('success', 'Restore finished', `${totalToAdd(result.inserted)} records added.`)
      window.setTimeout(() => resultHeading.current?.focus(), 0)
    } catch (err) {
      if (err instanceof ApiError && (err.kind === 'network' || err.kind === 'timeout')) {
        // The request may have reached the server: say so honestly.
        setState({ stage: 'unconfirmed', file })
        return
      }
      setState({ stage: 'checked', file, report })
      setError(describeError(err, 'Restoring', true).message)
    }
  }

  const file = 'file' in state ? state.file : null
  const step = state.stage === 'choose' || state.stage === 'refused' ? 1 : state.stage === 'done' ? 3 : state.stage === 'ready' || state.stage === 'checking' ? 2 : 3
  const report = 'report' in state ? state.report : null
  const toAdd = report ? totalToAdd(report.inserted) : 0

  return (
    <div>
      <PageHeader
        title="Your data"
        sub={
          <>
            <Link to="/settings">Settings</Link> → Your data
          </>
        }
      />

      <Card style={{ marginBottom: 16 }}>
        <div className="card-content data-card">
          <h2 className="section-title" style={{ marginTop: 0 }}>
            Export everything
          </h2>
          <p>
            Downloads every capture, record, reminder and your settings as one JSON file. It contains all your personal
            data: keep it somewhere private.
          </p>
          <div>
            <Button onClick={() => void download()} loading={exporting} disabled={!online}>
              Download export
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <div className="card-content data-card">
          <h2 className="section-title" style={{ marginTop: 0 }}>
            Restore from an export
          </h2>
          <ol className="steps" aria-label="Restore steps">
            {['Choose file', 'Check', 'Restore'].map((label, index) => (
              <li
                key={label}
                className={index + 1 < step || state.stage === 'done' ? 'done' : ''}
                aria-current={index + 1 === step ? 'step' : undefined}
              >
                {index + 1} {label}
              </li>
            ))}
          </ol>
          <p>Restore only adds records that are missing. It never changes or deletes what you have. Nothing is written until step 3.</p>

          <div className="form-group">
            <label htmlFor="restore-file" className="form-label">
              Export file (.json, up to 25 MB)
            </label>
            <input
              id="restore-file"
              ref={fileInput}
              type="file"
              accept="application/json,.json"
              className="file-input"
              onChange={(event) => {
                void choose(event.target.files?.[0])
                // Clear the input so choosing the same file again also counts as a new choice.
                event.target.value = ''
              }}
            />
          </div>

          {state.stage === 'refused' && (
            <div className="file-box">
              <div>
                <strong>{state.name}</strong> · {formatBytes(state.size)}
              </div>
              <div className="form-error" role="alert">
                {state.message}
              </div>
            </div>
          )}

          {file && (
            <div className="file-box">
              <div>
                <strong>{file.name}</strong> · {formatBytes(file.size)} · schema version {file.summary.schemaVersion}
                {file.summary.exportedAt ? ` · exported ${formatLocalDateTime(file.summary.exportedAt, timeZone)}` : ''}
              </div>
              <div className="page-header-sub">
                Fingerprint <span className="tabular">{shortFingerprint(file.sha256)}</span> ·{' '}
                {state.stage === 'checked' ? 'checked, nothing written yet' : state.stage === 'done' ? 'restored' : 'not checked yet'}
              </div>
            </div>
          )}

          {error && (
            <div className="state-view state-error" role="alert">
              <span>{error}</span>
            </div>
          )}

          {(state.stage === 'ready' || state.stage === 'checking') && (
            <div>
              <Button onClick={() => void runCheck(state.file)} loading={state.stage === 'checking'} disabled={!online}>
                Check this file
              </Button>
            </div>
          )}

          {(state.stage === 'checked' || state.stage === 'restoring') && report && (
            <>
              <ReportTable report={report} mode="check" />
              {report.errors.length > 0 && <RowErrors errors={report.errors} intro="These rows can’t be restored; everything else can:" />}
              <div className="inbox-actions">
                <Button variant="secondary" onClick={() => fileInput.current?.click()}>
                  Choose another file
                </Button>
                <Button
                  onClick={() => setConfirmOpen(true)}
                  disabled={toAdd === 0 || !online}
                  loading={state.stage === 'restoring'}
                >
                  {toAdd === 0 ? 'Nothing to restore' : `Restore ${toAdd} record${toAdd === 1 ? '' : 's'}`}
                </Button>
              </div>
            </>
          )}

          {state.stage === 'done' && (
            <>
              <h3 ref={resultHeading} tabIndex={-1} className="data-result-title">
                Restore finished
              </h3>
              <ReportTable report={state.report} mode="done" />
              {state.report.errors.length > 0 && <RowErrors errors={state.report.errors} intro="These rows weren’t restored:" />}
              <div>
                <Button variant="secondary" onClick={() => setState({ stage: 'choose' })}>
                  Restore another file
                </Button>
              </div>
            </>
          )}

          {state.stage === 'unconfirmed' && (
            <div className="state-view state-error" role="alert">
              <strong>We couldn’t confirm the restore finished.</strong>
              <span>
                The connection was lost. Rows already written stay, and restoring only adds what is missing, so it’s safe
                to restore the same file again.
              </span>
              <div>
                <Button variant="secondary" onClick={() => void runCheck(state.file)} disabled={!online}>
                  Check the same file again
                </Button>
              </div>
            </div>
          )}
        </div>
      </Card>

      {file && report && state.stage === 'checked' && (
        <ConfirmDialog
          open={confirmOpen}
          title={`Restore ${toAdd} record${toAdd === 1 ? '' : 's'}?`}
          confirmLabel="Restore"
          cancelLabel="Not now"
          tone="default"
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => void runRestore(file, report)}
        >
          <p>
            From <strong>{file.name}</strong> ({formatBytes(file.size)}, fingerprint {shortFingerprint(file.sha256)}).
          </p>
          <p>Restore only adds missing records. It never changes or deletes what you have.</p>
        </ConfirmDialog>
      )}
    </div>
  )
}

function ReportTable({ report, mode }: { report: RestoreFileReportDto; mode: 'check' | 'done' }) {
  const tables = Array.from(new Set([...Object.keys(report.inserted), ...Object.keys(report.skipped)]))
  return (
    <div className="table-wrap">
      <table className="data-table">
        <caption className="sr-only">{mode === 'check' ? 'What the restore would do' : 'What the restore did'}</caption>
        <thead>
          <tr>
            <th scope="col">Records</th>
            <th scope="col" className="num">
              {mode === 'check' ? 'Would add' : 'Added'}
            </th>
            <th scope="col" className="num">
              Already here
            </th>
          </tr>
        </thead>
        <tbody>
          {tables.map((table) => (
            <tr key={table}>
              <th scope="row">{tableLabel(table)}</th>
              <td className="num tabular">{report.inserted[table] ?? 0}</td>
              <td className="num tabular">{report.skipped[table] ?? 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function RowErrors({ errors, intro }: { errors: string[]; intro: string }) {
  return (
    <div className="offline-banner" role="status">
      <strong>
        {errors.length} {errors.length === 1 ? 'problem' : 'problems'}.
      </strong>{' '}
      {intro}
      <ul className="row-errors">
        {errors.slice(0, 20).map((message) => (
          <li key={message}>{message}</li>
        ))}
      </ul>
      {errors.length > 20 && <p>…and {errors.length - 20} more.</p>}
    </div>
  )
}
