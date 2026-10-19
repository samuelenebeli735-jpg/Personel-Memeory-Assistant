import { useState, useEffect } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { useToast } from '../hooks/useToast'
import { eventsApi, type EventDto } from '../lib/api'
import { formatLocalDateTime, formatRelative, getTimeZone } from '../lib/date'
import { Button, Input, Textarea, Card, Badge, EmptyState, Modal } from '../components/ui'
import { EventsIcon } from '../components/Layout'

function EventRow({ event, timeZone }: { event: EventDto; timeZone: string }) {
  const isUpcoming = new Date(event.startsAt).getTime() > Date.now()
  return (
    <Link to={`/events/${event.id}`} className="list-item" style={{ textDecoration: 'none', color: 'inherit' }}>
      <div className="list-item-content" style={{ minWidth: 0 }}>
        <div className="list-item-title" style={{ textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
          {event.title}
        </div>
        <div className="list-item-meta">
          <Badge variant={isUpcoming ? 'primary' : 'muted'}>
            {isUpcoming ? 'Upcoming' : 'Past'}
          </Badge>
          <span>{formatLocalDateTime(event.startsAt, timeZone)}</span>
          {event.endsAt && <span>– {formatLocalTime(event.endsAt, timeZone)}</span>}
          {event.projectName && <Badge variant="muted">{event.projectName}</Badge>}
          <span style={{ fontFamily: 'monospace', fontSize: '11px', color: 'var(--color-text-muted)' }}>#{event.id.slice(0, 6)}</span>
        </div>
      </div>
    </Link>
  )
}

function formatLocalTime(isoString: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(isoString))
  } catch {
    return '—'
  }
}

export function EventsPage() {
  const { showToast } = useToast()
  const [searchParams, setSearchParams] = useSearchParams()
  const [events, setEvents] = useState<EventDto[]>([])
  const [total, setTotal] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [createForm, setCreateForm] = useState<{ title: string; description: string; startsAt: string; endsAt: string }>({
    title: '', description: '', startsAt: '', endsAt: ''
  })
  const [createLoading, setCreateLoading] = useState(false)

  const timeZone = getTimeZone()
  const page = parseInt(searchParams.get('page') || '1', 10)
  const limit = 25

  useEffect(() => {
    const load = async () => {
      setIsLoading(true)
      try {
        const data = await eventsApi.list({ limit, offset: (page - 1) * limit, sort: 'startsAt', order: 'asc' })
        setEvents(data.items)
        setTotal(data.total)
      } catch (err) {
        console.error(err)
      } finally {
        setIsLoading(false)
      }
    }
    load()
  }, [page])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!createForm.title.trim() || !createForm.startsAt) return
    setCreateLoading(true)
    try {
      await eventsApi.create({
        title: createForm.title.trim(),
        description: createForm.description.trim() || null,
        startsAt: new Date(createForm.startsAt).toISOString(),
        endsAt: createForm.endsAt ? new Date(createForm.endsAt).toISOString() : null,
        projectId: null,
        captureId: null,
      })
      showToast('success', 'Event created')
      setShowCreateModal(false)
      setCreateForm({ title: '', description: '', startsAt: '', endsAt: '' })
      const data = await eventsApi.list({ limit, offset: (page - 1) * limit, sort: 'startsAt', order: 'asc' })
      setEvents(data.items)
      setTotal(data.total)
    } catch (err) {
      console.error(err)
    } finally {
      setCreateLoading(false)
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <h1 style={{ fontSize: '24px', fontWeight: '600', margin: 0 }}>Events</h1>
        <Button variant="primary" size="lg" onClick={() => setShowCreateModal(true)}>New Event</Button>
      </div>

      <Card>
        <div className="card-content" style={{ padding: 0 }}>
          {isLoading ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '32px' }}>
              <div className="loading-spinner" aria-hidden="true" />
            </div>
          ) : events.length === 0 ? (
            <EmptyState
              icon={<EventsIcon />}
              title="No events yet"
              text="Schedule appointments and happenings."
              action={<Button variant="primary" onClick={() => setShowCreateModal(true)}>Create Event</Button>}
            />
          ) : (
            <>
              <div className="list" style={{ borderTop: '1px solid var(--color-border)' }}>
                {events.map(event => (
                  <EventRow key={event.id} event={event} timeZone={getTimeZone()} />
                ))}
              </div>
            </>
          )}
        </div>
      </Card>

      <Modal isOpen={showCreateModal} onClose={() => setShowCreateModal(false)} title="Create Event">
        <form onSubmit={async (e) => {
          e.preventDefault()
          try {
            await eventsApi.create({
              title: createForm.title.trim(),
              description: createForm.description.trim() || null,
              startsAt: new Date(createForm.startsAt).toISOString(),
              endsAt: createForm.endsAt ? new Date(createForm.endsAt).toISOString() : null,
              projectId: null,
              captureId: null,
            })
            showToast('success', 'Event created')
            setShowCreateModal(false)
            setCreateForm({ title: '', description: '', startsAt: '', endsAt: '' })
            const data = await eventsApi.list({ limit: 25, offset: 0, sort: 'startsAt', order: 'asc' })
            setEvents(data.items)
            setTotal(data.total)
          } catch (err) {
            console.error(err)
          }
        }}>
          <Input label="Title" placeholder="Event title" value={createForm.title} onChange={e => setCreateForm({ ...createForm, title: e.target.value })} required />
          <Textarea label="Description (optional)" placeholder="Details..." value={createForm.description} onChange={e => setCreateForm({ ...createForm, description: e.target.value })} rows={3} />
          <Input label="Starts At" type="datetime-local" value={createForm.startsAt} onChange={e => setCreateForm({ ...createForm, startsAt: e.target.value })} required />
          <Input label="Ends At (optional)" type="datetime-local" value={createForm.endsAt} onChange={e => setCreateForm({ ...createForm, endsAt: e.target.value })} />
          <div className="modal-footer">
            <Button variant="secondary" type="button" onClick={() => setShowCreateModal(false)}>Cancel</Button>
            <Button type="submit">Create Event</Button>
          </div>
        </form>
      </Modal>
    </div>
  )
}