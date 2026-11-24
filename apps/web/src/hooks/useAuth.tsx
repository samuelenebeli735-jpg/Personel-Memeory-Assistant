import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { authApi, type HealthDto } from '../lib/api'
import { UNAUTHORIZED_EVENT } from '../lib/auth-events'
import { bootstrapSession } from './session-bootstrap'

export type AuthStatus = 'loading' | 'authenticated' | 'signed-out' | 'unreachable'

interface AuthContextValue {
  status: AuthStatus
  isAuthenticated: boolean
  isLoading: boolean
  /**
   * A protected request answered 401 while the app was open. The page stays
   * on screen until the user chooses to sign in again, so they are told
   * before any unsaved text is lost.
   */
  sessionExpired: boolean
  health: HealthDto | null
  login: (password: string) => Promise<void>
  logout: () => Promise<void>
  /** Runs the session check again (used by "Can't reach Recall → Retry"). */
  retrySession: () => Promise<void>
  /** Leaves the expired session: the router then shows the login page. */
  acknowledgeSignedOut: () => void
  refreshHealth: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading')
  const [sessionExpired, setSessionExpired] = useState(false)
  const [health, setHealth] = useState<HealthDto | null>(null)

  const checkAuth = useCallback(async () => {
    setStatus('loading')
    const result = await bootstrapSession(authApi.session, authApi.health)
    if (result.status === 'authenticated') {
      setHealth(result.health)
      setSessionExpired(false)
    } else {
      setHealth(null)
    }
    setStatus(result.status)
  }, [])

  const login = async (password: string) => {
    await authApi.login(password)
    await checkAuth()
  }

  const logout = async () => {
    await authApi.logout()
    setStatus('signed-out')
    setSessionExpired(false)
    setHealth(null)
  }

  const acknowledgeSignedOut = useCallback(() => {
    setSessionExpired(false)
    setHealth(null)
    setStatus('signed-out')
  }, [])

  const refreshHealth = async () => {
    try {
      const h = await authApi.health()
      setHealth(h)
    } catch {
      // A failed health refresh never changes the session.
    }
  }

  useEffect(() => {
    if (typeof window === 'undefined') return undefined

    const handleUnauthorized = () => setSessionExpired(true)
    window.addEventListener(UNAUTHORIZED_EVENT, handleUnauthorized)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, handleUnauthorized)
  }, [])

  useEffect(() => {
    void checkAuth()
  }, [checkAuth])

  return (
    <AuthContext.Provider
      value={{
        status,
        isAuthenticated: status === 'authenticated',
        isLoading: status === 'loading',
        sessionExpired,
        health,
        login,
        logout,
        retrySession: checkAuth,
        acknowledgeSignedOut,
        refreshHealth,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
