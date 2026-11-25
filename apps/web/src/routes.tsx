/**
 * The dashboard route table.
 *
 * `App` renders this list directly and tests match visible links against the
 * same patterns, so a detail URL cannot be added to a row without also being
 * registered here.
 */
import type { ReactNode } from 'react'
import { APP_PATHS, DETAIL_ROUTE_PATTERNS, type RecordDetailType } from './lib/routes'
import { OverviewPage } from './pages/Overview'
import { CapturePage } from './pages/Capture'
import { InboxPage } from './pages/Inbox'
import { TodayPage } from './pages/Today'
import { AskPage } from './pages/Ask'
import { TasksPage } from './pages/Tasks'
import { RemindersPage } from './pages/Reminders'
import { NotesPage } from './pages/Notes'
import { IdeasPage } from './pages/Ideas'
import { EventsPage } from './pages/Events'
import { ProjectsPage } from './pages/Projects'
import { SearchPage } from './pages/Search'
import { SettingsPage } from './pages/Settings'
import {
  CaptureDetailPage,
  EventDetailPage,
  IdeaDetailPage,
  NoteDetailPage,
  ProjectDetailPage,
  ReminderDetailPage,
  TaskDetailPage,
} from './pages/RecordDetails'

export interface AppRoute {
  path: string
  element: ReactNode
}

const detailElements: Record<RecordDetailType, ReactNode> = {
  capture: <CaptureDetailPage />,
  task: <TaskDetailPage />,
  reminder: <ReminderDetailPage />,
  note: <NoteDetailPage />,
  idea: <IdeaDetailPage />,
  event: <EventDetailPage />,
  project: <ProjectDetailPage />,
}

export const APP_ROUTES: AppRoute[] = [
  { path: APP_PATHS.overview, element: <OverviewPage /> },
  { path: APP_PATHS.capture, element: <CapturePage /> },
  { path: APP_PATHS.inbox, element: <InboxPage /> },
  { path: APP_PATHS.today, element: <TodayPage /> },
  { path: APP_PATHS.ask, element: <AskPage /> },
  { path: APP_PATHS.tasks, element: <TasksPage /> },
  { path: APP_PATHS.reminders, element: <RemindersPage /> },
  { path: APP_PATHS.notes, element: <NotesPage /> },
  { path: APP_PATHS.ideas, element: <IdeasPage /> },
  { path: APP_PATHS.events, element: <EventsPage /> },
  { path: APP_PATHS.projects, element: <ProjectsPage /> },
  { path: APP_PATHS.search, element: <SearchPage /> },
  { path: APP_PATHS.settings, element: <SettingsPage /> },
  ...(Object.keys(DETAIL_ROUTE_PATTERNS) as RecordDetailType[]).map((type) => ({
    path: DETAIL_ROUTE_PATTERNS[type],
    element: detailElements[type],
  })),
]

/** `App` registers the login route outside the authenticated layout. */
export const REGISTERED_ROUTE_PATTERNS = [
  ...APP_ROUTES.map((route) => route.path),
  APP_PATHS.login,
]
