/**
 * API client for the Recall dashboard.
 *
 * All methods throw `ApiError` on failure (R2-07, refinement 5):
 * - `kind: 'http'` carries the HTTP status, the server's safe message and code,
 *   and `retryAfter` (seconds) on 429.
 * - `kind: 'network'` means no response arrived; `kind: 'timeout'` means none
 *   arrived within the time limit (15 s by default).
 * - Only a 401 from a protected endpoint signs the dashboard out.
 * - Reads (GET) retry up to twice on a network failure or a 5xx. Writes are
 *   never retried automatically, so an action is never applied twice.
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
  RestoreFileReportDto,
  AskResponse,
  BriefingResponseDto,
  CaptureConvertResultDto,
  CaptureRemovalResultDto,
} from '../types/api'
import { notifyUnauthorized, shouldNotifyUnauthorized } from './auth-events'
import { notifyNetworkFailed, notifyNetworkOk } from './network-events'

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
  RestoreFileReportDto,
  AskResponse,
  BriefingResponseDto,
  CaptureConvertResultDto,
  CaptureRemovalResultDto,
}

const API_BASE = '/api'

/** Requests that get no response within this time fail as `timeout`. */
export const DEFAULT_TIMEOUT_MS = 15_000

/** Waits before the first and second automatic retry of a read. */
export const READ_RETRY_DELAYS_MS = [500, 1500] as const

interface ApiErrorResponse {
  error: {
    code: string
    message: string
    details?: unknown
  }
}

export type ApiErrorKind = 'http' | 'network' | 'timeout'

class ApiError extends Error {
  code: string
  /** HTTP status, or 0 when no response arrived. */
  status: number
  details?: unknown
  kind: ApiErrorKind
  /** Seconds to wait, from the Retry-After header (429). */
  retryAfter: number | null

  constructor(
    message: string,
    code: string,
    status: number,
    details?: unknown,
    extra: { kind?: ApiErrorKind; retryAfter?: number | null } = {},
  ) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.details = details
    this.kind = extra.kind ?? 'http'
    this.retryAfter = extra.retryAfter ?? null
  }
}

/** Retry-After is either whole seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value === null || value.trim() === '') return null
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed)
  const at = Date.parse(trimmed)
  if (Number.isNaN(at)) return null
  return Math.max(0, Math.ceil((at - now) / 1000))
}

/**
 * True when the server refused an action until the user confirms it (for
 * example converting or undoing a capture whose records were edited); the UI
 * then asks and repeats the request with `force: true`.
 */
export function requiresConfirmation(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 400) return false
  const details = error.details as { requiresConfirmation?: unknown } | undefined
  return details?.requiresConfirmation === true
}

/** Only reads that failed without a usable answer are retried. */
export function isRetryableRead(error: unknown): boolean {
  return error instanceof ApiError && (error.kind === 'network' || (error.kind === 'http' && error.status >= 500))
}

