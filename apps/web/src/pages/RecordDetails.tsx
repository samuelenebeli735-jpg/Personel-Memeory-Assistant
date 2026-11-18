/**
 * Record detail pages.
 *
 * These render only fields that are already part of the public DTO. Capture
 * provider metadata, retained-audio paths and classification-cache fields never
 * reach the browser, and the capture page additionally avoids showing the
 * internal voice placeholder as if it were user content.
 */
import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
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
import { formatLocalDateTime, getTimeZone } from "../lib/date";
import {
  DETAIL_BACK_LINKS,
  detailPath,
  type RecordDetailType,
} from "../lib/routes";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Modal,
  Select,
  Textarea,
} from "../components/ui";
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
      {actions && (
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginBottom: "20px" }}>
          {actions}
        </div>
      )}
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

function TaskDetailInteractiveView({
  task,
  timeZone,
}: {
  task: TaskDto;
  timeZone: string;
}) {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [currentTask, setCurrentTask] = useState(task);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editForm, setEditForm] = useState({
    title: task.title,
    description: task.description ?? "",
    priority: task.priority ?? "",
  });

  const openEdit = () => {
    setEditForm({
      title: currentTask.title,
      description: currentTask.description ?? "",
      priority: currentTask.priority ?? "",
    });
    setEditOpen(true);
  };

  const saveEdit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editForm.title.trim()) return;

    setSaving(true);
    try {
      const updated = await tasksApi.update(currentTask.id, {
        title: editForm.title.trim(),
        description: editForm.description.trim() || null,
        priority: editForm.priority
          ? (editForm.priority as "LOW" | "MEDIUM" | "HIGH" | "URGENT")
          : null,
      });
      setCurrentTask(updated);
      setEditOpen(false);
      showToast("success", "Task updated");
    } catch (error) {
      showToast(
        "error",
        "Failed to update task",
        error instanceof Error ? error.message : "Unknown error",
      );
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    setSaving(true);
    try {
      await tasksApi.delete(currentTask.id);
      showToast("success", "Task deleted");
      navigate("/tasks");
    } catch (error) {
      showToast(
        "error",
        "Failed to delete task",
        error instanceof Error ? error.message : "Unknown error",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <TaskDetailView
        task={currentTask}
        timeZone={timeZone}
        actions={
          <>
            <Button variant="secondary" onClick={openEdit}>Edit</Button>
            <Button variant="danger" onClick={() => setDeleteOpen(true)}>Delete</Button>
          </>
        }
      />

      <Modal isOpen={editOpen} onClose={() => setEditOpen(false)} title="Edit Task">
        <form onSubmit={saveEdit}>
          <Input
            label="Title"
            value={editForm.title}
            onChange={(event) => setEditForm({ ...editForm, title: event.target.value })}
            required
          />
          <Textarea
            label="Description"
            value={editForm.description}
            onChange={(event) => setEditForm({ ...editForm, description: event.target.value })}
            rows={3}
          />
          <Select
            label="Priority"
            options={[
              { value: "", label: "None" },
              { value: "LOW", label: "Low" },
              { value: "MEDIUM", label: "Medium" },
              { value: "HIGH", label: "High" },
              { value: "URGENT", label: "Urgent" },
            ]}
            value={editForm.priority}
            onChange={(event) => setEditForm({ ...editForm, priority: event.target.value })}
          />
          <div className="modal-footer">
            <Button variant="secondary" type="button" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button type="submit" loading={saving}>Save</Button>
          </div>
        </form>
      </Modal>

      <Modal isOpen={deleteOpen} onClose={() => setDeleteOpen(false)} title="Delete Task">
        <p>Delete this task? This action cannot be undone.</p>
        <div className="modal-footer">
          <Button variant="secondary" type="button" onClick={() => setDeleteOpen(false)}>Cancel</Button>
          <Button variant="danger" onClick={() => void confirmDelete()} loading={saving}>Delete</Button>
        </div>
      </Modal>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Reminders                                                                   */
/* -------------------------------------------------------------------------- */

export function ReminderDetailView({
  reminder,
  timeZone,
}: {
  reminder: ReminderDto;
  timeZone: string;
}) {
  return (
    <div>
      <DetailHeading
        eyebrow="Reminder"
        title={reminder.title}
        badges={statusBadge(reminder.status)}
      />
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
}: {
  note: NoteDto;
  timeZone: string;
}) {
  return (
    <div>
      <DetailHeading eyebrow="Note" title={note.title || "Untitled note"} />
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
}: {
  idea: IdeaDto;
  timeZone: string;
}) {
  return (
    <div>
      <DetailHeading eyebrow="Idea" title={idea.title} />
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
}: {
  event: EventDto;
  timeZone: string;
}) {
  return (
    <div>
      <DetailHeading eyebrow="Event" title={event.title} />
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
}: {
  project: ProjectDto;
  timeZone: string;
}) {
  return (
    <div>
      <DetailHeading
        eyebrow="Project"
        title={project.name}
        badges={statusBadge(project.status)}
      />
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
  const timeZone = getTimeZone();
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
  const timeZone = getTimeZone();
  return (
    <LoadedOrEmpty
      type="task"
      {...record}
      render={(task) => <TaskDetailInteractiveView task={task} timeZone={timeZone} />}
    />
  );
}

export function ReminderDetailPage() {
  const record = useRecordDetail(remindersApi.get);
  const timeZone = getTimeZone();
  return (
    <LoadedOrEmpty
      type="reminder"
      {...record}
      render={(reminder) => (
        <ReminderDetailView reminder={reminder} timeZone={timeZone} />
      )}
    />
  );
}

export function NoteDetailPage() {
  const record = useRecordDetail(notesApi.get);
  const timeZone = getTimeZone();
  return (
    <LoadedOrEmpty
      type="note"
      {...record}
      render={(note) => <NoteDetailView note={note} timeZone={timeZone} />}
    />
  );
}

export function IdeaDetailPage() {
  const record = useRecordDetail(ideasApi.get);
  const timeZone = getTimeZone();
  return (
    <LoadedOrEmpty
      type="idea"
      {...record}
      render={(idea) => <IdeaDetailView idea={idea} timeZone={timeZone} />}
    />
  );
}

export function EventDetailPage() {
  const record = useRecordDetail(eventsApi.get);
  const timeZone = getTimeZone();
  return (
    <LoadedOrEmpty
      type="event"
      {...record}
      render={(event) => <EventDetailView event={event} timeZone={timeZone} />}
    />
  );
}

export function ProjectDetailPage() {
  const record = useRecordDetail(projectsApi.get);
  const timeZone = getTimeZone();
  return (
    <LoadedOrEmpty
      type="project"
      {...record}
      render={(project) => (
        <ProjectDetailView project={project} timeZone={timeZone} />
      )}
    />
  );
}
