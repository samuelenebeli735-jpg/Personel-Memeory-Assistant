import { projectsApi } from "../lib/api";
import { useTimeZone } from "../hooks/useTimeZone";
import { ListPage } from "../components/ListPage";
import { projectFormSpec } from "../components/record-forms";
import { ProjectRow } from "../components/record-rows";
import { ProjectsIcon } from "../components/Layout";

export function ProjectsPage() {
  const { timeZone } = useTimeZone();
  return (
    <ListPage
      title="Projects"
      noun="projects"
      icon={<ProjectsIcon />}
      emptyTitle="No projects yet"
      emptyText="Create a project to organize your tasks, notes, and ideas."
      spec={projectFormSpec}
      fetchPage={(page) => projectsApi.list(page)}
      renderRows={(projects) =>
        projects.map((project) => <ProjectRow key={project.id} project={project} timeZone={timeZone} />)
      }
    />
  );
}
