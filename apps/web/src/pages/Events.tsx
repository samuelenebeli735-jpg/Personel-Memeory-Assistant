import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { useToast } from '../hooks/useToast'
import { eventsApi, type EventDto } from '../lib/api'
import { useTimeZone } from '../hooks/useTimeZone'
import { localDateTimeToUtcIso } from '../lib/date'
import { Button, Input, Textarea, Card, EmptyState, Modal } from '../components/ui'
import { EventRow } from '../components/record-rows'
import { EventsIcon } from '../components/Layout'

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
  const [createErrors, setCreateErrors] = useState<{ startsAt?: string; endsAt?: string }>({})

  const timeZone = useTimeZone().timeZone
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
    // Start and end are wall-clock times in the owner's Settings zone.
    const startsAt = localDateTimeToUtcIso(createForm.startsAt, timeZone)
    const endsAt = localDateTimeToUtcIso(createForm.endsAt, timeZone)
    const nextErrors: { startsAt?: string; endsAt?: string } = {}
    if (!startsAt.ok) nextErrors.startsAt = startsAt.error
    if (!endsAt.ok) nextErrors.endsAt = endsAt.error
    if (Object.keys(nextErrors).length > 0 || !startsAt.ok || !startsAt.value || !endsAt.ok) {
      setCreateErrors(nextErrors)
      return
    }
    setCreateErrors({})
    setCreateLoading(true)
    try {
      await eventsApi.create({
        title: createForm.title.trim(),
        description: createForm.description.trim() || null,
        startsAt: startsAt.value,
        endsAt: endsAt.value,
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
                  <EventRow key={event.id} event={event} timeZone={timeZone} />
                ))}
              </div>
            </>
          )}
        </div>
      </Card>

      <Modal isOpen={showCreateModal} onClose={() => setShowCreateModal(false)} title="Create Event">
        {/* One submit path: `handleCreate` converts the times in the Settings zone. */}
        <form onSubmit={handleCreate}>
          <Input label="Title" placeholder="Event title" value={createForm.title} onChange={e => setCreateForm({ ...createForm, title: e.target.value })} required />
          <Textarea label="Description (optional)" placeholder="Details..." value={createForm.description} onChange={e => setCreateForm({ ...createForm, description: e.target.value })} rows={3} />
          <Input
            label="Starts At"
            type="datetime-local"
            value={createForm.startsAt}
            onChange={e => {
              setCreateForm({ ...createForm, startsAt: e.target.value })
              if (createErrors.startsAt) setCreateErrors(prev => ({ ...prev, startsAt: undefined }))
            }}
            error={createErrors.startsAt}
            hint={`Time zone: ${timeZone}`}
            required
          />
          <Input
            label="Ends At (optional)"
            type="datetime-local"
            value={createForm.endsAt}
            onChange={e => {
              setCreateForm({ ...createForm, endsAt: e.target.value })
              if (createErrors.endsAt) setCreateErrors(prev => ({ ...prev, endsAt: undefined }))
            }}
            error={createErrors.endsAt}
          />
          <div className="modal-footer">
            <Button variant="secondary" type="button" onClick={() => setShowCreateModal(false)}>Cancel</Button>
            <Button type="submit" loading={createLoading}>Create Event</Button>
          </div>
        </form>
      </Modal>
    </div>
  )
}