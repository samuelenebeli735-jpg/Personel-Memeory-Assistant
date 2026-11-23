/**
 * The dashboard's time zone.
 *
 * Source of truth: the owner's `timeZone` in Recall Settings — the same value
 * the server uses for reminders, briefings and "today". The provider loads it
 * once after sign-in and renders nothing date-related until it is known, so no
 * page can show a time in the wrong zone while it loads.
 *
 * If Settings cannot be read, the browser's zone is used and `source` is
 * `'browser'`, so the layout can say so instead of silently guessing.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { settingsApi } from '../lib/api'
import { resolveDisplayZone, type DisplayZone } from '../lib/date'

interface TimeZoneContextValue extends DisplayZone {
  /** Applies a zone the server just confirmed (e.g. after saving Settings). */
  setTimeZone: (timeZone: string) => void
  /** Re-reads the zone from Settings. */
  refresh: () => Promise<void>
}

const TimeZoneContext = createContext<TimeZoneContextValue | null>(null)

export function TimeZoneProvider({ children }: { children: ReactNode }) {
  const [zone, setZone] = useState<DisplayZone | null>(null)

  const refresh = useCallback(async () => {
    try {
      const settings = await settingsApi.get()
      setZone(resolveDisplayZone(settings.timeZone))
    } catch {
      setZone(resolveDisplayZone(null))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const setTimeZone = useCallback((timeZone: string) => {
    setZone(resolveDisplayZone(timeZone))
  }, [])

  if (!zone) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
        <div className="loading-spinner" style={{ width: 32, height: 32 }} aria-hidden="true" />
      </div>
    )
  }

  return (
    <TimeZoneContext.Provider value={{ ...zone, setTimeZone, refresh }}>
      {children}
    </TimeZoneContext.Provider>
  )
}

export function useTimeZone(): TimeZoneContextValue {
  const context = useContext(TimeZoneContext)
  if (!context) throw new Error('useTimeZone must be used within a TimeZoneProvider')
  return context
}
