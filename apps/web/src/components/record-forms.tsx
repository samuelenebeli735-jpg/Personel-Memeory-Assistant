/**
 * One form per record type, used for both create and edit (R2-07, R2-04).
 *
 * Every form:
 * - runs on FormDialog (one submit path, busy button, unsaved-changes guard,
 *   writes paused offline);
 * - validates with the shared Zod schema the API uses, after converting times
 *   from the owner's Settings zone, and shows messages on the fields plus a
 *   summary, moving focus to the first invalid field;
 * - on a server error keeps everything typed, shows the safe message in the
 *   form and as an error toast, and maps 400 field details onto the fields;
 * - when editing, sends only the fields that changed (PATCH).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  eventCreateSchema,
  ideaCreateSchema,
  noteCreateSchema,
  projectCreateSchema,
  reminderCreateSchema,
  taskCreateSchema,
} from '@recall/shared'
import {
  eventsApi,
  ideasApi,
  notesApi,
  projectsApi,
  remindersApi,
  tasksApi,
  type EventDto,
  type IdeaDto,
  type NoteDto,
  type ProjectDto,
  type ReminderDto,
  type TaskDto,
} from '../lib/api'
import { describeError, fieldErrorsFrom } from '../lib/errors'
import { localDateTimeToUtcIso, utcIsoToLocalInput } from '../lib/date'
import { detailPath, type RecordDetailType } from '../lib/routes'
import { useTimeZone } from '../hooks/useTimeZone'
import { useToast } from '../hooks/useToast'
import { Input, Select, Textarea } from './ui'
import { FormDialog, type FieldError } from './patterns'

export type FormValues = Record<string, string>

type Option = { value: string; label: string }

export interface FieldSpec {
  name: string
  label: string
  kind: 'text' | 'textarea' | 'select' | 'datetime' | 'url' | 'project'
  options?: ReadonlyArray<Option>
  placeholder?: string
  rows?: number
  /** Shown under the field; datetime fields always name the Settings zone. */
  hint?: string
  /** Only shown when editing (for example a project's status). */
  editOnly?: boolean
}

type Conversion = { ok: true; input: Record<string, unknown> } | { ok: false; errors: Record<string, string> }

interface SafeParser {
  safeParse: (value: unknown) =>
    | { success: true }
    | { success: false; error: { issues: Array<{ path: Array<string | number>; message: string }> } }
}

export interface RecordFormSpec<R extends { id: string }> {
  /** Capitalised noun used in titles and toasts: "Task". */
  noun: string
  type: RecordDetailType
  fields: FieldSpec[]
  empty: FormValues
  fromRecord: (record: R, timeZone: string) => FormValues
  /** Required checks and Settings-zone time conversion; keys are API fields. */
  toInput: (values: FormValues, timeZone: string, original: R | null) => Conversion
  schema: SafeParser
  create: (input: Record<string, unknown>) => Promise<R>
  update: (id: string, patch: Record<string, unknown>) => Promise<R>
}

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                              */
/* -------------------------------------------------------------------------- */

const PRIORITY_OPTIONS: Option[] = [
  { value: '', label: 'None' },
  { value: 'LOW', label: 'Low' },
  { value: 'MEDIUM', label: 'Medium' },
  { value: 'HIGH', label: 'High' },
  { value: 'URGENT', label: 'Urgent' },
]

const RECURRENCE_OPTIONS: Option[] = [
  { value: '', label: 'None' },
  { value: 'DAILY', label: 'Daily' },
  { value: 'WEEKLY', label: 'Weekly' },
  { value: 'MONTHLY', label: 'Monthly' },
]

const PROJECT_STATUS_OPTIONS: Option[] = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'ARCHIVED', label: 'Archived' },
]

const orNull = (value: string | undefined): string | null => {
  const trimmed = (value ?? '').trim()
  return trimmed.length > 0 ? trimmed : null
}

