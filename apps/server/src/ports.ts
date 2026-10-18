/**
 * Replaceable infrastructure ports.
 *
 * Every external dependency (AI, speech-to-text, notification delivery, time)
 * is reached through one of these interfaces so tests can substitute fakes and
 * so the application keeps working when a provider is unavailable.
 */

/** Injectable clock. Tests use `fixedClock` / `advanceableClock`. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export function fixedClock(instant: Date | string): Clock {
  const value = typeof instant === 'string' ? new Date(instant) : instant;
  return { now: () => new Date(value.getTime()) };
}

/** A clock a test can move forward without sleeping. */
export interface AdvanceableClock extends Clock {
  advanceMs(ms: number): void;
  set(instant: Date): void;
}

export function advanceableClock(start: Date | string): AdvanceableClock {
  let current = typeof start === 'string' ? new Date(start) : new Date(start.getTime());
  return {
    now: () => new Date(current.getTime()),
    advanceMs(ms: number) {
      current = new Date(current.getTime() + ms);
    },
    set(instant: Date) {
      current = new Date(instant.getTime());
    },
  };
}

export interface OutboundMessage {
  /** Destination. Defaults to the configured owner chat. */
  chatId?: string;
  text: string;
  /** When true the message is a proactive notification, not a reply. */
  proactive?: boolean;
  /** Correlation id so a duplicate send can be detected by the channel. */
  idempotencyKey?: string;
  /** Optional inline keyboard rows of [label, callbackData]. */
  buttons?: string[][];
}

export interface DeliveryOutcome {
  ok: boolean;
  /** Provider message id when available. */
  messageId?: string;
  error?: string;
  /** True when retrying later could plausibly succeed. */
  retryable?: boolean;
  /**
   * Provider guidance: do not retry before this many milliseconds have passed
   * (Telegram sends `retry_after` with a 429). The scheduler uses the larger of
   * this and its own backoff.
   */
  retryAfterMs?: number;
}

export interface Notifier {
  readonly channel: string;
  /** Whether this notifier can actually reach the user right now. */
  isAvailable(): boolean;
  send(message: OutboundMessage): Promise<DeliveryOutcome>;
}

/** Records what was sent, useful for the dashboard and for tests. */
export function recordingNotifier(channel = 'test'): Notifier & { sent: OutboundMessage[] } {
  const sent: OutboundMessage[] = [];
  return {
    channel,
    sent,
    isAvailable: () => true,
    async send(message) {
      sent.push(message);
      return { ok: true, messageId: `rec-${sent.length}` };
    },
  };
}

/** Used when no delivery channel is configured: nothing is sent, nothing crashes. */
export function nullNotifier(reason = 'no delivery channel configured'): Notifier {
  return {
    channel: 'none',
    isAvailable: () => false,
    async send() {
      return { ok: false, error: reason, retryable: false };
    },
  };
}
