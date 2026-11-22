/**
 * Wire types for the HTTP API. Everything crossing the network is JSON with UTC
 * ISO-8601 timestamps; the dashboard converts to the configured local zone for
 * display only.
 */

import type {
  CaptureKind,
  CaptureSource,
  CaptureStatus,
  DeliveryStatus,
  Priority,
  ProjectStatus,
  ReminderStatus,
  SearchEntityType,
  TaskStatus,
  TranscriptSource,
} from './enums.js';
import type { ReminderRecurrence } from './schemas.js';

export interface TagDto {
  id: string;
  name: string;
}

export interface CaptureDto {
  id: string;
  source: CaptureSource;
  externalId: string | null;
  rawText: string;
  kind: CaptureKind;
  status: CaptureStatus;
  confidence: number;
  needsReview: boolean;
  classificationRationale: string | null;
  transcript: string | null;
  transcriptSource: TranscriptSource | null;
  /**
   * True when the source was an audio message. This is a safe presentation flag
   * only: provider names, file ids, audio paths and raw metadata stay server-side.
   */
  isVoice: boolean;
  capturedAt: string;
  processedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  tags: TagDto[];
  /** Structured records distilled from this capture. */
  links: { type: 'TASK' | 'NOTE' | 'IDEA' | 'EVENT'; id: string; title: string }[];
}

export interface TaskDto {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: Priority | null;
  category: string | null;
  dueAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  projectId: string | null;
  projectName: string | null;
  captureId: string | null;
  isOverdue: boolean;
  createdAt: string;
  updatedAt: string;
  tags: TagDto[];
}

export interface NoteDto {
  id: string;
  title: string | null;
  body: string;
  url: string | null;
  projectId: string | null;
  projectName: string | null;
  captureId: string | null;
  createdAt: string;
  updatedAt: string;
  tags: TagDto[];
}

export interface IdeaDto {
  id: string;
  title: string;
  body: string | null;
  projectId: string | null;
  projectName: string | null;
  captureId: string | null;
  createdAt: string;
  updatedAt: string;
  tags: TagDto[];
}

