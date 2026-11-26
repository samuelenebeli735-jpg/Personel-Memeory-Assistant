/**
 * Capture API.
 *
 * This is the same service layer the Telegram adapter uses, exposed so the
 * dashboard (and any local script) can capture, review and correct without the
 * bot. Nothing here bypasses a service rule: undo windows, conversion
 * safeguards and idempotency all still apply.
 *
 * All routes are behind the session hook in `http/server.ts`; nothing here
 * re-implements authentication.
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  CAPTURE_KINDS,
  CAPTURE_SOURCES,
  CAPTURE_STATUSES,
  type CaptureAckDto,
  type CaptureDto,
  type Paginated,
} from '@recall/shared';

import type { AppContext } from '../../context.js';
import { AppError, NotFoundError } from '../../lib/errors.js';
import {
  convertCaptureKind,
  countCaptures,
  countInbox,
  getCapture,
  ingestCapture,
  listCaptures,
  listInbox,
  purgeCapture,
  reprocessCapture,
  undoCapture,
} from '../../services/capture-service.js';
import { getSettings } from '../../services/settings-service.js';
import { formatCaptureConfirmation } from '../../telegram/format.js';
import type { IngestOutcome } from '../../services/capture-service.js';

const idParamsSchema = z.object({ id: z.string().min(1).max(64) });

const listQuerySchema = z.object({
  status: z.union([z.string(), z.array(z.string())]).optional(),
  kind: z.enum(CAPTURE_KINDS).optional(),
  source: z.enum(CAPTURE_SOURCES).optional(),
  needsReview: z.enum(['true', 'false']).optional(),
  q: z.string().max(200).optional(),
  tag: z.string().max(40).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  includeDeleted: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  order: z.enum(['asc', 'desc']).default('desc'),
});

const inboxQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

const ingestBodySchema = z.object({
  rawText: z.string().trim().min(1).max(8000),
  source: z.enum(CAPTURE_SOURCES).default('API'),
  externalId: z.string().max(191).nullable().optional(),
  occurredAt: z.union([z.string(), z.date()]).nullable().optional(),
  forcedKind: z.enum(CAPTURE_KINDS).nullable().optional(),
  captureOnly: z.boolean().default(false),
});

const convertBodySchema = z.object({
  kind: z.enum(CAPTURE_KINDS),
  force: z.boolean().default(false),
});

const confirmBodySchema = z.object({
  force: z.boolean().default(false),
});

function validationError(error: z.ZodError): AppError {
  return new AppError('VALIDATION_ERROR', 'Invalid request', {
    httpStatus: 400,
    details: error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  });
}

function parseId(params: unknown): string {
  const parsed = idParamsSchema.safeParse(params);
  if (!parsed.success) throw validationError(parsed.error);
  return parsed.data.id;
}

/** Splits `?status=A,B` and repeated `?status=A&status=B` into a list. */
function statusList(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const parts = (Array.isArray(value) ? value : [value])
    .flatMap((part) => part.split(','))
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return undefined;
  for (const part of parts) {
    if (!CAPTURE_STATUSES.includes(part as (typeof CAPTURE_STATUSES)[number])) {
      throw new AppError('VALIDATION_ERROR', `Unknown capture status: ${part}`, { httpStatus: 400 });
    }
  }
  return parts;
}

