import { useState, useEffect } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { useToast } from '../hooks/useToast'
import { capturesApi, type CaptureInput } from '../lib/api'
import { formatLocalDateTime, getTimeZone } from '../lib/date'
import { Button, Textarea, Card, Badge, EmptyState } from '../components/ui'
import { CaptureIcon } from '../components/Layout'

export function CapturePage() {
  const { showToast } = useToast()
  const [text, setText] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [recentCaptures, setRecentCaptures] = useState<Array<{ id: string; rawText: string; kind: string; capturedAt: string; needsReview: boolean }>>([])
  const [isLoadingCaptures, setIsLoadingCaptures] = useState(true)

  const timeZone = getTimeZone()

  const loadRecent = async () => {
    try {
      const data = await capturesApi.list({ limit: 10, order: 'desc' })
      setRecentCaptures(data.items)
    } catch {
      // Ignore
    } finally {
      setIsLoadingCaptures(false)
    }
  }

  useEffect(() => {
    loadRecent()
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!text.trim()) return

    setIsLoading(true)
    try {
      const input: CaptureInput = {
        rawText: text.trim(),
        source: 'WEB',
      }
      await capturesApi.create(input)
      showToast('success', 'Capture saved')
      setText('')
      loadRecent()
    } catch (err) {
      showToast('error', 'Failed to save capture', err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <h1 style={{ fontSize: '24px', fontWeight: '600', margin: 0 }}>Quick Capture</h1>
      </div>

      <Card style={{ marginBottom: '24px' }}>
        <div className="card-content">
          <form onSubmit={handleSubmit}>
            <Textarea
              label="What's on your mind?"
              placeholder="Type anything... tasks, ideas, notes, appointments, links"
              value={text}
              onChange={e => setText(e.target.value)}
              rows={4}
              disabled={isLoading}
            />
            <div style={{ marginTop: '16px', display: 'flex', justifyContent: 'flex-end' }}>
              <Button type="submit" size="lg" loading={isLoading} disabled={!text.trim()}>
                <CaptureIcon style={{ marginRight: '8px' }} /> Save Capture
              </Button>
            </div>
          </form>
        </div>
      </Card>

      <Card>
        <div className="card-header">
          <h2 className="card-title">Recent Captures</h2>
        </div>
        <div className="card-content">
          {isLoadingCaptures ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '32px' }}>
              <div className="loading-spinner" aria-hidden="true" />
            </div>
          ) : recentCaptures.length === 0 ? (
            <EmptyState
              icon={<CaptureIcon />}
              title="No captures yet"
              text="Your captures will appear here."
            />
          ) : (
            <div className="list">
              {recentCaptures.map(capture => (
                <Link key={capture.id} to={`/captures/${capture.id}`} className="list-item" style={{ textDecoration: 'none', color: 'inherit' }}>
                  <div className="list-item-content" style={{ minWidth: 0 }}>
                    <div className="list-item-title" style={{ textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                      {capture.rawText.slice(0, 120)}
                    </div>
                    <div className="list-item-meta">
                      <Badge variant="muted">{capture.kind}</Badge>
                      <span>{formatLocalDateTime(capture.capturedAt, timeZone)}</span>
                      {capture.needsReview && <Badge variant="warning">needs review</Badge>}
                      <span style={{ fontFamily: 'monospace', fontSize: '11px', color: 'var(--color-text-muted)' }}>#{capture.id.slice(0, 6)}</span>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}