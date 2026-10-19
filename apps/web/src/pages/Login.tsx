import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { useToast } from '../hooks/useToast'
import { Button, Input, Card } from '../components/ui'

export function LoginPage() {
  const navigate = useNavigate()
  const { login } = useAuth()
  const { showToast } = useToast()
  const [password, setPassword] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setIsLoading(true)

    try {
      await login(password)
      showToast('success', 'Welcome back!')
      navigate('/')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Login failed'
      setError(message)
      showToast('error', 'Login failed', message)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', padding: '24px' }}>
      <Card style={{ width: '100%', maxWidth: '400px' }}>
        <div className="card-content" style={{ textAlign: 'center' }}>
          <h1 style={{ fontSize: '24px', fontWeight: '600', marginBottom: '8px', color: 'var(--color-text)' }}>
            Recall
          </h1>
          <p style={{ color: 'var(--color-text-muted)', marginBottom: '24px' }}>
            Sign in to your personal memory assistant
          </p>

          <form onSubmit={handleSubmit}>
            <Input
              type="password"
              label="Password"
              placeholder="Enter your dashboard password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              error={error}
              autoComplete="current-password"
              autoFocus
              disabled={isLoading}
            />

            <Button type="submit" className="w-full" size="lg" loading={isLoading}>
              Sign In
            </Button>
          </form>

          <p style={{ marginTop: '16px', fontSize: '13px', color: 'var(--color-text-muted)' }}>
            Your password is set via the <code>DASHBOARD_PASSWORD</code> environment variable.
          </p>
        </div>
      </Card>
    </div>
  )
}