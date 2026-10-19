/**
 * API client for the Recall dashboard.
 * All methods throw on non-2xx responses with a structured error.
 */
import type {
  CaptureDto,
  TaskDto,
  NoteDto,
  IdeaDto,
  EventDto,
  ProjectDto,
  TagDto,
  ReminderDto,
  ReminderDeliveryDto,
  SettingsDto,
  HealthDto,
  DashboardOverviewDto,
  SearchResponse,
  SearchQuery,
  SearchResultItem,
  Paginated,
  CaptureInput,
  TaskCreateInput,
  TaskUpdateInput,
  TaskStatus,
  NoteCreateInput,
  NoteUpdateInput,
  IdeaCreateInput,
  IdeaUpdateInput,
  EventCreateInput,
  EventUpdateInput,
  ProjectCreateInput,
  ProjectUpdateInput,
  ReminderCreateInput,
  ReminderUpdateInput,
  SnoozeInput,
  CaptureAckDto,
  ExportBundleDto,
  RestoreReportDto,
} from '../types/api'

export type {
  CaptureDto,
  TaskDto,
  NoteDto,
  IdeaDto,
  EventDto,
  ProjectDto,
  TagDto,
  ReminderDto,
  ReminderDeliveryDto,
  SettingsDto,
  HealthDto,
  DashboardOverviewDto,
  SearchResponse,
  SearchQuery,
  SearchResultItem,
  Paginated,
  CaptureInput,
  TaskCreateInput,
  TaskUpdateInput,
  TaskStatus,
  NoteCreateInput,
  NoteUpdateInput,
  IdeaCreateInput,
  IdeaUpdateInput,
  EventCreateInput,
  EventUpdateInput,
  ProjectCreateInput,
  ProjectUpdateInput,
  ReminderCreateInput,
  ReminderUpdateInput,
  SnoozeInput,
  CaptureAckDto,
  ExportBundleDto,
  RestoreReportDto,
}

const API_BASE = '/api'

interface ApiErrorResponse {
  error: {
    code: string
    message: string
    details?: unknown
  }
}

class ApiError extends Error {
  code: string
  status: number
  details?: unknown

  constructor(message: string, code: string, status: number, details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.details = details
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    credentials: 'include',
  })

  if (!response.ok) {
    let errorData: ApiErrorResponse
    try {
      errorData = await response.json()
    } catch {
      errorData = { error: { code: 'UNKNOWN', message: response.statusText } }
    }
    throw new ApiError(
      errorData.error?.message ?? 'Request failed',
      errorData.error?.code ?? 'UNKNOWN',
      response.status,
      errorData.error?.details
    )
  }

  if (response.status === 204) {
    return undefined as T
  }

  return response.json()
}

function queryString(params: Record<string, unknown>): string {
  const searchParams = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      for (const v of value) {
        searchParams.append(key, String(v))
      }
    } else {
      searchParams.set(key, String(value))
    }
  }
  const qs = searchParams.toString()
  return qs ? `?${qs}` : ''
}

// Auth
export const authApi = {
  login: (password: string) =>
    request<{ ok: true; expiresInHours: number }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),

  logout: () =>
    request<{ ok: true }>('/auth/logout', { method: 'POST' }),

  session: () =>
    request<{ authenticated: boolean; expiresAt?: string; reason?: string }>('/auth/session'),

  health: () => request<HealthDto>('/health'),
  healthLive: () => request<{ status: 'ok'; version: string; uptimeSeconds: number }>('/health/live'),
}

