/**
 * Export and restore.
 *
 * Export is a lossless JSON dump of every table the product owns, in a shape
 * that is stable across releases (`schemaVersion` guards the contract).
 *
 * Restore is deliberately conservative:
 *
 *  - **Additive only.** It never deletes, never updates and never overwrites. A
 *    row whose `id` already exists is skipped and counted.
 *  - **Identity-aware for the natural keys.** A tag that already exists by name,
 *    or a capture that already exists by `(source, externalId)` (the normal case
 *    when restoring onto a database that has already seen the same Telegram
 *    messages), is mapped to the existing row so the links that follow point at
 *    the right records instead of colliding.
 *  - **Dry run by default at the API.** A dry run reports exactly what would be
 *    inserted and what would be skipped without writing anything.
 *  - **Nothing is silently dropped.** A row that cannot be written is reported in
 *    `errors` with its table and id; the remaining rows still load, and because
 *    the operation is id-based and additive, re-running after a fix is safe.
 *
 * The single owner-settings row is never overwritten by a restore: an existing
 * settings row wins, and a missing one is created from the bundle.
 */
import { z } from 'zod';
import type { ExportBundleDto, RestoreReportDto } from '@recall/shared';

import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import { AppError } from '../lib/errors.js';
import { getSettings, toSettingsDto } from './settings-service.js';

export const EXPORT_SCHEMA_VERSION = 1;

interface TablePlan {
  /** Key in `bundle.data`, and the label used in the restore report. */
  key: keyof ExportBundleDto['data'];
  /** Prisma delegate name on the client. */
  model: string;
  /** Columns copied from the bundle, in insertion order. */
  columns: string[];
  /** Columns stored as dates (ISO strings in the bundle). */
  dates: string[];
  /** Columns that must be present for the row to be usable. */
  required: string[];
  /**
   * Alternative natural identity, used to reuse an existing row when the id is
   * new. `columns` are matched against the existing row.
   */
  identity?: string[];
  /**
   * Foreign-key columns remapped through an earlier table's id map.
   */
  remap?: Record<string, keyof ExportBundleDto['data']>;
}

