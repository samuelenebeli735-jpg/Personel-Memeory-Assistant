import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { useToast } from '../hooks/useToast'
import { dashboardApi, type DashboardOverviewDto } from '../lib/api'
import { getTimeZone } from '../lib/date'
import { Card, Button, EmptyState } from '../components/ui'
import { CaptureRow, ReminderRow, TaskRow } from '../components/record-rows'
import { TasksIcon, RemindersIcon, CaptureIcon, SearchIcon } from '../components/Layout'

interface StatCardProps {
  icon: React.ReactNode
  label: string
  value: number | string
  href: string
  trend?: string
}

function StatCard({ icon, label, value, href, trend }: StatCardProps) {
  return (
    <Link to={href} style={{ textDecoration: 'none', color: 'inherit' }}>
      <Card style={{ height: '100%' }}>
        <div className="card-content" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: '13px', color: 'var(--color-text-muted)', marginBottom: '4px' }}>{label}</div>
            <div style={{ fontSize: '28px', fontWeight: '700', color: 'var(--color-text)' }}>{value}</div>
            {trend && <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '4px' }}>{trend}</div>}
          </div>
          <div style={{ opacity: 0.5 }}>{icon}</div>
        </div>
      </Card>
    </Link>
  )
}

function SectionHeader({ title, href, count }: { title: string; href: string; count?: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
      <h2 style={{ fontSize: '18px', fontWeight: '600', margin: 0 }}>{title}</h2>
      <Link to={href} style={{ fontSize: '13px', color: 'var(--color-primary)' }}>
        {count !== undefined && count > 0 ? `View all (${count})` : 'View all'}
      </Link>
    </div>
  )
}

export function OverviewPage() {
  const { health } = useAuth()
  const { showToast } = useToast()
  const [overview, setOverview] = useState<DashboardOverviewDto | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    const load = async () => {
      try {
        const data = await dashboardApi.overview()
        setOverview(data)
      } catch (err) {
        showToast('error', 'Failed to load dashboard', err instanceof Error ? err.message : 'Unknown error')
      } finally {
        setIsLoading(false)
      }
    }
    load()
  }, [showToast])

  const timeZone = overview?.timeZone || getTimeZone()

  if (isLoading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '400px' }}>
        <div className="loading-spinner" style={{ width: 32, height: 32 }} aria-hidden="true" />
      </div>
    )
  }

  if (!overview) {
    return <EmptyState icon={<CaptureIcon />} title="No data" text="Unable to load dashboard overview." />
  }

  return (
    <div>
      {/* Stats Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', marginBottom: '24px' }}>
        <StatCard icon={<TasksIcon />} label="Open Tasks" value={overview.counts.tasksOpen} href="/tasks" />
        <StatCard icon={<TasksIcon />} label="Due Today" value={overview.counts.tasksDueToday} href="/tasks" />
        <StatCard icon={<TasksIcon />} label="Overdue" value={overview.counts.tasksOverdue} href="/tasks" />
        <StatCard icon={<RemindersIcon />} label="Upcoming Reminders" value={overview.upcomingReminders.length} href="/reminders" />
        <StatCard icon={<CaptureIcon />} label="Inbox" value={overview.counts.inboxNeedsReview} href="/capture" />
        <StatCard icon={<CaptureIcon />} label="Captures Today" value={overview.counts.capturesToday} href="/capture" />
      </div>

      {/* Quick Actions */}
      <div style={{ display: 'flex', gap: '12px', marginBottom: '24px', flexWrap: 'wrap' }}>
        <Link to="/capture" style={{ textDecoration: 'none' }}>
          <Button variant="primary" size="lg" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <CaptureIcon /> Quick Capture
          </Button>
        </Link>
        <Link to="/search" style={{ textDecoration: 'none' }}>
          <Button variant="secondary" size="lg" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <SearchIcon /> Search
          </Button>
        </Link>
        <Link to="/tasks" style={{ textDecoration: 'none' }}>
          <Button variant="secondary" size="lg" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <TasksIcon /> New Task
          </Button>
        </Link>
        <Link to="/reminders" style={{ textDecoration: 'none' }}>
          <Button variant="secondary" size="lg" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <RemindersIcon /> Set Reminder
          </Button>
        </Link>
      </div>

      {/* Main Content Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
        {/* Left Column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          <Card>
            <SectionHeader title="Tasks Due Today" href="/tasks" count={overview.tasksDueToday.length} />
            <div className="list" style={{ gap: '8px' }}>
              {overview.tasksDueToday.length > 0 ? (
                overview.tasksDueToday.slice(0, 5).map(task => (
                  <TaskRow key={task.id} task={task} timeZone={timeZone} />
                ))
              ) : (
                <EmptyState
                  icon={<TasksIcon />}
                  title="Nothing due today"
                  text="Enjoy your day! Create a task to get started."
                  action={<Link to="/tasks"><Button variant="primary" size="sm">Create Task</Button></Link>}
                />
              )}
            </div>
          </Card>

          <Card>
            <SectionHeader title="Overdue Tasks" href="/tasks" count={overview.overdueTasks.length} />
            <div className="list" style={{ gap: '8px' }}>
              {overview.overdueTasks.length > 0 ? (
                overview.overdueTasks.slice(0, 5).map(task => (
                  <TaskRow key={task.id} task={task} timeZone={timeZone} />
                ))
              ) : (
                <EmptyState
                  icon={<TasksIcon />}
                  title="No overdue tasks"
                  text="You're all caught up!"
                />
              )}
            </div>
          </Card>
        </div>

        {/* Right Column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          <Card>
            <SectionHeader title="Upcoming Reminders" href="/reminders" count={overview.upcomingReminders.length} />
            <div className="list" style={{ gap: '8px' }}>
              {overview.upcomingReminders.length > 0 ? (
                overview.upcomingReminders.slice(0, 5).map(reminder => (
                  <ReminderRow key={reminder.id} reminder={reminder} timeZone={timeZone} />
                ))
              ) : (
                <EmptyState
                  icon={<RemindersIcon />}
                  title="No reminders set"
                  text="Create a reminder to get notified on time."
                  action={<Link to="/reminders"><Button variant="primary" size="sm">Set Reminder</Button></Link>}
                />
              )}
            </div>
          </Card>

          <Card>
            <SectionHeader title="Recent Captures" href="/capture" count={overview.recentCaptures.length} />
            <div className="list" style={{ gap: '8px' }}>
              {overview.recentCaptures.length > 0 ? (
                overview.recentCaptures.slice(0, 5).map(capture => (
                  <CaptureRow key={capture.id} capture={capture} timeZone={timeZone} />
                ))
              ) : (
                <EmptyState
                  icon={<CaptureIcon />}
                  title="No captures yet"
                  text="Send a message to Telegram or use Quick Capture to get started."
                />
              )}
            </div>
          </Card>

          <Card>
            <SectionHeader title="Inbox" href="/capture" count={overview.inbox.length} />
            <div className="list" style={{ gap: '8px' }}>
              {overview.inbox.length > 0 ? (
                overview.inbox.slice(0, 5).map(capture => (
                  <CaptureRow key={capture.id} capture={capture} timeZone={timeZone} />
                ))
              ) : (
                <EmptyState
                  icon={<CaptureIcon />}
                  title="Inbox empty"
                  text="All captures have been reviewed."
                />
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}