import { ApiError, type HealthDto } from '../lib/api'

export interface SessionProbe {
  authenticated: boolean
}

export type SessionBootstrapResult =
  | { status: 'authenticated'; health: HealthDto | null }
  | { status: 'signed-out' }
  /** Recall could not be asked; the UI offers Retry and never the login screen. */
  | { status: 'unreachable'; error: unknown }

/**
 * Waits after the 1st, 2nd and 3rd failed session check. So the session is
 * checked at most 4 times: 1 initial attempt plus up to 3 retries (D6,
 * refinement 5).
 */
export const SESSION_RETRY_DELAYS_MS = [1000, 2000, 4000] as const

/** Longest wait honoured from a Retry-After header. */
export const SESSION_MAX_RETRY_WAIT_MS = 60_000

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function isSignedOut(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401
}

/**
 * Authentication is decided by `/auth/session`, not by `/health`.
 *
 * - Only an explicit "not authenticated" answer or a 401 means signed out.
 * - Anything else (429, 5xx, network failure, timeout) means "unknown": the
 *   check is retried on the schedule above, honouring Retry-After, and if it
 *   still fails the result is `unreachable`.
 * - A health failure other than 401 leaves a valid session usable.
 */
export async function bootstrapSession(
  loadSession: () => Promise<SessionProbe>,
  loadHealth: () => Promise<HealthDto>,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<SessionBootstrapResult> {
  let session: SessionProbe | null = null
  for (let attempt = 0; session === null; attempt += 1) {
    try {
      session = await loadSession()
    } catch (error) {
      if (isSignedOut(error)) return { status: 'signed-out' }
      const base = SESSION_RETRY_DELAYS_MS[attempt]
      if (base === undefined) return { status: 'unreachable', error }
      const retryAfterMs =
        error instanceof ApiError && error.retryAfter !== null ? error.retryAfter * 1000 : 0
      await sleep(Math.min(SESSION_MAX_RETRY_WAIT_MS, Math.max(base, retryAfterMs)))
    }
  }

  if (!session.authenticated) {
    return { status: 'signed-out' }
  }

  try {
    return { status: 'authenticated', health: await loadHealth() }
  } catch (error) {
    if (isSignedOut(error)) return { status: 'signed-out' }
    return { status: 'authenticated', health: null }
  }
}
