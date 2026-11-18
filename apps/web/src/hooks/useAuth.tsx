import { createContext, useContext, useState, useEffect, type ReactNode } from 'react'
import { authApi, type HealthDto } from '../lib/api'
import { UNAUTHORIZED_EVENT } from '../lib/auth-events'
import { bootstrapSession } from './session-bootstrap'

interface AuthContextValue {
  isAuthenticated: boolean
  isLoading: boolean
  health: HealthDto | null
  login: (password: string) => Promise<void>
  logout: () => Promise<void>
  refreshHealth: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [health, setHealth] = useState<HealthDto | null>(null)

  const checkAuth = async () => {
    try {
      const result = await bootstrapSession(authApi.session, authApi.health)
      setIsAuthenticated(result.isAuthenticated)
      setHealth(result.health)
    } catch {
      // A failure to determine the session state is treated as unauthenticated.
      // A failure of the separate health probe is handled by bootstrapSession
      // and does not invalidate a valid session.
      setIsAuthenticated(false)
      setHealth(null)
    } finally {
      setIsLoading(false)
    }
  }

  const login = async (password: string) => {
    await authApi.login(password)
    await checkAuth()
  }

  const logout = async () => {
    await authApi.logout()
    setIsAuthenticated(false)
    setHealth(null)
  }

  const refreshHealth = async () => {
    try {
      const h = await authApi.health()
      setHealth(h)
    } catch {
      // Ignore health check failures
    }
  }

  useEffect(() => {
    if (typeof window === 'undefined') return undefined

    const handleUnauthorized = () => {
      setIsAuthenticated(false)
      setHealth(null)
    }
    window.addEventListener(UNAUTHORIZED_EVENT, handleUnauthorized)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, handleUnauthorized)
  }, [])

  useEffect(() => {
    checkAuth()
  }, [])

  return (
    <AuthContext.Provider value={{ isAuthenticated, isLoading, health, login, logout, refreshHealth }}>
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

export function useRequireAuth() {
  const auth = useAuth()
  if (!auth.isLoading && !auth.isAuthenticated) {
    // Redirect handled by router
  }
  return auth
}