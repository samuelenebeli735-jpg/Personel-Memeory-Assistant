import { z } from 'zod';

import {
  CAPTURE_KINDS,
  CAPTURE_RELATION_TYPES,
  CAPTURE_SOURCES,
  CAPTURE_STATUSES,
  DELIVERY_STATUSES,
  PRIORITIES,
  PROJECT_STATUSES,
  RECURRENCE_FREQUENCIES,
  REMINDER_STATUSES,
  STRUCTURED_TYPES,
  TASK_STATUSES,
  TRANSCRIPT_SOURCES,
} from './enums.js';

/* -------------------------------------------------------------------------- */
/* Primitives                                                                  */
/* -------------------------------------------------------------------------- */

export const zId = z.string().min(1).max(64);

/** A trimmed, non-empty string with a hard upper bound. */
export const zText = (max: number) => z.string().trim().min(1).max(max);

export const zOptionalText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((v) => v.trim())
    .transform((v) => (v.length === 0 ? null : v))
    .nullable()
    .optional();

/**
 * UTC ISO-8601 timestamp. The application stores UTC everywhere and converts to
 * the configured local zone only for display / interpretation.
 */
export const zUtcDateTime = z
  .string()
  .datetime({ offset: false, message: 'Expected an ISO-8601 UTC timestamp' });

/** Accepts a Date or an ISO string and normalises to a Date. */
export const zDateInput = z.union([z.string().datetime({ offset: true }), z.date()]);

export const zCaptureKind = z.enum(CAPTURE_KINDS);
export const zCaptureStatus = z.enum(CAPTURE_STATUSES);
export const zCaptureSource = z.enum(CAPTURE_SOURCES);
export const zTaskStatus = z.enum(TASK_STATUSES);
export const zPriority = z.enum(PRIORITIES);
export const zProjectStatus = z.enum(PROJECT_STATUSES);
export const zReminderStatus = z.enum(REMINDER_STATUSES);
export const zDeliveryStatus = z.enum(DELIVERY_STATUSES);
export const zRecurrenceFrequency = z.enum(RECURRENCE_FREQUENCIES);
export const zTranscriptSource = z.enum(TRANSCRIPT_SOURCES);
export const zStructuredType = z.enum(STRUCTURED_TYPES);
export const zCaptureRelationType = z.enum(CAPTURE_RELATION_TYPES);

export const zTagName = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .transform((v) => v.replace(/\s+/g, ' '));

export const zTagList = z.array(zTagName).max(20).default([]);

