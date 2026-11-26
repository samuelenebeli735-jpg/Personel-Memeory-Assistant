/**
 * Today page (R2-02) helpers: calendar dates (YYYY-MM-DD) in the Settings zone.
 * Pure, so they are unit tested without a browser.
 */
import { localDateKey } from './date'

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/

/** A real calendar date written as YYYY-MM-DD. */
export function isValidDateKey(value: string | null | undefined): value is string {
  if (!value) return false
  const match = DATE_KEY.exec(value)
  if (!match) return false
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
}

/** Calendar arithmetic only: no time zone can shift the result. */
export function addDays(dateKey: string, days: number): string {
  const match = DATE_KEY.exec(dateKey)
  if (!match) return dateKey
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days))
  return date.toISOString().slice(0, 10)
}

function calendarDate(dateKey: string): Date {
  const match = DATE_KEY.exec(dateKey)
  return new Date(Date.UTC(Number(match?.[1]), Number(match?.[2]) - 1, Number(match?.[3]), 12))
}

/** "Tuesday 24 November" (the year only when it is not the current one). */
export function longDateLabel(dateKey: string, todayKey: string): string {
  const sameYear = dateKey.slice(0, 4) === todayKey.slice(0, 4)
  // Built from parts so the label reads the same with or without the year.
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).formatToParts(calendarDate(dateKey))
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  const label = `${part('weekday')} ${part('day')} ${part('month')}`
  return sameYear ? label : `${label} ${part('year')}`
}

/** "Mon" */
export function shortDayLabel(dateKey: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short' }).format(calendarDate(dateKey))
}

/** 24-hour "09:30" in the zone. */
export function clockTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(
    new Date(iso),
  )
}

/**
 * What the time column shows: the time for items on the page's day, the
 * weekday for the coming week, and the date further out.
 */
export function timeColumnLabel(iso: string, dayKey: string, timeZone: string): string {
  const itemKey = localDateKey(new Date(iso), timeZone)
  if (itemKey === dayKey) return clockTime(iso, timeZone)
  const distance = Math.abs(
    (calendarDate(itemKey).getTime() - calendarDate(dayKey).getTime()) / 86_400_000,
  )
  if (distance <= 6) return shortDayLabel(itemKey)
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(
    calendarDate(itemKey),
  )
}

/** Where the "now" marker goes in a time-ordered list: before the first item not yet past. */
export function nowMarkerIndex(timestamps: string[], nowMs: number): number {
  const index = timestamps.findIndex((iso) => Date.parse(iso) >= nowMs)
  return index < 0 ? timestamps.length : index
}

/** Whole calendar days an item is overdue, in the zone. */
export function daysOverdue(iso: string, todayKey: string, timeZone: string): number {
  const itemKey = localDateKey(new Date(iso), timeZone)
  return Math.round((calendarDate(todayKey).getTime() - calendarDate(itemKey).getTime()) / 86_400_000)
}

export const EMPTY_SECTION_TEXT: Record<string, string> = {
  today: 'Nothing scheduled for this day.',
  overdue: 'Nothing overdue.',
  upcoming: 'Nothing coming up in the next 7 days.',
  ideas: 'No recent ideas.',
  deadlines: 'No deadlines coming up.',
}
