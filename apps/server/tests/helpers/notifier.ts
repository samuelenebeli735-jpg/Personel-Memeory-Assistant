/**
 * A scripted notifier for delivery tests.
 *
 * Outcomes are consumed in order; once the queue is empty the last outcome is
 * repeated. That makes both "fails once then succeeds" (two entries) and
 * "always fails" (one entry) expressible without a second helper.
 */
import type { DeliveryOutcome, Notifier, OutboundMessage } from '../../src/ports.js';

export interface ScriptedNotifier extends Notifier {
  sent: OutboundMessage[];
  /** Every outcome this notifier has returned, in order. */
  outcomes: DeliveryOutcome[];
  isAvailable(): boolean;
  setAvailable(available: boolean): void;
  setNext(...outcomes: Partial<DeliveryOutcome>[]): void;
}

export function scriptedNotifier(
  options: { outcomes?: Partial<DeliveryOutcome>[]; available?: boolean; channel?: string } = {},
): ScriptedNotifier {
  const sent: OutboundMessage[] = [];
  const outcomes: DeliveryOutcome[] = [];
  let queue: Partial<DeliveryOutcome>[] = [...(options.outcomes ?? [])];
  let last: Partial<DeliveryOutcome> | null = null;
  let available = options.available ?? true;

  return {
    channel: options.channel ?? 'test',
    sent,
    outcomes,
    isAvailable: () => available,
    setAvailable(next: boolean) {
      available = next;
    },
    setNext(...next: Partial<DeliveryOutcome>[]) {
      queue = [...next];
    },
    async send(message: OutboundMessage): Promise<DeliveryOutcome> {
      sent.push(message);
      const chosen = queue.length > 0 ? (queue.shift() as Partial<DeliveryOutcome>) : (last ?? {});
      last = chosen;
      const outcome: DeliveryOutcome = {
        ok: chosen.ok ?? true,
        ...(chosen.messageId === undefined ? {} : { messageId: chosen.messageId }),
        ...(chosen.error === undefined ? {} : { error: chosen.error }),
        ...(chosen.retryable === undefined ? {} : { retryable: chosen.retryable }),
        ...(chosen.retryAfterMs === undefined ? {} : { retryAfterMs: chosen.retryAfterMs }),
      };
      if (outcome.messageId === undefined && outcome.ok) outcome.messageId = `rec-${sent.length}`;
      outcomes.push(outcome);
      return outcome;
    },
  };
}
