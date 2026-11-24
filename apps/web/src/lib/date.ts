/**
 * Date formatting utilities for the dashboard.
 * The backend returns UTC ISO-8601 strings; we convert to the user's configured timezone.
 */

export function formatLocalDateTime(isoString: string | null | undefined, timeZone: string): string {
  if (!isoString) return '—'
  try {
    const date = new Date(isoString)
    if (isNaN(date.getTime())) return '—'
    return new Intl.DateTimeFormat(undefined, {
      timeZone,
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(date)
  } catch {
    return '—'
  }
}

export function formatLocalDate(isoString: string | null | undefined, timeZone: string): string {
  if (!isoString) return '—'
  try {
    const date = new Date(isoString)
    if (isNaN(date.getTime())) return '—'
    return new Intl.DateTimeFormat(undefined, {
      timeZone,
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }).format(date)
  } catch {
    return '—'
  }
}

export function formatLocalTime(isoString: string | null | undefined, timeZone: string): string {
  if (!isoString) return '—'
  try {
    const date = new Date(isoString)
    if (isNaN(date.getTime())) return '—'
    return new Intl.DateTimeFormat(undefined, {
      timeZone,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(date)
  } catch {
    return '—'
  }
}

export function formatRelative(
  isoString: string | null | undefined,
  timeZone: string,
  now: Date = new Date(),
): string {
  if (!isoString) return '—'
  try {
    const date = new Date(isoString)
    if (isNaN(date.getTime())) return '—'
    const diffMs = date.getTime() - now.getTime()
    const diffMinutes = Math.round(diffMs / 60000)
    const diffHours = Math.round(diffMs / 3600000)
    // "Today", "tomorrow" and weekday names are calendar dates in the owner's
    // zone, not rounded 24-hour periods: 23:00 Monday to 05:00 Wednesday is
    // 30 hours, but it is Wednesday, not "tomorrow".
    const diffDays = calendarDayDifference(now, date, timeZone)

    if (Math.abs(diffMinutes) < 60) {
      return diffMinutes >= 0 ? `in ${diffMinutes} min` : `${Math.abs(diffMinutes)} min ago`
    }
    if (Math.abs(diffHours) < 24 && diffDays === 0) {
      return diffHours >= 0 ? `in ${diffHours} hr` : `${Math.abs(diffHours)} hr ago`
    }
    if (diffDays === 0) {
      return `today at ${formatLocalTime(isoString, timeZone)}`
    }
    if (diffDays === 1) {
      return `tomorrow at ${formatLocalTime(isoString, timeZone)}`
    }
    if (diffDays === -1) {
      return `yesterday at ${formatLocalTime(isoString, timeZone)}`
    }
    if (Math.abs(diffDays) < 7) {
      const dayName = new Intl.DateTimeFormat(undefined, {
        timeZone,
        weekday: 'long',
      }).format(new Date(isoString))
      return diffDays > 0
        ? `${dayName} at ${formatLocalTime(isoString, timeZone)}`
        : `last ${dayName} at ${formatLocalTime(isoString, timeZone)}`
    }
    return formatLocalDateTime(isoString, timeZone)
  } catch {
    return '—'
  }
}

export function isOverdue(isoString: string | null | undefined): boolean {
  if (!isoString) return false
  try {
    return new Date(isoString).getTime() < Date.now()
  } catch {
    return false
  }
}

/** True when the runtime knows this IANA zone. */
export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== 'string' || timeZone.trim().length === 0) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

/** The zone the browser reports, or UTC when it reports none. */
export function browserTimeZone(): string {
  try {
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone
    return isValidTimeZone(zone) ? zone : 'UTC'
  } catch {
    return 'UTC'
  }
}

export interface DisplayZone {
  timeZone: string
  /** `settings` when the owner's configured zone is in use. */
  source: 'settings' | 'browser'
}

/**
 * The dashboard's single time-zone decision.
 *
 * The owner's Settings zone always wins. Only when it is unavailable (the
 * settings request failed) or unusable does the dashboard fall back to the
 * browser's zone, and it says so (`source: 'browser'`) so the page can tell
 * the owner. No particular zone is ever assumed.
 */
export function resolveDisplayZone(settingsZone: unknown, fallback: string = browserTimeZone()): DisplayZone {
  if (isValidTimeZone(settingsZone)) return { timeZone: settingsZone, source: 'settings' }
  return { timeZone: isValidTimeZone(fallback) ? fallback : 'UTC', source: 'browser' }
}

/** `YYYY-MM-DD` of an instant in a zone. */
export function localDateKey(date: Date, timeZone: string): string {
  const parts = partsInTimeZone(date, timeZone)
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

/**
 * The UTC instant of a wall-clock time `dayOffset` local calendar days from
 * `now`, in `timeZone` ("tomorrow at 09:00"). Calendar arithmetic is done on
 * the local date, so a DST change between now and then cannot shift the hour.
 */
export function localDayAtTime(
  now: Date,
  timeZone: string,
  dayOffset: number,
  hhmm: string,
): string | null {
  const [y, m, d] = localDateKey(now, timeZone).split('-').map(Number) as [number, number, number]
  const target = new Date(Date.UTC(y, m - 1, d + dayOffset))
  const key = target.toISOString().slice(0, 10)
  const converted = localDateTimeToUtcIso(`${key}T${hhmm}`, timeZone)
  return converted.ok ? converted.value : null
}

/**
 * Whole calendar days from `from` to `to` in a zone: 0 for the same local
 * date, 1 for the next local date. A DST change never shifts the result,
 * because only the local dates are compared.
 */
export function calendarDayDifference(from: Date, to: Date, timeZone: string): number {
  const toUtcMidnight = (key: string) => {
    const [y, m, d] = key.split('-').map(Number) as [number, number, number]
    return Date.UTC(y, m - 1, d)
  }
  return Math.round((toUtcMidnight(localDateKey(to, timeZone)) - toUtcMidnight(localDateKey(from, timeZone))) / 86_400_000)
}

export type LocalDateTimeConversion =
  | { ok: true; value: string | null }
  | { ok: false; error: string }

const LOCAL_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/

interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function partsInTimeZone(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date)

  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type)
    if (!part) throw new Error(`Missing ${type} while reading ${timeZone}`)
    return Number(part.value)
  }

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  }
}

