import { describe, expect, it } from 'vitest'
import { SEARCH_ENTITY_TYPES, TASK_STATUSES } from '@recall/shared'

import {
  canFilterByStatus,
  parseSearchStatus,
  parseSearchTypes,
  selectedSearchTypes,
  SEARCH_STATUS_OPTIONS,
  SEARCH_TYPE_OPTIONS,
} from './search-filters'

describe('search filters', () => {
  it('advertises every entity type the backend can search', () => {
    expect(SEARCH_TYPE_OPTIONS.map((option) => option.value)).toEqual([...SEARCH_ENTITY_TYPES])
    expect(SEARCH_TYPE_OPTIONS.map((option) => option.label)).toContain('Captures')
    expect(SEARCH_TYPE_OPTIONS.map((option) => option.label)).toContain('Projects')
    expect(SEARCH_TYPE_OPTIONS.map((option) => option.label)).toContain('Reminders')
  })

  it('keeps multiple supported selections in order and removes duplicates', () => {
    expect(parseSearchTypes(['TASK', 'CAPTURE', 'PROJECT', 'REMINDER', 'TASK'])).toEqual([
      'TASK',
      'CAPTURE',
      'PROJECT',
      'REMINDER',
    ])
  })

  it('drops unknown, blank, and unsupported URL values instead of sending them to the API', () => {
    expect(parseSearchTypes(['', 'TOASTER', 'NOTE', 'TASK'])).toEqual(['NOTE', 'TASK'])
  })

  it('serializes a native multi-select through selectedOptions values', () => {
    const selected = [
      { value: 'CAPTURE' },
      { value: 'REMINDER' },
      { value: '' },
    ]
    expect(selectedSearchTypes(selected)).toEqual(['CAPTURE', 'REMINDER'])
  })

  it('offers only task statuses, never reminder or delivery statuses', () => {
    expect(SEARCH_STATUS_OPTIONS.map((option) => option.value)).toEqual([...TASK_STATUSES])
    expect(SEARCH_STATUS_OPTIONS.map((option) => option.value)).not.toEqual(
      expect.arrayContaining(['SCHEDULED', 'SENT', 'FAILED', 'MISSED']),
    )
  })

  it('accepts task statuses from URL state and clears invalid ones', () => {
    expect(parseSearchStatus('COMPLETED')).toBe('COMPLETED')
    expect(parseSearchStatus('IN_PROGRESS')).toBe('IN_PROGRESS')
    expect(parseSearchStatus('SCHEDULED')).toBe('')
    expect(parseSearchStatus('SENT')).toBe('')
    expect(parseSearchStatus('not-a-status')).toBe('')
    expect(parseSearchStatus(null)).toBe('')
  })

  it('enables the task status filter only when the selection can contain tasks', () => {
    expect(canFilterByStatus([])).toBe(true)
    expect(canFilterByStatus(['TASK'])).toBe(true)
    expect(canFilterByStatus(['NOTE', 'TASK'])).toBe(true)
    expect(canFilterByStatus(['NOTE', 'CAPTURE', 'PROJECT'])).toBe(false)
  })
})
