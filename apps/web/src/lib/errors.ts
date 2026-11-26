/**
 * One mapping from any failure to what the user is told (R2-07).
 *
 * Every message says what happened and what to do next; none of them reveal
 * more than the server's safe message and error code.
 */
import { ApiError } from './api'

export interface ErrorDescription {
  title: string
  message: string
  /** Shown for support; never contains personal data. */
  code?: string
  /** Seconds to wait before trying again (429). */
  retryAfter?: number
  /** True when nothing reached the server, so the user's input is unaffected. */
  notSent?: boolean
}

/**
 * `action` names what failed, e.g. "Saving the task" or "Loading tasks".
 * `isWrite` changes the timeout wording: a write that timed out may still have
 * been applied, so the user is asked to check before trying again.
 */
export function describeError(error: unknown, action: string, isWrite = false): ErrorDescription {
  if (error instanceof ApiError) {
    if (error.kind === 'network') {
      return {
        title: `${action} failed`,
        message: 'Can’t reach Recall. Check your connection, then try again.',
        code: error.code,
        notSent: true,
      }
    }
    if (error.kind === 'timeout') {
      return {
        title: `${action} is taking too long`,
        message: isWrite
          ? 'Recall didn’t answer in time. It may still have finished: check before trying again.'
          : 'Recall didn’t answer in time. Try again.',
        code: error.code,
      }
    }
    if (error.status === 429) {
      const wait = error.retryAfter ?? undefined
      return {
        title: 'Too many requests',
        message: wait !== undefined ? `Try again in ${wait} s.` : 'Wait a moment, then try again.',
        code: error.code,
        retryAfter: wait,
      }
    }
    if (error.status >= 500) {
      return {
        title: `${action} failed`,
        message: `The server had a problem (${error.code}). Try again.`,
        code: error.code,
      }
    }
    return { title: `${action} failed`, message: error.message, code: error.code }
  }
  return {
    title: `${action} failed`,
    message: error instanceof Error && error.message ? error.message : 'Something went wrong. Try again.',
  }
}

/** Field-level messages from a 400 VALIDATION_ERROR, keyed by the first path segment. */
export function fieldErrorsFrom(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError) || error.status !== 400) return {}
  const details = error.details as { issues?: Array<{ path?: string; message?: string }> } | Array<{ path?: string; message?: string }> | undefined
  const issues = Array.isArray(details) ? details : details?.issues
  const result: Record<string, string> = {}
  for (const issue of issues ?? []) {
    const key = (issue.path ?? '').split('.')[0]
    if (key && issue.message && !(key in result)) result[key] = issue.message
  }
  return result
}
