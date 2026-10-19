import { useState, useEffect, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { useToast } from '../hooks/useToast'
import { searchApi, type SearchResponse, type SearchResultItem, type SearchQuery } from '../lib/api'
import { formatLocalDateTime, formatRelative, getTimeZone } from '../lib/date'
import { Button, Input, Select, Card, Badge, EmptyState } from '../components/ui'
import { SearchIcon } from '../components/Layout'

const TYPE_OPTIONS = [
  { value: 'TASK', label: 'Tasks' },
  { value: 'NOTE', label: 'Notes' },
  { value: 'IDEA', label: 'Ideas' },
  { value: 'EVENT', label: 'Events' },
  { value: 'CAPTURE', label: 'Captures' },
  { value: 'PROJECT', label: 'Projects' },
  { value: 'REMINDER', label: 'Reminders' },
] as const

function SearchResultRow({ item, timeZone, onNavigate }: { item: SearchResultItem; timeZone: string; onNavigate: (path: string) => void }) {
  const typeLabels: Record<string, string> = {
    TASK: 'Task', NOTE: 'Note', IDEA: 'Idea', EVENT: 'Event', CAPTURE: 'Capture', PROJECT: 'Project', REMINDER: 'Reminder'
  }

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault()
    const pathMap: Record<string, string> = {
      TASK: '/tasks', NOTE: '/notes', IDEA: '/ideas', EVENT: '/events',
      CAPTURE: '/captures', PROJECT: '/projects', REMINDER: '/reminders'
    }
    onNavigate(`${pathMap[item.type]}/${item.id}`)
  }

  return (
    <div className="list-item" style={{ cursor: 'pointer' }} onClick={handleClick}>
      <div className="list-item-content" style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
          <Badge variant="primary">{typeLabels[item.type] || item.type}</Badge>
          <div className="list-item-title" style={{ textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap', flex: 1 }}>
            {item.title}
          </div>
        </div>
        <div className="list-item-meta">
          {item.matchedOn.length > 0 && <Badge variant="muted">matched: {item.matchedOn.join(', ')}</Badge>}
          {item.snippet && <span style={{ color: 'var(--color-text-muted)', fontSize: '12px' }}>{item.snippet}</span>}
          <span>{formatRelative(item.timestamp, timeZone)}</span>
          <span style={{ fontFamily: 'monospace', fontSize: '11px', color: 'var(--color-text-muted)' }}>#{item.id.slice(0, 6)}</span>
        </div>
      </div>
    </div>
  )
}

export function SearchPage() {
  const { showToast } = useToast()
  const [searchParams, setSearchParams] = useSearchParams()
  const [results, setResults] = useState<SearchResponse | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [query, setQuery] = useState(searchParams.get('q') || '')
  const [types, setTypes] = useState<string[]>(searchParams.getAll('t'))
  const [status, setStatus] = useState(searchParams.get('status') || '')
  const [from, setFrom] = useState(searchParams.get('from') || '')
  const [to, setTo] = useState(searchParams.get('to') || '')

  const timeZone = getTimeZone()

  const handleSearch = async (e: FormEvent) => {
    e.preventDefault()
    setIsLoading(true)
    const searchQuery: SearchQuery = { q: query, limit: 50, offset: 0, sort: 'relevance', order: 'desc', includeDeleted: false }
    if (types.length > 0) searchQuery.types = types as ('TASK' | 'IDEA' | 'NOTE' | 'EVENT')[]
    if (status) searchQuery.status = status as SearchQuery['status']
    if (from) searchQuery.from = from
    if (to) searchQuery.to = to

    try {
      const data = await searchApi.search(searchQuery)
      setResults(data)
      const params = new URLSearchParams()
      if (query) params.set('q', query)
      if (types.length > 0) types.forEach(t => params.append('t', t))
      if (status) params.set('status', status)
      if (from) params.set('from', from)
      if (to) params.set('to', to)
      setSearchParams(params)
    } catch (err) {
      console.error(err)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <h1 style={{ fontSize: '24px', fontWeight: '600', margin: 0 }}>Search</h1>
      </div>

      <Card style={{ marginBottom: '24px' }}>
        <div className="card-content">
          <form onSubmit={handleSearch} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <Input
              label="Search"
              placeholder="Enter search terms..."
              value={query}
              onChange={e => setQuery(e.target.value)}
              style={{ flex: 1 }}
            />
            <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
              <Select
                label="Types"
                options={[{ value: '', label: 'All types' }, ...TYPE_OPTIONS]}
                value={types.join(',')}
                onChange={e => setTypes(e.target.value ? e.target.value.split(',') : [])}
                multiple
              />
              <Select
                label="Status"
                options={[
                  { value: '', label: 'All statuses' },
                  { value: 'PENDING', label: 'Pending' },
                  { value: 'IN_PROGRESS', label: 'In Progress' },
                  { value: 'COMPLETED', label: 'Completed' },
                  { value: 'CANCELLED', label: 'Cancelled' },
                  { value: 'SCHEDULED', label: 'Scheduled' },
                  { value: 'SENT', label: 'Sent' },
                  { value: 'FAILED', label: 'Failed' },
                  { value: 'MISSED', label: 'Missed' },
                ]}
                value={status}
                onChange={e => setStatus(e.target.value)}
              />
              <Input label="From" type="datetime-local" value={from} onChange={e => setFrom(e.target.value)} />
              <Input label="To" type="datetime-local" value={to} onChange={e => setTo(e.target.value)} />
            </div>
            <Button type="submit" size="lg" loading={isLoading}>
              <SearchIcon style={{ marginRight: '8px' }} /> Search
            </Button>
          </form>
        </div>
      </Card>

      {results && (
        <Card>
          <div className="card-header">
            <h2 className="card-title">Results ({results.total})</h2>
          </div>
          <div className="card-content" style={{ padding: 0 }}>
            {isLoading ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '32px' }}>
                <div className="loading-spinner" aria-hidden="true" />
              </div>
            ) : results.items.length === 0 ? (
              <EmptyState
                icon={<SearchIcon />}
                title="No results found"
                text="Try adjusting your search terms or filters."
              />
            ) : (
              <div className="list" style={{ borderTop: '1px solid var(--color-border)' }}>
                {results.items.map(item => (
                  <SearchResultRow key={item.id} item={item} timeZone={getTimeZone()} onNavigate={path => window.location.href = path} />
                ))}
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  )
}