import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../hooks/useAuth'
import { useToast } from '../hooks/useToast'
import { useTimeZone } from '../hooks/useTimeZone'
import { settingsApi, type SettingsDto } from '../lib/api'
import { Button, Input, Select, Card } from '../components/ui'
import {
  BRIEFING_SECTION_OPTIONS,
  buildSettingsPatch,
  formFromSettings,
  moveSection,
  sectionDisplayOrder,
  timeZoneOptions,
  toggleSection,
  type BriefingSectionId,
  type SettingsFormErrors,
  type SettingsFormState,
} from '../lib/settings-form'

const GRID = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '16px' } as const

function HHMMInput({
  id,
  label,
  value,
  error,
  hint,
  onChange,
}: {
  id: string
  label: string
  value: string
  error?: string
  hint?: string
  onChange: (v: string) => void
}) {
  return (
    <Input
      id={id}
      label={label}
      placeholder="HH:MM"
      inputMode="numeric"
      autoComplete="off"
      value={value}
      error={error}
      hint={hint}
      onChange={(e) => onChange(e.target.value.replace(/[^0-9:]/g, '').slice(0, 5))}
      maxLength={5}
    />
  )
}

function Toggle({
  id,
  checked,
  label,
  hint,
  onChange,
}: {
  id: string
  checked: boolean
  label: string
  hint?: string
  onChange: (checked: boolean) => void
}) {
  return (
    <div className="form-group">
      <label htmlFor={id} style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
        <input
          id={id}
          type="checkbox"
          checked={checked}
          aria-describedby={hint ? `${id}-hint` : undefined}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>{label}</span>
      </label>
      {hint && (
        <div id={`${id}-hint`} className="form-hint">
          {hint}
        </div>
      )}
    </div>
  )
}

function BriefingSectionsEditor({
  sections,
  error,
  onChange,
}: {
  sections: BriefingSectionId[]
  error?: string
  onChange: (sections: BriefingSectionId[]) => void
}) {
  const order = sectionDisplayOrder(sections)
  return (
    <fieldset className="form-group" aria-describedby={error ? 'briefing-sections-error' : 'briefing-sections-hint'}>
      <legend className="form-label">Briefing sections</legend>
      <div id="briefing-sections-hint" className="form-hint" style={{ marginBottom: '8px' }}>
        Checked sections appear in this order.
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '6px' }}>
        {order.map((id) => {
          const option = BRIEFING_SECTION_OPTIONS.find((o) => o.id === id)!
          const included = sections.includes(id)
          const position = sections.indexOf(id)
          return (
            <li key={id} style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <label htmlFor={`briefing-section-${id}`} style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: '1 1 200px', cursor: 'pointer' }}>
                <input
                  id={`briefing-section-${id}`}
                  type="checkbox"
                  checked={included}
                  onChange={() => onChange(toggleSection(sections, id))}
                />
                <span>
                  {option.label}
                  <span className="form-hint" style={{ marginLeft: '6px' }}>{option.hint}</span>
                </span>
              </label>
              {included && (
                <span style={{ display: 'flex', gap: '4px' }}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Move ${option.label} up`}
                    disabled={position <= 0}
                    onClick={() => onChange(moveSection(sections, id, -1))}
                  >
                    Up
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Move ${option.label} down`}
                    disabled={position >= sections.length - 1}
                    onClick={() => onChange(moveSection(sections, id, 1))}
                  >
                    Down
                  </Button>
                </span>
              )}
            </li>
          )
        })}
      </ul>
      {error && (
        <div id="briefing-sections-error" className="form-error" role="alert">
          {error}
        </div>
      )}
    </fieldset>
  )
}