// Captures
export const capturesApi = {
  list: (params?: {
    kind?: string[]
    status?: string[]
    q?: string
    limit?: number
    offset?: number
    sort?: string
    order?: 'asc' | 'desc'
  }) =>
    request<Paginated<CaptureDto>>(`/captures${queryString(params ?? {})}`),

  inbox: (limit = 25) =>
    request<CaptureDto[]>(`/captures/inbox${queryString({ limit })}`),

  get: (id: string) => request<CaptureDto>(`/captures/${id}`),

  create: (input: CaptureInput) =>
    request<CaptureAckDto>('/captures', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  update: (id: string, input: CaptureInput) =>
    request<CaptureDto>(`/captures/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  reprocess: (id: string) =>
    request<CaptureAckDto>(`/captures/${id}/reprocess`, { method: 'POST' }),

  convert: (id: string, forcedKind: string) =>
    request<CaptureAckDto>(`/captures/${id}/convert`, {
      method: 'POST',
      body: JSON.stringify({ forcedKind }),
    }),

  undo: (id: string) =>
    request<CaptureAckDto>(`/captures/${id}/undo`, { method: 'POST' }),

  delete: (id: string, force = false) =>
    request<{ deleted: true }>(`/captures/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ force }),
    }),
}

// Tasks
export const tasksApi = {
  list: (params?: {
    status?: string[]
    priority?: string
    projectId?: string
    tag?: string
    q?: string
    dueBefore?: string
    dueAfter?: string
    overdue?: 'true' | 'false'
    open?: 'true' | 'false'
    sort?: 'dueAt' | 'createdAt' | 'updatedAt' | 'priority' | 'title'
    order?: 'asc' | 'desc'
    limit?: number
    offset?: number
  }) => request<Paginated<TaskDto>>(`/tasks${queryString(params ?? {})}`),

  today: () => request<TaskDto[]>('/tasks/today'),
  overdue: () => request<TaskDto[]>('/tasks/overdue'),
  counts: () =>
    request<{
      dueToday: number
      overdue: number
      open: number
      total: number
    }>('/tasks/counts'),

  get: (id: string) => request<TaskDto>(`/tasks/${id}`),

  create: (input: TaskCreateInput) =>
    request<TaskDto>('/tasks', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  update: (id: string, input: TaskUpdateInput) =>
    request<TaskDto>(`/tasks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  delete: (id: string) =>
    request<{ deleted: true }>(`/tasks/${id}`, { method: 'DELETE' }),
}

// Notes
export const notesApi = {
  list: (params?: {
    q?: string
    projectId?: string
    tag?: string
    withUrlOnly?: 'true' | 'false'
    sort?: 'createdAt' | 'updatedAt' | 'title'
    order?: 'asc' | 'desc'
    limit?: number
    offset?: number
  }) => request<Paginated<NoteDto>>(`/notes${queryString(params ?? {})}`),

  get: (id: string) => request<NoteDto>(`/notes/${id}`),

  create: (input: NoteCreateInput) =>
    request<NoteDto>('/notes', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  update: (id: string, input: NoteUpdateInput) =>
    request<NoteDto>(`/notes/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  delete: (id: string) =>
    request<{ deleted: true }>(`/notes/${id}`, { method: 'DELETE' }),
}

// Ideas
export const ideasApi = {
  list: (params?: {
    q?: string
    projectId?: string
    tag?: string
    sort?: 'createdAt' | 'updatedAt' | 'title'
    order?: 'asc' | 'desc'
    limit?: number
    offset?: number
  }) => request<Paginated<IdeaDto>>(`/ideas${queryString(params ?? {})}`),

  get: (id: string) => request<IdeaDto>(`/ideas/${id}`),

  create: (input: IdeaCreateInput) =>
    request<IdeaDto>('/ideas', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  update: (id: string, input: IdeaUpdateInput) =>
    request<IdeaDto>(`/ideas/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  promote: (id: string) =>
    request<TaskDto>(`/ideas/${id}/promote`, { method: 'POST' }),

  delete: (id: string) =>
    request<{ deleted: true }>(`/ideas/${id}`, { method: 'DELETE' }),
}

// Events
export const eventsApi = {
  list: (params?: {
    from?: string
    to?: string
    projectId?: string
    sort?: 'startsAt' | 'createdAt' | 'title'
    order?: 'asc' | 'desc'
    limit?: number
    offset?: number
  }) => request<Paginated<EventDto>>(`/events${queryString(params ?? {})}`),

  get: (id: string) => request<EventDto>(`/events/${id}`),

  create: (input: EventCreateInput) =>
    request<EventDto>('/events', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  update: (id: string, input: EventUpdateInput) =>
    request<EventDto>(`/events/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  delete: (id: string) =>
    request<{ deleted: true }>(`/events/${id}`, { method: 'DELETE' }),
}

// Projects
export const projectsApi = {
  list: (params?: {
    status?: string
    limit?: number
    offset?: number
  }) => request<ProjectDto[]>(`/projects${queryString(params ?? {})}`),

  get: (id: string) => request<ProjectDto>(`/projects/${id}`),

  create: (input: ProjectCreateInput) =>
    request<ProjectDto>('/projects', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  update: (id: string, input: ProjectUpdateInput) =>
    request<ProjectDto>(`/projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  delete: (id: string) =>
    request<{ deleted: true; detached: number }>(`/projects/${id}`, { method: 'DELETE' }),
}

// Tags
export const tagsApi = {
  list: () => request<TagDto[]>('/tags'),
  prune: () => request<{ removed: number }>('/tags/prune', { method: 'POST' }),
}

// Reminders
export const remindersApi = {
  list: (params?: {
    status?: string[]
    taskId?: string
    captureId?: string
    dueAfter?: string
    dueBefore?: string
    seriesHeadsOnly?: boolean
    limit?: number
    offset?: number
    order?: 'asc' | 'desc'
  }) => request<Paginated<ReminderDto>>(`/reminders${queryString(params ?? {})}`),

  get: (id: string) => request<ReminderDto>(`/reminders/${id}`),

  create: (input: ReminderCreateInput) =>
    request<ReminderDto>('/reminders', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  update: (id: string, input: ReminderUpdateInput) =>
    request<ReminderDto>(`/reminders/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  delete: (id: string) =>
    request<{ deleted: true }>(`/reminders/${id}`, { method: 'DELETE' }),

  cancel: (id: string) =>
    request<ReminderDto>(`/reminders/${id}/cancel`, { method: 'POST' }),

  snooze: (id: string, input: SnoozeInput) =>
    request<ReminderDto>(`/reminders/${id}/snooze`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  deliveries: (id: string) => request<ReminderDeliveryDto[]>(`/reminders/${id}/deliveries`),
}

// Search
export const searchApi = {
  search: (query: SearchQuery) =>
    request<SearchResponse>('/search', {
      method: 'POST',
      body: JSON.stringify(query),
    }),

  searchGet: (params: SearchQuery) => request<SearchResponse>(`/search${queryString(params)}`),
}

// Settings
export const settingsApi = {
  get: () => request<SettingsDto>('/settings'),
  update: (input: Partial<SettingsDto>) =>
    request<SettingsDto>('/settings', {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
}

// Export / Restore
export const exportApi = {
  export: () => request<ExportBundleDto>('/export'),
  restore: (bundle: ExportBundleDto, dryRun = true) =>
    request<RestoreReportDto>('/restore', {
      method: 'POST',
      body: JSON.stringify({ bundle, dryRun }),
    }),
}

// Dashboard Overview
export const dashboardApi = {
  overview: () => request<DashboardOverviewDto>('/dashboard/overview'),
}

// Export all
export const api = {
  auth: authApi,
  captures: capturesApi,
  tasks: tasksApi,
  notes: notesApi,
  ideas: ideasApi,
  events: eventsApi,
  projects: projectsApi,
  tags: tagsApi,
  reminders: remindersApi,
  search: searchApi,
  settings: settingsApi,
  export: exportApi,
  dashboard: dashboardApi,
}

export { ApiError }
export type { ApiErrorResponse }