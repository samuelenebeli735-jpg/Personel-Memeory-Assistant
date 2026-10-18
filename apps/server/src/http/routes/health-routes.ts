import type { HealthDto } from '@recall/shared';
import type { FastifyInstance } from 'fastify';

import type { AppContext } from '../../context.js';
import { pingDatabase } from '../../db/client.js';
import type { RuntimeStatus } from '../server.js';

/**
 * Full readiness report. Authenticated: it exposes operational counts.
 * Returns HTTP 200 with `status: "degraded"` when a dependency is down, so a
 * supervisor can distinguish "process down" from "dependency down". The
 * unauthenticated `/api/health/live` probe is the liveness check.
 */
export async function registerHealthRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  runtime: RuntimeStatus,
): Promise<void> {
  app.get('/health', async (): Promise<HealthDto> => {
    const db = await pingDatabase(ctx.db);
    const providers = describeProviders(ctx, runtime);

    if (!db.connected) {
      return {
        status: 'degraded',
        version: runtime.version,
        uptimeSeconds: uptimeSeconds(runtime, ctx),
        database: db,
        scheduler: emptyScheduler(),
        providers,
        counts: { captures: 0, tasks: 0, reminders: 0, pendingDeliveries: 0 },
      };
    }

    try {
      const [captures, tasks, reminders, pendingDeliveries] = await Promise.all([
        ctx.db.capture.count(),
        ctx.db.task.count(),
        ctx.db.reminder.count(),
        // SENDING counts as outstanding too: it is a delivery a worker is
        // currently sending, not a finished one.
        ctx.db.reminderDelivery.count({ where: { status: { in: ['PENDING', 'SENDING'] } } }),
      ]);
      return {
        status: 'ok',
        version: runtime.version,
        uptimeSeconds: uptimeSeconds(runtime, ctx),
        database: db,
        scheduler: runtime.schedulerStatus(),
        providers,
        counts: { captures, tasks, reminders, pendingDeliveries },
      };
    } catch (error) {
      return {
        status: 'degraded',
        version: runtime.version,
        uptimeSeconds: uptimeSeconds(runtime, ctx),
        database: {
          connected: false,
          latencyMs: db.latencyMs,
          error: error instanceof Error ? error.message : 'count query failed',
        },
        scheduler: emptyScheduler(),
        providers,
        counts: { captures: 0, tasks: 0, reminders: 0, pendingDeliveries: 0 },
      };
    }
  });
}

function emptyScheduler() {
  return { running: false, lastTickAt: null, dueNow: 0, scheduledTotal: 0 };
}

function uptimeSeconds(runtime: RuntimeStatus, ctx: AppContext): number {
  return Math.round((ctx.clock.now().getTime() - runtime.startedAt.getTime()) / 1000);
}

function describeProviders(ctx: AppContext, runtime: RuntimeStatus) {
  return {
    ai: {
      provider: ctx.config.ai.provider,
      configured: ctx.ai !== null,
      enabled: ctx.ai !== null && ctx.capabilities.aiEnabled,
    },
    stt: {
      provider: ctx.config.stt.provider,
      configured: ctx.stt !== null,
      enabled: ctx.stt !== null && ctx.capabilities.sttEnabled,
    },
    telegram: runtime.telegramStatus(),
  };
}
