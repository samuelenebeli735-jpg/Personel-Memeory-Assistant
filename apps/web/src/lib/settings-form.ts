/**
 * Settings form state and its conversion to the API patch.
 *
 * The form keeps every field as the string the owner typed, so a half-typed
 * value never gets coerced into something else. `buildSettingsPatch` turns that
 * state into the exact shape `PATCH /api/settings` accepts:
 *
 *  - an empty optional field becomes `null` (never `''`, which the shared
 *    `HH:MM` schema rejects);
 *  - quiet hours are both set or both empty;
 *  - the result is checked against the shared `settingsUpdateSchema`, so the
 *    client and the server cannot disagree about what is valid.
 */
import { settingsUpdateSchema, type SettingsUpdateInput } from '@recall/shared'
import type { SettingsDto } from '../types/api'

export const BRIEFING_SECTION_OPTIONS = [
  { id: 'today', label: 'Due today', hint: 'Open tasks due today' },
  { id: 'overdue', label: 'Overdue', hint: 'Open tasks past their deadline' },
  { id: 'upcoming', label: 'Upcoming events', hint: 'Events in the next 7 days' },
  { id: 'ideas', label: 'Recent ideas', hint: 'Your 5 newest ideas' },
  { id: 'deadlines', label: 'Later deadlines', hint: 'Open tasks due after today' },
] as const

export type BriefingSectionId = (typeof BRIEFING_SECTION_OPTIONS)[number]['id']

const SECTION_IDS: readonly string[] = BRIEFING_SECTION_OPTIONS.map((option) => option.id)

export interface SettingsFormState {
  displayName: string
  timeZone: string
  morningDefaultTime: string
  eveningDefaultTime: string
  locale: string
  quietHoursStart: string
  quietHoursEnd: string
  maxNotificationsPerDay: string
  reminderOverdueGraceHours: string
  aiEnabled: boolean
  briefingEnabled: boolean
  briefingTime: string
  /** Included sections, in delivery order. */
  briefingSections: BriefingSectionId[]
}

export type SettingsFormErrors = Partial<Record<keyof SettingsFormState, string>>

export type SettingsPatchResult =
  | { ok: true; patch: SettingsUpdateInput }
  | { ok: false; errors: SettingsFormErrors }

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

/** Keeps only known section ids, in order, without duplicates. */
export function normaliseSections(sections: readonly string[]): BriefingSectionId[] {
  const seen = new Set<string>()
  const result: BriefingSectionId[] = []
  for (const raw of sections) {
    const id = raw.trim().toLowerCase()
    if (!SECTION_IDS.includes(id) || seen.has(id)) continue
    seen.add(id)
    result.push(id as BriefingSectionId)
  }
  return result
}

export function formFromSettings(settings: SettingsDto): SettingsFormState {
  return {
    displayName: settings.displayName ?? '',
    timeZone: settings.timeZone,
    morningDefaultTime: settings.morningDefaultTime,
    eveningDefaultTime: settings.eveningDefaultTime,
    locale: settings.locale,
    quietHoursStart: settings.quietHoursStart ?? '',
    quietHoursEnd: settings.quietHoursEnd ?? '',
    maxNotificationsPerDay: String(settings.maxNotificationsPerDay),
    reminderOverdueGraceHours: String(settings.reminderOverdueGraceHours),
    aiEnabled: settings.aiEnabled,
    briefingEnabled: settings.briefingEnabled,
    briefingTime: settings.briefingTime,
    briefingSections: normaliseSections(settings.briefingSections),
  }
}

function parseWholeNumber(value: string): number | null {
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) return null
  return Number(trimmed)
}

/**
 * Validates the form and builds the patch. Every field is sent, so a save
 * always leaves the server in exactly the state the form shows.
 */
