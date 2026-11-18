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
import { registerCaptureRoutes } from './capture-routes.js';
import { registerExportRoutes } from './export-routes.js';
import { registerHealthRoutes } from './health-routes.js';
import { registerLibraryRoutes } from './library-routes.js';
import { registerReminderRoutes } from './reminder-routes.js';
import { registerSearchRoutes } from './search-routes.js';
import { registerSettingsRoutes } from './settings-routes.js';
import { registerDashboardRoutes } from './dashboard-routes.js';
import { registerAskRoutes } from './ask-routes.js';
import { registerBriefingRoutes } from './briefing-routes.js';

export async function registerProtectedRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  runtime: RuntimeStatus,
): Promise<void> {
  await registerHealthRoutes(app, ctx, runtime);
  await registerSettingsRoutes(app, ctx);
  await registerDashboardRoutes(app, ctx);
  await registerCaptureRoutes(app, ctx);
  await registerLibraryRoutes(app, ctx);
  await registerReminderRoutes(app, ctx);
  await registerSearchRoutes(app, ctx);
  await registerExportRoutes(app, ctx);
  await registerAskRoutes(app, ctx);
  await registerBriefingRoutes(app, ctx);
}
