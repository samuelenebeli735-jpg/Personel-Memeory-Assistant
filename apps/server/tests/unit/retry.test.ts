import { describe, expect, it, vi } from 'vitest';

import { backoffDelay, withRetry } from '../../src/lib/retry.js';

/** Records the delays a retry sequence asked for, without waiting. */
function fakeSleep() {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

describe('withRetry', () => {
  it('returns immediately on success without sleeping', async () => {
    const { delays, sleep } = fakeSleep();
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { attempts: 3, baseDelayMs: 10, sleep, jitter: false });
    expect(result).toEqual({ value: 'ok', attempts: 1 });
    expect(delays).toEqual([]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries with exponential backoff up to the attempt limit', async () => {
    const { delays, sleep } = fakeSleep();
    const fn = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(
      withRetry(fn, { attempts: 4, baseDelayMs: 100, maxDelayMs: 1000, sleep, jitter: false }),
    ).rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([100, 200, 400]);
  });

  it('caps the delay at maxDelayMs', () => {
    expect(backoffDelay(1, 100, 250, false)).toBe(100);
    expect(backoffDelay(2, 100, 250, false)).toBe(200);
    expect(backoffDelay(3, 100, 250, false)).toBe(250);
    expect(backoffDelay(10, 100, 250, false)).toBe(250);
  });

  it('adds bounded jitter when enabled', () => {
    const values = Array.from({ length: 40 }, () => backoffDelay(3, 100, 10_000, true));
    expect(Math.min(...values)).toBeGreaterThanOrEqual(400);
    expect(Math.max(...values)).toBeLessThanOrEqual(500);
    expect(new Set(values).size).toBeGreaterThan(1);
  });

  it('stops early when shouldRetry says the error is permanent', async () => {
    const { delays, sleep } = fakeSleep();
    const permanent = Object.assign(new Error('bad request'), { permanent: true });
    const fn = vi.fn().mockRejectedValue(permanent);
    await expect(
      withRetry(fn, {
        attempts: 5,
        baseDelayMs: 10,
        sleep,
        jitter: false,
        shouldRetry: (error) => !(error as { permanent?: boolean }).permanent,
      }),
    ).rejects.toThrow('bad request');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('succeeds after a transient failure and reports the attempt count', async () => {
    const { sleep } = fakeSleep();
    let call = 0;
    const fn = vi.fn(async () => {
      call += 1;
      if (call < 3) throw new Error('transient');
      return 'recovered';
    });
    const result = await withRetry(fn, { attempts: 5, baseDelayMs: 1, sleep, jitter: false });
    expect(result).toEqual({ value: 'recovered', attempts: 3 });
  });

  it('honours totalTimeoutMs to bound the overall operation', async () => {
    const { delays, sleep } = fakeSleep();
    const fn = vi.fn().mockRejectedValue(new Error('nope'));
    await expect(
      withRetry(fn, {
        attempts: 10,
        baseDelayMs: 1_000,
        maxDelayMs: 60_000,
        totalTimeoutMs: 3_000,
        sleep,
        jitter: false,
      }),
    ).rejects.toThrow('nope');
    // 1000ms then 2000ms fits in the 3s budget; the 4000ms wait does not.
    expect(delays).toEqual([1_000, 2_000]);
  });

  it('reports each retry through onRetry', async () => {
    const { sleep } = fakeSleep();
    const onRetry = vi.fn();
    const fn = vi.fn().mockRejectedValue(new Error('x'));
    await expect(
      withRetry(fn, { attempts: 2, baseDelayMs: 5, sleep, jitter: false, onRetry }),
    ).rejects.toThrow('x');
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]?.[0]).toMatchObject({ attempt: 1, delayMs: 5 });
  });
});
