import { describe, expect, it } from 'vitest'
import { searchQuerySchema } from '@recall/shared'

import {
  calendarDayDifference,
  formatLocalDateTime,
  formatRelative,
  localDateKey,
  localDateTimeToUtcIso,
  localDayAtTime,
  resolveDisplayZone,
} from './date'

describe('localDateTimeToUtcIso', () => {
  it('interprets a datetime-local value in the configured time zone', () => {
    expect(localDateTimeToUtcIso('2026-10-21T10:00', 'Africa/Lagos')).toEqual({
      ok: true,
      value: '2026-10-21T09:00:00.000Z',
    })
  })

  it('handles the configured time zone differing from UTC and from DST', () => {
    expect(localDateTimeToUtcIso('2026-01-15T09:30', 'America/New_York')).toEqual({
      ok: true,
      value: '2026-01-15T14:30:00.000Z',
    })
    expect(localDateTimeToUtcIso('2026-07-15T09:30', 'America/New_York')).toEqual({
      ok: true,
      value: '2026-07-15T13:30:00.000Z',
    })
  })

  it('preserves seconds and milliseconds supplied by the control', () => {
    expect(localDateTimeToUtcIso('2026-10-21T10:00:30', 'Africa/Lagos')).toEqual({
      ok: true,
      value: '2026-10-21T09:00:30.000Z',
    })
    expect(localDateTimeToUtcIso('2026-10-21T10:00:30.250', 'Africa/Lagos')).toEqual({
      ok: true,
      value: '2026-10-21T09:00:30.250Z',
    })
  })

  it('serializes an empty control value as an absent filter', () => {
    expect(localDateTimeToUtcIso('', 'Africa/Lagos')).toEqual({ ok: true, value: null })
    expect(localDateTimeToUtcIso('   ', 'Africa/Lagos')).toEqual({ ok: true, value: null })
  })

  it('rejects malformed and impossible local values instead of sending them', () => {
    for (const value of [
      'not-a-date',
      '2026-10-21',
      '2026-02-30T10:00',
      '2026-10-21T24:00',
      '2026-10-21T10:60',
      '2026-10-21T10:00:60',
    ]) {
      expect(localDateTimeToUtcIso(value, 'Africa/Lagos'), value).toMatchObject({ ok: false })
    }
  })

  it('rejects a time that falls in a DST spring-forward gap', () => {
    expect(localDateTimeToUtcIso('2026-03-08T02:30', 'America/New_York')).toMatchObject({
      ok: false,
    })
  })

  it('reports an unsupported configured time zone rather than guessing', () => {
    expect(localDateTimeToUtcIso('2026-10-21T10:00', 'Not/AZone')).toMatchObject({ ok: false })
  })

  it('produces timestamps accepted by the shared search contract', () => {
    const local = '2026-10-21T10:00'
    const converted = localDateTimeToUtcIso(local, 'Africa/Lagos')

    expect(searchQuerySchema.safeParse({ from: local }).success).toBe(false)
    expect(converted.ok).toBe(true)
    if (!converted.ok) return
    expect(searchQuerySchema.safeParse({ from: converted.value }).success).toBe(true)
  })
})

describe('resolveDisplayZone', () => {
  it('uses the Settings zone whenever it is valid', () => {
    expect(resolveDisplayZone('America/New_York', 'Europe/Berlin')).toEqual({
      timeZone: 'America/New_York',
      source: 'settings',
    })
  })

  it('falls back to the browser zone (never a hard-coded one) and says so', () => {
    expect(resolveDisplayZone(null, 'Europe/Berlin')).toEqual({ timeZone: 'Europe/Berlin', source: 'browser' })
    expect(resolveDisplayZone('Not/AZone', 'Asia/Tokyo')).toEqual({ timeZone: 'Asia/Tokyo', source: 'browser' })
    expect(resolveDisplayZone(undefined, 'Not/AZone')).toEqual({ timeZone: 'UTC', source: 'browser' })
  })
})

describe('display in two zones', () => {
  const instant = '2026-07-01T03:00:00.000Z'

  it('renders one instant as the local wall clock of each zone', () => {
    expect(localDateKey(new Date(instant), 'America/New_York')).toBe('2026-06-30')
    expect(localDateKey(new Date(instant), 'Africa/Lagos')).toBe('2026-07-01')
    expect(formatLocalDateTime(instant, 'America/New_York')).toMatch(/11:00/)
    expect(formatLocalDateTime(instant, 'Africa/Lagos')).toMatch(/4:00/)
  })
})

