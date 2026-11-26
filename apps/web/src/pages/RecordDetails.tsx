/**
 * Record detail pages.
 *
 * These render only fields that are already part of the public DTO. Capture
 * provider metadata, retained-audio paths and classification-cache fields never
 * reach the browser, and the capture page additionally avoids showing the
 * internal voice placeholder as if it were user content.
 */
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useToast } from "../hooks/useToast";
import {
  capturesApi,
  eventsApi,
  ideasApi,
  notesApi,
  projectsApi,
  remindersApi,
  tasksApi,
  type CaptureDto,
  type EventDto,
  type IdeaDto,
  type NoteDto,
  type ProjectDto,
  type ReminderDto,
  type TaskDto,
} from "../lib/api";
import { captureContent, captureDisplayTitle } from "../lib/capture-content";
import { formatLocalDateTime } from "../lib/date";
import { useTimeZone } from "../hooks/useTimeZone";
import {
  APP_PATHS,
  DETAIL_BACK_LINKS,
  detailPath,
  type RecordDetailType,
} from "../lib/routes";
import { Badge, Button, Card, EmptyState } from "../components/ui";
import { DetailActions, EditableDetail, type DeleteCopy } from "../components/EditableDetail";
import {
  eventFormSpec,
  ideaFormSpec,
  noteFormSpec,
  projectFormSpec,
  reminderFormSpec,
  taskFormSpec,
} from "../components/record-forms";
import { useOnline } from "../hooks/useOnline";
import { describeError } from "../lib/errors";
import { CaptureIcon } from "../components/Layout";
import {
  DetailField,
  DetailPageShell,
  DetailTags,
  DetailText,
  useRecordDetail,
} from "../components/detail";

const CAPTURE_LINK_TYPES: Record<
  "TASK" | "NOTE" | "IDEA" | "EVENT",
  RecordDetailType
> = {
  TASK: "task",
  NOTE: "note",
  IDEA: "idea",
  EVENT: "event",
};

function DetailHeading({
  eyebrow,
  title,
  badges,
}: {
  eyebrow: string;
  title: string;
  badges?: ReactNode;
}) {
  return (
    <div style={{ marginBottom: "20px" }}>
      <div
        style={{
          fontSize: "13px",
          color: "var(--color-text-muted)",
          marginBottom: "6px",
        }}
      >
        {eyebrow}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "12px",
          flexWrap: "wrap",
        }}
      >
        <h1 style={{ fontSize: "24px", fontWeight: "600", margin: 0 }}>
          {title}
        </h1>
        {badges}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="detail-section">
      <h2 className="detail-section-title">{title}</h2>
      {children}
    </div>
  );
}

function statusBadge(status: string) {
  const variant =
    status === "COMPLETED" || status === "SENT"
      ? "success"
      : status === "IN_PROGRESS" || status === "SCHEDULED"
        ? "primary"
        : status === "FAILED" || status === "CANCELLED" || status === "DELETED"
          ? "danger"
          : status === "NEEDS_REVIEW" ||
              status === "MISSED" ||
              status === "ARCHIVED"
            ? "warning"
            : "muted";
  return <Badge variant={variant}>{status}</Badge>;
}

function captureLink(id: string | null) {
  return id ? (
    <Link to={detailPath("capture", id)}>View capture</Link>
  ) : (
    <span className="detail-muted">None</span>
  );
}

function taskLink(id: string | null) {
  return id ? (
    <Link to={detailPath("task", id)}>View task</Link>
  ) : (
    <span className="detail-muted">None</span>
  );
}

/* -------------------------------------------------------------------------- */
/* Capture                                                                     */
/* -------------------------------------------------------------------------- */