function convertTime(
  values: FormValues,
  field: string,
  timeZone: string,
  errors: Record<string, string>,
  requiredMessage?: string,
): string | null {
  const raw = values[field] ?? ''
  if (!raw.trim()) {
    if (requiredMessage) errors[field] = requiredMessage
    return null
  }
  const converted = localDateTimeToUtcIso(raw, timeZone)
  if (!converted.ok) {
    errors[field] = converted.error
    return null
  }
  return converted.value
}

function done(input: Record<string, unknown>, errors: Record<string, string>): Conversion {
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, input }
}

/** Fields whose value differs from the original (edits send only these). */
export function changedFields(
  input: Record<string, unknown>,
  original: Record<string, unknown>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (JSON.stringify(value) !== JSON.stringify(original[key] ?? null)) patch[key] = value
  }
  return patch
}

/* -------------------------------------------------------------------------- */
/* Specs                                                                       */
/* -------------------------------------------------------------------------- */

export const taskFormSpec: RecordFormSpec<TaskDto> = {
  noun: 'Task',
  type: 'task',
  fields: [
    { name: 'title', label: 'Title', kind: 'text', placeholder: 'Task title' },
    { name: 'description', label: 'Description', kind: 'textarea', placeholder: 'Optional description', rows: 3 },
    { name: 'priority', label: 'Priority', kind: 'select', options: PRIORITY_OPTIONS },
    { name: 'dueAt', label: 'Due Date', kind: 'datetime', hint: 'Optional.' },
    { name: 'projectId', label: 'Project', kind: 'project' },
  ],
  empty: { title: '', description: '', priority: '', dueAt: '', projectId: '' },
  fromRecord: (task, tz) => ({
    title: task.title,
    description: task.description ?? '',
    priority: task.priority ?? '',
    dueAt: utcIsoToLocalInput(task.dueAt, tz),
    projectId: task.projectId ?? '',
  }),
  toInput: (values, tz) => {
    const errors: Record<string, string> = {}
    if (!values.title?.trim()) errors.title = 'Title is required'
    const dueAt = convertTime(values, 'dueAt', tz, errors)
    return done(
      {
        title: values.title?.trim() ?? '',
        description: orNull(values.description),
        priority: orNull(values.priority),
        dueAt,
        projectId: orNull(values.projectId),
      },
      errors,
    )
  },
  schema: taskCreateSchema,
  create: (input) => tasksApi.create(input as never),
  update: (id, patch) => tasksApi.update(id, patch as never),
}

export const noteFormSpec: RecordFormSpec<NoteDto> = {
  noun: 'Note',
  type: 'note',
  fields: [
    { name: 'title', label: 'Title (optional)', kind: 'text', placeholder: 'Note title' },
    { name: 'body', label: 'Body', kind: 'textarea', placeholder: 'Note content', rows: 4 },
    { name: 'url', label: 'URL (optional)', kind: 'url', placeholder: 'https://example.com' },
    { name: 'projectId', label: 'Project', kind: 'project' },
  ],
  empty: { title: '', body: '', url: '', projectId: '' },
  fromRecord: (note) => ({
    title: note.title ?? '',
    body: note.body,
    url: note.url ?? '',
    projectId: note.projectId ?? '',
  }),
  toInput: (values) => {
    const errors: Record<string, string> = {}
    if (!values.body?.trim()) errors.body = 'Body is required'
    return done(
      {
        title: orNull(values.title),
        body: values.body?.trim() ?? '',
        url: orNull(values.url),
        projectId: orNull(values.projectId),
      },
      errors,
    )
  },
  schema: noteCreateSchema,
  create: (input) => notesApi.create(input as never),
  update: (id, patch) => notesApi.update(id, patch as never),
}

