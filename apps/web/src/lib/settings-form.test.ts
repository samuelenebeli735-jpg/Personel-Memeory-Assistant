import { settingsUpdateSchema } from '@recall/shared'
import { describe, expect, it } from 'vitest'
import type { SettingsDto } from '../types/api'
import {
  buildSettingsPatch,
  formFromSettings,
  moveSection,
  normaliseSections,
  sectionDisplayOrder,
  timeZoneOptions,
  toggleSection,
  type SettingsFormState,
} from './settings-form'

/** The settings a fresh install returns: no quiet hours, no display name. */
function defaultSettings(overrides: Partial<SettingsDto> = {}): SettingsDto {
  return {
    displayName: null,
    timeZone: 'Africa/Lagos',
    morningDefaultTime: '09:00',
    eveningDefaultTime: '19:00',
    quietHoursStart: null,
    quietHoursEnd: null,
    maxNotificationsPerDay: 0,
    briefingEnabled: false,
    briefingTime: '07:30',
    briefingSections: ['today', 'overdue', 'upcoming'],
    reminderOverdueGraceHours: 12,
    aiEnabled: true,
    locale: 'en',
    telegramOwnerConfigured: false,
    aiProviderConfigured: false,
    sttProviderConfigured: false,
    updatedAt: '2026-11-17T08:00:00.000Z',
    ...overrides,
  }
}

function form(overrides: Partial<SettingsFormState> = {}): SettingsFormState {
  return { ...formFromSettings(defaultSettings()), ...overrides }
}

function patchOf(state: SettingsFormState) {
  const result = buildSettingsPatch(state)
  if (!result.ok) throw new Error(`expected a valid patch, got ${JSON.stringify(result.errors)}`)
  return result.patch
}

describe('formFromSettings', () => {
  it('shows empty fields for unset optional values instead of the word null', () => {
    const state = form()
    expect(state.quietHoursStart).toBe('')
    expect(state.quietHoursEnd).toBe('')
    expect(state.displayName).toBe('')
  })

  it('drops unknown or duplicate briefing sections stored by hand', () => {
    const state = formFromSettings(defaultSettings({ briefingSections: ['ideas', 'bogus', 'ideas', 'TODAY'] }))
    expect(state.briefingSections).toEqual(['ideas', 'today'])
  })
})