export function buildSettingsPatch(form: SettingsFormState): SettingsPatchResult {
  const errors: SettingsFormErrors = {}

  const requireTime = (key: 'morningDefaultTime' | 'eveningDefaultTime' | 'briefingTime') => {
    if (!HHMM.test(form[key].trim())) errors[key] = 'Use 24-hour HH:MM, for example 07:30.'
  }
  requireTime('morningDefaultTime')
  requireTime('eveningDefaultTime')
  requireTime('briefingTime')

  const quietStart = form.quietHoursStart.trim()
  const quietEnd = form.quietHoursEnd.trim()
  if (quietStart && !HHMM.test(quietStart)) {
    errors.quietHoursStart = 'Use 24-hour HH:MM, or leave both quiet-hours fields empty.'
  }
  if (quietEnd && !HHMM.test(quietEnd)) {
    errors.quietHoursEnd = 'Use 24-hour HH:MM, or leave both quiet-hours fields empty.'
  }
  if (!errors.quietHoursStart && !errors.quietHoursEnd) {
    if (quietStart && !quietEnd) errors.quietHoursEnd = 'Set an end time, or clear the start time.'
    if (quietEnd && !quietStart) errors.quietHoursStart = 'Set a start time, or clear the end time.'
    if (quietStart && quietEnd && quietStart === quietEnd) {
      errors.quietHoursEnd = 'Start and end must be different times.'
    }
  }

  const cap = parseWholeNumber(form.maxNotificationsPerDay)
  if (cap === null || cap > 200) {
    errors.maxNotificationsPerDay = 'Enter a whole number from 0 to 200 (0 means no limit).'
  }
  const grace = parseWholeNumber(form.reminderOverdueGraceHours)
  if (grace === null || grace < 1 || grace > 168) {
    errors.reminderOverdueGraceHours = 'Enter a whole number of hours from 1 to 168.'
  }

  if (form.displayName.trim().length > 80) {
    errors.displayName = 'Use 80 characters or fewer.'
  }
  if (!form.timeZone.trim()) errors.timeZone = 'Choose a time zone.'

  const sections = normaliseSections(form.briefingSections)
  if (sections.length === 0) errors.briefingSections = 'Choose at least one briefing section.'

  if (Object.keys(errors).length > 0) return { ok: false, errors }

  const patch: SettingsUpdateInput = {
    displayName: form.displayName.trim() || null,
    timeZone: form.timeZone.trim(),
    morningDefaultTime: form.morningDefaultTime.trim(),
    eveningDefaultTime: form.eveningDefaultTime.trim(),
    locale: form.locale.trim() || 'en',
    quietHoursStart: quietStart || null,
    quietHoursEnd: quietEnd || null,
    maxNotificationsPerDay: cap as number,
    reminderOverdueGraceHours: grace as number,
    aiEnabled: form.aiEnabled,
    briefingEnabled: form.briefingEnabled,
    briefingTime: form.briefingTime.trim(),
    briefingSections: sections,
  }

  // The shared schema is the contract the server enforces; checking it here
  // means a form the client accepts is a form the server accepts.
  const checked = settingsUpdateSchema.safeParse(patch)
  if (!checked.success) {
    const schemaErrors: SettingsFormErrors = {}
    for (const issue of checked.error.issues) {
      const key = issue.path[0]
      if (typeof key === 'string' && key in form && !schemaErrors[key as keyof SettingsFormState]) {
        schemaErrors[key as keyof SettingsFormState] = issue.message
      }
    }
    return { ok: false, errors: schemaErrors }
  }
  return { ok: true, patch: checked.data }
}

/** Adds or removes a section; a newly added section goes to the end. */
export function toggleSection(
  sections: readonly BriefingSectionId[],
  id: BriefingSectionId,
): BriefingSectionId[] {
  return sections.includes(id) ? sections.filter((s) => s !== id) : [...sections, id]
}

/** Moves an included section one place earlier or later. */
export function moveSection(
  sections: readonly BriefingSectionId[],
  id: BriefingSectionId,
  direction: -1 | 1,
): BriefingSectionId[] {
  const index = sections.indexOf(id)
  const target = index + direction
  if (index < 0 || target < 0 || target >= sections.length) return [...sections]
  const next = [...sections]
  next[index] = next[target] as BriefingSectionId
  next[target] = id
  return next
}

/** Every section in display order: included ones first (in order), then the rest. */
export function sectionDisplayOrder(sections: readonly BriefingSectionId[]): BriefingSectionId[] {
  const rest = BRIEFING_SECTION_OPTIONS.map((o) => o.id).filter((id) => !sections.includes(id))
  return [...sections, ...rest]
}

/**
 * Every IANA zone the browser knows, with the current value and UTC always
 * present so a saved zone can never disappear from the list.
 */
export function timeZoneOptions(current: string): string[] {
  let zones: string[] = []
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
    zones = intl.supportedValuesOf ? intl.supportedValuesOf('timeZone') : []
  } catch {
    zones = []
  }
  const all = new Set<string>(zones.length > 0 ? zones : ['Africa/Lagos', 'Europe/London', 'America/New_York'])
  all.add('UTC')
  if (current) all.add(current)
  return [...all].sort((a, b) => a.localeCompare(b))
}
