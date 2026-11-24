import { useState, useEffect } from 'react'
import type { FormEvent } from 'react'
import { useOnline } from '../hooks/useOnline'
import { describeError } from '../lib/errors'
import { useToast } from '../hooks/useToast'
import { capturesApi, type CaptureDto, type CaptureInput } from '../lib/api'
import { useTimeZone } from '../hooks/useTimeZone'
import { Button, Textarea, Card, EmptyState } from '../components/ui'
import { CaptureRow } from '../components/record-rows'
import { CaptureIcon } from '../components/Layout'

export function CapturePage() {
  const { showToast } = useToast()
  const [text, setText] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [recentCaptures, setRecentCaptures] = useState<CaptureDto[]>([])
  const [isLoadingCaptures, setIsLoadingCaptures] = useState(true)

  const timeZone = useTimeZone().timeZone
  const { online } = useOnline()

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
      // The typed text stays in the box so nothing is lost.
      const described = describeError(err, 'Saving the capture', true)
      showToast(described.retryAfter !== undefined ? 'warning' : 'error', 'Failed to save capture', described.message)
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
              <Button type="submit" size="lg" loading={isLoading} disabled={!text.trim() || !online}>
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
                <CaptureRow key={capture.id} capture={capture} timeZone={timeZone} />
              ))}
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}