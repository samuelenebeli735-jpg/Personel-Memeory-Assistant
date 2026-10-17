/**
 * Domain vocabulary shared by the API, the bots and the dashboard.
 *
 * SQLite (via Prisma) has no native enum support, so these string unions are the
 * single source of truth. They are enforced at runtime by Zod on every write
 * path and at compile time across the codebase.
 */

export const CAPTURE_KINDS = ['TASK', 'IDEA', 'NOTE', 'EVENT', 'OTHER', 'UNKNOWN'] as const;
export type CaptureKind = (typeof CAPTURE_KINDS)[number];

export const CAPTURE_STATUSES = [
  'RECEIVED',
  'CLASSIFIED',
  'NEEDS_REVIEW',
  'FAILED',
  'DELETED',
] as const;
export type CaptureStatus = (typeof CAPTURE_STATUSES)[number];

export const CAPTURE_SOURCES = ['TELEGRAM', 'WEB', 'API', 'CLI'] as const;
export type CaptureSource = (typeof CAPTURE_SOURCES)[number];

export const TASK_STATUSES = ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PROJECT_STATUSES = ['ACTIVE', 'ARCHIVED'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const REMINDER_STATUSES = ['SCHEDULED', 'SENT', 'CANCELLED', 'FAILED', 'MISSED'] as const;
export type ReminderStatus = (typeof REMINDER_STATUSES)[number];

export const DELIVERY_STATUSES = ['PENDING', 'DELIVERED', 'FAILED', 'SKIPPED'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const RECURRENCE_FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY'] as const;
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];

/** Where a transcript came from - keeps provenance explicit. */
export const TRANSCRIPT_SOURCES = ['SPEECH_PROVIDER', 'MANUAL'] as const;
export type TranscriptSource = (typeof TRANSCRIPT_SOURCES)[number];

/** Which structured record a capture was distilled into. */
export const STRUCTURED_TYPES = ['TASK', 'NOTE', 'IDEA', 'EVENT'] as const;
export type StructuredType = (typeof STRUCTURED_TYPES)[number];

export const CAPTURE_RELATION_TYPES = ['DUPLICATE_OF', 'RELATED_TO', 'FOLLOW_UP_OF'] as const;
export type CaptureRelationType = (typeof CAPTURE_RELATION_TYPES)[number];

/** Terminal task states. Used by the state-transition guard. */
export const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  PENDING: ['IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'PENDING'],
  IN_PROGRESS: ['PENDING', 'COMPLETED', 'CANCELLED', 'IN_PROGRESS'],
  COMPLETED: ['PENDING', 'COMPLETED'],
  CANCELLED: ['PENDING', 'CANCELLED'],
};

export const DEFAULT_TIME_ZONE = 'Africa/Lagos';
export const APP_NAME = 'Recall';
