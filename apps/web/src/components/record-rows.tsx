/**
 * Shared list rows.
 *
 * Every visible record detail link is built here through `detailPath`, which is
 * backed by the same route patterns the app registers.
 */
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type {
  CaptureDto,
  EventDto,
  IdeaDto,
  NoteDto,
  ProjectDto,
  ReminderDto,
  TaskDto,
} from '../lib/api'
import { formatLocalDateTime, formatLocalTime, formatRelative, isOverdue } from '../lib/date'
import { captureDisplayTitle } from '../lib/capture-content'
import { detailPath } from '../lib/routes'
import { Badge } from './ui'

const detailLinkStyle = {
  textDecoration: 'none',
  color: 'inherit',
  display: 'flex',
  flexDirection: 'column' as const,
  gap: '4px',
  width: '100%',
  minWidth: 0,
}

const idStyle = {
  fontFamily: 'monospace',
  fontSize: '11px',
  color: 'var(--color-text-muted)',
}

export function CaptureRow({ capture, timeZone }: { capture: CaptureDto; timeZone: string }) {
  return (
    <div className="list-item">
      <div className="list-item-content" style={{ minWidth: 0 }}>
        <Link to={detailPath('capture', capture.id)} style={detailLinkStyle}>
          <div className="list-item-title" style={{ textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
            {captureDisplayTitle(capture)}
          </div>
          <div className="list-item-meta">
            <Badge variant="muted">{capture.kind}</Badge>
            {capture.isVoice && <Badge variant="primary">voice</Badge>}
            <span>{formatRelative(capture.capturedAt, timeZone)}</span>
            {capture.needsReview && <Badge variant="warning">needs review</Badge>}
            <span style={idStyle}>#{capture.id.slice(0, 6)}</span>
          </div>
        </Link>
      </div>
    </div>
  )
}

export function TaskRow({
  task,
  timeZone,
  actions,
}: {
  task: TaskDto
  timeZone: string
  actions?: ReactNode
}) {
  return (
    <div className="list-item">
      <div className="list-item-content" style={{ minWidth: 0 }}>
        <Link to={detailPath('task', task.id)} style={detailLinkStyle}>
          <div className="list-item-title" style={{ textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
            {task.title}
          </div>
          <div className="list-item-meta">
            {task.dueAt && (
              <span style={{ color: task.isOverdue ? 'var(--color-overdue)' : 'var(--color-text-muted)' }}>
                {task.isOverdue ? '⚠ ' : ''}{formatLocalDateTime(task.dueAt, timeZone)}
              </span>
            )}
            {task.priority && <Badge variant={task.priority === 'URGENT' ? 'danger' : task.priority === 'HIGH' ? 'warning' : 'muted'}>{task.priority}</Badge>}
            {task.projectName && <Badge variant="muted">{task.projectName}</Badge>}
            <Badge variant={
              task.status === 'COMPLETED' ? 'success' :
              task.status === 'IN_PROGRESS' ? 'primary' :
              task.status === 'CANCELLED' ? 'danger' : 'primary'
            }>{task.status}</Badge>
            <span style={idStyle}>#{task.id.slice(0, 6)}</span>
          </div>
        </Link>
      </div>
      {actions && <div className="list-item-actions">{actions}</div>}
    </div>
  )
}

export function ReminderRow({
  reminder,
  timeZone,
  actions,
}: {
  reminder: ReminderDto
  timeZone: string
  actions?: ReactNode
}) {
  return (
    <div className="list-item">
      <div className="list-item-content" style={{ minWidth: 0 }}>
        <Link to={detailPath('reminder', reminder.id)} style={detailLinkStyle}>
          <div className="list-item-title" style={{ textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
            {reminder.title}
          </div>
          <div className="list-item-meta">
            <span style={{ color: reminder.status === 'SCHEDULED' && isOverdue(reminder.remindAt) ? 'var(--color-overdue)' : 'var(--color-text-muted)' }}>
              {formatLocalDateTime(reminder.remindAt, timeZone)}
              {reminder.recurrence && <Badge variant="muted" style={{ marginLeft: '8px' }}>{reminder.recurrence.frequency}</Badge>}
            </span>
            <Badge variant={
              reminder.status === 'SCHEDULED' ? 'primary' :
              reminder.status === 'SENT' ? 'success' :
              reminder.status === 'FAILED' ? 'danger' :
              reminder.status === 'MISSED' ? 'warning' : 'muted'
            }>{reminder.status}</Badge>
            <span style={idStyle}>#{reminder.id.slice(0, 6)}</span>
          </div>
        </Link>
      </div>
      {actions && <div className="list-item-actions">{actions}</div>}
    </div>
  )
}

export function NoteRow({ note, timeZone }: { note: NoteDto; timeZone: string }) {
  return (
    <div className="list-item">
      <div className="list-item-content" style={{ minWidth: 0 }}>
        <Link to={detailPath('note', note.id)} style={detailLinkStyle}>
          <div className="list-item-title" style={{ textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
            {note.title || note.body.slice(0, 80)}
          </div>
          <div className="list-item-meta">
            <span>{formatRelative(note.createdAt, timeZone)}</span>
            {note.projectName && <Badge variant="muted">{note.projectName}</Badge>}
            <span style={idStyle}>#{note.id.slice(0, 6)}</span>
          </div>
        </Link>
        {note.url && (
          <a
            href={note.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'var(--color-primary)', textDecoration: 'none', fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis' }}
          >
            {note.url}
          </a>
        )}
      </div>
    </div>
  )
}

export function IdeaRow({ idea, timeZone }: { idea: IdeaDto; timeZone: string }) {
  return (
    <div className="list-item">
      <div className="list-item-content" style={{ minWidth: 0 }}>
        <Link to={detailPath('idea', idea.id)} style={detailLinkStyle}>
          <div className="list-item-title" style={{ textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
            {idea.title}
          </div>
          <div className="list-item-meta">
            {idea.body && <span style={{ color: 'var(--color-text-muted)', fontSize: '12px', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block', verticalAlign: 'middle' }}>{idea.body.slice(0, 100)}</span>}
            <span>{formatRelative(idea.createdAt, timeZone)}</span>
            {idea.projectName && <Badge variant="muted">{idea.projectName}</Badge>}
            <span style={idStyle}>#{idea.id.slice(0, 6)}</span>
          </div>
        </Link>
      </div>
    </div>
  )
}

export function EventRow({ event, timeZone }: { event: EventDto; timeZone: string }) {
  const isUpcoming = new Date(event.startsAt).getTime() > Date.now()
  return (
    <div className="list-item">
      <div className="list-item-content" style={{ minWidth: 0 }}>
        <Link to={detailPath('event', event.id)} style={detailLinkStyle}>
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
            <span style={idStyle}>#{event.id.slice(0, 6)}</span>
          </div>
        </Link>
      </div>
    </div>
  )
}

export function ProjectRow({ project, timeZone }: { project: ProjectDto; timeZone: string }) {
  return (
    <div className="list-item">
      <div className="list-item-content" style={{ minWidth: 0 }}>
        <Link to={detailPath('project', project.id)} style={detailLinkStyle}>
          <div className="list-item-title" style={{ textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
            {project.name}
          </div>
          <div className="list-item-meta">
            <Badge variant={project.status === 'ARCHIVED' ? 'warning' : 'success'}>{project.status}</Badge>
            <span>{project.counts.openTasks > 0 ? `${project.counts.openTasks} open tasks` : 'No open tasks'}</span>
            {project.counts.notes > 0 && <span>{project.counts.notes} notes</span>}
            {project.counts.ideas > 0 && <span>{project.counts.ideas} ideas</span>}
            {project.counts.events > 0 && <span>{project.counts.events} events</span>}
            <span>{formatRelative(project.updatedAt, timeZone)}</span>
            <span style={idStyle}>#{project.id.slice(0, 6)}</span>
          </div>
        </Link>
      </div>
    </div>
  )
}
