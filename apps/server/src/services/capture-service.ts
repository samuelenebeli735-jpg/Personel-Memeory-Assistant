/**
 * Capture: the path from "the user said something" to "it is stored and
 * organised".
 *
 * Invariants enforced here:
 *  1. `rawText` is written verbatim and is never modified afterwards.
 *  2. `(source, externalId)` is unique, so a replayed Telegram update returns the
 *     existing capture instead of creating a second one.
 *  3. Classification happens *after* the capture is committed. A provider outage
 *     can never lose the user's words.
 *  4. Derived records are written in one transaction together with the capture's
 *     processing state. If that fails, the capture survives as RECEIVED and can
 *     be reprocessed.
 *  5. Nothing is invented: an EVENT without a date, or an unrecognised capture,
 *     is kept for review instead of being forced into a shape.
 */
import type { CaptureDto, CaptureKind, Classification } from '@recall/shared';
import { captureInputSchema, type CaptureInput } from '@recall/shared';

import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import { withTransaction } from '../db/client.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { captureDedupeHash } from '../lib/hash.js';
import { extractUrls, isOnlyUrl } from '../lib/text.js';
import { captureInclude, toCaptureDto, type CaptureRow } from '../mappers.js';
import { classifyCaptureText } from './classification-service.js';
import { createEvent } from './event-service.js';
import { createIdea } from './idea-service.js';
import { createNote } from './note-service.js';
import { findProjectByName } from './project-service.js';
import { createReminder } from './reminder-service.js';
import { ensureTagIds, replaceTags } from './tag-service.js';
import { createTask } from './task-service.js';

export interface CreatedLink {
  type: 'TASK' | 'NOTE' | 'IDEA' | 'EVENT';
  id: string;
  title: string;
}

export interface IngestOutcome {
  capture: CaptureDto;
  created: CreatedLink[];
  /** True when an identical (source, externalId) had already been stored. */
  duplicate: boolean;
  classification: Classification | null;
  provider: string | null;
  /** Set when an AI attempt was made and failed; the capture was still stored. */
  aiError: string | null;
  needsReview: boolean;
  /** Set when the derived records could not be written; capture is RECEIVED. */
  processingError: string | null;
  /** How many reminders were scheduled from this capture. */
  remindersScheduled: number;
  /** Set when very similar text was captured recently. */
  dedupeSuspicion: { captureId: string; rawText: string; capturedAt: string } | null;
  /** Clarification to ask the user, when the intent or the date is unclear. */
  clarification: string | null;
}

export interface IngestOptions {
  /** Store the capture only; skip classification and derived records. */
  captureOnly?: boolean;
  /** Skip the "you may have captured this already" check. */
  skipDedupeCheck?: boolean;
  /** Suppress the AI provider for this capture (used by explicit commands). */
  skipAi?: boolean;
}

/** How far back the soft-duplicate check looks. */
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

export interface CaptureFilter {
  status?: string | string[];
  kind?: string;
  source?: string;
  needsReview?: boolean;
  q?: string;
  tag?: string;
  from?: Date;
  to?: Date;
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
  order?: 'asc' | 'desc';
}

export async function getCapture(db: Db, id: string): Promise<CaptureDto> {
  const row = await db.capture.findUnique({ where: { id }, include: captureInclude });
  if (!row) throw new NotFoundError('Capture', id);
  return toCaptureDto(row as CaptureRow);
}

function captureWhere(filter: CaptureFilter): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  if (!filter.includeDeleted) where.deletedAt = null;
  if (filter.status !== undefined) {
    where.status = Array.isArray(filter.status) ? { in: filter.status } : filter.status;
  }
  if (filter.kind) where.kind = filter.kind;
  if (filter.source) where.source = filter.source;
  if (filter.needsReview !== undefined) where.needsReview = filter.needsReview;
  if (filter.tag) where.tags = { some: { tag: { name: filter.tag.toLowerCase() } } };
  if (filter.q) where.rawText = { contains: filter.q };
  if (filter.from || filter.to) {
    where.capturedAt = {
      ...(filter.from ? { gte: filter.from } : {}),
      ...(filter.to ? { lt: filter.to } : {}),
    };
  }
  return where;
}

export async function listCaptures(db: Db, filter: CaptureFilter = {}): Promise<CaptureDto[]> {
  const rows = await db.capture.findMany({
    where: captureWhere(filter),
    include: captureInclude,
    orderBy: { capturedAt: filter.order ?? 'desc' },
    take: filter.limit ?? 50,
    skip: filter.offset ?? 0,
  });
  return rows.map((row) => toCaptureDto(row as CaptureRow));
}

