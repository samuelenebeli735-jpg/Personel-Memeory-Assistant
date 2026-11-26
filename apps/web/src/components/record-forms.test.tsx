import { describe, expect, it } from 'vitest'
import {
  changedFields,
  eventFormSpec,
  noteFormSpec,
  projectFormSpec,
  reminderFormSpec,
  taskFormSpec,
  type FormValues,
} from './record-forms'
import { reminderFixture, taskFixture } from '../test/fixtures'

describe('record form rules', () => {
  it('requires a task title and reads the due time in the Settings zone', () => {
    const missing = taskFormSpec.toInput({ ...taskFormSpec.empty }, 'Africa/Lagos', null)
    expect(missing).toEqual({ ok: false, errors: { title: 'Title is required' } })

    const ok = taskFormSpec.toInput(
      { ...taskFormSpec.empty, title: ' Buy tiles ', dueAt: '2026-11-25T09:00', priority: 'HIGH' },
      'Africa/Lagos',
      null,
    )
    expect(ok).toEqual({
      ok: true,
      input: { title: 'Buy tiles', description: null, priority: 'HIGH', dueAt: '2026-11-25T08:00:00.000Z', projectId: null },
    })
  })

  it('refuses a time inside a daylight-saving gap', () => {
    const result = eventFormSpec.toInput(
      { ...eventFormSpec.empty, title: 'Call', startsAt: '2026-03-08T02:30' },
      'America/New_York',
      null,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.startsAt).toMatch(/does not exist/)
  })

  it('requires an event start and an end after it', () => {
    const noStart = eventFormSpec.toInput({ ...eventFormSpec.empty, title: 'Dentist' }, 'UTC', null)
    expect(noStart.ok === false && noStart.errors.startsAt).toBe('Starts At is required')
    const backwards = eventFormSpec.toInput(
      { ...eventFormSpec.empty, title: 'Dentist', startsAt: '2026-11-25T10:00', endsAt: '2026-11-25T09:00' },
      'UTC',
      null,
    )
    expect(backwards.ok === false && backwards.errors.endsAt).toBe('Ends At must be after Starts At')
  })

  it('validates with the shared schema the API uses', () => {
    const converted = noteFormSpec.toInput({ ...noteFormSpec.empty, body: 'x', url: 'ftp://example.com' }, 'UTC', null)
    expect(converted.ok).toBe(true)
    if (converted.ok) expect(noteFormSpec.schema.safeParse(converted.input).success).toBe(false)
    expect(projectFormSpec.toInput({ ...projectFormSpec.empty }, 'UTC', null)).toEqual({
      ok: false,
      errors: { name: 'Name is required' },
    })
  })

  it('sends only the fields that changed when editing', () => {
    const task = taskFixture({ title: 'Old', description: 'Keep me', dueAt: '2026-11-25T08:00:00.000Z' })
    const values: FormValues = { ...taskFormSpec.fromRecord(task, 'Africa/Lagos'), title: 'New' }
    expect(values.dueAt).toBe('2026-11-25T09:00')
    const input = taskFormSpec.toInput(values, 'Africa/Lagos', task)
    const original = taskFormSpec.toInput(taskFormSpec.fromRecord(task, 'Africa/Lagos'), 'Africa/Lagos', task)
    expect(input.ok && original.ok && changedFields(input.input, original.input)).toEqual({ title: 'New' })
  })

  it('keeps a reminder series’ settings when the frequency is unchanged', () => {
    const recurrence = { frequency: 'WEEKLY' as const, weekdays: [1, 3], until: null, maxOccurrences: 10 }
    const reminder = reminderFixture({ recurrence })
    const values = reminderFormSpec.fromRecord(reminder, 'UTC')
    const same = reminderFormSpec.toInput(values, 'UTC', reminder)
    expect(same.ok && same.input.recurrence).toEqual(recurrence)
    const changed = reminderFormSpec.toInput({ ...values, recurrence: 'DAILY' }, 'UTC', reminder)
    expect(changed.ok && changed.input.recurrence).toEqual({ frequency: 'DAILY', weekdays: [], until: null, maxOccurrences: 52 })
    const none = reminderFormSpec.toInput({ ...values, recurrence: '' }, 'UTC', reminder)
    expect(none.ok && none.input.recurrence).toBeNull()
  })
})