export function SettingsPage() {
  const { health, refreshHealth } = useAuth()
  const { showToast } = useToast()
  const { setTimeZone } = useTimeZone()
  const [settings, setSettings] = useState<SettingsDto | null>(null)
  const [form, setForm] = useState<SettingsFormState | null>(null)
  const [errors, setErrors] = useState<SettingsFormErrors>({})
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setIsLoading(true)
    setLoadError(null)
    try {
      const data = await settingsApi.get()
      setSettings(data)
      setForm(formFromSettings(data))
      setErrors({})
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'The settings could not be loaded.')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const zones = useMemo(() => timeZoneOptions(form?.timeZone ?? ''), [form?.timeZone])

  const update = <K extends keyof SettingsFormState>(key: K, value: SettingsFormState[K]) => {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev))
    setErrors((prev) => {
      if (!prev[key]) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form) return
    const result = buildSettingsPatch(form)
    if (!result.ok) {
      setErrors(result.errors)
      showToast('error', 'Settings not saved', 'Fix the highlighted fields and save again.')
      return
    }
    setSaving(true)
    try {
      const saved = await settingsApi.update(result.patch)
      // Show exactly what the server stored, not what was sent.
      setSettings(saved)
      setForm(formFromSettings(saved))
      // Every page reads the zone from the provider, so the dashboard switches
      // to the saved zone immediately, without a reload.
      setTimeZone(saved.timeZone)
      setErrors({})
      showToast('success', 'Settings saved')
      void refreshHealth()
    } catch (err) {
      showToast('error', 'Settings not saved', err instanceof Error ? err.message : 'Unknown error')
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

  if (loadError || !form || !settings) {
    return (
      <div>
        <h1 style={{ fontSize: '24px', fontWeight: '600', marginBottom: '24px' }}>Settings</h1>
        <Card>
          <div className="card-content" role="alert">
            <h2 className="card-title">Settings could not be loaded</h2>
            <p>{loadError ?? 'The settings could not be loaded.'} Nothing was changed.</p>
            <Button type="button" onClick={() => void load()}>Retry</Button>
          </div>
        </Card>
      </div>
    )
  }

  return (
    <div>
      <h1 style={{ fontSize: '24px', fontWeight: '600', marginBottom: '24px' }}>Settings</h1>

      <form onSubmit={handleSubmit} noValidate>
        <Card style={{ marginBottom: '24px' }}>
          <div className="card-header">
            <h2 className="card-title">Profile</h2>
          </div>
          <div className="card-content">
            <div style={GRID}>
              <Input
                id="settings-display-name"
                label="Display Name"
                value={form.displayName}
                error={errors.displayName}
                onChange={(e) => update('displayName', e.target.value)}
                placeholder="Your name"
                maxLength={80}
              />
            </div>
          </div>
        </Card>

        <Card style={{ marginBottom: '24px' }}>
          <div className="card-header">
            <h2 className="card-title">Localization</h2>
          </div>
          <div className="card-content">
            <div style={GRID}>
              <Select
                id="settings-time-zone"
                label="Time Zone"
                hint="Reminders, briefings and every date in the dashboard use this zone."
                error={errors.timeZone}
                options={zones.map((z) => ({ value: z, label: z }))}
                value={form.timeZone}
                onChange={(e) => update('timeZone', e.target.value)}
              />
              <HHMMInput
                id="settings-morning-time"
                label="Morning Default Time"
                value={form.morningDefaultTime}
                error={errors.morningDefaultTime}
                onChange={(v) => update('morningDefaultTime', v)}
              />
              <HHMMInput
                id="settings-evening-time"
                label="Evening Default Time"
                value={form.eveningDefaultTime}
                error={errors.eveningDefaultTime}
                onChange={(v) => update('eveningDefaultTime', v)}
              />
              <Select
                id="settings-locale"
                label="Locale"
                options={[
                  { value: 'en', label: 'English' },
                  { value: 'es', label: 'Spanish' },
                  { value: 'fr', label: 'French' },
                  { value: 'de', label: 'German' },
                ]}
                value={form.locale}
                onChange={(e) => update('locale', e.target.value)}
              />
            </div>
          </div>
        </Card>

        <Card style={{ marginBottom: '24px' }}>
          <div className="card-header">
            <h2 className="card-title">Quiet Hours & Notifications</h2>
          </div>
          <div className="card-content">
            <div style={GRID}>
              <HHMMInput
                id="settings-quiet-start"
                label="Quiet Hours Start"
                value={form.quietHoursStart}
                error={errors.quietHoursStart}
                hint="Leave both quiet-hours fields empty for no quiet hours."
                onChange={(v) => update('quietHoursStart', v)}
              />
              <HHMMInput
                id="settings-quiet-end"
                label="Quiet Hours End"
                value={form.quietHoursEnd}
                error={errors.quietHoursEnd}
                onChange={(v) => update('quietHoursEnd', v)}
              />
              <Input
                id="settings-max-notifications"
                label="Max Notifications Per Day (0 = unlimited)"
                type="number"
                inputMode="numeric"
                min={0}
                max={200}
                value={form.maxNotificationsPerDay}
                error={errors.maxNotificationsPerDay}
                onChange={(e) => update('maxNotificationsPerDay', e.target.value)}
              />
              <Input
                id="settings-grace-hours"
                label="Reminder Overdue Grace (hours)"
                type="number"
                inputMode="numeric"
                min={1}
                max={168}
                value={form.reminderOverdueGraceHours}
                error={errors.reminderOverdueGraceHours}
                onChange={(e) => update('reminderOverdueGraceHours', e.target.value)}
              />
            </div>
          </div>
        </Card>

        <Card style={{ marginBottom: '24px' }}>
          <div className="card-header">
            <h2 className="card-title">AI Assistance</h2>
          </div>
          <div className="card-content">
            <Toggle
              id="settings-ai-enabled"
              checked={form.aiEnabled}
              label="Use AI to classify captures and answer questions"
              hint={
                settings.aiProviderConfigured
                  ? 'When off, nothing is sent to the AI provider; Recall uses its built-in rules and cited record summaries.'
                  : 'No AI provider is configured on the server, so Recall uses its built-in rules either way.'
              }
              onChange={(checked) => update('aiEnabled', checked)}
            />
          </div>
        </Card>

        <Card style={{ marginBottom: '24px' }}>
          <div className="card-header">
            <h2 className="card-title">Daily Briefing</h2>
          </div>
          <div className="card-content">
            <div style={{ ...GRID, alignItems: 'start' }}>
              <Toggle
                id="settings-briefing-enabled"
                checked={form.briefingEnabled}
                label="Send the daily briefing"
                hint="Off still lets you read the briefing on demand."
                onChange={(checked) => update('briefingEnabled', checked)}
              />
              <HHMMInput
                id="settings-briefing-time"
                label="Briefing Time"
                value={form.briefingTime}
                error={errors.briefingTime}
                onChange={(v) => update('briefingTime', v)}
              />
            </div>
            <BriefingSectionsEditor
              sections={form.briefingSections}
              error={errors.briefingSections}
              onChange={(sections) => update('briefingSections', sections)}
            />
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
