import { eventsApi } from '../lib/api'
import { useTimeZone } from '../hooks/useTimeZone'
import { ListPage } from '../components/ListPage'
import { eventFormSpec } from '../components/record-forms'
import { EventRow } from '../components/record-rows'
import { EventsIcon } from '../components/Layout'

export function EventsPage() {
  const { timeZone } = useTimeZone()
  return (
    <ListPage
      title="Events"
      noun="events"
      icon={<EventsIcon />}
      emptyTitle="No events yet"
      emptyText="Schedule appointments and happenings."
      spec={eventFormSpec}
      fetchPage={(page) => eventsApi.list({ sort: 'startsAt', order: 'asc', ...page })}
      renderRows={(events) => events.map((event) => <EventRow key={event.id} event={event} timeZone={timeZone} />)}
    />
  )
}
