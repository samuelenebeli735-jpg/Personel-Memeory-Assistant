import { useState, useEffect } from "react";
import type { FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useToast } from "../hooks/useToast";
import {
  tasksApi,
  type TaskDto,
  type TaskCreateInput,
  type TaskUpdateInput,
  type TaskStatus,
} from "../lib/api";
import { getTimeZone } from "../lib/date";
import {
  Button,
  Input,
  Textarea,
  Select,
  Card,
  EmptyState,
  Modal,
} from "../components/ui";
import { TaskRow } from "../components/record-rows";
import { TasksIcon } from "../components/Layout";

const STATUS_OPTIONS = [
  { value: "PENDING", label: "Pending" },
  { value: "IN_PROGRESS", label: "In Progress" },
  { value: "COMPLETED", label: "Completed" },
  { value: "CANCELLED", label: "Cancelled" },
] as const;

const PRIORITY_OPTIONS = [
  { value: "LOW", label: "Low" },
  { value: "MEDIUM", label: "Medium" },
  { value: "HIGH", label: "High" },
  { value: "URGENT", label: "Urgent" },
] as const;

export function TasksPage() {
  const { showToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createForm, setCreateForm] = useState<{
    title: string;
    description: string;
    priority: string;
    dueAt: string;
    projectId: string;
  }>({
    title: "",
    description: "",
    priority: "",
    dueAt: "",
    projectId: "",
  });
  const [createLoading, setCreateLoading] = useState(false);
  const [createErrors, setCreateErrors] = useState<{ title?: string }>({});

  const timeZone = getTimeZone();
  const status = searchParams.get("status") || "";
  const page = parseInt(searchParams.get("page") || "1", 10);
  const limit = 25;

  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      try {
        const data = await tasksApi.list({
          status: status ? [status] : undefined,
          limit,
          offset: (page - 1) * limit,
          sort: "dueAt",
          order: "asc",
        });
        setTasks(data.items);
        setTotal(data.total);
      } catch (err) {
        console.error(err);
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, [page, status]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!createForm.title.trim()) {
      setCreateErrors({ title: "Title is required" });
      return;
    }
    setCreateErrors({});

    setCreateLoading(true);
    try {
      await tasksApi.create({
        title: createForm.title.trim(),
        description: createForm.description.trim() || null,
        status: "PENDING",
        priority: createForm.priority
          ? (createForm.priority as "LOW" | "MEDIUM" | "HIGH" | "URGENT")
          : null,
        dueAt: createForm.dueAt || null,
        projectId: createForm.projectId || null,
        tags: [],
        captureId: null,
      });
      showToast("success", "Task created");
      setShowCreateModal(false);
      setCreateErrors({});
      setCreateForm({
        title: "",
        description: "",
        priority: "",
        dueAt: "",
        projectId: "",
      });
      const data = await tasksApi.list({
        status: status ? [status] : undefined,
        limit,
        offset: (page - 1) * limit,
        sort: "dueAt",
        order: "asc",
      });
      setTasks(data.items);
      setTotal(data.total);
    } catch (err) {
      console.error(err);
      showToast(
        "error",
        "Failed to create task",
        err instanceof Error ? err.message : "Unknown error",
      );
    } finally {
      setCreateLoading(false);
    }
  };

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "24px",
        }}
      >
        <h1 style={{ fontSize: "24px", fontWeight: "600", margin: 0 }}>
          Tasks
        </h1>
        <Button
          variant="primary"
          size="lg"
          onClick={() => setShowCreateModal(true)}
        >
          <TasksIcon style={{ marginRight: "8px" }} /> New Task
        </Button>
      </div>

      <div style={{ marginBottom: "16px" }}>
        {STATUS_OPTIONS.map((opt) => (
          <Link
            key={opt.value}
            to={`?status=${opt.value}`}
            style={{
              textDecoration: "none",
              marginRight: "8px",
              padding: "6px 12px",
              borderRadius: "var(--radius-md)",
              background:
                status === opt.value
                  ? "var(--color-primary)"
                  : "var(--color-surface)",
              color:
                status === opt.value
                  ? "var(--color-primary-text, white)"
                  : "var(--color-text)",
              border: "1px solid var(--color-border)",
            }}
          >
            {opt.label}
          </Link>
        ))}
        <Link
          to="/tasks"
          style={{
            textDecoration: "none",
            marginRight: "8px",
            padding: "6px 12px",
            borderRadius: "var(--radius-md)",
            background: !status
              ? "var(--color-primary)"
              : "var(--color-surface)",
            color: !status
              ? "var(--color-primary-text, white)"
              : "var(--color-text)",
            border: "1px solid var(--color-border)",
          }}
        >
          All
        </Link>
      </div>

      <Card>
        <div className="card-content" style={{ padding: 0 }}>
          {isLoading ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "32px",
              }}
            >
              <div className="loading-spinner" aria-hidden="true" />
            </div>
          ) : tasks.length === 0 ? (
            <EmptyState
              icon={<TasksIcon />}
              title={
                status ? `No ${status.toLowerCase()} tasks` : "No tasks yet"
              }
              text="Create your first task to get started."
              action={
                <Button
                  variant="primary"
                  onClick={() => setShowCreateModal(true)}
                >
                  Create Task
                </Button>
              }
            />
          ) : (
            <>
              <div
                className="list"
                style={{ borderTop: "1px solid var(--color-border)" }}
              >
                {tasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    timeZone={timeZone}
                    actions={
                      <select
                        aria-label={`Status for ${task.title}`}
                        value={task.status}
                        onChange={async (e) => {
                          try {
                            await tasksApi.update(task.id, {
                              status: e.target.value as TaskStatus,
                            });
                          } catch (err) {
                            showToast(
                              "error",
                              "Failed to update task",
                              err instanceof Error ? err.message : "Unknown error",
                            );
                          }
                        }}
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
              {total > tasks.length && (
                <div
                  style={{
                    display: "flex",
                    justifyContent: "center",
                    gap: "8px",
                    padding: "16px",
                  }}
                >
                  {page > 1 && (
                    <Link to={`?status=${status}&page=${page - 1}`}>
                      <Button variant="secondary" size="sm">
                        Previous
                      </Button>
                    </Link>
                  )}
                  <span
                    style={{
                      display: "flex",
                      alignItems: "center",
                      color: "var(--color-text-muted)",
                      fontSize: "13px",
                    }}
                  >
                    Page {page} of {Math.ceil(total / limit)}
                  </span>
                  {page < Math.ceil(total / limit) && (
                    <Link to={`?status=${status}&page=${page + 1}`}>
                      <Button variant="secondary" size="sm">
                        Next
                      </Button>
                    </Link>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </Card>

      <Modal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        title="Create Task"
      >
        <form onSubmit={handleCreate} noValidate>
          <Input
            label="Title"
            placeholder="Task title"
            value={createForm.title}
            onChange={(e) => {
              setCreateForm({ ...createForm, title: e.target.value });
              if (createErrors.title) setCreateErrors({});
            }}
            error={createErrors.title}
            required
          />
          <Textarea
            label="Description"
            placeholder="Optional description"
            value={createForm.description}
            onChange={(e) =>
              setCreateForm({ ...createForm, description: e.target.value })
            }
            rows={3}
          />
          <Select
            label="Priority"
            options={[{ value: "", label: "None" }, ...PRIORITY_OPTIONS]}
            value={createForm.priority}
            onChange={(e) =>
              setCreateForm({ ...createForm, priority: e.target.value })
            }
          />
          <Input
            label="Due Date"
            type="datetime-local"
            value={createForm.dueAt}
            onChange={(e) =>
              setCreateForm({ ...createForm, dueAt: e.target.value })
            }
          />
          <Input
            label="Project ID (optional)"
            placeholder="Enter project ID"
            value={createForm.projectId}
            onChange={(e) =>
              setCreateForm({ ...createForm, projectId: e.target.value })
            }
          />
          <div className="modal-footer">
            <Button
              variant="secondary"
              type="button"
              onClick={() => setShowCreateModal(false)}
            >
              Cancel
            </Button>
            <Button type="submit" loading={createLoading}>
              Create Task
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
