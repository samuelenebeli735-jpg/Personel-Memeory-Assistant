/**
 * Network reachability signals (R2-07).
 *
 * `navigator.onLine` only reports whether the device has a network at all. The
 * API client also reports what it actually saw: a fetch that failed before any
 * HTTP response means Recall could not be reached; any HTTP response, even an
 * error, means it could.
 */
export const NETWORK_FAILED_EVENT = 'recall:network-failed'
export const NETWORK_OK_EVENT = 'recall:network-ok'

export function notifyNetworkFailed(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(NETWORK_FAILED_EVENT))
}

export function notifyNetworkOk(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(NETWORK_OK_EVENT))
}
