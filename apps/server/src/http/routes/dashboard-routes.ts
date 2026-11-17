/**
 * Dashboard overview.
 *
 * This is a read-only composition of data the dashboard already owns; it does
 * not introduce a second source of truth. Counts and lists are computed in the
 * owner's configured time zone so "today" matches what the dashboard displays.
 */
import type { DashboardOverviewDto } from '@recall/shared';
import type { FastifyInstance } from 'fastify';

import type { AppContext } from '../../context.js';
import { localDayRange } from '../../lib/time.js';
import {
  countCaptures,
  listCaptures,
  listInbox,
} from '../../services/capture-service.js';
import {
  countEvents,
} from '../../services/event-service.js';
import {
  countIdeas,
} from '../../services/idea-service.js';
import {
  countNotes,
} from '../../services/note-service.js';
import {
  findUpcomingReminders,
} from '../../services/reminder-service.js';
import {
  findTasks,
  taskCounts,
} from '../../services/task-service.js';

export async function registerDashboardRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  app.get('/dashboard/overview', async (): Promise<DashboardOverviewDto> => {
    const settings = await ctx.db.userSettings.findUnique({ where: { id: 'singleton' } });
    const timeZone = settings?.timeZone ?? ctx.defaults.timeZone;
    const now = ctx.clock.now();
    const range = localDayRange(now, timeZone);

    const [
      counts,
      tasksDueToday,
      overdueTasks,
      upcomingReminders,
      recentCaptures,
      inbox,
      ideas,
      notes,
      eventsUpcoming,
      capturesToday,
      inboxNeedsReview,
    ] = await Promise.all([
      taskCounts(ctx.db, now, range),
      findTasks(
        ctx.db,
        {
          status: ['PENDING', 'IN_PROGRESS'],
          dueAfter: range.startUtc,
          dueBefore: range.endUtc,
          sort: 'dueAt',
          order: 'asc',
          limit: 100,
        },
        now,
      ),
      findTasks(ctx.db, { overdueOnly: true, sort: 'dueAt', order: 'asc', limit: 100 }, now),
      findUpcomingReminders(ctx.db, { limit: 20 }),
      listCaptures(ctx.db, { limit: 10 }),
      listInbox(ctx.db, 10),
      countIdeas(ctx.db),
      countNotes(ctx.db),
      countEvents(ctx.db, { from: now }),
      countCaptures(ctx.db, { from: range.startUtc, to: range.endUtc }),
      countCaptures(ctx.db, { status: ['NEEDS_REVIEW', 'FAILED'] }),
    ]);

    return {
      timeZone,
      today: range.localDate,
      counts: {
        inboxNeedsReview,
        tasksDueToday: counts.dueToday,
        tasksOverdue: counts.overdue,
        tasksOpen: counts.open,
        ideas,
        notes,
        eventsUpcoming,
        capturesToday,
      },
      tasksDueToday,
      overdueTasks,
      upcomingReminders,
      recentCaptures,
      inbox,
    };
  });
}