export const ideaFormSpec: RecordFormSpec<IdeaDto> = {
  noun: 'Idea',
  type: 'idea',
  fields: [
    { name: 'title', label: 'Title', kind: 'text', placeholder: 'Idea title' },
    { name: 'body', label: 'Body (optional)', kind: 'textarea', placeholder: 'Details, context, links…', rows: 4 },
    { name: 'projectId', label: 'Project', kind: 'project' },
  ],
  empty: { title: '', body: '', projectId: '' },
  fromRecord: (idea) => ({ title: idea.title, body: idea.body ?? '', projectId: idea.projectId ?? '' }),
  toInput: (values) => {
    const errors: Record<string, string> = {}
    if (!values.title?.trim()) errors.title = 'Title is required'
    return done(
      { title: values.title?.trim() ?? '', body: orNull(values.body), projectId: orNull(values.projectId) },
      errors,
    )
  },
  schema: ideaCreateSchema,
  create: (input) => ideasApi.create(input as never),
  update: (id, patch) => ideasApi.update(id, patch as never),
}

export const eventFormSpec: RecordFormSpec<EventDto> = {
  noun: 'Event',
  type: 'event',
  fields: [
    { name: 'title', label: 'Title', kind: 'text', placeholder: 'Event title' },
    { name: 'description', label: 'Description (optional)', kind: 'textarea', placeholder: 'Details…', rows: 3 },
    { name: 'startsAt', label: 'Starts At', kind: 'datetime' },
    { name: 'endsAt', label: 'Ends At (optional)', kind: 'datetime' },
    { name: 'projectId', label: 'Project', kind: 'project' },
  ],
  empty: { title: '', description: '', startsAt: '', endsAt: '', projectId: '' },
  fromRecord: (event, tz) => ({
    title: event.title,
    description: event.description ?? '',
    startsAt: utcIsoToLocalInput(event.startsAt, tz),
    endsAt: utcIsoToLocalInput(event.endsAt, tz),
    projectId: event.projectId ?? '',
  }),
  toInput: (values, tz) => {
    const errors: Record<string, string> = {}
    if (!values.title?.trim()) errors.title = 'Title is required'
    const startsAt = convertTime(values, 'startsAt', tz, errors, 'Starts At is required')
    const endsAt = convertTime(values, 'endsAt', tz, errors)
    if (startsAt && endsAt && endsAt <= startsAt) errors.endsAt = 'Ends At must be after Starts At'
    return done(
      {
        title: values.title?.trim() ?? '',
        description: orNull(values.description),
        startsAt,
        endsAt,
        projectId: orNull(values.projectId),
      },
      errors,
    )
  },
  schema: eventCreateSchema,
  create: (input) => eventsApi.create(input as never),
  update: (id, patch) => eventsApi.update(id, patch as never),
}

export const projectFormSpec: RecordFormSpec<ProjectDto> = {
  noun: 'Project',
  type: 'project',
  fields: [
    { name: 'name', label: 'Name', kind: 'text', placeholder: 'Project name' },
    { name: 'description', label: 'Description (optional)', kind: 'textarea', placeholder: 'What is this project about?', rows: 3 },
    { name: 'status', label: 'Status', kind: 'select', options: PROJECT_STATUS_OPTIONS, editOnly: true },
  ],
  empty: { name: '', description: '', status: 'ACTIVE' },
  fromRecord: (project) => ({ name: project.name, description: project.description ?? '', status: project.status }),
  toInput: (values) => {
    const errors: Record<string, string> = {}
    if (!values.name?.trim()) errors.name = 'Name is required'
    return done(
      { name: values.name?.trim() ?? '', description: orNull(values.description), status: values.status || 'ACTIVE' },
      errors,
    )
  },
  schema: projectCreateSchema,
  create: (input) => projectsApi.create(input as never),
  update: (id, patch) => projectsApi.update(id, patch as never),
}

