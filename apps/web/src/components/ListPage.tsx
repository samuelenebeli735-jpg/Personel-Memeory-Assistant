/**
 * The shared shape of a simple library list (notes, ideas, events, projects):
 * page header with a create button, the list body states, and the create form.
 */
import { useRef, useState, type ReactNode } from 'react'
import type { Paginated } from '../lib/api'
import { usePagedQuery, type PagedQuery } from '../hooks/usePagedQuery'
import { Button, Card, EmptyState } from './ui'
import { ListState, PageHeader } from './patterns'
import { RecordFormDialog, type RecordFormSpec } from './record-forms'

export function ListPage<T extends { id: string }>({
  title,
  noun,
  icon,
  emptyTitle,
  emptyText,
  spec,
  fetchPage,
  deps = [],
  renderRows,
  filters,
}: {
  title: string
  /** Plural, lower case: "notes". */
  noun: string
  icon: ReactNode
  emptyTitle: string
  emptyText: string
  spec: RecordFormSpec<T>
  fetchPage: (page: { limit: number; offset: number }) => Promise<Paginated<T>>
  deps?: ReadonlyArray<unknown>
  renderRows: (items: T[], query: PagedQuery<T>) => ReactNode
  filters?: (query: PagedQuery<T>) => ReactNode
}) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const query = usePagedQuery<T>(fetchPage, deps, { headingRef })

  return (
    <div>
      <PageHeader
        ref={headingRef}
        title={title}
        sub={query.status === 'ready' ? `${query.total} ${query.total === 1 ? noun.replace(/s$/, '') : noun}` : undefined}
        actions={
          <Button variant="primary" size="lg" onClick={() => setCreateOpen(true)}>
            New {spec.noun}
          </Button>
        }
      />
      {filters?.(query)}
      <Card>
        <div className="card-content" style={{ padding: 0 }}>
          <ListState
            status={query.status}
            error={query.error}
            items={query.items}
            noun={noun}
            onRetry={query.reload}
            empty={
              <EmptyState
                icon={icon}
                title={emptyTitle}
                text={emptyText}
                action={
                  <Button variant="primary" onClick={() => setCreateOpen(true)}>
                    Create {spec.noun}
                  </Button>
                }
              />
            }
          >
            {(items) => (
              <div className="list" style={{ borderTop: '1px solid var(--color-border)' }}>
                {renderRows(items, query)}
              </div>
            )}
          </ListState>
        </div>
      </Card>

      <RecordFormDialog
        spec={spec}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSaved={() => {
          setCreateOpen(false)
          query.reload()
        }}
      />
    </div>
  )
}
