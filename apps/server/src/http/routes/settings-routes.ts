import { settingsUpdateSchema, type SettingsDto } from '@recall/shared';
import type { FastifyInstance } from 'fastify';

import type { AppContext } from '../../context.js';
import { AppError } from '../../lib/errors.js';
import { getSettings, toSettingsDto, updateSettings } from '../../services/settings-service.js';

export async function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/settings', async (): Promise<SettingsDto> => {
    const row = await getSettings(ctx.db, ctx.defaults);
    return toSettingsDto(row, ctx.capabilities, ctx.config.telegram.ownerIds);
  });

  app.patch('/settings', async (request): Promise<SettingsDto> => {
    const parsed = settingsUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', 'Invalid settings', {
        httpStatus: 400,
        details: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    const row = await updateSettings(ctx.db, parsed.data, ctx.defaults);
    return toSettingsDto(row, ctx.capabilities, ctx.config.telegram.ownerIds);
  });
}
