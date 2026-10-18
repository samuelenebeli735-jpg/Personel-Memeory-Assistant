/**
 * Reminder API.
 *
 * Reminders are created here, but never *sent* here: delivery belongs to the
 * scheduler (`services/reminder-scheduler.ts`). These routes only manage the
 * schedule, so the dashboard and the Telegram commands share one implementation
 * of the rules (what may be snoozed, what a cancel means for a series).
 *
 * Every route sits behind the owner session hook in `http/server.ts`.
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  REMINDER_STATUSES,
  reminderCreateSchema,
  reminderQuerySchema,
  reminderUpdateSchema,
  snoozeSchema,
  type Paginated,
  type ReminderDeliveryDto,
  type ReminderDto,
} from '@recall/shared';

import type { AppContext } from '../../context.js';
import { enumListParam, parseBody, parseIdParam, parseQuery, validationError } from '../validation.js';
import {
  cancelReminder,
  countReminders,
  createReminder,
  deleteReminder,
  findReminders,
  getReminder,
  listDeliveries,
  snoozeReminder,
  updateReminder,
  type ReminderFilter,
} from '../../services/reminder-service.js';

/** Querystring values are strings; they are coerced before the strict check. */
const reminderParamsSchema = z.object({
  status: z.union([z.string(), z.array(z.string())]).optional(),
  taskId: z.string().max(64).optional(),
  captureId: z.string().max(64).optional(),
  dueAfter: z.string().max(40).optional(),
  dueBefore: z.string().max(40).optional(),
  seriesHeadsOnly: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().optional(),
  offset: z.coerce.number().int().optional(),
  order: z.string().max(4).optional(),
});

export async function registerReminderRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/reminders', async (request): Promise<Paginated<ReminderDto>> => {
    const params = parseQuery(reminderParamsSchema, request.query, 'Invalid reminder query');
    const status = enumListParam(params.status, REMINDER_STATUSES, 'reminder status');

    const parsed = reminderQuerySchema.safeParse({
      ...(status === undefined ? {} : { status }),
      ...(params.taskId === undefined ? {} : { taskId: params.taskId }),
      ...(params.captureId === undefined ? {} : { captureId: params.captureId }),
      ...(params.dueAfter === undefined ? {} : { dueAfter: params.dueAfter }),
      ...(params.dueBefore === undefined ? {} : { dueBefore: params.dueBefore }),
      seriesHeadsOnly: params.seriesHeadsOnly === 'true',
      ...(params.limit === undefined ? {} : { limit: params.limit }),
      ...(params.offset === undefined ? {} : { offset: params.offset }),
      ...(params.order === undefined ? {} : { order: params.order }),
    });
    if (!parsed.success) throw validationError(parsed.error, 'Invalid reminder query');
    const query = parsed.data;

    const filter: ReminderFilter = {
      status: query.status,
      taskId: query.taskId,
      captureId: query.captureId,
      dueAfter: query.dueAfter ? new Date(query.dueAfter) : undefined,
      dueBefore: query.dueBefore ? new Date(query.dueBefore) : undefined,
      includeSeriesChildren: query.seriesHeadsOnly ? false : undefined,
      limit: query.limit,
      offset: query.offset,
      order: query.order,
    };
    const [items, total] = await Promise.all([
      findReminders(ctx.db, filter),
      countReminders(ctx.db, filter),
    ]);
    return { items, total, limit: query.limit, offset: query.offset };
  });

  app.post('/reminders', async (request, reply): Promise<ReminderDto> => {
    const input = parseBody(reminderCreateSchema, request.body, 'Invalid reminder');
    const reminder = await createReminder(ctx, input);
    reply.status(201);
    return reminder;
  });

  app.get('/reminders/:id', async (request): Promise<ReminderDto> =>
    getReminder(ctx.db, parseIdParam(request.params)),
  );

  app.patch('/reminders/:id', async (request): Promise<ReminderDto> => {
    const id = parseIdParam(request.params);
    const patch = parseBody(reminderUpdateSchema, request.body, 'Invalid reminder update');
    return updateReminder(ctx, id, patch);
  });

  app.delete('/reminders/:id', async (request): Promise<{ deleted: true }> => {
    await deleteReminder(ctx.db, parseIdParam(request.params));
    return { deleted: true };
  });

  app.post('/reminders/:id/cancel', async (request): Promise<ReminderDto> =>
    cancelReminder(ctx, parseIdParam(request.params)),
  );

  app.post('/reminders/:id/snooze', async (request): Promise<ReminderDto> => {
    const id = parseIdParam(request.params);
    const input = parseBody(snoozeSchema, request.body, 'Invalid snooze');
    return snoozeReminder(ctx, id, input);
  });

  app.get('/reminders/:id/deliveries', async (request): Promise<ReminderDeliveryDto[]> => {
    const id = parseIdParam(request.params);
    // Confirms the reminder exists, so an unknown id is a 404 rather than [].
    await getReminder(ctx.db, id);
    return listDeliveries(ctx.db, id);
  });
}
