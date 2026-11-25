import { describe, expect, it } from 'vitest'
import {
  addDays,
  clockTime,
  daysOverdue,
  isValidDateKey,
  longDateLabel,
  nowMarkerIndex,
  shortDayLabel,
  timeColumnLabel,
} from './briefing'

describe('Today page dates', () => {
  it('accepts only real calendar dates', () => {
    expect(isValidDateKey('2026-11-24')).toBe(true)
    expect(isValidDateKey('2028-02-29')).toBe(true)
    for (const bad of ['2026-02-30', '2026-13-01', '24-11-2026', '2026-11-24T00:00', '', null]) {
      expect(isValidDateKey(bad)).toBe(false)
    }
  })

  it('moves by calendar days across months, years and DST changes', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09')
  })

  it('labels the day', () => {
    expect(longDateLabel('2026-11-24', '2026-11-24')).toBe('Tuesday 24 November')
    expect(longDateLabel('2027-01-05', '2026-11-24')).toBe('Tuesday 5 January 2027')
    expect(shortDayLabel('2026-11-23')).toBe('Mon')
  })

  it('shows times in the Settings zone, not the browser’s', () => {
    expect(clockTime('2026-11-24T08:30:00.000Z', 'Africa/Lagos')).toBe('09:30')
    expect(clockTime('2026-11-24T08:30:00.000Z', 'America/New_York')).toBe('03:30')
    expect(timeColumnLabel('2026-11-24T12:30:00.000Z', '2026-11-24', 'Africa/Lagos')).toBe('13:30')
    // 23:30 UTC on the 24th is already the 25th in Lagos.
    expect(timeColumnLabel('2026-11-24T23:30:00.000Z', '2026-11-24', 'Africa/Lagos')).toBe('Wed')
    expect(timeColumnLabel('2026-12-10T09:00:00.000Z', '2026-11-24', 'Africa/Lagos')).toBe('10 Dec')
  })

  it('places the now marker before the first item that is not past', () => {
    const times = ['2026-11-24T08:00:00.000Z', '2026-11-24T12:30:00.000Z', '2026-11-24T17:00:00.000Z']
    expect(nowMarkerIndex(times, Date.parse('2026-11-24T09:20:00.000Z'))).toBe(1)
    expect(nowMarkerIndex(times, Date.parse('2026-11-24T07:00:00.000Z'))).toBe(0)
    expect(nowMarkerIndex(times, Date.parse('2026-11-24T18:00:00.000Z'))).toBe(3)
  })

  it('counts overdue days in the zone', () => {
    expect(daysOverdue('2026-11-22T10:00:00.000Z', '2026-11-24', 'Africa/Lagos')).toBe(2)
  })
})
