import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { ReactNode } from 'react'
import { ConfirmDialog, ErrorState, FormDialog, LoadingState, Pagination } from './patterns'
import { toastLifetimeMs } from '../hooks/useToast'

function render(node: ReactNode): string {
  return renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>)
}

const noop = () => undefined

describe('Pagination', () => {
  it('is a labelled navigation landmark with the current page marked', () => {
    const html = render(<Pagination page={2} total={132} pageSize={25} onPageChange={noop} />)
    expect(html).toContain('<nav class="pagination" aria-label="Pagination">')
    expect(html).toContain('26–50 of 132')
    expect(html).toContain('aria-label="Page 2" aria-current="page"')
    expect(html).toContain('aria-label="Previous page"')
    expect(html).toContain('aria-label="Next page"')
    expect(html).toContain('Page 2 of 6')
  })

  it('disables Previous on the first page and Next on the last', () => {
    const first = render(<Pagination page={1} total={60} pageSize={25} onPageChange={noop} />)
    expect(first).toMatch(/aria-label="Previous page" disabled=""/)
    const last = render(<Pagination page={3} total={60} pageSize={25} onPageChange={noop} />)
    expect(last).toMatch(/aria-label="Next page" disabled=""/)
  })

  it('shows only the count when everything fits on one page', () => {
    const html = render(<Pagination page={1} total={7} pageSize={25} onPageChange={noop} />)
    expect(html).not.toContain('<nav')
    expect(html).toContain('1–7 of 7')
    expect(render(<Pagination page={1} total={0} pageSize={25} onPageChange={noop} />)).toBe('')
  })
})

describe('state views', () => {
  it('announces loading once through a status region', () => {
    const html = render(<LoadingState label="Loading tasks…" />)
    expect(html).toContain('role="status"')
    expect(html).toContain('Loading tasks…')
    expect(html).toContain('aria-hidden="true"')
  })

  it('shows the safe message, the code and a retry action', () => {
    const html = render(
      <ErrorState title="Couldn’t load tasks" message="The server had a problem." code="INTERNAL_ERROR" onRetry={noop} />,
    )
    expect(html).toContain('role="alert"')
    expect(html).toContain('Code: INTERNAL_ERROR')
    expect(html).toContain('Try again')
  })
})

describe('ConfirmDialog', () => {
  it('is an alert dialog with the safe choice first', () => {
    const html = render(
      <ConfirmDialog open title="Delete note “Groceries”?" confirmLabel="Delete note" cancelLabel="Keep note" onConfirm={noop} onCancel={noop}>
        <p>This can’t be undone.</p>
      </ConfirmDialog>,
    )
    expect(html).toContain('role="alertdialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html.indexOf('Keep note')).toBeLessThan(html.indexOf('Delete note</button>'))
    expect(html).not.toContain('aria-label="Close"')
  })

  it('keeps a typed confirmation disabled until the word is typed', () => {
    const html = render(
      <ConfirmDialog open title="Delete permanently?" confirmLabel="Delete permanently" typedConfirmation="delete" onConfirm={noop} onCancel={noop}>
        <p>Erases the capture.</p>
      </ConfirmDialog>,
    )
    expect(html).toContain('Type <strong>delete</strong> to confirm')
    expect(html).toMatch(/<button class="btn btn-danger" disabled="" type="submit">Delete permanently<\/button>/)
  })

  it('renders nothing when closed', () => {
    expect(render(<ConfirmDialog open={false} title="x" confirmLabel="y" onConfirm={noop} onCancel={noop}>z</ConfirmDialog>)).toBe('')
  })
})

describe('FormDialog', () => {
  it('has one submit path, a Cancel button and the field-error summary', () => {
    const html = render(
      <FormDialog
        open
        title="Edit note"
        submitLabel="Save changes"
        dirty={false}
        busy={false}
        errors={[{ fieldId: 'note-body', message: 'Enter the note text.' }]}
        onSubmit={noop}
        onClose={noop}
      >
        <input id="note-body" />
      </FormDialog>,
    )
    expect(html).toContain('role="dialog"')
    expect(html).toContain('<form novalidate="">')
    expect((html.match(/type="submit"/g) ?? []).length).toBe(1)
    expect(html).toContain('Fix 1 field to continue:')
    expect(html).toContain('href="#note-body"')
    expect(html).toContain('>Cancel</button>')
  })

  it('shows a server error without losing the form', () => {
    const html = render(
      <FormDialog open title="New task" submitLabel="Create task" dirty busy={false} serverError="The server had a problem (INTERNAL_ERROR). Your text is still here." onSubmit={noop} onClose={noop}>
        <input id="task-title" defaultValue="Buy tiles" />
      </FormDialog>,
    )
    expect(html).toContain('Your text is still here.')
    expect(html).toContain('value="Buy tiles"')
  })
})

describe('toast lifetimes', () => {
  it('auto-closes success and info, keeps errors and warnings', () => {
    expect(toastLifetimeMs('success', false)).toBe(5000)
    expect(toastLifetimeMs('info', true)).toBe(8000)
    expect(toastLifetimeMs('error', false)).toBeNull()
    expect(toastLifetimeMs('warning', false)).toBeNull()
  })
})
