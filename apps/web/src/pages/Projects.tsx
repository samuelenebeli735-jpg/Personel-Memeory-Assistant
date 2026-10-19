import { useState, useEffect } from 'react'
import type { FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { useToast } from '../hooks/useToast'
import { projectsApi, type ProjectDto, type ProjectCreateInput } from '../lib/api'
import { formatRelative, getTimeZone } from '../lib/date'
import { Button, Input, Textarea, Card, Badge, EmptyState, Modal } from '../components/ui'
import { ProjectsIcon } from '../components/Layout'

function ProjectRow({ project, timeZone }: { project: ProjectDto; timeZone: string }) {
  return (
    <Link to={`/projects/${project.id}`} className="list-item" style={{ textDecoration: 'none', color: 'inherit' }}>
      <div className="list-item-content" style={{ minWidth: 0 }}>
        <div className="list-item-title" style={{ textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
          {project.name}
        </div>
        <div className="list-item-meta">
          <Badge variant={project.status === 'ARCHIVED' ? 'warning' : 'success'}>{project.status}</Badge>
          <span>{project.counts.openTasks > 0 ? `${project.counts.openTasks} open tasks` : 'No open tasks'}</span>
          {project.counts.notes > 0 && <span>{project.counts.notes} notes</span>}
          {project.counts.ideas > 0 && <span>{project.counts.ideas} ideas</span>}
          {project.counts.events > 0 && <span>{project.counts.events} events</span>}
          <span style={{ fontFamily: 'monospace', fontSize: '11px', color: 'var(--color-text-muted)' }}>#{project.id.slice(0, 6)}</span>
        </div>
      </div>
    </Link>
  )
}

export function ProjectsPage() {
  const { showToast } = useToast()
  const [searchParams, setSearchParams] = useSearchParams()
  const [projects, setProjects] = useState<ProjectDto[]>([])
  const [total, setTotal] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [createForm, setCreateForm] = useState<{ name: string; description: string }>({ name: '', description: '' })
  const [createLoading, setCreateLoading] = useState(false)

  const timeZone = getTimeZone()
  const page = parseInt(searchParams.get('page') || '1', 10)
  const limit = 25

  useEffect(() => {
    const load = async () => {
      setIsLoading(true)
      try {
        const data = await projectsApi.list({ limit, offset: (page - 1) * limit })
        setProjects(data)
        setTotal(data.length)
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
    if (!createForm.name.trim()) return
    setCreateLoading(true)
    try {
      await projectsApi.create({ 
        name: createForm.name.trim(), 
        description: createForm.description.trim() || null,
        status: 'ACTIVE'
      })
      showToast('success', 'Project created')
      setShowCreateModal(false)
      setCreateForm({ name: '', description: '' })
      const data = await projectsApi.list({ limit, offset: (page - 1) * limit })
      setProjects(data)
      setTotal(data.length)
    } catch (err) {
      console.error(err)
    } finally {
      setCreateLoading(false)
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <h1 style={{ fontSize: '24px', fontWeight: '600', margin: 0 }}>Projects</h1>
        <Button variant="primary" size="lg" onClick={() => setShowCreateModal(true)}>New Project</Button>
      </div>

      <Card>
        <div className="card-content" style={{ padding: 0 }}>
          {isLoading ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '32px' }}>
              <div className="loading-spinner" aria-hidden="true" />
            </div>
          ) : projects.length === 0 ? (
            <EmptyState
              icon={<ProjectsIcon />}
              title="No projects yet"
              text="Create a project to organize your tasks, notes, and ideas."
              action={<Button variant="primary" onClick={() => setShowCreateModal(true)}>Create Project</Button>}
            />
          ) : (
            <>
              <div className="list" style={{ borderTop: '1px solid var(--color-border)' }}>
                {projects.map(project => (
                  <ProjectRow key={project.id} project={project} timeZone={getTimeZone()} />
                ))}
              </div>
            </>
          )}
        </div>
      </Card>

      <Modal isOpen={showCreateModal} onClose={() => setShowCreateModal(false)} title="Create Project">
        <form onSubmit={async (e) => {
          e.preventDefault()
          try {
            await projectsApi.create({ name: createForm.name.trim(), description: createForm.description.trim() || null, status: 'ACTIVE' })
            showToast('success', 'Project created')
            setShowCreateModal(false)
            setCreateForm({ name: '', description: '' })
            const data = await projectsApi.list({ limit: 25, offset: 0 })
            setProjects(data)
            setTotal(data.length)
          } catch (err) {
            console.error(err)
          }
        }}>
          <Input label="Name" placeholder="Project name" value={createForm.name} onChange={e => setCreateForm({ ...createForm, name: e.target.value })} required />
          <Textarea label="Description (optional)" placeholder="What is this project about?" value={createForm.description} onChange={e => setCreateForm({ ...createForm, description: e.target.value })} rows={3} />
          <div className="modal-footer">
            <Button variant="secondary" type="button" onClick={() => setShowCreateModal(false)}>Cancel</Button>
            <Button type="submit">Create Project</Button>
          </div>
        </form>
      </Modal>
    </div>
  )
}