export function CaptureDetailView({
  capture,
  timeZone,
}: {
  capture: CaptureDto;
  timeZone: string;
}) {
  const content = captureContent(capture);

  return (
    <div>
      <DetailHeading
        eyebrow="Capture"
        title={captureDisplayTitle(capture)}
        badges={
          <>
            <Badge variant="muted">{capture.kind}</Badge>
            {statusBadge(capture.status)}
            {capture.isVoice && <Badge variant="primary">voice</Badge>}
            {capture.needsReview && (
              <Badge variant="warning">needs review</Badge>
            )}
          </>
        }
      />

      <Card>
        <div className="detail-section">
          <h2 className="detail-section-title">Content</h2>
          {content.kind === "transcript" ? (
            <>
              {content.caption && (
                <div style={{ marginBottom: "16px" }}>
                  <div className="detail-field-label">Caption</div>
                  <DetailText>{content.caption}</DetailText>
                </div>
              )}
              <div className="detail-field-label">
                {content.transcriptLabel}
              </div>
              <DetailText>{content.transcript}</DetailText>
            </>
          ) : content.kind === "caption-only" ? (
            <>
              <div className="detail-field-label">Caption</div>
              <DetailText>{content.caption}</DetailText>
              <div className="detail-notice" role="status">
                Transcript unavailable — this voice message was not transcribed.
              </div>
            </>
          ) : content.kind === "unavailable" ? (
            <div className="detail-notice" role="status">
              Transcript unavailable — this voice message was not transcribed.
            </div>
          ) : (
            <>
              <div className="detail-field-label">Captured text</div>
              <DetailText>{content.text}</DetailText>
            </>
          )}
        </div>

        <div className="detail-section">
          <h2 className="detail-section-title">Details</h2>
          <div className="detail-grid">
            <DetailField label="Captured">
              {formatLocalDateTime(capture.capturedAt, timeZone)}
            </DetailField>
            <DetailField label="Processed">
              {formatLocalDateTime(capture.processedAt, timeZone)}
            </DetailField>
            <DetailField label="Source">{capture.source}</DetailField>
            <DetailField label="Confidence">{`${Math.round(capture.confidence * 100)}%`}</DetailField>
            <DetailField label="Tags">
              <DetailTags tags={capture.tags} />
            </DetailField>
          </div>
        </div>

        <div className="detail-section">
          <h2 className="detail-section-title">Derived records</h2>
          {capture.links.length === 0 ? (
            <span className="detail-muted">
              No structured records were created from this capture.
            </span>
          ) : (
            <div className="list" style={{ gap: "8px" }}>
              {capture.links.map((link) => (
                <Link
                  key={`${link.type}:${link.id}`}
                  to={detailPath(CAPTURE_LINK_TYPES[link.type], link.id)}
                  className="list-item"
                  style={{ textDecoration: "none", color: "inherit" }}
                >
                  <div className="list-item-content">
                    <div className="list-item-title">{link.title}</div>
                    <div className="list-item-meta">
                      <Badge variant="muted">{link.type}</Badge>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Tasks                                                                       */
/* -------------------------------------------------------------------------- */

export function TaskDetailView({
  task,
  timeZone,
  actions,
}: {
  task: TaskDto;
  timeZone: string;
  actions?: ReactNode;
}) {
  return (
    <div>
      <DetailHeading
        eyebrow="Task"
        title={task.title}
        badges={
          <>
            {statusBadge(task.status)}
            {task.priority && <Badge variant="muted">{task.priority}</Badge>}
          </>
        }
      />
      <DetailActions>{actions}</DetailActions>
      <Card>
        <Section title="Description">
          {task.description ? (
            <DetailText>{task.description}</DetailText>
          ) : (
            <span className="detail-muted">No description.</span>
          )}
        </Section>
        <Section title="Details">
          <div className="detail-grid">
            <DetailField label="Due">
              {formatLocalDateTime(task.dueAt, timeZone)}
            </DetailField>
            <DetailField label="Project">
              {task.projectName || "None"}
            </DetailField>
            <DetailField label="Completed">
              {formatLocalDateTime(task.completedAt, timeZone)}
            </DetailField>
            <DetailField label="Cancelled">
              {formatLocalDateTime(task.cancelledAt, timeZone)}
            </DetailField>
            <DetailField label="Created">
              {formatLocalDateTime(task.createdAt, timeZone)}
            </DetailField>
            <DetailField label="Updated">
              {formatLocalDateTime(task.updatedAt, timeZone)}
            </DetailField>
            <DetailField label="Source capture">
              {captureLink(task.captureId)}
            </DetailField>
            <DetailField label="Tags">
              <DetailTags tags={task.tags} />
            </DetailField>
          </div>
        </Section>
      </Card>
    </div>
  );
}

/* Delete confirmations name the record and say what happens (R2-04, D3). */

const CANT_UNDO = <p>This can’t be undone.</p>;

function taskDeleteCopy(task: TaskDto): DeleteCopy {
  return {
    title: `Delete task “${task.title}”?`,
    body: (
      <>
        <p>
          This permanently deletes the task and any reminders set for it.
          {task.captureId ? " The capture it came from stays." : ""}
        </p>
        {CANT_UNDO}
      </>
    ),
    confirmLabel: "Delete task",
    cancelLabel: "Keep task",
  };
}

function reminderDeleteCopy(reminder: ReminderDto): DeleteCopy {
  return {
    title: `Delete reminder “${reminder.title}”?`,
    body: (
      <>
        <p>
          {reminder.recurrence
            ? "This permanently deletes the reminder, its delivery history and every later reminder in its series."
            : "This permanently deletes the reminder and its delivery history."}{" "}
          To stop it but keep the record, cancel it from the Reminders list instead.
        </p>
        {CANT_UNDO}
      </>
    ),
    confirmLabel: "Delete reminder",
    cancelLabel: "Keep reminder",
  };
}

function simpleDeleteCopy(noun: string, title: string, extra?: string): DeleteCopy {
  return {
    title: `Delete ${noun} “${title}”?`,
    body: (
      <>
        <p>
          This permanently deletes the {noun}.{extra ? ` ${extra}` : ""}
        </p>
        {CANT_UNDO}
      </>
    ),
    confirmLabel: `Delete ${noun}`,
    cancelLabel: `Keep ${noun}`,
  };
}

function projectDeleteCopy(project: ProjectDto): DeleteCopy {
  const items = project.counts.tasks + project.counts.notes + project.counts.ideas + project.counts.events;
  return {
    title: `Delete project “${project.name}”?`,
    body: (
      <>
        <p>
          {items === 0
            ? "The project has no tasks, notes, ideas or events."
            : `${items} ${items === 1 ? "item" : "items"} (tasks, notes, ideas and events) stay, but are no longer in a project.`}
        </p>
        {CANT_UNDO}
      </>
    ),
    confirmLabel: "Delete project",
    cancelLabel: "Keep project",
  };
}

/** Idea → task: the idea is kept; the toast links to the new task. */
function PromoteIdeaButton({ idea }: { idea: IdeaDto }) {
  const { showToast } = useToast();
  const { online } = useOnline();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="secondary"
      loading={busy}
      disabled={!online}
      onClick={async () => {
        setBusy(true);
        try {
          const result = await ideasApi.promote(idea.id);
          showToast("success", "Task created from idea", idea.title, {
            action: { label: "Open task", to: detailPath("task", result.taskId) },
          });
        } catch (error) {
          showToast("error", "Task not created", describeError(error, "Making a task", true).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      Make it a task
    </Button>
  );
}

/* -------------------------------------------------------------------------- */
/* Reminders                                                                   */
/* -------------------------------------------------------------------------- */

export function ReminderDetailView({
  reminder,
  timeZone,
  actions,
}: {
  reminder: ReminderDto;
  timeZone: string;
  actions?: ReactNode;
}) {
  return (
    <div>
      <DetailHeading
        eyebrow="Reminder"
        title={reminder.title}
        badges={statusBadge(reminder.status)}
      />
      <DetailActions>{actions}</DetailActions>
      <Card>
        <Section title="Body">
          {reminder.body ? (
            <DetailText>{reminder.body}</DetailText>
          ) : (
            <span className="detail-muted">No body.</span>
          )}
        </Section>
        <Section title="Details">
          <div className="detail-grid">
            <DetailField label="Remind at">
              {formatLocalDateTime(reminder.remindAt, timeZone)}
            </DetailField>
            <DetailField label="Recurrence">
              {reminder.recurrence?.frequency ?? "None"}
            </DetailField>
            <DetailField label="Delivery attempts">
              {reminder.attempts}
            </DetailField>
            <DetailField label="Delivered">
              {formatLocalDateTime(reminder.deliveredAt, timeZone)}
            </DetailField>
            <DetailField label="Created">
              {formatLocalDateTime(reminder.createdAt, timeZone)}
            </DetailField>
            <DetailField label="Task">{taskLink(reminder.taskId)}</DetailField>
            <DetailField label="Capture">
              {captureLink(reminder.captureId)}
            </DetailField>
          </div>
        </Section>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Notes, ideas, events, projects                                              */
/* -------------------------------------------------------------------------- */

export function NoteDetailView({
  note,
  timeZone,
  actions,
}: {
  note: NoteDto;
  timeZone: string;
  actions?: ReactNode;
}) {
  return (
    <div>
      <DetailHeading eyebrow="Note" title={note.title || "Untitled note"} />
      <DetailActions>{actions}</DetailActions>
      <Card>
        <Section title="Body">
          <DetailText>{note.body}</DetailText>
        </Section>
        <Section title="Details">
          <div className="detail-grid">
            <DetailField label="URL">
              {note.url ? (
                <a href={note.url} target="_blank" rel="noopener noreferrer">
                  {note.url}
                </a>
              ) : (
                <span className="detail-muted">None</span>
              )}
            </DetailField>
            <DetailField label="Project">
              {note.projectName || "None"}
            </DetailField>
            <DetailField label="Created">
              {formatLocalDateTime(note.createdAt, timeZone)}
            </DetailField>
            <DetailField label="Updated">
              {formatLocalDateTime(note.updatedAt, timeZone)}
            </DetailField>
            <DetailField label="Source capture">
              {captureLink(note.captureId)}
            </DetailField>
            <DetailField label="Tags">
              <DetailTags tags={note.tags} />
            </DetailField>
          </div>
        </Section>
      </Card>
    </div>
  );
}

export function IdeaDetailView({
  idea,
  timeZone,
  actions,
}: {
  idea: IdeaDto;
  timeZone: string;
  actions?: ReactNode;
}) {
  return (
    <div>
      <DetailHeading eyebrow="Idea" title={idea.title} />
      <DetailActions>{actions}</DetailActions>
      <Card>
        <Section title="Body">
          {idea.body ? (
            <DetailText>{idea.body}</DetailText>
          ) : (
            <span className="detail-muted">No body.</span>
          )}
        </Section>
        <Section title="Details">
          <div className="detail-grid">
            <DetailField label="Project">
              {idea.projectName || "None"}
            </DetailField>
            <DetailField label="Created">
              {formatLocalDateTime(idea.createdAt, timeZone)}
            </DetailField>
            <DetailField label="Updated">
              {formatLocalDateTime(idea.updatedAt, timeZone)}
            </DetailField>
            <DetailField label="Source capture">
              {captureLink(idea.captureId)}
            </DetailField>
            <DetailField label="Tags">
              <DetailTags tags={idea.tags} />
            </DetailField>
          </div>
        </Section>
      </Card>
    </div>
  );
}

export function EventDetailView({
  event,
  timeZone,
  actions,
}: {
  event: EventDto;
  timeZone: string;
  actions?: ReactNode;
}) {
  return (
    <div>
      <DetailHeading eyebrow="Event" title={event.title} />
      <DetailActions>{actions}</DetailActions>
      <Card>
        <Section title="Description">
          {event.description ? (
            <DetailText>{event.description}</DetailText>
          ) : (
            <span className="detail-muted">No description.</span>
          )}
        </Section>
        <Section title="Details">
          <div className="detail-grid">
            <DetailField label="Starts">
              {formatLocalDateTime(event.startsAt, timeZone)}
            </DetailField>
            <DetailField label="Ends">
              {formatLocalDateTime(event.endsAt, timeZone)}
            </DetailField>
            <DetailField label="Project">
              {event.projectName || "None"}
            </DetailField>
            <DetailField label="Created">
              {formatLocalDateTime(event.createdAt, timeZone)}
            </DetailField>
            <DetailField label="Source capture">
              {captureLink(event.captureId)}
            </DetailField>
          </div>
        </Section>
      </Card>
    </div>
  );
}

export function ProjectDetailView({
  project,
  timeZone,
  actions,
}: {
  project: ProjectDto;
  timeZone: string;
  actions?: ReactNode;
}) {
  return (
    <div>
      <DetailHeading
        eyebrow="Project"
        title={project.name}
        badges={statusBadge(project.status)}
      />
      <DetailActions>{actions}</DetailActions>
      <Card>
        <Section title="Description">
          {project.description ? (
            <DetailText>{project.description}</DetailText>
          ) : (
            <span className="detail-muted">No description.</span>
          )}
        </Section>
        <Section title="Details">
          <div className="detail-grid">
            <DetailField label="Open tasks">
              {project.counts.openTasks}
            </DetailField>
            <DetailField label="All tasks">{project.counts.tasks}</DetailField>
            <DetailField label="Notes">{project.counts.notes}</DetailField>
            <DetailField label="Ideas">{project.counts.ideas}</DetailField>
            <DetailField label="Events">{project.counts.events}</DetailField>
            <DetailField label="Created">
              {formatLocalDateTime(project.createdAt, timeZone)}
            </DetailField>
            <DetailField label="Updated">
              {formatLocalDateTime(project.updatedAt, timeZone)}
            </DetailField>
          </div>
        </Section>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Route pages                                                                 */
/* -------------------------------------------------------------------------- */

function LoadedOrEmpty<T>({
  type,
  data,
  error,
  isLoading,
  render,
}: {
  type: RecordDetailType;
  data: T | null;
  error: unknown;
  isLoading: boolean;
  render: (record: T) => ReactNode;
}) {
  const back = DETAIL_BACK_LINKS[type];
  return (
    <DetailPageShell
      backTo={back.to}
      backLabel={back.label}
      isLoading={isLoading}
      error={error}
      recordType={type}
    >
      {data ? (
        render(data)
      ) : (
        <Card>
          <EmptyState
            icon={<CaptureIcon />}
            title="Record unavailable"
            text="The record could not be displayed."
          />
        </Card>
      )}
    </DetailPageShell>
  );
}

export function CaptureDetailPage() {
  const record = useRecordDetail(capturesApi.get);
  const timeZone = useTimeZone().timeZone;
  return (
    <LoadedOrEmpty
      type="capture"
      {...record}
      render={(capture) => (
        <CaptureDetailView capture={capture} timeZone={timeZone} />
      )}
    />
  );
}

export function TaskDetailPage() {
  const record = useRecordDetail(tasksApi.get);
  const timeZone = useTimeZone().timeZone;
  return (
    <LoadedOrEmpty
      type="task"
      {...record}
      render={(task) => (
        <EditableDetail
          record={task}
          spec={taskFormSpec}
          remove={(t) => tasksApi.delete(t.id)}
          deleteCopy={taskDeleteCopy}
          listPath={APP_PATHS.tasks}
          render={(current, actions) => <TaskDetailView task={current} timeZone={timeZone} actions={actions} />}
        />
      )}
    />
  );
}

export function ReminderDetailPage() {
  const record = useRecordDetail(remindersApi.get);
  const timeZone = useTimeZone().timeZone;
  return (
    <LoadedOrEmpty
      type="reminder"
      {...record}
      render={(reminder) => (
        <EditableDetail
          record={reminder}
          spec={reminderFormSpec}
          remove={(r) => remindersApi.delete(r.id)}
          deleteCopy={reminderDeleteCopy}
          listPath={APP_PATHS.reminders}
          render={(current, actions) => <ReminderDetailView reminder={current} timeZone={timeZone} actions={actions} />}
        />
      )}
    />
  );
}

export function NoteDetailPage() {
  const record = useRecordDetail(notesApi.get);
  const timeZone = useTimeZone().timeZone;
  return (
    <LoadedOrEmpty
      type="note"
      {...record}
      render={(note) => (
        <EditableDetail
          record={note}
          spec={noteFormSpec}
          remove={(n) => notesApi.delete(n.id)}
          deleteCopy={(n) => simpleDeleteCopy("note", n.title || "Untitled note")}
          listPath={APP_PATHS.notes}
          render={(current, actions) => <NoteDetailView note={current} timeZone={timeZone} actions={actions} />}
        />
      )}
    />
  );
}

export function IdeaDetailPage() {
  const record = useRecordDetail(ideasApi.get);
  const timeZone = useTimeZone().timeZone;
  return (
    <LoadedOrEmpty
      type="idea"
      {...record}
      render={(idea) => (
        <EditableDetail
          record={idea}
          spec={ideaFormSpec}
          remove={(i) => ideasApi.delete(i.id)}
          deleteCopy={(i) => simpleDeleteCopy("idea", i.title, "Tasks made from it stay.")}
          listPath={APP_PATHS.ideas}
          extraActions={(current) => <PromoteIdeaButton idea={current} />}
          render={(current, actions) => <IdeaDetailView idea={current} timeZone={timeZone} actions={actions} />}
        />
      )}
    />
  );
}

export function EventDetailPage() {
  const record = useRecordDetail(eventsApi.get);
  const timeZone = useTimeZone().timeZone;
  return (
    <LoadedOrEmpty
      type="event"
      {...record}
      render={(event) => (
        <EditableDetail
          record={event}
          spec={eventFormSpec}
          remove={(e) => eventsApi.delete(e.id)}
          deleteCopy={(e) => simpleDeleteCopy("event", e.title)}
          listPath={APP_PATHS.events}
          render={(current, actions) => <EventDetailView event={current} timeZone={timeZone} actions={actions} />}
        />
      )}
    />
  );
}

export function ProjectDetailPage() {
  const record = useRecordDetail(projectsApi.get);
  const timeZone = useTimeZone().timeZone;
  return (
    <LoadedOrEmpty
      type="project"
      {...record}
      render={(project) => (
        <EditableDetail
          record={project}
          spec={projectFormSpec}
          remove={(p) => projectsApi.delete(p.id)}
          deleteCopy={projectDeleteCopy}
          deletedMessage={(_p, result) =>
            result.detached > 0 ? `${result.detached} ${result.detached === 1 ? "item is" : "items are"} no longer in a project.` : undefined
          }
          listPath={APP_PATHS.projects}
          render={(current, actions) => <ProjectDetailView project={current} timeZone={timeZone} actions={actions} />}
        />
      )}
    />
  );
}
