import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { useToast } from '../hooks/useToast'
import { ideasApi, type IdeaDto } from '../lib/api'
import { useTimeZone } from '../hooks/useTimeZone'
import { Button, Input, Textarea, Card, EmptyState, Modal } from '../components/ui'
import { IdeaRow } from '../components/record-rows'
import { IdeasIcon } from '../components/Layout'

export function IdeasPage() {
  const { showToast } = useToast()
  const [searchParams, setSearchParams] = useSearchParams()
  const [ideas, setIdeas] = useState<IdeaDto[]>([])
  const [total, setTotal] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [createForm, setCreateForm] = useState<{ title: string; body: string }>({ title: '', body: '' })
  const [createLoading, setCreateLoading] = useState(false)

  const timeZone = useTimeZone().timeZone
  const page = parseInt(searchParams.get('page') || '1', 10)
  const limit = 25

  useEffect(() => {
    const load = async () => {
      setIsLoading(true)
      try {
        const data = await ideasApi.list({ limit, offset: (page - 1) * limit, sort: 'createdAt', order: 'desc' })
        setIdeas(data.items)
        setTotal(data.total)
      } catch (err) {
        console.error(err)
      } finally {
        setIsLoading(false)
      }
    }
    load()
  }, [page])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!createForm.title.trim()) return
    setCreateLoading(true)
    try {
      await ideasApi.create({ 
        title: createForm.title.trim(), 
        body: createForm.body.trim() || null,
        tags: [],
        projectId: null,
        captureId: null,
      })
      showToast('success', 'Idea created')
      setShowCreateModal(false)
      setCreateForm({ title: '', body: '' })
      const data = await ideasApi.list({ limit, offset: (page - 1) * limit, sort: 'createdAt', order: 'desc' })
      setIdeas(data.items)
      setTotal(data.total)
    } catch (err) {
      console.error(err)
    } finally {
      setCreateLoading(false)
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <h1 style={{ fontSize: '24px', fontWeight: '600', margin: 0 }}>Ideas</h1>
        <Button variant="primary" size="lg" onClick={() => setShowCreateModal(true)}>New Idea</Button>
      </div>

      <Card>
        <div className="card-content" style={{ padding: 0 }}>
          {isLoading ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '32px' }}>
              <div className="loading-spinner" aria-hidden="true" />
            </div>
          ) : ideas.length === 0 ? (
            <EmptyState
              icon={<IdeasIcon />}
              title="No ideas yet"
              text="Capture your thoughts and inspirations."
              action={<Button variant="primary" onClick={() => setShowCreateModal(true)}>Create Idea</Button>}
            />
          ) : (
            <>
              <div className="list" style={{ borderTop: '1px solid var(--color-border)' }}>
                {ideas.map(idea => (
                  <IdeaRow key={idea.id} idea={idea} timeZone={timeZone} />
                ))}
              </div>
            </>
          )}
        </div>
      </Card>

      <Modal isOpen={showCreateModal} onClose={() => setShowCreateModal(false)} title="Create Idea">
        <form onSubmit={async (e) => {
          e.preventDefault()
          try {
            await ideasApi.create({ title: createForm.title.trim(), body: createForm.body.trim() || null, tags: [], projectId: null, captureId: null })
            showToast('success', 'Idea created')
            setShowCreateModal(false)
            setCreateForm({ title: '', body: '' })
            const data = await ideasApi.list({ limit: 25, offset: 0, sort: 'createdAt', order: 'desc' })
            setIdeas(data.items)
            setTotal(data.total)
          } catch (err) {
            console.error(err)
          }
        }}>
          <Input label="Title" placeholder="Idea title" value={createForm.title} onChange={e => setCreateForm({ ...createForm, title: e.target.value })} required />
          <Textarea label="Body (optional)" placeholder="Details, context, links..." value={createForm.body} onChange={e => setCreateForm({ ...createForm, body: e.target.value })} rows={4} />
          <div className="modal-footer">
            <Button variant="secondary" type="button" onClick={() => setShowCreateModal(false)}>Cancel</Button>
            <Button type="submit">Create Idea</Button>
          </div>
        </form>
      </Modal>
    </div>
  )
}