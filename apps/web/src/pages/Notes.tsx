import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useToast } from "../hooks/useToast";
import { notesApi, type NoteDto } from "../lib/api";
import { useTimeZone } from "../hooks/useTimeZone";
import {
  Button,
  Input,
  Textarea,
  Card,
  EmptyState,
  Modal,
} from "../components/ui";
import { NoteRow } from "../components/record-rows";
import { NotesIcon } from "../components/Layout";

export function NotesPage() {
  const { showToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [notes, setNotes] = useState<NoteDto[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createForm, setCreateForm] = useState<{
    title: string;
    body: string;
    url: string;
  }>({
    title: "",
    body: "",
    url: "",
  });
  const [createLoading, setCreateLoading] = useState(false);
  const [createErrors, setCreateErrors] = useState<{ body?: string }>({});

  const timeZone = useTimeZone().timeZone;
  const page = parseInt(searchParams.get("page") || "1", 10);
  const limit = 25;

  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      try {
        const data = await notesApi.list({
          limit,
          offset: (page - 1) * limit,
          sort: "createdAt",
          order: "desc",
        });
        setNotes(data.items);
        setTotal(data.total);
      } catch (err) {
        console.error(err);
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, [page]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateLoading(true);
    try {
      await notesApi.create({
        title: createForm.title.trim() || null,
        body: createForm.body.trim(),
        url: createForm.url.trim() || null,
        tags: [],
        projectId: null,
        captureId: null,
      });
      showToast("success", "Note created");
      setShowCreateModal(false);
      setCreateForm({ title: "", body: "", url: "" });
      const data = await notesApi.list({
        limit,
        offset: (page - 1) * limit,
        sort: "createdAt",
        order: "desc",
      });
      setNotes(data.items);
      setTotal(data.total);
    } catch (err) {
      console.error(err);
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
          Notes
        </h1>
        <Button
          variant="primary"
          size="lg"
          onClick={() => setShowCreateModal(true)}
        >
          New Note
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
          ) : notes.length === 0 ? (
            <EmptyState
              icon={<NotesIcon />}
              title="No notes yet"
              text="Create a note to save information, links, or references."
              action={
                <Button
                  variant="primary"
                  onClick={() => setShowCreateModal(true)}
                >
                  Create Note
                </Button>
              }
            />
          ) : (
            <>
              <div
                className="list"
                style={{ borderTop: "1px solid var(--color-border)" }}
              >
                {notes.map((note) => (
                  <NoteRow key={note.id} note={note} timeZone={timeZone} />
                ))}
              </div>
            </>
          )}
        </div>
      </Card>

      <Modal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        title="Create Note"
      >
        <form
          noValidate
          onSubmit={async (e) => {
            e.preventDefault();
            if (!createForm.body.trim()) {
              setCreateErrors({ body: "Body is required" });
              return;
            }
            setCreateErrors({});
            try {
              await notesApi.create({
                title: createForm.title.trim() || null,
                body: createForm.body.trim(),
                url: createForm.url.trim() || null,
                tags: [],
                projectId: null,
                captureId: null,
              });
              showToast("success", "Note created");
              setShowCreateModal(false);
              setCreateForm({ title: "", body: "", url: "" });
              const data = await notesApi.list({
                limit: 25,
                offset: 0,
                sort: "createdAt",
                order: "desc",
              });
              setNotes(data.items);
              setTotal(data.total);
            } catch (err) {
              console.error(err);
            }
          }}
        >
          <Input
            label="Title (optional)"
            placeholder="Note title"
            value={createForm.title}
            onChange={(e) =>
              setCreateForm({ ...createForm, title: e.target.value })
            }
          />
          <Textarea
            label="Body"
            placeholder="Note content"
            value={createForm.body}
            onChange={(e) => {
              setCreateForm({ ...createForm, body: e.target.value });
              if (createErrors.body) setCreateErrors({});
            }}
            error={createErrors.body}
            rows={4}
            required
          />
          <Input
            label="URL (optional)"
            placeholder="https://example.com"
            value={createForm.url}
            onChange={(e) =>
              setCreateForm({ ...createForm, url: e.target.value })
            }
            type="url"
          />
          <div className="modal-footer">
            <Button
              variant="secondary"
              type="button"
              onClick={() => setShowCreateModal(false)}
            >
              Cancel
            </Button>
            <Button type="submit">Create Note</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