export const reminderFormSpec: RecordFormSpec<ReminderDto> = {
  noun: 'Reminder',
  type: 'reminder',
  fields: [
    { name: 'title', label: 'Title', kind: 'text', placeholder: 'Reminder title' },
    { name: 'body', label: 'Body (optional)', kind: 'textarea', placeholder: 'Optional details', rows: 3 },
    { name: 'remindAt', label: 'Remind At', kind: 'datetime' },
    { name: 'recurrence', label: 'Recurrence', kind: 'select', options: RECURRENCE_OPTIONS },
  ],
  empty: { title: '', body: '', remindAt: '', recurrence: '' },
  fromRecord: (reminder, tz) => ({
    title: reminder.title,
    body: reminder.body ?? '',
    remindAt: utcIsoToLocalInput(reminder.remindAt, tz),
    recurrence: reminder.recurrence?.frequency ?? '',
  }),
  toInput: (values, tz, original) => {
    const errors: Record<string, string> = {}
    if (!values.title?.trim()) errors.title = 'Title is required'
    // The wall-clock time is read in the owner's Settings zone, never the
    // browser's, so the reminder fires at the time the owner typed.
    const remindAt = convertTime(values, 'remindAt', tz, errors, 'Remind At is required')
    const frequency = values.recurrence ?? ''
    // Keeping the same frequency keeps the series' other settings unchanged.
    const recurrence = !frequency
      ? null
      : original?.recurrence && original.recurrence.frequency === frequency
        ? original.recurrence
        : { frequency, weekdays: [], until: null, maxOccurrences: frequency === 'MONTHLY' ? 24 : 52 }
    return done({ title: values.title?.trim() ?? '', body: orNull(values.body), remindAt, recurrence }, errors)
  },
  schema: reminderCreateSchema,
  create: (input) => remindersApi.create(input as never),
  update: (id, patch) => remindersApi.update(id, patch as never),
}

/* -------------------------------------------------------------------------- */
/* Project picker                                                              */
/* -------------------------------------------------------------------------- */

function useProjectOptions(active: boolean): { options: Option[]; failed: boolean } {
  const [projects, setProjects] = useState<ProjectDto[] | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!active || projects !== null) return
    let cancelled = false
    projectsApi
      .list({ limit: 200 })
      .then((page) => {
        if (!cancelled) setProjects(page.items)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [active, projects])
  const options = useMemo(
    () => [{ value: '', label: 'No project' }, ...(projects ?? []).map((p) => ({ value: p.id, label: p.name }))],
    [projects],
  )
  return { options, failed }
}

/* -------------------------------------------------------------------------- */
/* The dialog                                                                  */
/* -------------------------------------------------------------------------- */

