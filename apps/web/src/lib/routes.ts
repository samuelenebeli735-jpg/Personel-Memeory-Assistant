/**
 * Single source of truth for dashboard URLs.
 *
 * Detail links and the router both import these values, so a row cannot point at
 * a path the app does not register. `detailPath` is the only supported way to
 * build a record URL.
 */

export const APP_PATHS = {
  overview: '/',
  today: '/briefing',
  ask: '/ask',
  login: '/login',
  capture: '/capture',
  inbox: '/inbox',
  tasks: '/tasks',
  reminders: '/reminders',
  notes: '/notes',
  ideas: '/ideas',
  events: '/events',
  projects: '/projects',
  search: '/search',
  settings: '/settings',
} as const

export type RecordDetailType =
  | 'capture'
  | 'task'
  | 'reminder'
  | 'note'
  | 'idea'
  | 'event'
  | 'project'

/** Registered React Router patterns for each record type. */
export const DETAIL_ROUTE_PATTERNS: Record<RecordDetailType, string> = {
  capture: '/captures/:id',
  task: '/tasks/:id',
  reminder: '/reminders/:id',
  note: '/notes/:id',
  idea: '/ideas/:id',
  event: '/events/:id',
  project: '/projects/:id',
}

/** Back-links shown on each detail page. */
export const DETAIL_BACK_LINKS: Record<RecordDetailType, { to: string; label: string }> = {
  capture: { to: APP_PATHS.capture, label: 'Quick Capture' },
  task: { to: APP_PATHS.tasks, label: 'Tasks' },
  reminder: { to: APP_PATHS.reminders, label: 'Reminders' },
  note: { to: APP_PATHS.notes, label: 'Notes' },
  idea: { to: APP_PATHS.ideas, label: 'Ideas' },
  event: { to: APP_PATHS.events, label: 'Events' },
  project: { to: APP_PATHS.projects, label: 'Projects' },
}

export function detailPath(type: RecordDetailType, id: string): string {
  return `${DETAIL_ROUTE_PATTERNS[type].replace(':id', '')}${encodeURIComponent(id)}`
}
