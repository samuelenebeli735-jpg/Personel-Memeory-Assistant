import type {
  CaptureDto,
  EventDto,
  IdeaDto,
  NoteDto,
  ProjectDto,
  ReminderDto,
  TaskDto,
} from '../lib/api'

const CAPTURED_AT = '2026-10-20T10:00:00.000Z'

export function captureFixture(overrides: Partial<CaptureDto> = {}): CaptureDto {
  return {
    id: 'capture_123456789',
    source: 'TELEGRAM',
    externalId: null,
    rawText: 'A typed capture',
    kind: 'NOTE',
    status: 'CLASSIFIED',
    confidence: 0.9,
    needsReview: false,
    classificationRationale: null,
    transcript: null,
    transcriptSource: null,
    isVoice: false,
    capturedAt: CAPTURED_AT,
    processedAt: CAPTURED_AT,
    deletedAt: null,
    createdAt: CAPTURED_AT,
    updatedAt: CAPTURED_AT,
    tags: [],
    links: [],
    ...overrides,
  }
}

export function taskFixture(overrides: Partial<TaskDto> = {}): TaskDto {
  return {
    id: 'task_123456789',
    title: 'Call Ada',
    description: 'Ask about the launch date',
    status: 'PENDING',
    priority: 'HIGH',
    category: null,
    dueAt: '2026-10-21T09:00:00.000Z',
    completedAt: null,
    cancelledAt: null,
    projectId: null,
    projectName: null,
    captureId: null,
    isOverdue: false,
    createdAt: CAPTURED_AT,
    updatedAt: CAPTURED_AT,
    tags: [],
    ...overrides,
  }
}

export function reminderFixture(overrides: Partial<ReminderDto> = {}): ReminderDto {
  return {
    id: 'reminder_123456789',
    title: 'Call Ada',
    body: 'Ask about the launch date',
    remindAt: '2026-10-21T09:00:00.000Z',
    status: 'SCHEDULED',
    attempts: 0,
    lastError: null,
    deliveredAt: null,
    taskId: null,
    captureId: null,
    recurrence: null,
    parentId: null,
    occurrenceKey: null,
    createdAt: CAPTURED_AT,
    updatedAt: CAPTURED_AT,
    ...overrides,
  }
}

export function noteFixture(overrides: Partial<NoteDto> = {}): NoteDto {
  return {
    id: 'note_123456789',
    title: 'Launch notes',
    body: 'Keep the rollout small.',
    url: 'https://example.com/launch',
    projectId: null,
    projectName: null,
    captureId: null,
    createdAt: CAPTURED_AT,
    updatedAt: CAPTURED_AT,
    tags: [],
    ...overrides,
  }
}

export function ideaFixture(overrides: Partial<IdeaDto> = {}): IdeaDto {
  return {
    id: 'idea_123456789',
    title: 'A smaller launch',
    body: 'Start with one team.',
    projectId: null,
    projectName: null,
    captureId: null,
    createdAt: CAPTURED_AT,
    updatedAt: CAPTURED_AT,
    tags: [],
    ...overrides,
  }
}

export function eventFixture(overrides: Partial<EventDto> = {}): EventDto {
  return {
    id: 'event_123456789',
    title: 'Launch review',
    description: 'Review the rollout plan.',
    startsAt: '2026-10-21T09:00:00.000Z',
    endsAt: '2026-10-21T10:00:00.000Z',
    projectId: null,
    projectName: null,
    captureId: null,
    createdAt: CAPTURED_AT,
    updatedAt: CAPTURED_AT,
    ...overrides,
  }
}

export function projectFixture(overrides: Partial<ProjectDto> = {}): ProjectDto {
  return {
    id: 'project_123456789',
    name: 'Launch',
    description: 'Ship the first version.',
    status: 'ACTIVE',
    createdAt: CAPTURED_AT,
    updatedAt: CAPTURED_AT,
    counts: { tasks: 3, openTasks: 2, notes: 1, ideas: 1, events: 1 },
    ...overrides,
  }
}
