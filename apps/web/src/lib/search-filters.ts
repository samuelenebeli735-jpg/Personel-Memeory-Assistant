import {
  SEARCH_ENTITY_TYPES,
  TASK_STATUSES,
  type SearchEntityType,
  type TaskStatus,
} from '@recall/shared'

export const SEARCH_TYPE_LABELS: Record<SearchEntityType, string> = {
  TASK: 'Tasks',
  NOTE: 'Notes',
  IDEA: 'Ideas',
  EVENT: 'Events',
  CAPTURE: 'Captures',
  PROJECT: 'Projects',
  REMINDER: 'Reminders',
}

export const SEARCH_TYPE_OPTIONS: { value: SearchEntityType; label: string }[] =
  SEARCH_ENTITY_TYPES.map((value) => ({ value, label: SEARCH_TYPE_LABELS[value] }))

/**
 * Keeps only genuine supported search types, removes blanks and duplicates, and
 * preserves the order the operator selected. Used for both URL state and the
 * native multi-select.
 */
export function parseSearchTypes(values: readonly string[]): SearchEntityType[] {
  const allowed = new Set<string>(SEARCH_ENTITY_TYPES)
  const seen = new Set<string>()
  const result: SearchEntityType[] = []
  for (const value of values) {
    if (!allowed.has(value) || seen.has(value)) continue
    seen.add(value)
    result.push(value as SearchEntityType)
  }
  return result
}

export function selectedSearchTypes(
  selected: ArrayLike<{ value: string }>,
): SearchEntityType[] {
  return parseSearchTypes(Array.from(selected, (option) => option.value))
}

const SEARCH_STATUS_LABELS: Record<TaskStatus, string> = {
  PENDING: 'Pending',
  IN_PROGRESS: 'In Progress',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
}

/**
 * Search status is a task-only filter. Reminder and delivery statuses
 * (SCHEDULED, SENT, FAILED, MISSED) belong to other resources and are not part
 * of the shared search contract.
 */
export const SEARCH_STATUS_OPTIONS: { value: TaskStatus; label: string }[] =
  TASK_STATUSES.map((value) => ({ value, label: SEARCH_STATUS_LABELS[value] }))

/** Returns '' for a blank or unsupported value so it can never reach the API. */
export function parseSearchStatus(value: string | null): TaskStatus | '' {
  if (!value) return ''
  return (TASK_STATUSES as readonly string[]).includes(value) ? (value as TaskStatus) : ''
}

/**
 * Status can be offered for "all types" (where it narrows to tasks) or when
 * tasks are explicitly selected. It is disabled for a selection that cannot
 * contain a task.
 */
export function canFilterByStatus(types: readonly SearchEntityType[]): boolean {
  return types.length === 0 || types.includes('TASK')
}