export function RecordFormDialog<R extends { id: string }>({
  spec,
  open,
  record,
  onClose,
  onSaved,
}: {
  spec: RecordFormSpec<R>
  open: boolean
  /** Present when editing. */
  record?: R | null
  onClose: () => void
  onSaved: (saved: R, mode: 'create' | 'edit') => void
}) {
  const { timeZone } = useTimeZone()
  const { showToast } = useToast()
  const mode: 'create' | 'edit' = record ? 'edit' : 'create'
  const initial = useMemo(
    () => (record ? spec.fromRecord(record, timeZone) : spec.empty),
    // Re-derive when the dialog opens for a (possibly different) record.
    [record, open, timeZone],
  )
  const [values, setValues] = useState<FormValues>(initial)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [serverError, setServerError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const idPrefix = `${spec.type}-form`
  const fieldId = (name: string) => `${idPrefix}-${name}`
  const hasProjectField = spec.fields.some((f) => f.kind === 'project')
  const projects = useProjectOptions(open && hasProjectField)
  const errorFocusPending = useRef(false)

  useEffect(() => {
    if (open) {
      setValues(initial)
      setErrors({})
      setServerError(null)
    }
  }, [open, initial])

  useEffect(() => {
    if (!errorFocusPending.current) return
    errorFocusPending.current = false
    const first = spec.fields.find((f) => errors[f.name])
    if (first) document.getElementById(fieldId(first.name))?.focus()
  })

  const dirty = spec.fields.some((f) => (values[f.name] ?? '') !== (initial[f.name] ?? ''))

  const setField = (name: string, value: string) => {
    setValues((prev) => ({ ...prev, [name]: value }))
    if (errors[name]) setErrors((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== name)))
  }

  const submit = async () => {
    setServerError(null)
    const converted = spec.toInput(values, timeZone, record ?? null)
    let nextErrors: Record<string, string> = converted.ok ? {} : converted.errors
    if (converted.ok) {
      const parsed = spec.schema.safeParse(converted.input)
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          const key = String(issue.path[0] ?? '')
          if (key && spec.fields.some((f) => f.name === key) && !nextErrors[key]) {
            nextErrors = { ...nextErrors, [key]: issue.message }
          }
        }
      }
    }
    if (Object.keys(nextErrors).length > 0 || !converted.ok) {
      setErrors(nextErrors)
      errorFocusPending.current = true
      return
    }

    let payload = converted.input
    if (record) {
      const original = spec.toInput(spec.fromRecord(record, timeZone), timeZone, record)
      payload = original.ok ? changedFields(converted.input, original.input) : converted.input
      if (Object.keys(payload).length === 0) {
        onClose()
        return
      }
    }

    setBusy(true)
    try {
      const saved = record ? await spec.update(record.id, payload) : await spec.create(payload)
      showToast('success', `${spec.noun} ${record ? 'updated' : 'created'}`, undefined, {
        action: { label: `Open ${spec.noun.toLowerCase()}`, to: detailPath(spec.type, saved.id) },
      })
      onSaved(saved, mode)
    } catch (error) {
      const described = describeError(error, record ? `Saving the ${spec.noun.toLowerCase()}` : `Creating the ${spec.noun.toLowerCase()}`, true)
      const fieldErrors = fieldErrorsFrom(error)
      const known = Object.fromEntries(Object.entries(fieldErrors).filter(([k]) => spec.fields.some((f) => f.name === k)))
      if (Object.keys(known).length > 0) {
        setErrors(known)
        errorFocusPending.current = true
      }
      setServerError(`${described.message} Your text is still in the form.`)
      showToast(described.retryAfter !== undefined ? 'warning' : 'error', `${spec.noun} not saved`, described.message)
    } finally {
      setBusy(false)
    }
  }

  const summary: FieldError[] = spec.fields
    .filter((f) => errors[f.name])
    .map((f) => ({ fieldId: fieldId(f.name), message: errors[f.name] as string }))

  return (
    <FormDialog
      open={open}
      title={`${mode === 'create' ? 'Create' : 'Edit'} ${spec.noun}`}
      submitLabel={mode === 'create' ? `Create ${spec.noun}` : 'Save changes'}
      dirty={dirty}
      busy={busy}
      errors={summary}
      serverError={serverError}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
      {spec.fields
        .filter((field) => !field.editOnly || mode === 'edit')
        .map((field) => {
          const common = {
            id: fieldId(field.name),
            label: field.label,
            value: values[field.name] ?? '',
            error: errors[field.name],
          }
          switch (field.kind) {
            case 'textarea':
              return (
                <Textarea
                  key={field.name}
                  {...common}
                  rows={field.rows ?? 3}
                  placeholder={field.placeholder}
                  hint={field.hint}
                  onChange={(e) => setField(field.name, e.target.value)}
                />
              )
            case 'select':
              return (
                <Select
                  key={field.name}
                  {...common}
                  options={[...(field.options ?? [])]}
                  hint={field.hint}
                  onChange={(e) => setField(field.name, e.target.value)}
                />
              )
            case 'project':
              return (
                <Select
                  key={field.name}
                  {...common}
                  options={projects.options}
                  hint={projects.failed ? 'Projects couldn’t be loaded; the item will be saved without one.' : undefined}
                  onChange={(e) => setField(field.name, e.target.value)}
                />
              )
            case 'datetime':
              return (
                <Input
                  key={field.name}
                  {...common}
                  type="datetime-local"
                  hint={`${field.hint ? `${field.hint} ` : ''}Time zone: ${timeZone}`}
                  onChange={(e) => setField(field.name, e.target.value)}
                />
              )
            default:
              return (
                <Input
                  key={field.name}
                  {...common}
                  type={field.kind === 'url' ? 'url' : 'text'}
                  placeholder={field.placeholder}
                  hint={field.hint}
                  onChange={(e) => setField(field.name, e.target.value)}
                />
              )
          }
        })}
    </FormDialog>
  )
}
