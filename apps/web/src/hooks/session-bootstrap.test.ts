import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../lib/api'
import {
  notifyUnauthorized,
  shouldNotifyUnauthorized,
  UNAUTHORIZED_EVENT,
} from '../lib/auth-events'
import { bootstrapSession, SESSION_RETRY_DELAYS_MS } from './session-bootstrap'

afterEach(() => vi.unstubAllGlobals())

const health = {
  status: 'ok' as const,
  version: 'test',
  uptimeSeconds: 1,
  database: { connected: true, latencyMs: null },
  scheduler: { running: false, lastTickAt: null, dueNow: 0, scheduledTotal: 0, stalled: false, stallLimitSeconds: 0 },
  providers: {
    ai: { provider: 'none', configured: false, enabled: false },
    stt: { provider: 'none', configured: false, enabled: false },
    telegram: { enabled: false, mode: 'polling', configured: false, ownerConfigured: true },
  },
  counts: { captures: 0, tasks: 0, reminders: 0, pendingDeliveries: 0 },
}

/** Records requested waits instead of sleeping. */
function fakeSleep() {
  const waits: number[] = []
  return { waits, sleep: async (ms: number) => void waits.push(ms) }
}

const rateLimited = (retryAfter: number | null = null) =>
  new ApiError('Too many requests', 'RATE_LIMITED', 429, undefined, { retryAfter })
const serverError = () => new ApiError('Internal error', 'INTERNAL_ERROR', 500)
const networkError = () => new ApiError('Can’t reach Recall.', 'NETWORK_ERROR', 0, undefined, { kind: 'network' })

describe('session bootstrap', () => {
  it('keeps a valid session when the health probe fails transiently', async () => {
    const result = await bootstrapSession(
      async () => ({ authenticated: true }),
      async () => {
        throw new Error('health endpoint unavailable')
      },
    )
    expect(result).toEqual({ status: 'authenticated', health: null })
  })

  it('keeps a valid session when the health probe returns a server error or 403', async () => {
    for (const error of [serverError(), new ApiError('Forbidden', 'FORBIDDEN', 403)]) {
      const result = await bootstrapSession(
        async () => ({ authenticated: true }),
        async () => {
          throw error
        },
      )
      expect(result).toEqual({ status: 'authenticated', health: null })
    }
  })

  it('treats an explicit "not authenticated" answer as signed out without probing health', async () => {
    const loadHealth = vi.fn(async () => health)
    const result = await bootstrapSession(async () => ({ authenticated: false }), loadHealth)
    expect(result).toEqual({ status: 'signed-out' })
    expect(loadHealth).not.toHaveBeenCalled()
  })

  it('treats a 401 from the session or health endpoint as signed out, without retrying', async () => {
    const { waits, sleep } = fakeSleep()
    const loadSession = vi.fn(async () => {
      throw new ApiError('Sign in to continue', 'UNAUTHORIZED', 401)
    })
    expect(await bootstrapSession(loadSession, async () => health, sleep)).toEqual({ status: 'signed-out' })
    expect(loadSession).toHaveBeenCalledTimes(1)
    expect(waits).toEqual([])

    const fromHealth = await bootstrapSession(
      async () => ({ authenticated: true }),
      async () => {
        throw new ApiError('Your session has expired', 'UNAUTHORIZED', 401)
      },
    )
    expect(fromHealth).toEqual({ status: 'signed-out' })
  })

  it('returns the health payload for a valid session', async () => {
    const result = await bootstrapSession(async () => ({ authenticated: true }), async () => health)
    expect(result).toEqual({ status: 'authenticated', health })
  })

  it('never signs out on 429: retries and then reports Recall unreachable', async () => {
    const { waits, sleep } = fakeSleep()
    const loadSession = vi.fn(async () => {
      throw rateLimited()
    })
    const result = await bootstrapSession(loadSession, async () => health, sleep)
    expect(result.status).toBe('unreachable')
    // 1 initial attempt + 3 retries = 4 attempts, waiting 1 s, 2 s and 4 s between them.
    expect(loadSession).toHaveBeenCalledTimes(1 + SESSION_RETRY_DELAYS_MS.length)
    expect(loadSession).toHaveBeenCalledTimes(4)
    expect(waits).toEqual([1000, 2000, 4000])
  })

  it('recovers when a retry succeeds after 5xx and network failures', async () => {
    const { waits, sleep } = fakeSleep()
    const answers = [serverError(), networkError()]
    const loadSession = vi.fn(async () => {
      const next = answers.shift()
      if (next) throw next
      return { authenticated: true }
    })
    const result = await bootstrapSession(loadSession, async () => health, sleep)
    expect(result).toEqual({ status: 'authenticated', health })
    expect(loadSession).toHaveBeenCalledTimes(3)
    expect(waits).toEqual([1000, 2000])
  })

  it('honours Retry-After when it is longer than the scheduled wait, up to 60 s', async () => {
    const { waits, sleep } = fakeSleep()
    const answers = [rateLimited(7), rateLimited(1), rateLimited(600)]
    const loadSession = vi.fn(async () => {
      const next = answers.shift()
      if (next) throw next
      return { authenticated: true }
    })
    await bootstrapSession(loadSession, async () => health, sleep)
    expect(waits).toEqual([7000, 2000, 60000])
  })
})

describe('unauthorized event routing', () => {
  it('notifies only for protected-endpoint 401s', () => {
    expect(shouldNotifyUnauthorized('/captures/abc', 401)).toBe(true)
    expect(shouldNotifyUnauthorized('/health', 401)).toBe(true)
    expect(shouldNotifyUnauthorized('/auth/login', 401)).toBe(false)
    expect(shouldNotifyUnauthorized('/auth/session', 401)).toBe(false)
    expect(shouldNotifyUnauthorized('/captures/abc', 403)).toBe(false)
    expect(shouldNotifyUnauthorized('/captures/abc', 429)).toBe(false)
    expect(shouldNotifyUnauthorized('/captures/abc', 500)).toBe(false)
  })

  it('dispatches the event the auth provider listens for', () => {
    const target = new EventTarget()
    vi.stubGlobal('window', target)
    let notifications = 0
    target.addEventListener(UNAUTHORIZED_EVENT, () => {
      notifications += 1
    })

    notifyUnauthorized()

    expect(notifications).toBe(1)
  })
})
