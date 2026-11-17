import { ApiError, type HealthDto } from '../lib/api'

export interface SessionProbe {
  authenticated: boolean
}

export interface SessionBootstrapResult {
  isAuthenticated: boolean
  health: HealthDto | null
}

/**
 * Authentication is decided by `/auth/session`, not by `/health`.
 *
 * A transient health failure (network error, 5xx) leaves a valid session usable;
 * a 401 from the health endpoint is still an authentication failure.
 */
export async function bootstrapSession(
  loadSession: () => Promise<SessionProbe>,
  loadHealth: () => Promise<HealthDto>,
): Promise<SessionBootstrapResult> {
  const session = await loadSession()
  if (!session.authenticated) {
    return { isAuthenticated: false, health: null }
  }

  try {
    return { isAuthenticated: true, health: await loadHealth() }
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      return { isAuthenticated: false, health: null }
    }
    return { isAuthenticated: true, health: null }
  }
}
