import { createContext, useContext, useState, useEffect, type ReactNode } from 'react'
import { authApi, type HealthDto } from '../lib/api'
import { ApiError } from '../lib/api'

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
      const session = await authApi.session()
      if (session.authenticated) {
        setIsAuthenticated(true)
        const h = await authApi.health()
        setHealth(h)
      } else {
        setIsAuthenticated(false)
        setHealth(null)
      }
    } catch {
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