/** Insertion order matters: every FK target is written before its referrer. */
const PLANS: TablePlan[] = [
  {
    key: 'projects',
    model: 'project',
    columns: ['id', 'name', 'description', 'status', 'createdAt', 'updatedAt', 'archivedAt'],
    dates: ['createdAt', 'updatedAt', 'archivedAt'],
    required: ['id', 'name'],
    identity: ['name'],
  },
  {
    key: 'captures',
    model: 'capture',
    columns: [
      'id',
      'source',
      'externalId',
      'dedupeHash',
      'rawText',
      'kind',
      'status',
      'confidence',
      'needsReview',
      'classificationRationale',
      'metadata',
      'transcript',
      'transcriptSource',
      'mediaRef',
      'sourceRef',
      'capturedAt',
      'processedAt',
      'deletedAt',
      'createdAt',
      'updatedAt',
    ],
    dates: ['capturedAt', 'processedAt', 'deletedAt', 'createdAt', 'updatedAt'],
    required: ['id', 'source', 'rawText'],
    identity: ['source', 'externalId'],
  },
  {
    key: 'tags',
    model: 'tag',
    columns: ['id', 'name', 'createdAt'],
    dates: ['createdAt'],
    required: ['id', 'name'],
    identity: ['name'],
  },
  {
    key: 'tasks',
    model: 'task',
    columns: [
      'id',
      'title',
      'description',
      'status',
      'priority',
      'category',
      'dueAt',
      'completedAt',
      'cancelledAt',
      'projectId',
      'captureId',
      'createdAt',
      'updatedAt',
    ],
    dates: ['dueAt', 'completedAt', 'cancelledAt', 'createdAt', 'updatedAt'],
    required: ['id', 'title'],
    remap: { projectId: 'projects', captureId: 'captures' },
  },
  {
    key: 'notes',
    model: 'note',
    columns: ['id', 'title', 'body', 'url', 'projectId', 'captureId', 'createdAt', 'updatedAt'],
    dates: ['createdAt', 'updatedAt'],
    required: ['id', 'body'],
    remap: { projectId: 'projects', captureId: 'captures' },
  },
  {
    key: 'ideas',
    model: 'idea',
    columns: ['id', 'title', 'body', 'projectId', 'captureId', 'createdAt', 'updatedAt'],
    dates: ['createdAt', 'updatedAt'],
    required: ['id', 'title'],
    remap: { projectId: 'projects', captureId: 'captures' },
  },
  {
    key: 'events',
    model: 'event',
    columns: [
      'id',
      'title',
      'description',
      'startsAt',
      'endsAt',
      'projectId',
      'captureId',
      'createdAt',
      'updatedAt',
    ],
    dates: ['startsAt', 'endsAt', 'createdAt', 'updatedAt'],
    required: ['id', 'title', 'startsAt'],
    remap: { projectId: 'projects', captureId: 'captures' },
  },
  {
    key: 'captureTags',
    model: 'captureTag',
    columns: ['captureId', 'tagId'],
    dates: [],
    required: ['captureId', 'tagId'],
    remap: { captureId: 'captures', tagId: 'tags' },
  },
  {
    key: 'taskTags',
    model: 'taskTag',
    columns: ['taskId', 'tagId'],
    dates: [],
    required: ['taskId', 'tagId'],
    remap: { taskId: 'tasks', tagId: 'tags' },
  },
  {
    key: 'noteTags',
    model: 'noteTag',
    columns: ['noteId', 'tagId'],
    dates: [],
    required: ['noteId', 'tagId'],
    remap: { noteId: 'notes', tagId: 'tags' },
  },
  {
    key: 'ideaTags',
    model: 'ideaTag',
    columns: ['ideaId', 'tagId'],
    dates: [],
    required: ['ideaId', 'tagId'],
    remap: { ideaId: 'ideas', tagId: 'tags' },
  },
  {
    key: 'captureRelations',
    model: 'captureRelation',
    columns: ['id', 'fromCaptureId', 'toCaptureId', 'relationType', 'note', 'createdAt'],
    dates: ['createdAt'],
    required: ['id', 'fromCaptureId', 'toCaptureId', 'relationType'],
    remap: { fromCaptureId: 'captures', toCaptureId: 'captures' },
  },
  {
    key: 'reminders',
    model: 'reminder',
    columns: [
      'id',
      'title',
      'body',
      'remindAt',
      'status',
      'attempts',
      'lastError',
      'deliveredAt',
      'taskId',
      'captureId',
      'recurrence',
      'parentId',
      'occurrenceKey',
      'createdAt',
      'updatedAt',
    ],
    dates: ['remindAt', 'deliveredAt', 'createdAt', 'updatedAt'],
    required: ['id', 'title', 'remindAt'],
    identity: ['occurrenceKey'],
    remap: { taskId: 'tasks', captureId: 'captures', parentId: 'reminders' },
  },
  {
    key: 'reminderDeliveries',
    model: 'reminderDelivery',
    columns: [
      'id',
      'reminderId',
      'attempt',
      'status',
      'channel',
      'scheduledFor',
      'attemptedAt',
      'deliveredAt',
      'nextRetryAt',
      'error',
      'occurrenceKey',
      'idempotencyKey',
      'createdAt',
      'updatedAt',
    ],
    dates: ['scheduledFor', 'attemptedAt', 'deliveredAt', 'nextRetryAt', 'createdAt', 'updatedAt'],
    required: ['id', 'reminderId', 'scheduledFor', 'idempotencyKey'],
    identity: ['idempotencyKey'],
    remap: { reminderId: 'reminders' },
  },
];

const rowSchema = z.record(z.string(), z.unknown());

