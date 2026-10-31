import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useToast } from "../hooks/useToast";
import { remindersApi, type ReminderDto, type SnoozeInput } from "../lib/api";
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
import { ReminderRow } from "../components/record-rows";
import { RemindersIcon } from "../components/Layout";

const SNOOZE_OPTIONS = [
  { value: "10m", label: "10 minutes" },
  { value: "1h", label: "1 hour" },
  { value: "tomorrow 9am", label: "Tomorrow 9 AM" },
];

export function RemindersPage() {
  const { showToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [reminders, setReminders] = useState<ReminderDto[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createForm, setCreateForm] = useState<{
    title: string;
    body: string;
    remindAt: string;
    recurrence: string;
  }>({
    title: "",
    body: "",
    remindAt: "",
    recurrence: "",
  });
  const [createLoading, setCreateLoading] = useState(false);
  const [createErrors, setCreateErrors] = useState<{
    title?: string;
    remindAt?: string;
  }>({});
  const [snoozeReminderId, setSnoozeReminderId] = useState<string | null>(null);
  const [snoozeForm, setSnoozeForm] = useState<SnoozeInput>({ minutes: 10 });

  const timeZone = getTimeZone();
  const status = searchParams.get("status") || "";
  const page = parseInt(searchParams.get("page") || "1", 10);
  const limit = 25;

  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      try {
        const data = await remindersApi.list({
          status: status ? [status] : undefined,
          limit,
          offset: (page - 1) * limit,
          order: "asc",
        });
        setReminders(data.items);
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

    const nextErrors: { title?: string; remindAt?: string } = {};
    if (!createForm.title.trim()) {
      nextErrors.title = "Title is required";
    }
    if (!createForm.remindAt.trim()) {
      nextErrors.remindAt = "Remind At is required";
    } else if (Number.isNaN(new Date(createForm.remindAt).getTime())) {
      nextErrors.remindAt = "Invalid date";
    }
    if (Object.keys(nextErrors).length > 0) {
      setCreateErrors(nextErrors);
      return;
    }
    setCreateErrors({});

    setCreateLoading(true);
    try {
      await remindersApi.create({
        title: createForm.title.trim(),
        body: createForm.body.trim() || null,
        remindAt: new Date(createForm.remindAt).toISOString(),
        recurrence: createForm.recurrence
          ? JSON.parse(createForm.recurrence)
          : null,
        captureId: null,
        taskId: null,
      });
      showToast("success", "Reminder created");
      setShowCreateModal(false);
      setCreateErrors({});
      setCreateForm({ title: "", body: "", remindAt: "", recurrence: "" });
      const data = await remindersApi.list({
        status: status ? [status] : undefined,
        limit,
        offset: (page - 1) * limit,
        order: "asc",
      });
      setReminders(data.items);
      setTotal(data.total);
    } catch (err) {
      console.error(err);
      showToast(
        "error",
        "Failed to create reminder",
        err instanceof Error ? err.message : "Unknown error",
      );
    } finally {
      setCreateLoading(false);
    }
  };

  const handleSnooze = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!snoozeReminderId) return;

    setCreateLoading(true);
    try {
      await remindersApi.snooze(snoozeReminderId, snoozeForm);
      showToast("success", "Reminder snoozed");
      setSnoozeReminderId(null);
      const data = await remindersApi.list({
        status: status ? [status] : undefined,
        limit,
        offset: (page - 1) * limit,
        order: "asc",
      });
      setReminders(data.items);
      setTotal(data.total);
    } catch (err) {
      showToast(
        "error",
        "Failed to snooze",
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
          Reminders
        </h1>
        <Button
          variant="primary"
          size="lg"
          onClick={() => setShowCreateModal(true)}
        >
          <RemindersIcon style={{ marginRight: "8px" }} /> New Reminder
        </Button>
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
          ) : reminders.length === 0 ? (
            <EmptyState
              icon={<RemindersIcon />}
              title="No reminders yet"
              text="Create a reminder to get notified on time."
              action={
                <Button
                  variant="primary"
                  onClick={() => setShowCreateModal(true)}
                >
                  Create Reminder
                </Button>
              }
            />
          ) : (
            <>
              <div
                className="list"
                style={{ borderTop: "1px solid var(--color-border)" }}
              >
                {reminders.map((reminder) => (
                  <ReminderRow
                    key={reminder.id}
                    reminder={reminder}
                    timeZone={timeZone}
                    actions={
                      reminder.status === "SCHEDULED" ? (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setSnoozeReminderId(reminder.id)}
                          >
                            Snooze
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={async () => {
                              if (confirm("Cancel this reminder?")) {
                                await remindersApi.cancel(reminder.id);
                              }
                            }}
                          >
                            Cancel
                          </Button>
                        </>
                      ) : undefined
                    }
                  />
                ))}
              </div>
              {total > reminders.length && (
                <div
                  style={{
                    display: "flex",
                    justifyContent: "center",
                    gap: "8px",
                    padding: "16px",
                  }}
                >
                  <span
                    style={{
                      display: "flex",
                      alignItems: "center",
                      color: "var(--color-text-muted)",
                      fontSize: "13px",
                    }}
                  >
                    Showing {reminders.length} of {total}
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      </Card>

      <Modal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        title="Create Reminder"
      >
        <form onSubmit={handleCreate} noValidate>
          <Input
            label="Title"
            placeholder="Reminder title"
            value={createForm.title}
            onChange={(e) => {
              setCreateForm({ ...createForm, title: e.target.value });
              if (createErrors.title) {
                setCreateErrors((prev) => ({ ...prev, title: undefined }));
              }
            }}
            error={createErrors.title}
            required
          />
          <Textarea
            label="Body (optional)"
            placeholder="Optional details"
            value={createForm.body}
            onChange={(e) =>
              setCreateForm({ ...createForm, body: e.target.value })
            }
            rows={3}
          />
          <Input
            label="Remind At"
            type="datetime-local"
            value={createForm.remindAt}
            onChange={(e) => {
              setCreateForm({ ...createForm, remindAt: e.target.value });
              if (createErrors.remindAt) {
                setCreateErrors((prev) => ({ ...prev, remindAt: undefined }));
              }
            }}
            error={createErrors.remindAt}
            required
          />
          <Select
            label="Recurrence"
            options={[
              { value: "", label: "None" },
              {
                value: JSON.stringify({
                  frequency: "DAILY",
                  weekdays: [],
                  until: null,
                  maxOccurrences: 52,
                }),
                label: "Daily",
              },
              {
                value: JSON.stringify({
                  frequency: "WEEKLY",
                  weekdays: [],
                  until: null,
                  maxOccurrences: 52,
                }),
                label: "Weekly",
              },
              {
                value: JSON.stringify({
                  frequency: "MONTHLY",
                  weekdays: [],
                  until: null,
                  maxOccurrences: 24,
                }),
                label: "Monthly",
              },
            ]}
            value={createForm.recurrence}
            onChange={(e) =>
              setCreateForm({ ...createForm, recurrence: e.target.value })
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
              Create Reminder
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={!!snoozeReminderId}
        onClose={() => setSnoozeReminderId(null)}
        title="Snooze Reminder"
      >
        <form onSubmit={handleSnooze}>
          <Select
            label="Snooze for"
            options={SNOOZE_OPTIONS}
            value={
              snoozeForm.minutes
                ? `${snoozeForm.minutes}m`
                : snoozeForm.until || ""
            }
            onChange={(e) => {
              const val = e.target.value;
              if (val === "10m") setSnoozeForm({ minutes: 10 });
              else if (val === "1h") setSnoozeForm({ minutes: 60 });
              else if (val === "tomorrow 9am")
                setSnoozeForm({
                  until: new Date(
                    new Date().getTime() + 24 * 60 * 60 * 1000,
                  ).toISOString(),
                });
            }}
          />
          <div className="modal-footer">
            <Button
              variant="secondary"
              type="button"
              onClick={() => setSnoozeReminderId(null)}
            >
              Cancel
            </Button>
            <Button type="submit" loading={createLoading}>
              Snooze
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
