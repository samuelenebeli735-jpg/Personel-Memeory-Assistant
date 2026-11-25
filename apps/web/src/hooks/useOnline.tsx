import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { authApi } from '../lib/api'
import { NETWORK_FAILED_EVENT, NETWORK_OK_EVENT } from '../lib/network-events'

interface OnlineState {
  /** False when the device is offline or the last request could not reach Recall. */
  online: boolean
  /** Why the app believes it is offline, for the banner. */
  reason: 'device' | 'unreachable' | null
  /** Asks Recall's liveness endpoint now; any answer clears "unreachable". */
  checkNow: () => void
}

/** How often to look for Recall again while it can't be reached. */
export const REACHABILITY_PROBE_MS = 5000

const OnlineContext = createContext<OnlineState>({ online: true, reason: null, checkNow: () => undefined })

export function OnlineProvider({ children }: { children: ReactNode }) {
  const [deviceOnline, setDeviceOnline] = useState(
    typeof navigator === 'undefined' ? true : navigator.onLine,
  )
  const [unreachable, setUnreachable] = useState(false)

  // The API client reports success through NETWORK_OK_EVENT, so a probe that
  // gets any HTTP answer clears the state by itself.
  const checkNow = useCallback(() => {
    authApi.healthLive().catch(() => undefined)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const up = () => setDeviceOnline(true)
    const down = () => setDeviceOnline(false)
    const failed = () => setUnreachable(true)
    const ok = () => setUnreachable(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    window.addEventListener(NETWORK_FAILED_EVENT, failed)
    window.addEventListener(NETWORK_OK_EVENT, ok)
    return () => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
      window.removeEventListener(NETWORK_FAILED_EVENT, failed)
      window.removeEventListener(NETWORK_OK_EVENT, ok)
    }
  }, [])

  // While Recall can't be reached, look again regularly and whenever the
  // device reconnects or the tab regains focus; otherwise nothing would ever
  // clear the state, because writes are paused.
  useEffect(() => {
    if (!unreachable || !deviceOnline || typeof window === 'undefined') return undefined
    const timer = window.setInterval(checkNow, REACHABILITY_PROBE_MS)
    window.addEventListener('focus', checkNow)
    window.addEventListener('online', checkNow)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', checkNow)
      window.removeEventListener('online', checkNow)
    }
  }, [unreachable, deviceOnline, checkNow])

  const value: OnlineState = !deviceOnline
    ? { online: false, reason: 'device', checkNow }
    : unreachable
      ? { online: false, reason: 'unreachable', checkNow }
      : { online: true, reason: null, checkNow }

  return <OnlineContext.Provider value={value}>{children}</OnlineContext.Provider>
}

export function useOnline(): OnlineState {
  return useContext(OnlineContext)
}
