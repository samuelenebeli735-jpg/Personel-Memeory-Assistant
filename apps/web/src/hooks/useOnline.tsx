import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { NETWORK_FAILED_EVENT, NETWORK_OK_EVENT } from '../lib/network-events'

interface OnlineState {
  /** False when the device is offline or the last request could not reach Recall. */
  online: boolean
  /** Why the app believes it is offline, for the banner. */
  reason: 'device' | 'unreachable' | null
}

const OnlineContext = createContext<OnlineState>({ online: true, reason: null })

export function OnlineProvider({ children }: { children: ReactNode }) {
  const [deviceOnline, setDeviceOnline] = useState(
    typeof navigator === 'undefined' ? true : navigator.onLine,
  )
  const [unreachable, setUnreachable] = useState(false)

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

  const value: OnlineState = !deviceOnline
    ? { online: false, reason: 'device' }
    : unreachable
      ? { online: false, reason: 'unreachable' }
      : { online: true, reason: null }

  return <OnlineContext.Provider value={value}>{children}</OnlineContext.Provider>
}

export function useOnline(): OnlineState {
  return useContext(OnlineContext)
}
