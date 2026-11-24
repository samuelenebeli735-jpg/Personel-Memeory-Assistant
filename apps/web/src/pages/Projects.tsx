import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useToast } from "../hooks/useToast";
import { projectsApi, type ProjectDto } from "../lib/api";
import { useTimeZone } from "../hooks/useTimeZone";
import {
  Button,
  Input,
  Textarea,
  Card,
  EmptyState,
  Modal,
} from "../components/ui";
import { ProjectRow } from "../components/record-rows";
import { ProjectsIcon } from "../components/Layout";

export function ProjectsPage() {
  const { showToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createForm, setCreateForm] = useState<{
    name: string;
    description: string;
  }>({ name: "", description: "" });
  const [createLoading, setCreateLoading] = useState(false);
  const [createErrors, setCreateErrors] = useState<{ name?: string }>({});

  const timeZone = useTimeZone().timeZone;
  const page = parseInt(searchParams.get("page") || "1", 10);
  const limit = 25;

  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      try {
        const data = await projectsApi.list({
          limit,
          offset: (page - 1) * limit,
        });
        setProjects(data.items);
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
    if (!createForm.name.trim()) {
      setCreateErrors({ name: "Name is required" });
      return;
    }
    setCreateErrors({});
    setCreateLoading(true);
    try {
      await projectsApi.create({
        name: createForm.name.trim(),
        description: createForm.description.trim() || null,
        status: "ACTIVE",
      });
      showToast("success", "Project created");
      setShowCreateModal(false);
      setCreateErrors({});
      setCreateForm({ name: "", description: "" });
      const data = await projectsApi.list({
        limit,
        offset: (page - 1) * limit,
      });
      setProjects(data.items);
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
          Projects
        </h1>
        <Button
          variant="primary"
          size="lg"
          onClick={() => setShowCreateModal(true)}
        >
          New Project
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
          ) : projects.length === 0 ? (
            <EmptyState
              icon={<ProjectsIcon />}
              title="No projects yet"
              text="Create a project to organize your tasks, notes, and ideas."
              action={
                <Button
                  variant="primary"
                  onClick={() => setShowCreateModal(true)}
                >
                  Create Project
                </Button>
              }
            />
          ) : (
            <>
              <div
                className="list"
                style={{ borderTop: "1px solid var(--color-border)" }}
              >
                {projects.map((project) => (
                  <ProjectRow
                    key={project.id}
                    project={project}
                    timeZone={timeZone}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </Card>

      <Modal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        title="Create Project"
      >
        <form onSubmit={handleCreate} noValidate>
          <Input
            label="Name"
            placeholder="Project name"
            value={createForm.name}
            onChange={(e) => {
              setCreateForm({ ...createForm, name: e.target.value });
              if (createErrors.name) setCreateErrors({});
            }}
            error={createErrors.name}
            required
          />
          <Textarea
            label="Description (optional)"
            placeholder="What is this project about?"
            value={createForm.description}
            onChange={(e) =>
              setCreateForm({ ...createForm, description: e.target.value })
            }
            rows={3}
          />
          <div className="modal-footer">
            <Button
              variant="secondary"
              type="button"
              onClick={() => setShowCreateModal(false)}
            >
              Cancel
            </Button>
            <Button type="submit">Create Project</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
