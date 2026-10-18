/**
 * Export and restore API.
 *
 * `GET /export` streams the whole database as one JSON bundle.
 * `POST /restore` is **dry-run by default**: without `{"dryRun": false}` it
 * reports what it would insert and writes nothing. This is the one route that
 * can bulk-write, so the safe behaviour is the default and the caller has to ask
 * for the write explicitly.
 *
 * Restore is additive (see `services/export-service.ts`): it never overwrites or
 * deletes, so an accidental call on a live database cannot destroy data.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ExportBundleDto, RestoreReportDto } from '@recall/shared';

import type { AppContext } from '../../context.js';
import { parseBody } from '../validation.js';
import { exportAll, restoreBundle } from '../../services/export-service.js';

const restoreBodySchema = z.object({
  bundle: z.unknown(),
  dryRun: z.boolean().default(true),
  maxRowsPerTable: z.number().int().min(1).max(100_000).optional(),
});

export async function registerExportRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/export', async (): Promise<ExportBundleDto> => exportAll(ctx));

  app.post('/restore', async (request): Promise<RestoreReportDto> => {
    const body = parseBody(restoreBodySchema, request.body, 'Invalid restore request');
    const { report } = await restoreBundle(ctx.db, body.bundle, {
      dryRun: body.dryRun,
      ...(body.maxRowsPerTable === undefined ? {} : { maxRowsPerTable: body.maxRowsPerTable }),
    });
    return report;
  });
}