export async function countCaptures(db: Db, filter: CaptureFilter = {}): Promise<number> {
  return db.capture.count({ where: captureWhere(filter) });
}

/** Captures that still need a human decision. */
export async function listInbox(db: Db, limit = 25): Promise<CaptureDto[]> {
  const rows = await db.capture.findMany({
    where: { deletedAt: null, status: { in: ['NEEDS_REVIEW', 'FAILED'] } },
    include: captureInclude,
    orderBy: { capturedAt: 'asc' },
    take: limit,
  });
  return rows.map((row) => toCaptureDto(row as CaptureRow));
}

/* -------------------------------------------------------------------------- */
/* Write: ingest                                                               */
/* -------------------------------------------------------------------------- */

export async function ingestCapture(
  ctx: AppContext,
  rawInput: CaptureInput,
  options: IngestOptions = {},
): Promise<IngestOutcome> {
  const parsed = captureInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError('Invalid capture', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  const input = parsed.data;
  const db = ctx.db;

  // --- 1. idempotency ------------------------------------------------------
  if (input.externalId) {
    const existing = await db.capture.findUnique({
      where: { source_externalId: { source: input.source, externalId: input.externalId } },
      include: captureInclude,
    });
    if (existing) {
      ctx.logger.debug('duplicate capture ignored', {
        captureId: existing.id,
        source: input.source,
      });
      return {
        capture: toCaptureDto(existing as CaptureRow),
        created: linksOf(existing as CaptureRow),
        duplicate: true,
        classification: null,
        provider: null,
        aiError: null,
        needsReview: existing.needsReview,
        processingError: null,
        dedupeSuspicion: null,
        remindersScheduled: 0,
        clarification: null,
      };
    }
  }

  const capturedAt = input.occurredAt ? new Date(input.occurredAt) : ctx.clock.now();
  const dedupeHash = captureDedupeHash({
    rawText: input.rawText,
    source: input.source,
    occurredAtIso: capturedAt.toISOString(),
  });

  // --- 2. persist the words, whatever else happens -------------------------
  let captureRow: CaptureRow;
  try {
    const created = await db.capture.create({
      data: {
        source: input.source,
        externalId: input.externalId ?? null,
        dedupeHash,
        rawText: input.rawText,
        kind: 'UNKNOWN',
        status: 'RECEIVED',
        sourceRef: input.sourceRef ?? null,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
        capturedAt,
      },
      include: captureInclude,
    });
    captureRow = created as CaptureRow;
  } catch (error) {
    // A concurrent insert of the same external id: treat as a duplicate.
    if (input.externalId) {
      const existing = await db.capture.findUnique({
        where: { source_externalId: { source: input.source, externalId: input.externalId } },
        include: captureInclude,
      });
      if (existing) {
        return {
          capture: toCaptureDto(existing as CaptureRow),
          created: linksOf(existing as CaptureRow),
          duplicate: true,
          classification: null,
          provider: null,
          aiError: null,
          needsReview: existing.needsReview,
          processingError: null,
          remindersScheduled: 0,
          dedupeSuspicion: null,
          clarification: null,
        };
      }
    }
    throw error;
  }

  // --- 3. soft duplicate warning ------------------------------------------
  let dedupeSuspicion: IngestOutcome['dedupeSuspicion'] = null;
  if (!options.skipDedupeCheck) {
    const similar = await db.capture.findFirst({
      where: {
        dedupeHash,
        id: { not: captureRow.id },
        deletedAt: null,
        capturedAt: { gte: new Date(capturedAt.getTime() - DEDUPE_WINDOW_MS) },
      },
      orderBy: { capturedAt: 'desc' },
      select: { id: true, rawText: true, capturedAt: true },
    });
    if (similar) {
      await db.captureRelation.create({
        data: {
          fromCaptureId: captureRow.id,
          toCaptureId: similar.id,
          relationType: 'DUPLICATE_OF',
          note: 'identical text within 24 hours',
        },
      });
      dedupeSuspicion = {
        captureId: similar.id,
        rawText: similar.rawText,
        capturedAt: similar.capturedAt.toISOString(),
      };
    }
  }

  if (options.captureOnly) {
    return {
      capture: toCaptureDto(captureRow),
      created: [],
      duplicate: false,
      classification: null,
      provider: null,
      aiError: null,
      needsReview: false,
      processingError: null,
      dedupeSuspicion,
      remindersScheduled: 0,
      clarification: null,
    };
  }

  // --- 4. classify (guarded) ----------------------------------------------
  const knowledge = await currentProjects(db);
  const outcome = await classifyCaptureText(ctx, {
    text: input.rawText,
    capturedAt,
    hintKind: input.forcedKind ?? null,
    knownProjects: knowledge,
    forceRules: options.skipAi === true,
  });

  const classification: Classification = input.forcedKind
    ? { ...outcome.classification, kind: input.forcedKind }
    : outcome.classification;

  // --- 5. write derived records and the capture's state atomically ----------
  let created: CreatedLink[] = [];
  let remindersScheduled = 0;
  let processingError: string | null = null;
  let status: CaptureDto['status'] = 'RECEIVED';
  try {
    const applied = await withTransaction(db, async (tx) => {
      const result = await applyClassification(ctx, tx, captureRow.id, input, classification, captureRow);
      const nextStatus = statusFor(classification, result.created.length);
      await tx.capture.update({
        where: { id: captureRow.id },
        data: {
          kind: classification.kind,
          confidence: classification.confidence,
          needsReview: nextStatus === 'NEEDS_REVIEW',
          classificationRationale: classification.rationale,
          status: nextStatus,
          processedAt: ctx.clock.now(),
        },
      });
      return { ...result, nextStatus };
    });
    created = applied.created;
    remindersScheduled = applied.remindersScheduled;
    status = applied.nextStatus;
  } catch (error) {
    // The transaction rolled back, so the capture is exactly as it was created:
    // RECEIVED, with no half-written derived records. It can be reprocessed.
    processingError = error instanceof Error ? error.message : 'unknown processing error';
    ctx.logger.error('failed to create structured records for a capture', {
      captureId: captureRow.id,
      reason: processingError,
    });
  }

  const fresh = await db.capture.findUnique({
    where: { id: captureRow.id },
    include: captureInclude,
  });

  return {
    capture: toCaptureDto((fresh ?? captureRow) as CaptureRow),
    created,
    duplicate: false,
    classification,
    provider: outcome.provider,
    aiError: outcome.aiError,
    needsReview: status === 'NEEDS_REVIEW',
    processingError,
    dedupeSuspicion,
    remindersScheduled,
    clarification: buildClarification(classification, created),
  };
}

async function currentProjects(db: Db): Promise<string[]> {
  const rows = await db.project.findMany({ where: { status: 'ACTIVE' }, select: { name: true }, take: 50 });
  return rows.map((row) => row.name);
}

function linksOf(row: CaptureRow): CreatedLink[] {
  return [
    ...row.tasks.map((t) => ({ type: 'TASK' as const, id: t.id, title: t.title })),
    ...row.notes.map((n) => ({
      type: 'NOTE' as const,
      id: n.id,
      title: n.title ?? '(saved reference)',
    })),
    ...row.ideas.map((i) => ({ type: 'IDEA' as const, id: i.id, title: i.title })),
    ...row.events.map((e) => ({ type: 'EVENT' as const, id: e.id, title: e.title })),
  ];
}

/** The capture status implied by a classification and what it produced. */
function statusFor(classification: Classification, createdCount: number): CaptureDto['status'] {
  if (
    classification.needsReview ||
    classification.kind === 'OTHER' ||
    classification.kind === 'UNKNOWN' ||
    (classification.kind === 'EVENT' && createdCount === 0)
  ) {
    return 'NEEDS_REVIEW';
  }
  return 'CLASSIFIED';
}

function buildClarification(classification: Classification, created: CreatedLink[]): string | null {
  if (classification.kind === 'EVENT' && created.length === 0) {
    return 'I saved this as an appointment but could not find a date. When is it?';
  }
  if (classification.kind === 'UNKNOWN' || classification.kind === 'OTHER') {
    return 'I saved this, but I am not sure what it is. Is it a task, an idea, a note, or an appointment?';
  }
  if (classification.dueAt === null && classification.kind === 'TASK' && classification.title) {
    return null;
  }
  return null;
}

/**
 * Creates the structured record(s) for a classification and links tags.
 *
 * Always called with a transaction client (`tx`): either the whole derivation
 * lands, or none of it does. `db` is explicit rather than read from `ctx` so the
 * callers cannot accidentally write outside their transaction.
 */
async function applyClassification(
  ctx: AppContext,
  db: Db,
  captureId: string,
  input: CaptureInput,
  classification: Classification,
  captureRow: CaptureRow,
): Promise<{ created: CreatedLink[]; remindersScheduled: number }> {
  const project = classification.projectName
    ? await findProjectByName(db, classification.projectName)
    : null;

  const created: CreatedLink[] = [];
  let remindersScheduled = 0;

  if (classification.kind === 'TASK') {
    const task = await createTask(ctx, {
      title: classification.title ?? input.rawText.slice(0, 200),
      description: classification.description ?? null,
      status: 'PENDING',
      priority: classification.priority ?? null,
      dueAt: classification.dueAt ?? null,
      projectId: project?.id ?? null,
      category: classification.category ?? null,
      tags: classification.tags,
      captureId,
    }, { db });
    created.push({ type: 'TASK', id: task.id, title: task.title });

    if (classification.remindAt) {
      const reminder = await createReminder(ctx, {
        title: classification.title ?? task.title,
        body: null,
        remindAt: classification.remindAt,
        taskId: task.id,
        captureId,
        recurrence: null,
      }, { db });
      remindersScheduled += 1;
      ctx.logger.debug('reminder scheduled from capture', { reminderId: reminder.id });
    }
  } else if (classification.kind === 'NOTE') {
    const urls = extractUrls(input.rawText);
    const note = await createNote(ctx, {
      title: classification.title ?? null,
      body: input.rawText,
      url: urls.length > 0 && (isOnlyUrl(input.rawText) || urls.length === 1) ? (urls[0] ?? null) : null,
      projectId: project?.id ?? null,
      tags: classification.tags,
      captureId,
    }, { db });
    created.push({ type: 'NOTE', id: note.id, title: note.title ?? '(saved reference)' });
  } else if (classification.kind === 'IDEA') {
    const idea = await createIdea(ctx, {
      title: classification.title ?? input.rawText.slice(0, 200),
      body: classification.description ?? input.rawText,
      projectId: project?.id ?? null,
      tags: classification.tags,
      captureId,
    }, { db });
    created.push({ type: 'IDEA', id: idea.id, title: idea.title });
  } else if (classification.kind === 'EVENT' && classification.dueAt) {
    const event = await createEvent(ctx, {
      title: classification.title ?? input.rawText.slice(0, 200),
      description: classification.description ?? null,
      startsAt: classification.dueAt,
      endsAt: null,
      projectId: project?.id ?? null,
      captureId,
    }, { db });
    created.push({ type: 'EVENT', id: event.id, title: event.title });
    if (classification.remindAt) {
      await createReminder(ctx, {
        title: event.title,
        body: null,
        remindAt: classification.remindAt,
        taskId: null,
        captureId,
        recurrence: null,
      }, { db });
      remindersScheduled += 1;
    }
  }

  // Tags always live on the capture; the derived record received its own copy above.
  await replaceTags(db, { captureId }, classification.tags);

  // A project suggestion that matched nothing is recorded on the capture rather
  // than silently creating a project the user never asked for.
  if (classification.projectName && !project) {
    await db.capture.update({
      where: { id: captureId },
      data: {
        classificationRationale: [captureRow.classificationRationale, `suggested project "${classification.projectName}" (no match, not created)`]
          .filter(Boolean)
          .join('; '),
      },
    });
  }

  return { created, remindersScheduled };
}

/* -------------------------------------------------------------------------- */
/* Write: correct, reprocess, undo                                             */
/* -------------------------------------------------------------------------- */

export interface ConvertResult {
  capture: CaptureDto;
  removed: CreatedLink[];
  created: CreatedLink[];
}

/**
 * Corrects an incorrect classification by converting the capture to another kind.
 *
 * Safeguard: if the existing structured record has been edited since it was
 * created, conversion is refused unless `force` is set, because the conversion
 * would discard those edits.
 */
export async function convertCaptureKind(
  ctx: AppContext,
  captureId: string,
  kind: CaptureKind,
  options: { force?: boolean } = {},
): Promise<ConvertResult> {
  const db = ctx.db;
  const row = await db.capture.findUnique({ where: { id: captureId }, include: captureInclude });
  if (!row) throw new NotFoundError('Capture', captureId);

  const links = linksOf(row as CaptureRow);
  const edited = await hasEditedRecords(db, links);
  if (edited.length > 0 && !options.force) {
    throw new ValidationError(
      `This item was edited after it was captured (${edited.map((l) => l.type.toLowerCase()).join(', ')}). ` +
        'Converting it would discard those edits. Confirm to continue.',
      { requiresConfirmation: true, edited: edited.map((l) => l.id) },
    );
  }

  const input: CaptureInput = {
    rawText: row.rawText,
    source: row.source as CaptureInput['source'],
    externalId: null,
    occurredAt: row.capturedAt,
    forcedKind: kind,
    metadata: null,
  };

  const classification = ctx.rules.classify({
    text: row.rawText,
    capturedAt: row.capturedAt,
    referenceNow: ctx.clock.now(),
    timeZone: ctx.defaults.timeZone,
    morningDefaultTime: ctx.defaults.morningDefaultTime,
    eveningDefaultTime: ctx.defaults.eveningDefaultTime,
    hintKind: kind,
    knownProjects: await currentProjects(db),
  });

  // Replacement is atomic: a failure must not leave the user with the old record
  // deleted and the new one missing.
  const applied = await withTransaction(db, async (tx) => {
    const migration = await removeDerivedRecords(tx, captureId);
    const result = await applyClassification(ctx, tx, captureId, input, classification, row as CaptureRow);
    await tx.captureTag.deleteMany({ where: { captureId } });
    await replaceTags(tx, { captureId }, classification.tags);
    const nextStatus = statusFor(classification, result.created.length);
    await tx.capture.update({
      where: { id: captureId },
      data: {
        kind,
        status: nextStatus,
        needsReview: nextStatus === 'NEEDS_REVIEW',
        confidence: 0.98,
        classificationRationale: `${row.classificationRationale ? `${row.classificationRationale}; ` : ''}corrected by the user to ${kind}`,
        processedAt: ctx.clock.now(),
      },
    });
    return { created: result.created, removed: migration };
  });

  const fresh = await db.capture.findUnique({ where: { id: captureId }, include: captureInclude });
  return {
    capture: toCaptureDto(fresh as CaptureRow),
    removed: applied.removed,
    created: applied.created,
  };
}

/** Re-runs classification on a capture that was stored but not processed. */
export async function reprocessCapture(ctx: AppContext, captureId: string): Promise<IngestOutcome> {
  const db = ctx.db;
  const row = await db.capture.findUnique({ where: { id: captureId }, include: captureInclude });
  if (!row) throw new NotFoundError('Capture', captureId);
  if (row.status === 'DELETED') throw new ValidationError('This capture was deleted');

  const existing = linksOf(row as CaptureRow);
  if (existing.length > 0) {
    return {
      capture: toCaptureDto(row as CaptureRow),
      created: existing,
      duplicate: false,
      classification: null,
      provider: null,
      aiError: null,
      needsReview: row.needsReview,
      processingError: null,
      remindersScheduled: 0,
      dedupeSuspicion: null,
      clarification: null,
    };
  }

  const input: CaptureInput = {
    rawText: row.rawText,
    source: row.source as CaptureInput['source'],
    externalId: null,
    occurredAt: row.capturedAt,
    forcedKind: null,
    metadata: null,
  };
  const outcome = await classifyCaptureText(ctx, {
    text: row.rawText,
    capturedAt: row.capturedAt,
    hintKind: null,
    knownProjects: await currentProjects(db),
  });

  let created: CreatedLink[] = [];
  let remindersScheduled = 0;
  let processingError: string | null = null;
  let status: CaptureDto['status'] = 'RECEIVED';
  try {
    const applied = await withTransaction(db, async (tx) => {
      const result = await applyClassification(
        ctx,
        tx,
        captureId,
        input,
        outcome.classification,
        row as CaptureRow,
      );
      const nextStatus = statusFor(outcome.classification, result.created.length);
      await tx.capture.update({
        where: { id: captureId },
        data: {
          kind: outcome.classification.kind,
          confidence: outcome.classification.confidence,
          needsReview: nextStatus === 'NEEDS_REVIEW',
          classificationRationale: outcome.classification.rationale,
          status: nextStatus,
          processedAt: ctx.clock.now(),
        },
      });
      return { ...result, nextStatus };
    });
    created = applied.created;
    remindersScheduled = applied.remindersScheduled;
    status = applied.nextStatus;
  } catch (error) {
    processingError = error instanceof Error ? error.message : 'unknown processing error';
  }

  const fresh = await db.capture.findUnique({ where: { id: captureId }, include: captureInclude });
  return {
    capture: toCaptureDto(fresh as CaptureRow),
    created,
    duplicate: false,
    classification: outcome.classification,
    provider: outcome.provider,
    aiError: outcome.aiError,
    needsReview: status === 'NEEDS_REVIEW',
    processingError,
    dedupeSuspicion: null,
    remindersScheduled,
    clarification: buildClarification(outcome.classification, created),
  };
}

/** How recently a capture may be undone without extra confirmation. */
export const UNDO_WINDOW_MS = 15 * 60 * 1000;

export interface UndoResult {
  captureId: string;
  removed: CreatedLink[];
}

/**
 * Undo a recent capture: removes the records it created and hides the capture.
 *
 * Safeguards against destroying real work:
 *  - only within `UNDO_WINDOW_MS`;
 *  - only if the derived records have not been edited since creation;
 *  - the capture itself is soft-deleted (audit trail retained).
 * Anything outside those bounds must be deleted item by item, deliberately.
 */
export async function undoCapture(
  ctx: AppContext,
  captureId: string,
  options: { force?: boolean; now?: Date } = {},
): Promise<UndoResult> {
  const db = ctx.db;
  const now = options.now ?? ctx.clock.now();
  const row = await db.capture.findUnique({ where: { id: captureId }, include: captureInclude });
  if (!row) throw new NotFoundError('Capture', captureId);

  const ageMs = now.getTime() - row.createdAt.getTime();
  if (!options.force && ageMs > UNDO_WINDOW_MS) {
    throw new ValidationError(
      'This capture is older than 15 minutes. Delete the individual items instead.',
      { requiresConfirmation: true },
    );
  }

  const links = linksOf(row as CaptureRow);
  const edited = await hasEditedRecords(db, links);
  if (edited.length > 0 && !options.force) {
    throw new ValidationError(
      `You have already edited ${edited.map((l) => l.type.toLowerCase()).join(', ')} from this capture. Confirm to undo anyway.`,
      { requiresConfirmation: true, edited: edited.map((l) => l.id) },
    );
  }

  const removal = await withTransaction(db, async (tx) => {
    const removed = await removeDerivedRecords(tx, captureId);
    await tx.capture.update({
      where: { id: captureId },
      data: { deletedAt: now, status: 'DELETED', needsReview: false },
    });
    return removed;
  });
  return { captureId, removed: removal };
}

/** Irreversible delete, used only after explicit confirmation. */
export async function purgeCapture(ctx: AppContext, captureId: string): Promise<UndoResult> {
  const db = ctx.db;
  const row = await db.capture.findUnique({ where: { id: captureId }, include: captureInclude });
  if (!row) throw new NotFoundError('Capture', captureId);
  const removal = await withTransaction(db, async (tx) => {
    const removed = await removeDerivedRecords(tx, captureId);
    await tx.reminder.deleteMany({ where: { captureId } });
    await tx.captureRelation.deleteMany({
      where: { OR: [{ fromCaptureId: captureId }, { toCaptureId: captureId }] },
    });
    await tx.capture.delete({ where: { id: captureId } });
    return removed;
  });
  return { captureId, removed: removal };
}

/** Records were created by this capture but changed by the user afterwards. */
async function hasEditedRecords(db: Db, links: CreatedLink[]): Promise<CreatedLink[]> {
  const edited: CreatedLink[] = [];
  for (const link of links) {
    const model =
      link.type === 'TASK'
        ? db.task
        : link.type === 'NOTE'
          ? db.note
          : link.type === 'IDEA'
            ? db.idea
            : db.event;
    const record = (await (model as { findUnique: (args: unknown) => Promise<unknown> }).findUnique({
      where: { id: link.id },
      select: { createdAt: true, updatedAt: true },
    })) as { createdAt: Date; updatedAt: Date } | null;
    if (!record) continue;
    // Prisma's @updatedAt has second-level resolution on SQLite; a 1s tolerance
    // avoids flagging the creation write itself as an edit.
    if (record.updatedAt.getTime() - record.createdAt.getTime() > 1000) edited.push(link);
  }
  return edited;
}

async function removeDerivedRecords(db: Db, captureId: string): Promise<CreatedLink[]> {
  const row = await db.capture.findUnique({ where: { id: captureId }, include: captureInclude });
  const links = row ? linksOf(row as CaptureRow) : [];
  await db.reminder.deleteMany({ where: { captureId } });
  await db.task.deleteMany({ where: { captureId } });
  await db.note.deleteMany({ where: { captureId } });
  await db.idea.deleteMany({ where: { captureId } });
  await db.event.deleteMany({ where: { captureId } });
  return links;
}