export async function registerCaptureRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  async function ack(outcome: IngestOutcome): Promise<CaptureAckDto> {
    // The confirmation describes dates in the owner's Settings zone, the same
    // zone the reminder will fire in and the dashboard displays.
    const settings = await getSettings(ctx.db, ctx.defaults);
    return {
      capture: outcome.capture,
      created: outcome.created,
      duplicate: outcome.duplicate,
      needsReview: outcome.needsReview,
      message: formatCaptureConfirmation(outcome, {
        timeZone: settings.timeZone,
        referenceNow: ctx.clock.now(),
      }),
    };
  }

  /**
   * Captures awaiting a human decision, oldest first. `total` counts every
   * capture that needs review, not just this page (S1). Registered before `/:id`.
   */
  app.get('/captures/inbox', async (request): Promise<Paginated<CaptureDto>> => {
    const parsed = inboxQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) throw validationError(parsed.error);
    const { limit, offset } = parsed.data;
    const [items, total] = await Promise.all([listInbox(ctx.db, limit, offset), countInbox(ctx.db)]);
    return { items, total, limit, offset };
  });

  app.get('/captures', async (request): Promise<Paginated<CaptureDto>> => {
    const parsed = listQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) throw validationError(parsed.error);
    const query = parsed.data;
    const statuses = statusList(query.status);
    const filter = {
      ...(statuses === undefined ? {} : { status: statuses }),
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(query.source === undefined ? {} : { source: query.source }),
      ...(query.needsReview === undefined ? {} : { needsReview: query.needsReview === 'true' }),
      ...(query.q === undefined ? {} : { q: query.q }),
      ...(query.tag === undefined ? {} : { tag: query.tag }),
      ...(query.from === undefined ? {} : { from: new Date(query.from) }),
      ...(query.to === undefined ? {} : { to: new Date(query.to) }),
      ...(query.includeDeleted === undefined
        ? {}
        : { includeDeleted: query.includeDeleted === 'true' }),
      limit: query.limit,
      offset: query.offset,
      order: query.order,
    };
    const [items, total] = await Promise.all([
      listCaptures(ctx.db, filter),
      countCaptures(ctx.db, filter),
    ]);
    return { items, total, limit: query.limit, offset: query.offset };
  });

  app.get('/captures/:id', async (request): Promise<CaptureDto> => {
    const id = parseId(request.params);
    return getCapture(ctx.db, id);
  });

  /** Ingest. Idempotent when `externalId` is supplied. */
  app.post('/captures', async (request, reply): Promise<CaptureAckDto> => {
    const parsed = ingestBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) throw validationError(parsed.error);
    const body = parsed.data;
    const outcome = await ingestCapture(
      ctx,
      {
        rawText: body.rawText,
        source: body.source,
        externalId: body.externalId ?? null,
        occurredAt: body.occurredAt ?? null,
        sourceRef: 'api',
        ...(body.forcedKind === undefined || body.forcedKind === null
          ? {}
          : { forcedKind: body.forcedKind }),
      },
      { captureOnly: body.captureOnly },
    );
    reply.status(outcome.duplicate ? 200 : 201);
    return ack(outcome);
  });

  app.post('/captures/:id/reprocess', async (request): Promise<CaptureAckDto> => {
    const id = parseId(request.params);
    const outcome = await reprocessCapture(ctx, id);
    return ack(outcome);
  });

  app.post('/captures/:id/convert', async (request) => {
    const id = parseId(request.params);
    const parsed = convertBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) throw validationError(parsed.error);
    const result = await convertCaptureKind(ctx, id, parsed.data.kind, { force: parsed.data.force });
    return {
      capture: result.capture,
      removed: result.removed,
      created: result.created,
    };
  });

  app.post('/captures/:id/undo', async (request) => {
    const id = parseId(request.params);
    const parsed = confirmBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) throw validationError(parsed.error);
    return undoCapture(ctx, id, { force: parsed.data.force });
  });

  /**
   * Irreversible purge. Requires an explicit body because a mistaken DELETE has
   * no undo; the soft-delete path is `POST /captures/:id/undo`.
   */
  app.delete('/captures/:id', async (request) => {
    const id = parseId(request.params);
    const parsed = confirmBodySchema.safeParse(request.body ?? {});
    if (!parsed.success || parsed.data.force !== true) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Deleting permanently requires {"force": true}. Use undo to remove it reversibly.',
        { httpStatus: 400, details: { requiresConfirmation: true } },
      );
    }
    // Confirm it exists so a typo does not silently succeed.
    try {
      await getCapture(ctx.db, id);
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
      throw error;
    }
    return purgeCapture(ctx, id);
  });
}