describe('buildSettingsPatch', () => {
  it('saves a fresh install unchanged: empty quiet hours become null, not empty strings', () => {
    const patch = patchOf(form())
    expect(patch.quietHoursStart).toBeNull()
    expect(patch.quietHoursEnd).toBeNull()
    expect(patch.displayName).toBeNull()
    // This is the exact regression: the old form sent '' and the server answered 400.
    expect(settingsUpdateSchema.safeParse(patch).success).toBe(true)
  })

  it('saves custom quiet hours, including a window that crosses midnight', () => {
    const patch = patchOf(form({ quietHoursStart: '22:00', quietHoursEnd: '07:00' }))
    expect(patch.quietHoursStart).toBe('22:00')
    expect(patch.quietHoursEnd).toBe('07:00')
  })

  it('clears quiet hours when both fields are emptied', () => {
    const patch = patchOf(form({ quietHoursStart: ' ', quietHoursEnd: '' }))
    expect(patch.quietHoursStart).toBeNull()
    expect(patch.quietHoursEnd).toBeNull()
  })

  it('refuses half-configured quiet hours with a message on the missing field', () => {
    const onlyStart = buildSettingsPatch(form({ quietHoursStart: '22:00' }))
    expect(onlyStart.ok).toBe(false)
    if (!onlyStart.ok) expect(onlyStart.errors.quietHoursEnd).toMatch(/end time/)

    const onlyEnd = buildSettingsPatch(form({ quietHoursEnd: '07:00' }))
    expect(onlyEnd.ok).toBe(false)
    if (!onlyEnd.ok) expect(onlyEnd.errors.quietHoursStart).toMatch(/start time/)
  })

  it('refuses malformed and identical quiet-hour times', () => {
    const malformed = buildSettingsPatch(form({ quietHoursStart: '25:00', quietHoursEnd: '07:00' }))
    expect(malformed.ok).toBe(false)
    if (!malformed.ok) expect(malformed.errors.quietHoursStart).toBeDefined()

    const same = buildSettingsPatch(form({ quietHoursStart: '07:00', quietHoursEnd: '07:00' }))
    expect(same.ok).toBe(false)
  })

  it('sends the AI switch on its own, without changing any other field', () => {
    const on = patchOf(form({ aiEnabled: true }))
    const off = patchOf(form({ aiEnabled: false }))
    expect(on.aiEnabled).toBe(true)
    expect(off.aiEnabled).toBe(false)
    const { aiEnabled: _a, ...restOn } = on
    const { aiEnabled: _b, ...restOff } = off
    expect(restOff).toEqual(restOn)
  })

  it('keeps the briefing switch independent of the AI switch', () => {
    const patch = patchOf(form({ aiEnabled: false, briefingEnabled: true }))
    expect(patch.aiEnabled).toBe(false)
    expect(patch.briefingEnabled).toBe(true)
  })

  it('validates the numeric limits the server enforces', () => {
    const cap = buildSettingsPatch(form({ maxNotificationsPerDay: '201' }))
    expect(cap.ok).toBe(false)
    const grace = buildSettingsPatch(form({ reminderOverdueGraceHours: '0' }))
    expect(grace.ok).toBe(false)
    const notANumber = buildSettingsPatch(form({ maxNotificationsPerDay: '3.5' }))
    expect(notANumber.ok).toBe(false)
    expect(patchOf(form({ maxNotificationsPerDay: '10', reminderOverdueGraceHours: '24' }))).toMatchObject({
      maxNotificationsPerDay: 10,
      reminderOverdueGraceHours: 24,
    })
  })

  it('requires at least one briefing section and keeps the chosen order', () => {
    const none = buildSettingsPatch(form({ briefingSections: [] }))
    expect(none.ok).toBe(false)
    if (!none.ok) expect(none.errors.briefingSections).toBeDefined()

    expect(patchOf(form({ briefingSections: ['ideas', 'today'] })).briefingSections).toEqual(['ideas', 'today'])
  })

  it('accepts a non-default time zone', () => {
    expect(patchOf(form({ timeZone: 'America/New_York' })).timeZone).toBe('America/New_York')
  })
})

describe('briefing section editing', () => {
  it('adds a section at the end and removes it again', () => {
    const added = toggleSection(['today'], 'ideas')
    expect(added).toEqual(['today', 'ideas'])
    expect(toggleSection(added, 'today')).toEqual(['ideas'])
  })

  it('moves a section and ignores moves past either end', () => {
    expect(moveSection(['today', 'overdue', 'ideas'], 'ideas', -1)).toEqual(['today', 'ideas', 'overdue'])
    expect(moveSection(['today', 'overdue'], 'today', -1)).toEqual(['today', 'overdue'])
    expect(moveSection(['today', 'overdue'], 'overdue', 1)).toEqual(['today', 'overdue'])
  })

  it('lists included sections first, then the remaining ones', () => {
    expect(sectionDisplayOrder(['ideas', 'today'])).toEqual(['ideas', 'today', 'overdue', 'upcoming', 'deadlines'])
  })

  it('normalises case and whitespace', () => {
    expect(normaliseSections([' Overdue ', 'overdue'])).toEqual(['overdue'])
  })
})

describe('timeZoneOptions', () => {
  it('always offers UTC and the saved zone, even an unusual one', () => {
    const zones = timeZoneOptions('Pacific/Chatham')
    expect(zones).toContain('UTC')
    expect(zones).toContain('Pacific/Chatham')
    expect(zones).toContain('America/New_York')
    expect([...zones].sort((a, b) => a.localeCompare(b))).toEqual(zones)
  })
})
