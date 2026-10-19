import { useState, useEffect } from 'react'
import { useAuth } from '../hooks/useAuth'
import { useToast } from '../hooks/useToast'
import { settingsApi, type SettingsDto } from '../lib/api'
import { Button, Input, Select, Card, Badge, Textarea } from '../components/ui'

function TimeZoneSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const commonZones = [
    'Africa/Lagos', 'UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
    'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Tokyo',
    'Australia/Sydney', 'Pacific/Auckland'
  ]
  return (
    <Select
      label="Time Zone"
      options={commonZones.map(z => ({ value: z, label: z }))}
      value={value}
      onChange={e => onChange(typeof e === 'string' ? e : e.target.value)}
    />
  )
}

function HHMMInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <Input
      label={label}
      placeholder="HH:MM"
      value={value}
      onChange={e => {
        const v = e.target.value.replace(/[^0-9:]/g, '').slice(0, 5)
        onChange(v)
      }}
      maxLength={5}
      pattern="^([01]\\d|2[0-3]):[0-5]\\d$"
    />
  )
}

export function SettingsPage() {
  const { health, refreshHealth } = useAuth()
  const { showToast } = useToast()
  const [settings, setSettings] = useState<SettingsDto | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState<Partial<SettingsDto>>({})

  useEffect(() => {
    const load = async () => {
      try {
        const data = await settingsApi.get()
        setSettings(data)
        setForm({
          displayName: data.displayName || '',
          timeZone: data.timeZone,
          morningDefaultTime: data.morningDefaultTime,
          eveningDefaultTime: data.eveningDefaultTime,
          quietHoursStart: data.quietHoursStart || '',
          quietHoursEnd: data.quietHoursEnd || '',
          maxNotificationsPerDay: data.maxNotificationsPerDay,
          briefingEnabled: data.briefingEnabled,
          briefingTime: data.briefingTime,
          briefingSections: data.briefingSections,
          reminderOverdueGraceHours: data.reminderOverdueGraceHours,
          locale: data.locale,
        })
      } catch (err) {
        console.error(err)
      } finally {
        setIsLoading(false)
      }
    }
    load()
  }, [])

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value, type } = e.target
    setForm(prev => ({ ...prev, [name]: type === 'checkbox' ? (e.target as HTMLInputElement).checked : value }))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      await settingsApi.update(form)
      showToast('success', 'Settings saved')
      refreshHealth()
    } catch (err) {
      showToast('error', 'Failed to save settings', err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setSaving(false)
    }
  }

  if (isLoading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '400px' }}>
        <div className="loading-spinner" style={{ width: 32, height: 32 }} aria-hidden="true" />
      </div>
    )
  }

  return (
    <div>
      <h1 style={{ fontSize: '24px', fontWeight: '600', marginBottom: '24px' }}>Settings</h1>

      <form onSubmit={handleSubmit}>
        <Card style={{ marginBottom: '24px' }}>
          <div className="card-header">
            <h2 className="card-title">Profile</h2>
          </div>
          <div className="card-content">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '16px' }}>
              <Input label="Display Name" name="displayName" value={form.displayName || ''} onChange={handleChange} placeholder="Your name" />
            </div>
          </div>
        </Card>

        <Card style={{ marginBottom: '24px' }}>
          <div className="card-header">
            <h2 className="card-title">Localization</h2>
          </div>
          <div className="card-content">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '16px' }}>
              <TimeZoneSelect value={form.timeZone || 'Africa/Lagos'} onChange={v => setForm({ ...form, timeZone: v })} />
              <HHMMInput label="Morning Default Time" value={form.morningDefaultTime || '09:00'} onChange={v => setForm({ ...form, morningDefaultTime: v })} />
              <HHMMInput label="Evening Default Time" value={form.eveningDefaultTime || '19:00'} onChange={v => setForm({ ...form, eveningDefaultTime: v })} />
              <Select
                label="Locale"
                options={[
                  { value: 'en', label: 'English' },
                  { value: 'es', label: 'Spanish' },
                  { value: 'fr', label: 'French' },
                  { value: 'de', label: 'German' },
                ]}
                value={form.locale || 'en'}
                onChange={e => setForm({ ...form, locale: e.target.value })}
              />
            </div>
          </div>
        </Card>

        <Card style={{ marginBottom: '24px' }}>
          <div className="card-header">
            <h2 className="card-title">Quiet Hours & Notifications</h2>
          </div>
          <div className="card-content">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '16px' }}>
              <HHMMInput
                label="Quiet Hours Start"
                value={form.quietHoursStart || ''}
                onChange={v => setForm({ ...form, quietHoursStart: v })}
              />
              <HHMMInput
                label="Quiet Hours End"
                value={form.quietHoursEnd || ''}
                onChange={v => setForm({ ...form, quietHoursEnd: v })}
              />
              <Input
                label="Max Notifications Per Day (0 = unlimited)"
                type="number"
                name="maxNotificationsPerDay"
                value={form.maxNotificationsPerDay ?? 0}
                onChange={e => setForm({ ...form, maxNotificationsPerDay: parseInt(e.target.value) || 0 })}
                min={0}
              />
              <Input
                label="Reminder Overdue Grace (hours)"
                type="number"
                name="reminderOverdueGraceHours"
                value={form.reminderOverdueGraceHours ?? 12}
                onChange={e => setForm({ ...form, reminderOverdueGraceHours: parseInt(e.target.value) || 12 })}
                min={1}
              />
            </div>
          </div>
        </Card>

        <Card style={{ marginBottom: '24px' }}>
          <div className="card-header">
            <h2 className="card-title">Daily Briefing</h2>
          </div>
          <div className="card-content">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '16px', alignItems: 'end' }}>
              <div className="form-group">
                <label className="form-label">Enabled</label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    name="briefingEnabled"
                    checked={form.briefingEnabled ?? false}
                    onChange={e => setForm({ ...form, briefingEnabled: e.target.checked })}
                  />
                  <span>Enable daily briefing</span>
                </label>
              </div>
              <HHMMInput
                label="Briefing Time"
                value={form.briefingTime || '09:00'}
                onChange={v => setForm({ ...form, briefingTime: v })}
              />
              <Textarea
                label="Briefing Sections (JSON array)"
                placeholder='["today", "overdue", "upcoming"]'
                value={form.briefingSections ? JSON.stringify(form.briefingSections) : '["today", "overdue", "upcoming"]'}
                onChange={e => {
                  try {
                    setForm({ ...form, briefingSections: JSON.parse(e.target.value) })
                  } catch {
                    // Ignore invalid JSON
                  }
                }}
                rows={2}
                style={{ fontFamily: 'monospace', fontSize: '12px' }}
              />
            </div>
          </div>
        </Card>

        <Card style={{ marginBottom: '24px' }}>
          <div className="card-header">
            <h2 className="card-title">System Status</h2>
          </div>
          <div className="card-content">
            {health && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
                <div style={{ padding: '16px', background: 'var(--color-bg)', borderRadius: 'var(--radius-md)' }}>
                  <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginBottom: '4px' }}>Database</div>
                  <div style={{ fontWeight: '600', color: health.database.connected ? 'var(--color-success)' : 'var(--color-danger)' }}>
                    {health.database.connected ? 'Connected' : 'Disconnected'}
                  </div>
                </div>
                <div style={{ padding: '16px', background: 'var(--color-bg)', borderRadius: 'var(--radius-md)' }}>
                  <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginBottom: '4px' }}>Scheduler</div>
                  <div style={{ fontWeight: '600', color: health.scheduler.running ? 'var(--color-success)' : 'var(--color-danger)' }}>
                    {health.scheduler.running ? 'Running' : 'Stopped'}
                  </div>
                </div>
                <div style={{ padding: '16px', background: 'var(--color-bg)', borderRadius: 'var(--radius-md)' }}>
                  <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginBottom: '4px' }}>AI Provider</div>
                  <div style={{ fontWeight: '600' }}>{health.providers.ai.provider} ({health.providers.ai.configured ? 'Configured' : 'Not configured'})</div>
                </div>
                <div style={{ padding: '16px', background: 'var(--color-bg)', borderRadius: 'var(--radius-md)' }}>
                  <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginBottom: '4px' }}>STT Provider</div>
                  <div style={{ fontWeight: '600' }}>{health.providers.stt.provider} ({health.providers.stt.configured ? 'Configured' : 'Not configured'})</div>
                </div>
                <div style={{ padding: '16px', background: 'var(--color-bg)', borderRadius: 'var(--radius-md)' }}>
                  <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginBottom: '4px' }}>Telegram</div>
                  <div style={{ fontWeight: '600', color: health.providers.telegram.ownerConfigured ? 'var(--color-success)' : 'var(--color-danger)' }}>
                    {health.providers.telegram.ownerConfigured ? 'Owner configured' : 'No owner'}
                  </div>
                </div>
              </div>
            )}
          </div>
        </Card>

        <div className="card-content" style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: '16px' }}>
          <Button type="submit" loading={saving}>Save Settings</Button>
        </div>
      </form>
    </div>
  )
}