/** Offset of a time zone at an instant, in milliseconds east of UTC. */
function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = partsInTimeZone(date, timeZone)
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  )
  // Intl has second precision, so ignore the instant's milliseconds.
  return asUtc - (date.getTime() - date.getUTCMilliseconds())
}

/**
 * Converts a `<input type="datetime-local">` value (a wall-clock time with no
 * offset) into the UTC ISO-8601 timestamp the search API requires.
 *
 * The value is interpreted in `timeZone`, matching how the dashboard displays
 * dates, rather than in the browser's local zone. It is never enough to append
 * `Z`: that would silently shift the selected time whenever the two zones
 * differ. Empty input is valid and serializes to `null`; malformed input is
 * rejected so the caller does not send a request the API will refuse.
 */
export function localDateTimeToUtcIso(
  value: string,
  timeZone: string,
): LocalDateTimeConversion {
  const input = value.trim()
  if (input.length === 0) return { ok: true, value: null }

  const match = LOCAL_DATE_TIME_PATTERN.exec(input)
  if (!match) return { ok: false, error: 'Enter a valid local date and time.' }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = match[6] ? Number(match[6]) : 0
  const millisecond = match[7] ? Number(match[7].padEnd(3, '0')) : 0

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return { ok: false, error: 'Enter a valid local date and time.' }
  }

  const wallClockAsUtc = Date.UTC(year, month - 1, day, hour, minute, second, millisecond)
  const normalized = new Date(wallClockAsUtc)
  if (
    normalized.getUTCFullYear() !== year ||
    normalized.getUTCMonth() !== month - 1 ||
    normalized.getUTCDate() !== day ||
    normalized.getUTCHours() !== hour ||
    normalized.getUTCMinutes() !== minute ||
    normalized.getUTCSeconds() !== second
  ) {
    return { ok: false, error: 'Enter a valid local date and time.' }
  }

  try {
    // A wall-clock time can map to two instants around a DST transition. Use the
    // offset at the guessed instant, then re-check with the candidate instant so
    // ordinary dates settle after one adjustment. A nonexistent local time (the
    // spring-forward gap) fails the round-trip check below.
    const firstOffset = timeZoneOffsetMs(normalized, timeZone)
    let utcMillis = wallClockAsUtc - firstOffset
    const secondOffset = timeZoneOffsetMs(new Date(utcMillis), timeZone)
    if (secondOffset !== firstOffset) {
      utcMillis = wallClockAsUtc - secondOffset
    }

    const result = new Date(utcMillis)
    const roundTrip = partsInTimeZone(result, timeZone)
    if (
      roundTrip.year !== year ||
      roundTrip.month !== month ||
      roundTrip.day !== day ||
      roundTrip.hour !== hour ||
      roundTrip.minute !== minute ||
      roundTrip.second !== second
    ) {
      return { ok: false, error: 'That local time does not exist in the configured time zone.' }
    }

    return { ok: true, value: result.toISOString() }
  } catch {
    return { ok: false, error: 'The configured time zone is not supported.' }
  }
}
/**
 * The inverse of `localDateTimeToUtcIso`: shows a stored UTC instant as the
 * `YYYY-MM-DDTHH:mm` wall-clock value a `datetime-local` field expects, in
 * the owner's Settings zone (used to pre-fill edit forms). Empty for null.
 */
export function utcIsoToLocalInput(isoString: string | null | undefined, timeZone: string): string {
  if (!isoString) return ''
  const date = new Date(isoString)
  if (Number.isNaN(date.getTime())) return ''
  try {
    const parts = partsInTimeZone(date, timeZone)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`
  } catch {
    return ''
  }
}
