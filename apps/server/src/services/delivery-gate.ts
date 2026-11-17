/**
 * Delivery gates shared by every proactive notification.
 *
 * Two rules decide whether a notification may leave the process right now:
 *
 *  - **Quiet hours.** The owner asked not to be disturbed between two local
 *    times. A notification that becomes due inside the window is *deferred*,
 *    never dropped: the attempt stays pending with a future `nextRetryAt`.
 *  - **The daily cap.** The owner set a maximum number of notifications per
 *    day. The cap counts every notification the process sends — reminders and
 *    briefings together — because that is what the owner actually experiences.
 *
 * Both gates are shared by the reminder scheduler and the briefing delivery
 * so the two can never disagree about the rules.
 */
import type { AppContext } from '../context.js';
import {
  isWithinQuietHours,
  nextQuietHoursEnd,
  startOfLocalDay,
  startOfNextLocalDay,
} from '../lib/time.js';
import type { SettingsRow } from './settings-service.js';

export interface DeliveryGate {
  /** Why the notification is held back. */
  reason: string;
  /** The earliest instant the notification may be delivered. */
  deferUntil: Date;
}

/**
 * How long a notification waits when there is no delivery channel at all.
 *
 * A missing channel is a deployment gap, not a failure of the notification, so
 * the attempt is deferred rather than marked failed.
 */
export const NO_CHANNEL_DEFER_MS = 15 * 60_000;

/**
 * Returns the gate that blocks a notification, or `null` when it may go out.
 */
export async function gateDelivery(
  ctx: AppContext,
  now: Date,
  settings: SettingsRow,
  timeZone: string,
): Promise<DeliveryGate | null> {
  if (isWithinQuietHours(now, timeZone, settings.quietHoursStart, settings.quietHoursEnd)) {
    const end = nextQuietHoursEnd(now, timeZone, settings.quietHoursStart, settings.quietHoursEnd);
    if (end) return { reason: 'quiet hours', deferUntil: end };
  }

  const cap = settings.maxNotificationsPerDay;
  if (cap > 0) {
    const from = startOfLocalDay(now, timeZone);
    const to = startOfNextLocalDay(now, timeZone);
    const [reminders, briefings] = await Promise.all([
      ctx.db.reminderDelivery.count({
        where: { status: 'DELIVERED', deliveredAt: { gte: from, lt: to } },
      }),
      ctx.db.briefingDelivery.count({
        where: { status: 'DELIVERED', deliveredAt: { gte: from, lt: to } },
      }),
    ]);
    const deliveredToday = reminders + briefings;
    if (deliveredToday >= cap) {
      return {
        reason: `daily notification cap of ${cap} reached`,
        deferUntil: to,
      };
    }
  }

  return null;
}
