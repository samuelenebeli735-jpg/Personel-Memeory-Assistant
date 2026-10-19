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

export function formatRelative(isoString: string | null | undefined, timeZone: string): string {
  if (!isoString) return '—'
  try {
    const date = new Date(isoString)
    if (isNaN(date.getTime())) return '—'
    const now = new Date()
    const diffMs = date.getTime() - now.getTime()
    const diffMinutes = Math.round(diffMs / 60000)
    const diffHours = Math.round(diffMs / 3600000)
    const diffDays = Math.round(diffMs / 86400000)

    if (Math.abs(diffMinutes) < 60) {
      return diffMinutes >= 0 ? `in ${diffMinutes} min` : `${Math.abs(diffMinutes)} min ago`
    }
    if (Math.abs(diffHours) < 24) {
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

export function getTimeZone(): string {
  // In a real app, this would come from settings
  // For now, default to Africa/Lagos as per the backend default
  return 'Africa/Lagos'
}