interface RequestOptions extends RequestInit {
  /** Overrides the 15 s limit (Ask and restore may legitimately take longer). */
  timeoutMs?: number
  /** Automatic retries for a GET; ignored for every other method. */
  retries?: number
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function attempt<T>(path: string, options: RequestOptions): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, retries: _retries, ...init } = options
  void _retries
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    let response: Response
    try {
      response = await fetch(`${API_BASE}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          // Fastify rejects an empty body when the request claims to be JSON, so
          // only advertise JSON when a body is actually present. Several actions
          // (logout, reprocess, undo) are bodyless POSTs.
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...init.headers,
        },
        credentials: 'include',
      })
    } catch {
      if (timedOut) {
        throw new ApiError('Recall didn’t respond in time.', 'TIMEOUT', 0, undefined, { kind: 'timeout' })
      }
      notifyNetworkFailed()
      throw new ApiError('Can’t reach Recall.', 'NETWORK_ERROR', 0, undefined, { kind: 'network' })
    }

    // Any HTTP answer, even an error, proves Recall is reachable.
    notifyNetworkOk()

    if (!response.ok) {
      let errorData: ApiErrorResponse
      try {
        errorData = await response.json()
      } catch {
        errorData = { error: { code: 'UNKNOWN', message: response.statusText } }
      }
      if (shouldNotifyUnauthorized(path, response.status)) {
        notifyUnauthorized()
      }
      throw new ApiError(
        errorData.error?.message ?? 'Request failed',
        errorData.error?.code ?? 'UNKNOWN',
        response.status,
        errorData.error?.details,
        { kind: 'http', retryAfter: parseRetryAfter(response.headers.get('retry-after')) },
      )
    }

    if (response.status === 204) {
      return undefined as T
    }

    return (await response.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase()
  // Writes are never retried: a lost response might mean the write happened.
  const retries =
    method === 'GET'
      ? Math.max(0, Math.min(options.retries ?? READ_RETRY_DELAYS_MS.length, READ_RETRY_DELAYS_MS.length))
      : 0
  for (let attemptIndex = 0; ; attemptIndex += 1) {
    try {
      return await attempt<T>(path, options)
    } catch (error) {
      if (attemptIndex >= retries || !isRetryableRead(error)) throw error
      await sleep(READ_RETRY_DELAYS_MS[attemptIndex] ?? 1500)
    }
  }
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

  /** No automatic retries: the session bootstrap runs its own retry schedule. */
  session: () =>
    request<{ authenticated: boolean; expiresAt?: string; reason?: string }>('/auth/session', { retries: 0 }),

  health: () => request<HealthDto>('/health', { retries: 0 }),
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

  /** Captures that need a decision, oldest first; `total` counts all of them (S1). */
  inbox: (params: { limit?: number; offset?: number } = {}) =>
    request<Paginated<CaptureDto>>(`/captures/inbox${queryString({ limit: params.limit ?? 25, offset: params.offset ?? 0 })}`),

  get: (id: string) => request<CaptureDto>(`/captures/${id}`),

  create: (input: CaptureInput) =>
    request<CaptureAckDto>('/captures', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  // Captures are immutable: there is no update endpoint (C2).

  reprocess: (id: string) =>
    request<CaptureAckDto>(`/captures/${id}/reprocess`, { method: 'POST' }),

  /**
   * Keeps the capture as the chosen kind (C1). Without `force` the server
   * refuses when a record derived from the capture was already edited.
   */
  convert: (id: string, kind: 'TASK' | 'NOTE' | 'IDEA' | 'EVENT', force = false) =>
    request<CaptureConvertResultDto>(`/captures/${id}/convert`, {
      method: 'POST',
      body: JSON.stringify({ kind, force }),
    }),

  /**
   * Removes what the capture created and hides it. Not reversible. Without
   * `force` the server refuses outside the 15-minute window or when a
   * derived record was edited.
   */
  undo: (id: string, force = false) =>
    request<CaptureRemovalResultDto>(`/captures/${id}/undo`, {
      method: 'POST',
      body: JSON.stringify({ force }),
    }),

  /** Permanent purge: the server requires `force: true`. */
  delete: (id: string, force = false) =>
    request<CaptureRemovalResultDto>(`/captures/${id}`, {
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
  /** Paginated (S2). Archived projects are listed only when asked for. */
  list: (params?: {
    includeArchived?: 'true' | 'false'
    limit?: number
    offset?: number
  }) => request<Paginated<ProjectDto>>(`/projects${queryString(params ?? {})}`),

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

// Ask (C3)
export const askApi = {
  /** The question travels only in the request body, never in a URL. */
  ask: (question: string) =>
    request<AskResponse>('/ask', {
      method: 'POST',
      body: JSON.stringify({ question }),
      timeoutMs: 60_000,
    }),
}

// Briefing (C3)
export const briefingApi = {
  /** `date` is a calendar date (YYYY-MM-DD) in the Settings zone; omitted means today. */
  get: (date?: string) => request<BriefingResponseDto>(`/briefing${queryString({ date })}`),
}

// Export / Restore (C3)
export const exportApi = {
  export: () => request<ExportBundleDto>('/export', { timeoutMs: 60_000 }),
}

export const restoreApi = {
  /**
   * Dry run of an export file. The body is the file's exact bytes; the
   * server hashes what it received and refuses with 409 if that differs from
   * `sha256` (the browser's own hash of the same bytes).
   */
  check: (bytes: ArrayBuffer, sha256: string) =>
    request<RestoreFileReportDto>(`/restore/file${queryString({ dryRun: 'true', sha256 })}`, {
      method: 'POST',
      body: bytes,
      headers: { 'Content-Type': 'application/json' },
      timeoutMs: 120_000,
    }),
  /**
   * Applies the restore. `sha256` and `checkToken` are the values the server
   * returned from the check; the server recomputes both from the bytes it
   * receives now and refuses with 409 if this is not the file it checked.
   */
  apply: (bytes: ArrayBuffer, sha256: string, checkToken: string) =>
    request<RestoreFileReportDto>(`/restore/file${queryString({ dryRun: 'false', sha256, checkToken })}`, {
      method: 'POST',
      body: bytes,
      headers: { 'Content-Type': 'application/json' },
      timeoutMs: 120_000,
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
  restore: restoreApi,
  ask: askApi,
  briefing: briefingApi,
  dashboard: dashboardApi,
}

export { ApiError }
export type { ApiErrorResponse }