/**
 * Search API.
 *
 * One endpoint for the whole database. The response always reports *why* each
 * row matched (`matchedOn`) and echoes the effective query, so the dashboard can
 * explain a result instead of just listing it.
 *
 * Query strings carry strings, so this module coerces them and then validates
 * the result against the shared `searchQuerySchema` — the same contract a JSON
 * client would be held to. Nothing is passed to the service unvalidated.
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { STRUCTURED_TYPES, searchQuerySchema, type SearchResponse } from '@recall/shared';

import type { AppContext } from '../../context.js';
import { enumListParam, parseQuery, validationError } from '../validation.js';
import { searchAll } from '../../services/search-service.js';

/** Loose shape of a querystring; values are coerced before the strict check. */
const searchParamsSchema = z.object({
  q: z.string().max(200).optional(),
  types: z.union([z.string(), z.array(z.string())]).optional(),
  status: z.string().max(20).optional(),
  kind: z.string().max(20).optional(),
  projectId: z.string().max(64).optional(),
  tag: z.string().max(40).optional(),
  priority: z.string().max(20).optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  includeDeleted: z.enum(['true', 'false']).optional(),
  sort: z.string().max(20).optional(),
  order: z.string().max(4).optional(),
  limit: z.coerce.number().int().optional(),
  offset: z.coerce.number().int().optional(),
});

export async function registerSearchRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/search', async (request): Promise<SearchResponse> => {
    const params = parseQuery(searchParamsSchema, request.query, 'Invalid search query');
    const types = enumListParam(params.types, STRUCTURED_TYPES, 'search type');

    const parsed = searchQuerySchema.safeParse({
      ...(params.q === undefined ? {} : { q: params.q }),
      ...(types === undefined ? {} : { types }),
      ...(params.status === undefined ? {} : { status: params.status }),
      ...(params.kind === undefined ? {} : { kind: params.kind }),
      ...(params.projectId === undefined ? {} : { projectId: params.projectId }),
      ...(params.tag === undefined ? {} : { tag: params.tag }),
      ...(params.priority === undefined ? {} : { priority: params.priority }),
      ...(params.from === undefined ? {} : { from: params.from }),
      ...(params.to === undefined ? {} : { to: params.to }),
      includeDeleted: params.includeDeleted === 'true',
      ...(params.sort === undefined ? {} : { sort: params.sort }),
      ...(params.order === undefined ? {} : { order: params.order }),
      ...(params.limit === undefined ? {} : { limit: params.limit }),
      ...(params.offset === undefined ? {} : { offset: params.offset }),
    });
    if (!parsed.success) throw validationError(parsed.error, 'Invalid search query');

    return searchAll(ctx.db, parsed.data);
  });
}