export const exportBundleSchema = z.object({
  exportedAt: z.string().optional(),
  schemaVersion: z.number().int().positive(),
  counts: z.record(z.string(), z.number()).optional(),
  settings: rowSchema.optional(),
  data: z.object({
    captures: z.array(rowSchema).default([]),
    tasks: z.array(rowSchema).default([]),
    notes: z.array(rowSchema).default([]),
    ideas: z.array(rowSchema).default([]),
    events: z.array(rowSchema).default([]),
    projects: z.array(rowSchema).default([]),
    tags: z.array(rowSchema).default([]),
    captureTags: z.array(rowSchema).default([]),
    taskTags: z.array(rowSchema).default([]),
    noteTags: z.array(rowSchema).default([]),
    ideaTags: z.array(rowSchema).default([]),
    reminders: z.array(rowSchema).default([]),
    reminderDeliveries: z.array(rowSchema).default([]),
    captureRelations: z.array(rowSchema).default([]),
  }),
});
export type ExportBundleInput = z.infer<typeof exportBundleSchema>;

/* -------------------------------------------------------------------------- */
/* Minimal delegate access                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The restore is table-driven, so it addresses Prisma delegates by name. The
 * casts are confined to this interface; the shape of every row is validated
 * before it reaches the client.
 */
interface Delegate {
  findFirst(args: unknown): Promise<Record<string, unknown> | null>;
  create(args: unknown): Promise<Record<string, unknown>>;
  count(args?: unknown): Promise<number>;
}

function delegate(db: Db, model: string): Delegate {
  const found = (db as unknown as Record<string, Delegate | undefined>)[model];
  if (!found || typeof found.findFirst !== 'function') {
    throw new AppError('INTERNAL_ERROR', `Unknown database model: ${model}`);
  }
  return found;
}

interface ListDelegate {
  findMany(args: unknown): Promise<Record<string, unknown>[]>;
}

function listDelegate(db: Db, model: string): ListDelegate {
  const found = (db as unknown as Record<string, ListDelegate | undefined>)[model];
  if (!found || typeof found.findMany !== 'function') {
    throw new AppError('INTERNAL_ERROR', `Unknown database model: ${model}`);
  }
  return found;
}

/* -------------------------------------------------------------------------- */
/* Export                                                                      */
/* -------------------------------------------------------------------------- */

function scalarSelect(plan: TablePlan): Record<string, true> {
  return Object.fromEntries(plan.columns.map((column) => [column, true]));
}

/**
 * A full, lossless dump. Row order is stable (`createdAt asc`) so two exports of
 * an unchanged database are byte-identical apart from `exportedAt`.
 */
export async function exportAll(ctx: AppContext, db: Db = ctx.db): Promise<ExportBundleDto> {
  const lists = await Promise.all(
    PLANS.map(async (plan) => {
      const rows = await listDelegate(db, plan.model).findMany({
        select: scalarSelect(plan),
        // Join tables have no `createdAt`; ordering is only meaningful where the
        // column exists.
        ...(plan.columns.includes('createdAt') ? { orderBy: { createdAt: 'asc' } } : {}),
      });
      return [plan.key, rows] as const;
    }),
  );

  const data = Object.fromEntries(lists) as unknown as ExportBundleDto['data'];

  const counts: Record<string, number> = {};
  for (const plan of PLANS) counts[plan.key] = (data[plan.key] as unknown[]).length;

  const settingsRow = await getSettings(db, ctx.defaults);

  return {
    exportedAt: new Date().toISOString(),
    schemaVersion: EXPORT_SCHEMA_VERSION,
    settings: toSettingsDto(settingsRow, ctx.capabilities, ctx.config.telegram.ownerIds),
    counts,
    data,
  };
}

/* -------------------------------------------------------------------------- */
/* Restore                                                                     */
/* -------------------------------------------------------------------------- */

export interface RestoreOptions {
  dryRun?: boolean;
  /** Maximum rows written per table; a safety valve against a wrong file. */
  maxRowsPerTable?: number;
}

const DEFAULT_MAX_ROWS = 50_000;

type IdMap = Map<string, string>;

interface PreparedRow {
  values: Record<string, unknown>;
  /** Original id (or a joined composite key for a join table). */
  id: string;
}

interface PreparedTable {
  plan: TablePlan;
  rows: PreparedRow[];
  errors: string[];
}

/**
 * Join tables have no `id`, so their identity is the composite key of their
 * columns (which are also their primary key in the schema).
 */
function isJoinTable(plan: TablePlan): boolean {
  return plan.columns[0] !== 'id';
}

