/**
 * Authenticated route registry. Each module owns one resource area; adding a
 * feature means adding one import plus one line here.
 *
 * Modules are introduced milestone by milestone (see docs/ROADMAP.md); the
 * registry only lists what is actually implemented so there are no dead routes.
 */
import type { FastifyInstance } from 'fastify';

import type { AppContext } from '../../context.js';
import type { RuntimeStatus } from '../server.js';
import { registerHealthRoutes } from './health-routes.js';
import { registerSettingsRoutes } from './settings-routes.js';

export async function registerProtectedRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  runtime: RuntimeStatus,
): Promise<void> {
  await registerHealthRoutes(app, ctx, runtime);
  await registerSettingsRoutes(app, ctx);
}