export interface EventDto {
  id: string;
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string | null;
  projectId: string | null;
  projectName: string | null;
  captureId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDto {
  id: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  counts: { tasks: number; openTasks: number; notes: number; ideas: number; events: number };
}

export interface ReminderDto {
  id: string;
  title: string;
  body: string | null;
  remindAt: string;
  status: ReminderStatus;
  attempts: number;
  lastError: string | null;
  deliveredAt: string | null;
  taskId: string | null;
  captureId: string | null;
  recurrence: ReminderRecurrence | null;
  parentId: string | null;
  /** Identity of this occurrence within its series, or null for a standalone one. */
  occurrenceKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReminderDeliveryDto {
  id: string;
  reminderId: string;
  attempt: number;
  status: DeliveryStatus;
  scheduledFor: string;
  attemptedAt: string | null;
  /** Identity of the logical occurrence this attempt belongs to. */
  occurrenceKey: string | null;
  nextRetryAt: string | null;
  error: string | null;
  idempotencyKey: string;
}

export interface SettingsDto {
  displayName: string | null;
  timeZone: string;
  morningDefaultTime: string;
  eveningDefaultTime: string;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  maxNotificationsPerDay: number;
  briefingEnabled: boolean;
  briefingTime: string;
  briefingSections: string[];
  reminderOverdueGraceHours: number;
  aiEnabled: boolean;
  locale: string;
  telegramOwnerConfigured: boolean;
  aiProviderConfigured: boolean;
  /** Server setting AI_ALLOW_RAW_TEXT (read-only here): personal text may be sent to the AI provider. */
  aiRawTextAllowed?: boolean;
  sttProviderConfigured: boolean;
  updatedAt: string;
}

/** Telegram polling state for health. Times and a short code only — never messages or tokens. */
export interface TelegramPollingStatusDto {
  /** starting: token check / webhook removal; retrying: last poll failed. */
  state: 'starting' | 'running' | 'retrying' | 'stopped';
  /** Last successful `getUpdates` (ISO). */
  lastPollAt: string | null;
  lastErrorAt: string | null;
  /** e.g. `webhook_conflict`, `poller_conflict`, `update_failed`, `http_502`, `timeout`, `network`. */
  lastErrorCode: string | null;
  stoppedReason: 'token_rejected' | 'shutdown' | null;
  /** An update whose handling failed and is being retried (not yet acknowledged). */
  retryingUpdateId: number | null;
  /** Updates given up on since start-up; each one was logged and the owner was asked to resend. */
  deadLetteredUpdates: number;
  lastDeadLetterAt: string | null;
}

export interface HealthDto {
  status: 'ok' | 'degraded';
  version: string;
  uptimeSeconds: number;
  database: { connected: boolean; latencyMs: number | null; error?: string };
  scheduler: {
    running: boolean;
    lastTickAt: string | null;
    dueNow: number;
    scheduledTotal: number;
  };
  providers: {
    ai: {
      provider: string;
      configured: boolean;
      enabled: boolean;
      /** Configured model id (AI_MODEL), or null when no provider. */
      model?: string | null;
      /** AI_ALLOW_RAW_TEXT: personal text may be sent to the provider. */
      rawTextAllowed?: boolean;
      /** Last successful provider call since the process started (UTC ISO). */
      lastSuccessAt?: string | null;
      /** Last failed provider call since the process started (UTC ISO). */
      lastFailureAt?: string | null;
      /** Sanitised failure code, e.g. "http_429", "timeout", "refused"; never a message. */
      lastFailureCode?: string | null;
    };
    stt: { provider: string; configured: boolean; enabled: boolean };
    telegram: {
      enabled: boolean;
      mode: string;
      configured: boolean;
      ownerConfigured: boolean;
      /** Present while the bot runs in polling mode; null otherwise. */
      polling?: TelegramPollingStatusDto | null;
    };
  };
  counts: { captures: number; tasks: number; reminders: number; pendingDeliveries: number };
}

export interface DashboardOverviewDto {
  timeZone: string;
  today: string;
  counts: {
    inboxNeedsReview: number;
    tasksDueToday: number;
    tasksOverdue: number;
    tasksOpen: number;
    ideas: number;
    notes: number;
    eventsUpcoming: number;
    capturesToday: number;
  };
  tasksDueToday: TaskDto[];
  overdueTasks: TaskDto[];
  upcomingReminders: ReminderDto[];
  recentCaptures: CaptureDto[];
  inbox: CaptureDto[];
}

export interface SearchResultItem {
  type: SearchEntityType;
  id: string;
  title: string;
  snippet: string;
  status?: string;
  timestamp: string;
  /** Reason this row matched, for transparency. */
  matchedOn: string[];
}

export interface SearchResponse {
  items: SearchResultItem[];
  total: number;
  limit: number;
  offset: number;
  query: Record<string, unknown>;
}

/**
 * The period a time question was answered for ("tomorrow", "this week").
 * Clients display it without parsing the answer text.
 */
export interface AskPeriod {
  /** Inclusive start, UTC ISO-8601. */
  start: string;
  /** Exclusive end, UTC ISO-8601. */
  end: string;
  /** Human-readable label in the owner's zone, e.g. "Tomorrow, Sun 18 Oct". */
  label: string;
  /** IANA zone the period was interpreted in (the owner's Settings zone). */
  timeZone: string;
}

export interface AskResponse {
  grounded: boolean;
  answer: string;
  /** Every record the answer was derived from. */
  evidence: SearchResultItem[];
  provider: string;
  /** True when the answer came from deterministic retrieval, not a model. */
  deterministic: boolean;
  /** Present when the question was about a period of time. Optional and additive. */
  period?: AskPeriod;
}

export interface CaptureAckDto {
  capture: CaptureDto;
  created: { type: 'TASK' | 'NOTE' | 'IDEA' | 'EVENT'; id: string; title: string }[];
  duplicate: boolean;
  needsReview: boolean;
  /** Human-readable confirmation shown to the user. */
  message: string;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface ExportBundleDto {
  exportedAt: string;
  schemaVersion: number;
  settings: SettingsDto;
  counts: Record<string, number>;
  data: {
    captures: unknown[];
    tasks: unknown[];
    notes: unknown[];
    ideas: unknown[];
    events: unknown[];
    projects: unknown[];
    tags: unknown[];
    /** Join rows. Without these a restore would lose every tag link. */
    captureTags: unknown[];
    taskTags: unknown[];
    noteTags: unknown[];
    ideaTags: unknown[];
    reminders: unknown[];
    reminderDeliveries: unknown[];
    captureRelations: unknown[];
  };
}

export interface RestoreReportDto {
  capturedAt: string;
  dryRun: boolean;
  inserted: Record<string, number>;
  skipped: Record<string, number>;
  errors: string[];
}
