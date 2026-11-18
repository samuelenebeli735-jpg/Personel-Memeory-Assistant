import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../lib/api'
import {
  notifyUnauthorized,
  shouldNotifyUnauthorized,
  UNAUTHORIZED_EVENT,
} from '../lib/auth-events'
import { bootstrapSession } from './session-bootstrap'

afterEach(() => vi.unstubAllGlobals())

const health = {
  status: 'ok' as const,
  version: 'test',
  uptimeSeconds: 1,
  database: { connected: true, latencyMs: null },
  scheduler: { running: false, lastTickAt: null, dueNow: 0, scheduledTotal: 0 },
  providers: {
    ai: { provider: 'none', configured: false, enabled: false },
    stt: { provider: 'none', configured: false, enabled: false },
    telegram: { enabled: false, mode: 'polling', configured: false, ownerConfigured: true },
  },
  counts: { captures: 0, tasks: 0, reminders: 0, pendingDeliveries: 0 },
}

describe('session bootstrap', () => {
  it('keeps a valid session when the health probe fails transiently', async () => {
    const result = await bootstrapSession(
      async () => ({ authenticated: true }),
      async () => {
        throw new Error('health endpoint unavailable')
      },
    )

    expect(result).toEqual({ isAuthenticated: true, health: null })
  })

  it('keeps a valid session when the health probe returns a server error', async () => {
    const result = await bootstrapSession(
      async () => ({ authenticated: true }),
      async () => {
        throw new ApiError('Health unavailable', 'INTERNAL_ERROR', 500)
      },
    )

    expect(result).toEqual({ isAuthenticated: true, health: null })
  })

  it('treats an expired or invalid session as unauthenticated without probing health', async () => {
    const loadHealth = vi.fn(async () => health)
    const result = await bootstrapSession(async () => ({ authenticated: false }), loadHealth)

    expect(result).toEqual({ isAuthenticated: false, health: null })
    expect(loadHealth).not.toHaveBeenCalled()
  })

  it('treats a 401 from the health endpoint as an authentication failure', async () => {
    const result = await bootstrapSession(
      async () => ({ authenticated: true }),
      async () => {
        throw new ApiError('Your session has expired', 'UNAUTHORIZED', 401)
      },
    )

    expect(result).toEqual({ isAuthenticated: false, health: null })
  })

  it('returns the health payload for a valid session', async () => {
    const result = await bootstrapSession(async () => ({ authenticated: true }), async () => health)
    expect(result).toEqual({ isAuthenticated: true, health })
  })
})

describe('unauthorized event routing', () => {
  it('notifies only for protected-endpoint 401s', () => {
    expect(shouldNotifyUnauthorized('/captures/abc', 401)).toBe(true)
    expect(shouldNotifyUnauthorized('/health', 401)).toBe(true)
    expect(shouldNotifyUnauthorized('/auth/login', 401)).toBe(false)
    expect(shouldNotifyUnauthorized('/auth/session', 401)).toBe(false)
    expect(shouldNotifyUnauthorized('/captures/abc', 403)).toBe(false)
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
