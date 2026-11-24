import { useRef, useState } from "react";
import { useToast } from "../hooks/useToast";
import { remindersApi, type ReminderDto, type SnoozeInput } from "../lib/api";
import { useTimeZone } from "../hooks/useTimeZone";
import { usePagedQuery } from "../hooks/usePagedQuery";
import { localDayAtTime } from "../lib/date";
import { describeError } from "../lib/errors";
import { Button, Select, Card, EmptyState, Modal } from "../components/ui";
import { ConfirmDialog, ListState, PageHeader } from "../components/patterns";
import { RecordFormDialog, reminderFormSpec } from "../components/record-forms";
import { ReminderRow } from "../components/record-rows";
import { RemindersIcon } from "../components/Layout";
import { useSearchParams } from "react-router-dom";

const SNOOZE_OPTIONS = [
  { value: "10m", label: "10 minutes" },
  { value: "1h", label: "1 hour" },
  { value: "tomorrow 9am", label: "Tomorrow 9 AM" },
];

export function RemindersPage() {
  const { showToast } = useToast();
  const { timeZone } = useTimeZone();
  const [searchParams] = useSearchParams();
  const status = searchParams.get("status") || "";
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [snoozeReminderId, setSnoozeReminderId] = useState<string | null>(null);
  const [snoozeForm, setSnoozeForm] = useState<SnoozeInput>({ minutes: 10 });
  const [snoozing, setSnoozing] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<ReminderDto | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const query = usePagedQuery<ReminderDto>(
    (page) => remindersApi.list({ status: status ? [status] : undefined, order: "asc", ...page }),
    [status],
    { headingRef },
  );

  const handleSnooze = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!snoozeReminderId) return;
    setSnoozing(true);
    try {
      await remindersApi.snooze(snoozeReminderId, snoozeForm);
      showToast("success", "Reminder snoozed");
      setSnoozeReminderId(null);
      query.reload();
    } catch (err) {
      showToast("error", "Failed to snooze", describeError(err, "Snoozing", true).message);
    } finally {
      setSnoozing(false);
    }
  };

  const confirmCancel = async () => {
    if (!cancelTarget) return;
    setCancelling(true);
    try {
      await remindersApi.cancel(cancelTarget.id);
      showToast("success", "Reminder cancelled", cancelTarget.title);
      setCancelTarget(null);
      query.reload();
    } catch (err) {
      showToast("error", "Reminder not cancelled", describeError(err, "Cancelling", true).message);
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div>
      <PageHeader
        ref={headingRef}
        title="Reminders"
        sub={query.status === "ready" ? `${query.total} reminder${query.total === 1 ? "" : "s"}` : undefined}
        actions={
          <Button variant="primary" size="lg" onClick={() => setCreateOpen(true)}>
            <RemindersIcon style={{ marginRight: "8px" }} /> New Reminder
          </Button>
        }
      />

      <Card>
        <div className="card-content" style={{ padding: 0 }}>
          <ListState
            status={query.status}
            error={query.error}
            items={query.items}
            noun="reminders"
            onRetry={query.reload}
            empty={
              <EmptyState
                icon={<RemindersIcon />}
                title="No reminders yet"
                text="Create a reminder to get notified on time."
                action={
                  <Button variant="primary" onClick={() => setCreateOpen(true)}>
                    Create Reminder
                  </Button>
                }
              />
            }
          >
            {(reminders) => (
              <div className="list" style={{ borderTop: "1px solid var(--color-border)" }}>
                {reminders.map((reminder) => (
                  <ReminderRow
                    key={reminder.id}
                    reminder={reminder}
                    timeZone={timeZone}
                    actions={
                      reminder.status === "SCHEDULED" ? (
                        <>
                          <Button variant="ghost" size="sm" onClick={() => setSnoozeReminderId(reminder.id)}>
                            Snooze
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setCancelTarget(reminder)}
                          >
                            Cancel
                          </Button>
                        </>
                      ) : undefined
                    }
                  />
                ))}
              </div>
            )}
          </ListState>
        </div>
      </Card>

      <RecordFormDialog
        spec={reminderFormSpec}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSaved={() => {
          setCreateOpen(false);
          query.reload();
        }}
      />

      <Modal isOpen={!!snoozeReminderId} onClose={() => setSnoozeReminderId(null)} title="Snooze Reminder">
        <form onSubmit={handleSnooze}>
          <Select
            label="Snooze for"
            options={SNOOZE_OPTIONS}
            value={snoozeForm.until ? "tomorrow 9am" : snoozeForm.minutes === 60 ? "1h" : "10m"}
            onChange={(e) => {
              const val = e.target.value;
              if (val === "10m") setSnoozeForm({ minutes: 10 });
              else if (val === "1h") setSnoozeForm({ minutes: 60 });
              else if (val === "tomorrow 9am") {
                // 09:00 tomorrow in the owner's Settings zone, not "24 hours from now".
                const until = localDayAtTime(new Date(), timeZone, 1, "09:00");
                if (until) setSnoozeForm({ until });
              }
            }}
          />
          <div className="modal-footer">
            <Button variant="secondary" type="button" onClick={() => setSnoozeReminderId(null)}>
              Cancel
            </Button>
            <Button type="submit" loading={snoozing}>
              Snooze
            </Button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={cancelTarget !== null}
        title={`Cancel reminder “${cancelTarget?.title ?? ""}”?`}
        confirmLabel="Cancel reminder"
        cancelLabel="Keep reminder"
        busy={cancelling}
        onConfirm={() => void confirmCancel()}
        onCancel={() => setCancelTarget(null)}
      >
        <p>It won’t be sent. The reminder stays in your list as cancelled.</p>
      </ConfirmDialog>
    </div>
  );
}
