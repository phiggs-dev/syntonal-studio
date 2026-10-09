/** Project metadata is edited independently of immutable song inputs and artifacts. */
import { useState, type FormEvent } from "react";
import { saveProject, type Project } from "./library";
import { errorMessage } from "./generation";
export function ProjectsWorkspace({
  projects,
  onSaved,
  onOpen,
}: {
  projects: Project[];
  onSaved: () => void;
  onOpen: (id: string) => void;
}) {
  const [selected, setSelected] = useState<Project | null>(null);
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [tags, setTags] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  function edit(project: Project | null) {
    setSelected(project);
    setName(project?.name ?? "");
    setNotes(project?.notes ?? "");
    setTags(project?.tags.join(", ") ?? "");
    setError("");
    setNotice("");
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const project = await saveProject(
        {
          name,
          notes,
          tags: tags
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean),
        },
        selected?.id,
      );
      setSelected(project);
      setNotice("Project saved.");
      onSaved();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="library-grid">
      <section className="panel">
        <div className="section-heading">
          <h2>Your projects</h2>
          <button className="secondary-button" onClick={() => edit(null)}>
            New project
          </button>
        </div>
        {projects.length === 0 && (
          <p>
            Create a project to organize recordings, notes, and related takes.
          </p>
        )}
        {projects.map((project) => (
          <article className="job-card" key={project.id}>
            <h3>{project.name}</h3>
            <p className="original-text">{project.notes}</p>
            <p className="field-help">{project.tags.join(" · ")}</p>
            <div className="job-actions">
              <button
                className="primary-button"
                onClick={() => onOpen(project.id)}
              >
                Open recordings
              </button>
              <button
                className="secondary-button"
                onClick={() => edit(project)}
              >
                Edit project
              </button>
              <a href={`/api/projects/${project.id}/export`} download>
                Export manifest
              </a>
            </div>
          </article>
        ))}
      </section>
      <form className="panel" onSubmit={(event) => void submit(event)}>
        <h2>{selected ? "Edit project" : "New project"}</h2>
        <fieldset className="settings-fieldset" disabled={busy}>
          <div className="field">
            <label htmlFor="project-name">Project name</label>
            <input
              id="project-name"
              value={name}
              required
              maxLength={200}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="project-notes">Notes</label>
            <textarea
              id="project-notes"
              rows={6}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="project-tags">Tags (comma separated)</label>
            <input
              id="project-tags"
              value={tags}
              onChange={(event) => setTags(event.target.value)}
            />
          </div>
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="notice success">
              {notice}
            </p>
          )}
          <button className="primary-button">
            {busy ? "Saving…" : "Save project"}
          </button>
        </fieldset>
      </form>
    </div>
  );
}
