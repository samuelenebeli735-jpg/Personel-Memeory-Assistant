import { useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useToast } from "../hooks/useToast";
import { tasksApi, type TaskDto, type TaskStatus } from "../lib/api";
import { useTimeZone } from "../hooks/useTimeZone";
import { usePagedQuery } from "../hooks/usePagedQuery";
import { describeError } from "../lib/errors";
import { Button, Card, EmptyState } from "../components/ui";
import { ListState, PageHeader } from "../components/patterns";
import { RecordFormDialog, taskFormSpec } from "../components/record-forms";
import { TaskRow } from "../components/record-rows";
import { TasksIcon } from "../components/Layout";

const STATUS_OPTIONS = [
  { value: "PENDING", label: "Pending" },
  { value: "IN_PROGRESS", label: "In Progress" },
  { value: "COMPLETED", label: "Completed" },
  { value: "CANCELLED", label: "Cancelled" },
] as const;

export function TasksPage() {
  const { showToast } = useToast();
  const { timeZone } = useTimeZone();
  const [searchParams] = useSearchParams();
  const status = searchParams.get("status") || "";
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [statusOverrides, setStatusOverrides] = useState<Record<string, TaskStatus>>({});

  const query = usePagedQuery<TaskDto>(
    (page) =>
      tasksApi.list({
        status: status ? [status] : undefined,
        sort: "dueAt",
        order: "asc",
        ...page,
      }),
    [status],
    { headingRef },
  );

  const changeStatus = async (task: TaskDto, next: TaskStatus) => {
    const previous = statusOverrides[task.id] ?? task.status;
    setStatusOverrides((prev) => ({ ...prev, [task.id]: next }));
    try {
      await tasksApi.update(task.id, { status: next });
    } catch (err) {
      setStatusOverrides((prev) => ({ ...prev, [task.id]: previous }));
      const described = describeError(err, "Updating the task", true);
      showToast("error", "Failed to update task", described.message);
    }
  };

  const statusLabel = STATUS_OPTIONS.find((opt) => opt.value === status)?.label.toLowerCase();

  return (
    <div>
      <PageHeader
        ref={headingRef}
        title="Tasks"
        sub={query.status === "ready" ? `${query.total} ${statusLabel ? `${statusLabel} ` : ""}task${query.total === 1 ? "" : "s"}` : undefined}
        actions={
          <Button variant="primary" size="lg" onClick={() => setCreateOpen(true)}>
            <TasksIcon style={{ marginRight: "8px" }} /> New Task
          </Button>
        }
      />

      <div className="filter-bar" role="group" aria-label="Filter by status">
        <Button
          variant={!status ? "primary" : "secondary"}
          size="sm"
          aria-pressed={!status}
          onClick={() => query.setFilters({ status: null })}
        >
          All
        </Button>
        {STATUS_OPTIONS.map((opt) => (
          <Button
            key={opt.value}
            variant={status === opt.value ? "primary" : "secondary"}
            size="sm"
            aria-pressed={status === opt.value}
            onClick={() => query.setFilters({ status: opt.value })}
          >
            {opt.label}
          </Button>
        ))}
      </div>

      <Card>
        <div className="card-content" style={{ padding: 0 }}>
          <ListState
            status={query.status}
            error={query.error}
            items={query.items}
            noun="tasks"
            onRetry={query.reload}
            empty={
              <EmptyState
                icon={<TasksIcon />}
                title={statusLabel ? `No ${statusLabel} tasks` : "No tasks yet"}
                text="Create your first task to get started."
                action={
                  <Button variant="primary" onClick={() => setCreateOpen(true)}>
                    Create Task
                  </Button>
                }
              />
            }
          >
            {(tasks) => (
              <div className="list" style={{ borderTop: "1px solid var(--color-border)" }}>
                {tasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={{ ...task, status: statusOverrides[task.id] ?? task.status }}
                    timeZone={timeZone}
                    actions={
                      <select
                        aria-label={`Status for ${task.title}`}
                        value={statusOverrides[task.id] ?? task.status}
                        onChange={(e) => void changeStatus(task, e.target.value as TaskStatus)}
                        className="form-select"
                        style={{ padding: "4px 8px", fontSize: "12px" }}
                      >
                        {STATUS_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    }
                  />
                ))}
              </div>
            )}
          </ListState>
        </div>
      </Card>

      <RecordFormDialog
        spec={taskFormSpec}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSaved={() => {
          setCreateOpen(false);
          query.reload();
        }}
      />
    </div>
  );
}