/** Converts and validates one bundle row against its table plan. */
function prepareRow(plan: TablePlan, raw: Record<string, unknown>): PreparedRow | string {
  for (const column of plan.required) {
    const value = raw[column];
    if (value === undefined || value === null || value === '') {
      return `missing required column "${column}"`;
    }
  }

  const values: Record<string, unknown> = {};
  for (const column of plan.columns) {
    const value = raw[column];
    if (value === undefined) continue;
    if (plan.dates.includes(column)) {
      if (value === null) {
        values[column] = null;
        continue;
      }
      const parsed = value instanceof Date ? value : new Date(String(value));
      if (Number.isNaN(parsed.getTime())) return `column "${column}" is not a valid date`;
      values[column] = parsed;
      continue;
    }
    values[column] = value;
  }

  return {
    values,
    id: isJoinTable(plan)
      ? plan.columns.map((column) => String(values[column] ?? '')).join('\u0000')
      : String(values.id),
  };
}

function prepareTable(plan: TablePlan, rows: unknown[]): PreparedTable {
  const prepared: PreparedTable = { plan, rows: [], errors: [] };
  rows.forEach((raw, index) => {
    const parsed = rowSchema.safeParse(raw);
    if (!parsed.success) {
      prepared.errors.push(`${plan.key}[${index}]: expected an object`);
      return;
    }
    const result = prepareRow(plan, parsed.data);
    if (typeof result === 'string') {
      prepared.errors.push(`${plan.key}[${index}]: ${result}`);
      return;
    }
    prepared.rows.push(result);
  });
  return prepared;
}

/**
 * Finds an existing row for a prepared row: first by primary key, then by
 * natural identity. Returns an identifier for the existing row, or null.
 */
async function findExisting(
  db: Db,
  plan: TablePlan,
  values: Record<string, unknown>,
): Promise<string | null> {
  const join = isJoinTable(plan);
  const select = join
    ? Object.fromEntries(plan.columns.map((column) => [column, true]))
    : { id: true };

  const where: Record<string, unknown> = join
    ? Object.fromEntries(plan.columns.map((column) => [column, values[column]]))
    : { id: values.id };

  const existing = await delegate(db, plan.model).findFirst({ where, select: select as never });
  if (existing) {
    return join
      ? plan.columns.map((column) => String(existing[column] ?? '')).join('\u0000')
      : String(existing.id);
  }

  if (join || !plan.identity) return null;
  const identityWhere: Record<string, unknown> = {};
  for (const column of plan.identity) {
    const value = values[column];
    if (value === undefined) continue;
    identityWhere[column] = value;
  }
  if (Object.keys(identityWhere).length === 0) return null;
  const byIdentity = await delegate(db, plan.model).findFirst({
    where: identityWhere,
    select: { id: true } as never,
  });
  return byIdentity ? String(byIdentity.id) : null;
}

