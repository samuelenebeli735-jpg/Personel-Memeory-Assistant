import { describe, expect, it } from 'vitest'
import { searchQuerySchema } from '@recall/shared'

import { localDateTimeToUtcIso } from './date'

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
