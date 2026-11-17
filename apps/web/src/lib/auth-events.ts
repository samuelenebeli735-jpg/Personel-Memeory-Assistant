export const UNAUTHORIZED_EVENT = 'recall:unauthorized'

/**
 * A 401 from a protected endpoint means the session is no longer usable. Login
 * and session-probe failures are handled by the login screen instead, so they
 * must not trigger the global sign-out path.
 */
export function shouldNotifyUnauthorized(path: string, status: number): boolean {
  return status === 401 && !path.startsWith('/auth/')
}

export function notifyUnauthorized(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
}