export async function restoreBundle(
  db: Db,
  input: unknown,
  options: RestoreOptions = {},
): Promise<{ report: RestoreReportDto; settingsRestored: boolean }> {
  const parsed = exportBundleSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', 'This file is not a Recall export bundle', {
      httpStatus: 400,
      details: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  const bundle = parsed.data;
  if (bundle.schemaVersion > EXPORT_SCHEMA_VERSION) {
    throw new AppError(
      'VALIDATION_ERROR',
      `This export was written by a newer version of Recall (schema ${bundle.schemaVersion}); this build understands up to ${EXPORT_SCHEMA_VERSION}.`,
      { httpStatus: 400 },
    );
  }

  const dryRun = options.dryRun ?? true;
  const maxRows = options.maxRowsPerTable ?? DEFAULT_MAX_ROWS;
  const inserted: Record<string, number> = {};
  const skipped: Record<string, number> = {};
  const errors: string[] = [];
  const maps = new Map<keyof ExportBundleDto['data'], IdMap>();

  for (const plan of PLANS) {
    const table = prepareTable(plan, bundle.data[plan.key] ?? []);
    errors.push(...table.errors);
    inserted[plan.key] = 0;
    skipped[plan.key] = 0;

    if (table.rows.length > maxRows) {
      errors.push(
        `${plan.key}: ${table.rows.length} rows exceeds the ${maxRows}-row safety limit; nothing from this table was restored.`,
      );
      continue;
    }

    const map: IdMap = new Map();
    maps.set(plan.key, map);

    for (const row of table.rows) {
      // Resolve foreign keys through the maps built by earlier tables so links
      // point at the row that actually exists in this database.
      const values: Record<string, unknown> = { ...row.values };
      if (plan.remap) {
        for (const [column, sourceKey] of Object.entries(plan.remap)) {
          const value = values[column];
          if (value === undefined || value === null) continue;
          const mapped = maps.get(sourceKey)?.get(String(value));
          if (mapped === undefined) {
            // The referenced row was not in this bundle: keep the original id so
            // a foreign-key error is reported honestly instead of hiding it.
            continue;
          }
          values[column] = mapped;
        }
      }

      const existing = await findExisting(db, plan, values);
      if (existing !== null) {
        skipped[plan.key] = (skipped[plan.key] ?? 0) + 1;
        if (existing !== row.id) map.set(row.id, existing);
        continue;
      }
      if (dryRun) {
        inserted[plan.key] = (inserted[plan.key] ?? 0) + 1;
        continue;
      }

      try {
        const created = await delegate(db, plan.model).create({ data: values as never });
        inserted[plan.key] = (inserted[plan.key] ?? 0) + 1;
        map.set(row.id, String(created.id ?? row.id));
      } catch (error) {
        errors.push(
          `${plan.key}:${row.id}: ${error instanceof Error ? error.message : 'write failed'}`,
        );
      }
    }
  }

  let settingsRestored = false;
  if (bundle.settings) {
    const existing = await db.userSettings.findFirst({ select: { id: true } });
    if (existing) {
      skipped.settings = 1;
    } else if (dryRun) {
      inserted.settings = 1;
    } else {
      try {
        const settings = bundle.settings as Record<string, unknown>;
        await db.userSettings.create({
          data: {
            id: 'singleton',
            ...(typeof settings.displayName === 'string' || settings.displayName === null
              ? { displayName: settings.displayName }
              : {}),
            ...(typeof settings.timeZone === 'string' ? { timeZone: settings.timeZone } : {}),
            ...(typeof settings.morningDefaultTime === 'string'
              ? { morningDefaultTime: settings.morningDefaultTime }
              : {}),
            ...(typeof settings.eveningDefaultTime === 'string'
              ? { eveningDefaultTime: settings.eveningDefaultTime }
              : {}),
            ...(settings.quietHoursStart === null || typeof settings.quietHoursStart === 'string'
              ? { quietHoursStart: settings.quietHoursStart as string | null }
              : {}),
            ...(settings.quietHoursEnd === null || typeof settings.quietHoursEnd === 'string'
              ? { quietHoursEnd: settings.quietHoursEnd as string | null }
              : {}),
            ...(typeof settings.maxNotificationsPerDay === 'number'
              ? { maxNotificationsPerDay: settings.maxNotificationsPerDay }
              : {}),
            ...(typeof settings.briefingEnabled === 'boolean'
              ? { briefingEnabled: settings.briefingEnabled }
              : {}),
            ...(typeof settings.briefingTime === 'string' ? { briefingTime: settings.briefingTime } : {}),
            ...(Array.isArray(settings.briefingSections)
              ? { briefingSections: JSON.stringify(settings.briefingSections) }
              : {}),
            ...(typeof settings.reminderOverdueGraceHours === 'number'
              ? { reminderOverdueGraceHours: settings.reminderOverdueGraceHours }
              : {}),
            ...(typeof settings.aiEnabled === 'boolean' ? { aiEnabled: settings.aiEnabled } : {}),
            ...(typeof settings.locale === 'string' ? { locale: settings.locale } : {}),
          },
        });
        settingsRestored = true;
        inserted.settings = 1;
      } catch (error) {
        errors.push(
          `settings: ${error instanceof Error ? error.message : 'write failed'}`,
        );
      }
    }
  }

  return {
    report: { capturedAt: new Date().toISOString(), dryRun, inserted, skipped, errors },
    settingsRestored,
  };
}
