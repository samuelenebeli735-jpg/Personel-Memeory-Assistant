/**
 * Daily briefing API.
 *
 * GET  /api/briefing          — the briefing for today, or for `?date=YYYY-MM-DD`
 * GET  /api/briefing/config   — the configured delivery settings
 * PATCH /api/briefing/config  — change the delivery settings
 *
 * `briefingEnabled` controls *scheduled delivery* only. Reading a briefing is
 * an on-demand retrieval and works whether or not the daily delivery is
 * enabled, so a disabled briefing is never a lost briefing.
 *
 * The route contains no briefing logic of its own: it validates the request
 * and delegates to `generateBriefing`, the single implementation of a briefing.
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';

import type { AppContext } from '../../context.js';
import { ValidationError } from '../../lib/errors.js';
import {
  BRIEFING_SECTION_IDS,
  generateBriefing,
  parseBriefingDate,
} from '../../services/briefing-service.js';
import {
  getSettings,
  parseBriefingSections,
  updateSettings,
} from '../../services/settings-service.js';

const briefingQuerySchema = z.object({
  date: z.string().trim().optional(),
});

const briefingConfigSchema = z.object({
  briefingEnabled: z.boolean().optional(),
  briefingTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  briefingSections: z.array(z.enum(BRIEFING_SECTION_IDS)).max(BRIEFING_SECTION_IDS.length).optional(),
});

export interface BriefingConfigDto {
  /** True when the daily briefing is delivered on a schedule. */
  enabled: boolean;
  /** Local wall-clock time (HH:MM) the daily briefing is due. */
  time: string;
  /** Sections the briefing contains, in order. */
  sections: string[];
}

export async function registerBriefingRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/briefing', async (request): Promise<unknown> => {
    const parsedQuery = briefingQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      throw new ValidationError('Invalid briefing query', {
        issues: parsedQuery.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    const settings = await getSettings(ctx.db, ctx.defaults);
    const timeZone = settings.timeZone;

    let referenceDate = ctx.clock.now();
    if (parsedQuery.data.date !== undefined) {
      const parsedDate = parseBriefingDate(parsedQuery.data.date, timeZone);
      if (!parsedDate) {
        throw new ValidationError('Invalid briefing date', {
          issues: [{ path: 'date', message: 'Expected a calendar date as YYYY-MM-DD' }],
        });
      }
      referenceDate = parsedDate;
    }

    const briefing = await generateBriefing(ctx.db, {
      timeZone,
      sections: parseBriefingSections(settings.briefingSections),
      referenceDate,
    });

    const config: BriefingConfigDto = {
      enabled: settings.briefingEnabled,
      time: settings.briefingTime,
      sections: parseBriefingSections(settings.briefingSections),
    };

    return { briefing, config };
  });

  app.get('/briefing/config', async (): Promise<BriefingConfigDto> => {
    const settings = await getSettings(ctx.db, ctx.defaults);
    return {
      enabled: settings.briefingEnabled,
      time: settings.briefingTime,
      sections: parseBriefingSections(settings.briefingSections),
    };
  });

  app.patch('/briefing/config', async (request): Promise<BriefingConfigDto> => {
    const parsed = briefingConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid briefing config', {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    const updated = await updateSettings(ctx.db, parsed.data, ctx.defaults);
    return {
      enabled: updated.briefingEnabled,
      time: updated.briefingTime,
      sections: parseBriefingSections(updated.briefingSections),
    };
  });
}