export const zUrl = z
  .string()
  .trim()
  .max(2048)
  .url()
  .refine((v) => /^https?:\/\//i.test(v), { message: 'Only http(s) URLs are supported' });

/* -------------------------------------------------------------------------- */
/* Capture                                                                     */
/* -------------------------------------------------------------------------- */

export const captureInputSchema = z.object({
  /** Raw text exactly as the user supplied it. Never rewritten. */
  rawText: zText(8000),
  source: zCaptureSource,
  /** Stable identifier from the source system, used for idempotency. */
  externalId: z.string().max(191).nullable().optional(),
  /** Provider-supplied timestamp of the original message. */
  occurredAt: zDateInput.nullable().optional(),
  /** Telegram chat id, web session id, etc. Not exposed publicly. */
  sourceRef: z.string().max(191).nullable().optional(),
  /** Skip AI classification and force a kind (used by explicit commands). */
  forcedKind: zCaptureKind.nullable().optional(),
  /** Extra structured fields the source already knows about. */
  metadata: z.record(z.unknown()).nullable().optional(),
});
export type CaptureInput = z.infer<typeof captureInputSchema>;

export const classifyCaptureSchema = z.object({
  kind: zCaptureKind,
  title: z.string().trim().max(300).nullable().default(null),
  description: z.string().trim().max(4000).nullable().default(null),
  category: z.string().trim().max(60).nullable().default(null),
  tags: zTagList,
  priority: zPriority.nullable().default(null),
  /** UTC instant. Only set when the text genuinely contained a date. */
  dueAt: zUtcDateTime.nullable().default(null),
  remindAt: zUtcDateTime.nullable().default(null),
  projectName: z.string().trim().max(120).nullable().default(null),
  /** Subjective model confidence in [0,1]. */
  confidence: z.number().min(0).max(1).default(0),
  /** Set when the model could not decide and a human should look at it. */
  needsReview: z.boolean().default(false),
  /** Free-form rationale. Never treated as fact. */
  rationale: z.string().max(500).nullable().default(null),
});
export type Classification = z.infer<typeof classifyCaptureSchema>;

/* -------------------------------------------------------------------------- */
/* Structured records                                                          */
/* -------------------------------------------------------------------------- */

export const taskCreateSchema = z.object({
  title: zText(300),
  description: zOptionalText(4000),
  status: zTaskStatus.default('PENDING'),
  priority: zPriority.nullable().default(null),
  dueAt: zUtcDateTime.nullable().default(null),
  projectId: zId.nullable().default(null),
  category: zOptionalText(60),
  tags: zTagList,
  captureId: zId.nullable().default(null),
});
export type TaskCreateInput = z.infer<typeof taskCreateSchema>;

export const taskUpdateSchema = taskCreateSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields supplied' });
export type TaskUpdateInput = z.infer<typeof taskUpdateSchema>;

export const noteCreateSchema = z.object({
  title: zOptionalText(300),
  body: zText(20000),
  url: zUrl.nullable().default(null),
  projectId: zId.nullable().default(null),
  tags: zTagList,
  captureId: zId.nullable().default(null),
});
export type NoteCreateInput = z.infer<typeof noteCreateSchema>;

export const noteUpdateSchema = noteCreateSchema.partial();
export type NoteUpdateInput = z.infer<typeof noteUpdateSchema>;

export const ideaCreateSchema = z.object({
  title: zText(300),
  body: zOptionalText(20000),
  projectId: zId.nullable().default(null),
  tags: zTagList,
  captureId: zId.nullable().default(null),
});
export type IdeaCreateInput = z.infer<typeof ideaCreateSchema>;

export const ideaUpdateSchema = ideaCreateSchema.partial();
export type IdeaUpdateInput = z.infer<typeof ideaUpdateSchema>;

export const eventCreateSchema = z.object({
  title: zText(300),
  description: zOptionalText(4000),
  startsAt: zUtcDateTime,
  endsAt: zUtcDateTime.nullable().default(null),
  projectId: zId.nullable().default(null),
  captureId: zId.nullable().default(null),
});
export type EventCreateInput = z.infer<typeof eventCreateSchema>;

export const eventUpdateSchema = eventCreateSchema.partial();
export type EventUpdateInput = z.infer<typeof eventUpdateSchema>;

export const projectCreateSchema = z.object({
  name: zText(120),
  description: zOptionalText(2000),
  status: zProjectStatus.default('ACTIVE'),
});
export type ProjectCreateInput = z.infer<typeof projectCreateSchema>;

export const projectUpdateSchema = projectCreateSchema.partial();
export type ProjectUpdateInput = z.infer<typeof projectUpdateSchema>;

/* -------------------------------------------------------------------------- */
/* Reminders                                                                   */
/* -------------------------------------------------------------------------- */

export const reminderRecurrenceSchema = z.object({
  frequency: zRecurrenceFrequency,
  /** 0 = Sunday .. 6 = Saturday. Only meaningful for WEEKLY. */
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  /** Stop generating occurrences after this UTC instant. */
  until: zUtcDateTime.nullable().default(null),
  /** Safety valve against runaway series. */
  maxOccurrences: z.number().int().min(1).max(500).default(52),
});
export type ReminderRecurrence = z.infer<typeof reminderRecurrenceSchema>;

export const reminderCreateSchema = z.object({
  title: zText(300),
  body: zOptionalText(2000),
  /** Fire time in UTC. */
  remindAt: zUtcDateTime,
  taskId: zId.nullable().default(null),
  captureId: zId.nullable().default(null),
  recurrence: reminderRecurrenceSchema.nullable().default(null),
});
export type ReminderCreateInput = z.infer<typeof reminderCreateSchema>;

export const reminderUpdateSchema = z.object({
  title: zText(300).optional(),
  body: zOptionalText(2000),
  remindAt: zUtcDateTime.optional(),
  recurrence: reminderRecurrenceSchema.nullable().optional(),
});
export type ReminderUpdateInput = z.infer<typeof reminderUpdateSchema>;

export const snoozeSchema = z.object({
  /** Relative snooze: minutes from now. */
  minutes: z.number().int().min(1).max(60 * 24 * 30).optional(),
  /** Absolute snooze target, UTC. Mutually exclusive with `minutes`. */
  until: zUtcDateTime.optional(),
});
export type SnoozeInput = z.infer<typeof snoozeSchema>;

/* -------------------------------------------------------------------------- */
/* Settings                                                                    */
/* -------------------------------------------------------------------------- */

export const hhmmSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM in 24-hour local time');

export const settingsUpdateSchema = z.object({
  displayName: z.string().trim().max(80).nullable().optional(),
  timeZone: z.string().trim().min(1).max(64).optional(),
  morningDefaultTime: hhmmSchema.optional(),
  eveningDefaultTime: hhmmSchema.optional(),
  quietHoursStart: hhmmSchema.nullable().optional(),
  quietHoursEnd: hhmmSchema.nullable().optional(),
  maxNotificationsPerDay: z.number().int().min(0).max(200).optional(),
  briefingEnabled: z.boolean().optional(),
  briefingTime: hhmmSchema.optional(),
  briefingSections: z
    .array(z.enum(['today', 'overdue', 'upcoming', 'ideas', 'deadlines']))
    .max(5)
    .optional(),
  reminderOverdueGraceHours: z.number().int().min(1).max(168).optional(),
  aiEnabled: z.boolean().optional(),
  locale: z.string().trim().max(20).optional(),
});
export type SettingsUpdateInput = z.infer<typeof settingsUpdateSchema>;

/* -------------------------------------------------------------------------- */
/* Search / query                                                              */
/* -------------------------------------------------------------------------- */

export const searchQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  types: z.array(zStructuredType).max(4).optional(),
  status: zTaskStatus.optional(),
  kind: zCaptureKind.optional(),
  projectId: zId.optional(),
  tag: zTagName.optional(),
  priority: zPriority.optional(),
  /** Inclusive UTC bounds on the relevant timestamp for the searched entity. */
  from: zUtcDateTime.optional(),
  to: zUtcDateTime.optional(),
  includeDeleted: z.boolean().default(false),
  sort: z.enum(['relevance', 'createdAt', 'updatedAt', 'dueAt', 'remindAt', 'title']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
  limit: z.number().int().min(1).max(100).default(25),
  offset: z.number().int().min(0).max(10_000).default(0),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

/* -------------------------------------------------------------------------- */
/* API envelopes                                                               */
/* -------------------------------------------------------------------------- */

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export function apiError(code: string, message: string, details?: unknown) {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}