describe('calendarDayDifference', () => {
  it('counts local calendar days, not 24-hour periods', () => {
    // 23:00 Monday to 05:00 Wednesday in New York is 30 hours but two days.
    const monday23 = new Date('2026-07-07T03:00:00.000Z')
    const wednesday05 = new Date('2026-07-08T09:00:00.000Z')
    expect(calendarDayDifference(monday23, wednesday05, 'America/New_York')).toBe(2)
  })

  it('is unaffected by the DST changes', () => {
    // New York springs forward on 2026-03-08 and falls back on 2026-11-01.
    const beforeSpring = new Date('2026-03-07T17:00:00.000Z')
    const afterSpring = new Date('2026-03-08T16:00:00.000Z')
    expect(calendarDayDifference(beforeSpring, afterSpring, 'America/New_York')).toBe(1)
    const beforeFall = new Date('2026-10-31T16:00:00.000Z')
    const afterFall = new Date('2026-11-01T17:00:00.000Z')
    expect(calendarDayDifference(beforeFall, afterFall, 'America/New_York')).toBe(1)
  })
})

describe('formatRelative', () => {
  it('names the calendar day in the owner zone', () => {
    const now = new Date('2026-07-07T03:00:00.000Z') // Mon 23:00 in New York
    expect(formatRelative('2026-07-08T09:00:00.000Z', 'America/New_York', now)).toMatch(/^Wednesday at /)
    expect(formatRelative('2026-07-07T09:00:00.000Z', 'America/New_York', now)).toMatch(/^tomorrow at /)
  })

  it('says "just now" within a minute either way, never "in 0 min"', () => {
    const now = new Date('2026-11-24T10:00:00.000Z')
    expect(formatRelative('2026-11-24T10:00:20.000Z', 'UTC', now)).toBe('just now')
    expect(formatRelative('2026-11-24T09:59:31.000Z', 'UTC', now)).toBe('just now')
    expect(formatRelative('2026-11-24T09:58:00.000Z', 'UTC', now)).toBe('2 min ago')
    expect(formatRelative('2026-11-24T10:05:00.000Z', 'UTC', now)).toBe('in 5 min')
  })

  it('gives different answers for the same instants in different zones', () => {
    const now = new Date('2026-06-30T20:00:00.000Z') // 16:00 NY / 21:00 Lagos
    const target = '2026-07-01T03:00:00.000Z' // 23:00 NY (same day) / 04:00 Lagos (next day)
    expect(formatRelative(target, 'America/New_York', now)).toBe('in 7 hr')
    expect(formatRelative(target, 'Africa/Lagos', now)).toMatch(/^tomorrow at /)
  })
})

describe('localDayAtTime', () => {
  it('means 09:00 tomorrow in the owner zone, not 24 hours from now', () => {
    const now = new Date('2026-10-17T14:00:00.000Z') // 15:00 in Lagos
    expect(localDayAtTime(now, 'Africa/Lagos', 1, '09:00')).toBe('2026-10-18T08:00:00.000Z')
    expect(localDayAtTime(now, 'America/New_York', 1, '09:00')).toBe('2026-10-18T13:00:00.000Z')
  })

  it('keeps the wall-clock hour across a DST change', () => {
    // Saturday before New York springs forward: 09:00 Sunday is EDT (UTC-4).
    const now = new Date('2026-03-07T20:00:00.000Z')
    expect(localDayAtTime(now, 'America/New_York', 1, '09:00')).toBe('2026-03-08T13:00:00.000Z')
  })
})

describe('localDateTimeToUtcIso around a fall-back DST change', () => {
  it('accepts a repeated local hour and keeps the round trip exact', () => {
    const result = localDateTimeToUtcIso('2026-11-01T01:30', 'America/New_York')
    expect(result.ok).toBe(true)
    if (!result.ok || !result.value) return
    expect(['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z']).toContain(result.value)
  })
})

describe('utcIsoToLocalInput', () => {
  it('shows a UTC instant as a wall-clock value in the Settings zone', async () => {
    const { utcIsoToLocalInput, localDateTimeToUtcIso } = await import('./date')
    expect(utcIsoToLocalInput('2026-11-24T08:30:00.000Z', 'Africa/Lagos')).toBe('2026-11-24T09:30')
    expect(utcIsoToLocalInput('2026-07-01T13:00:00.000Z', 'America/New_York')).toBe('2026-07-01T09:00')
    expect(utcIsoToLocalInput(null, 'UTC')).toBe('')
    expect(utcIsoToLocalInput('not a date', 'UTC')).toBe('')
    // Round trip with the converter used on save.
    const local = utcIsoToLocalInput('2026-03-29T00:59:00.000Z', 'Europe/London')
    expect(localDateTimeToUtcIso(local, 'Europe/London')).toEqual({ ok: true, value: '2026-03-29T00:59:00.000Z' })
  })
})
