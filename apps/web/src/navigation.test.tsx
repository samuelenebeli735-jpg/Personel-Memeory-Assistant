import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, matchPath } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import {
  CaptureRow,
  EventRow,
  IdeaRow,
  NoteRow,
  ProjectRow,
  ReminderRow,
  TaskRow,
} from './components/record-rows'
import {
  APP_PATHS,
  DETAIL_ROUTE_PATTERNS,
  detailPath,
  type RecordDetailType,
} from './lib/routes'
import { REGISTERED_ROUTE_PATTERNS } from './routes'
import {
  captureFixture,
  eventFixture,
  ideaFixture,
  noteFixture,
  projectFixture,
  reminderFixture,
  taskFixture,
} from './test/fixtures'

function visibleRowLinks(): string[] {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <CaptureRow capture={captureFixture()} timeZone="Africa/Lagos" />
      <TaskRow task={taskFixture()} timeZone="Africa/Lagos" />
      <ReminderRow reminder={reminderFixture()} timeZone="Africa/Lagos" />
      <NoteRow note={noteFixture()} timeZone="Africa/Lagos" />
      <IdeaRow idea={ideaFixture()} timeZone="Africa/Lagos" />
      <EventRow event={eventFixture()} timeZone="Africa/Lagos" />
      <ProjectRow project={projectFixture()} timeZone="Africa/Lagos" />
    </MemoryRouter>,
  )

  return [...html.matchAll(/href="([^"]+)"/g)]
    .map((match) => match[1] ?? '')
    .filter((href) => href.startsWith('/'))
}

function isRegistered(path: string): boolean {
  return REGISTERED_ROUTE_PATTERNS.some((pattern) =>
    matchPath({ path: pattern, end: true }, path) !== null,
  )
}

describe('dashboard navigation', () => {
  it('registers every detail pattern the dashboard can build', () => {
    const types = Object.keys(DETAIL_ROUTE_PATTERNS) as RecordDetailType[]
    expect(types).toHaveLength(7)

    for (const type of types) {
      const path = detailPath(type, 'record-id')
      expect(REGISTERED_ROUTE_PATTERNS).toContain(DETAIL_ROUTE_PATTERNS[type])
      expect(isRegistered(path), `${type} link ${path}`).toBe(true)
    }
  })

  it('keeps every visible capture, task, reminder, note, idea, event and project row link registered', () => {
    const links = visibleRowLinks()

    expect(links).toHaveLength(7)
    for (const link of links) {
      expect(isRegistered(link), `unregistered detail link: ${link}`).toBe(true)
    }

    expect(links).toContain(detailPath('capture', captureFixture().id))
    expect(links).toContain(detailPath('task', taskFixture().id))
    expect(links).toContain(detailPath('reminder', reminderFixture().id))
    expect(links).toContain(detailPath('note', noteFixture().id))
    expect(links).toContain(detailPath('idea', ideaFixture().id))
    expect(links).toContain(detailPath('event', eventFixture().id))
    expect(links).toContain(detailPath('project', projectFixture().id))
  })

  it('registers every top-level navigation path', () => {
    for (const path of Object.values(APP_PATHS)) {
      expect(isRegistered(path), `unregistered app path: ${path}`).toBe(true)
    }
  })
})
