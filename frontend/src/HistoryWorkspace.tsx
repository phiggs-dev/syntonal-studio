/** History browsing never mutates native files; inspection hashes are requested explicitly. */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { apiRequest } from "./api";
import { errorMessage, type GenerationJob } from "./generation";
import {
  historyPath,
  historyQuery,
  rerunGeneration,
  reuseGeneration,
  updateHistory,
  type Artifact,
  type HistoryEntry,
  type Project,
  type ReuseDraft,
} from "./library";
interface Props {
  projects: Project[];
  initialProject: string;
  onListen: (job: GenerationJob, decoder?: string | null) => void;
  onReuse: (draft: ReuseDraft) => void;
  onQueued: (job: GenerationJob) => void;
  onOpenPlan: (id: string) => void;
}
export function HistoryWorkspace({
  projects,
  initialProject,
  onOpenPlan,
  onListen,
  onReuse,
  onQueued,
}: Props) {
  const [filters, setFilters] = useState<Record<string, string>>({
    project_id: initialProject,
  });
  const [query, setQuery] = useState(
    historyQuery({ project_id: initialProject }),
  );
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError("");
    void apiRequest<{ generations: HistoryEntry[]; warnings: string[] }>(
      `/api/history?${query}`,
    )
      .then((result) => {
        if (current) {
          setEntries(result.generations);
          setWarnings(result.warnings);
        }
      })
      .catch((error) => {
        if (current) setError(errorMessage(error));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [query, revision]);
  const entry = entries.find((item) => item.job.id === selected);
  function filter(key: string, value: string) {
    setFilters((previous) => ({ ...previous, [key]: value }));
  }
  function refresh() {
    setRevision((value) => value + 1);
  }
  return (
    <>
      <section className="panel">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setSelected(null);
            setQuery(historyQuery(filters));
            refresh();
          }}
        >
          <div className="section-heading">
            <h2>Generation history</h2>
            <button className="primary-button" disabled={loading}>
              {loading ? "Loading…" : "Search / refresh"}
            </button>
          </div>
          <div className="history-filters">
            <div className="field">
              <label htmlFor="history-search">Search name, style, lyrics</label>
              <input
                id="history-search"
                value={filters.q ?? ""}
                onChange={(event) => filter("q", event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="history-project">Project</label>
              <select
                id="history-project"
                value={filters.project_id ?? ""}
                onChange={(event) => filter("project_id", event.target.value)}
              >
                <option value="">All projects</option>
                <option value="unassigned">Unassigned</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="history-cot">Conditioning</label>
              <select
                id="history-cot"
                value={filters.cot ?? ""}
                onChange={(event) => filter("cot", event.target.value)}
              >
                <option value="">All modes</option>
                {["full", "melody", "off"].map((mode) => (
                  <option key={mode}>{mode}</option>
                ))}
              </select>
            </div>
            <label className="history-favorite">
              <input
                type="checkbox"
                checked={filters.favorite === "true"}
                onChange={(event) =>
                  filter("favorite", event.target.checked ? "true" : "")
                }
              />{" "}
              Favorites only
            </label>
          </div>
          <details className="advanced-details">
            <summary>More filters</summary>
            <div className="history-filters">
              {[
                ["seed", "Seed", "text"],
                ["model", "Model", "text"],
                ["decoder", "Decoder", "text"],
                ["date_from", "From date", "date"],
                ["date_to", "Through date", "date"],
              ].map(([key, label, type]) => (
                <div className="field" key={key}>
                  <label htmlFor={`filter-${key}`}>{label}</label>
                  <input
                    id={`filter-${key}`}
                    type={type}
                    value={filters[key] ?? ""}
                    onChange={(event) => filter(key, event.target.value)}
                  />
                </div>
              ))}
            </div>
          </details>
        </form>
        {error && (
          <p role="alert" className="notice error">
            {error}
          </p>
        )}
        {warnings.map((warning, index) => (
          <p key={index} className="notice warning">
            {warning}
          </p>
        ))}
      </section>
      <div className="library-grid history-grid">
        <section className="panel">
          {!loading && !entries.length && (
            <p>
              No recordings match these filters. Existing output folders are
              adopted automatically.
            </p>
          )}
          {entries.map((item) => (
            <article
              className={`job-card ${selected === item.job.id ? "selected-history" : ""}`}
              key={item.job.id}
            >
              <div className="job-heading">
                <h3>
                  {item.favorite ? "★ " : ""}
                  {item.display_name || item.job.title || "Untitled recording"}
                </h3>
                <span className={`job-status status-${item.job.status}`}>
                  {item.job.stage}
                </span>
              </div>
              <p className="job-time">
                {new Date(item.job.created_at).toLocaleString()} ·{" "}
                {item.job.request.operation === "plan" ? "Plan only · " : ""}
                {item.job.request.cot} · Seed {item.job.request.seed}
              </p>
              <p className="history-style original-text">
                {item.job.request.style}
              </p>
              <p className="field-help">
                {item.job.duration_seconds?.toFixed(1) ?? "—"} s audio ·{" "}
                {item.generation_seconds?.toFixed(1) ?? "—"} s generation
              </p>
              <p className="field-help">
                Model: {item.model ?? "Unknown"}
                <br />
                Decoder: {item.decoder ?? "Unknown"}
              </p>
              {item.job.truncated && (
                <p className="notice warning">
                  Truncated: recording may be incomplete.
                </p>
              )}
              {item.job.error && (
                <p className="notice error">{item.job.error}</p>
              )}
              <div className="job-actions">
                {item.job.status === "complete" &&
                  item.job.request.cot !== "off" && (
                    <button
                      className="secondary-button"
                      onClick={() => onOpenPlan(item.job.id)}
                    >
                      Open plan in Compose
                    </button>
                  )}
                {item.job.audio_url && (
                  <button
                    className="primary-button"
                    onClick={() =>
                      onListen(
                        {
                          ...item.job,
                          title: item.display_name || item.job.title,
                        },
                        item.decoder,
                      )
                    }
                  >
                    Listen
                  </button>
                )}
                <button
                  className="secondary-button"
                  onClick={() => setSelected(item.job.id)}
                >
                  Details & artifacts
                </button>
              </div>
            </article>
          ))}
        </section>
        {entry ? (
          <HistoryDetails
            key={entry.job.id}
            entry={entry}
            projects={projects}
            onChanged={(updated) =>
              setEntries((previous) =>
                previous.map((item) =>
                  item.job.id === updated.job.id ? updated : item,
                ),
              )
            }
            onReuse={onReuse}
            onQueued={(job) => {
              onQueued(job);
              refresh();
            }}
          />
        ) : (
          <section className="panel">
            <h2>Recording details</h2>
            <p>
              Select a recording to organize it, inspect original artifacts, or
              reuse its inputs.
            </p>
          </section>
        )}
      </div>
    </>
  );
}
function HistoryDetails({
  entry,
  projects,
  onChanged,
  onReuse,
  onQueued,
}: {
  entry: HistoryEntry;
  projects: Project[];
  onChanged: (entry: HistoryEntry) => void;
  onReuse: Props["onReuse"];
  onQueued: Props["onQueued"];
}) {
  const [name, setName] = useState(entry.display_name);
  const [notes, setNotes] = useState(entry.notes);
  const [project, setProject] = useState(entry.project_id ?? "");
  const [favorite, setFavorite] = useState(entry.favorite);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [artifacts, setArtifacts] = useState<Artifact[] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [confirmRerun, setConfirmRerun] = useState(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function action(task: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await task();
    } catch (error) {
      if (active.current) setError(errorMessage(error));
    } finally {
      if (active.current) setBusy(false);
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    await action(async () => {
      const updated = await updateHistory(entry.job.id, {
        display_name: name,
        notes,
        project_id: project || null,
        favorite,
      });
      if (active.current) {
        onChanged(updated);
        setNotice(
          "Recording metadata saved. Original inputs and files are unchanged.",
        );
      }
    });
  }
  return (
    <section className="panel history-details">
      <h2>Recording details</h2>
      <p className="player-id">{entry.job.id}</p>
      <form onSubmit={(event) => void save(event)}>
        <fieldset className="settings-fieldset" disabled={busy}>
          <div className="field">
            <label htmlFor="recording-name">Display name</label>
            <input
              id="recording-name"
              value={name}
              maxLength={200}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="recording-project">Project assignment</label>
            <select
              id="recording-project"
              value={project}
              onChange={(event) => setProject(event.target.value)}
            >
              <option value="">Unassigned</option>
              {projects.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="recording-notes">Notes</label>
            <textarea
              id="recording-notes"
              value={notes}
              rows={3}
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={favorite}
              onChange={(event) => setFavorite(event.target.checked)}
            />{" "}
            Favorite
          </label>
          <button className="secondary-button">Save recording details</button>
        </fieldset>
      </form>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice success" role="status">
          {notice}
        </p>
      )}
      <dl className="job-metadata">
        <dt>Parent generation</dt>
        <dd>
          {entry.parent_generation_id ?? "Original generation"}
          {entry.relation && ` · ${entry.relation}`}
        </dd>
        <dt>Model revision</dt>
        <dd>{entry.model_revision ?? "Not recorded"}</dd>
        <dt>Decoder revision</dt>
        <dd>{entry.decoder_revision ?? "Not recorded"}</dd>
        <dt>Output folder</dt>
        <dd>{entry.job.output_directory}</dd>
      </dl>
      <details className="advanced-details">
        <summary>Original request</summary>
        <pre className="artifact-preview">
          {JSON.stringify(entry.job.request, null, 2)}
        </pre>
      </details>
      <div className="job-actions">
        <button
          className="secondary-button"
          disabled={busy}
          onClick={() =>
            void action(async () => {
              const draft = await reuseGeneration(entry.job.id);
              if (active.current) onReuse(draft);
            })
          }
        >
          Reuse original inputs
        </button>
        <button
          className="secondary-button"
          disabled={
            busy ||
            entry.job.status === "running" ||
            entry.job.status === "queued"
          }
          onClick={() => setConfirmRerun(true)}
        >
          Re-run with saved settings
        </button>
        <a href={`${historyPath(entry.job.id)}/reproduction`} download>
          Export reproduction manifest
        </a>
      </div>
      {confirmRerun && (
        <div className="notice">
          <p>
            Queue a new recording with this generation’s saved request and model
            settings? This uses the GPU and preserves the original. Identical
            audio is not guaranteed.
          </p>
          <button
            className="primary-button"
            disabled={busy}
            onClick={() =>
              void action(async () => {
                const job = await rerunGeneration(entry.job.id);
                if (active.current) {
                  onQueued(job);
                  setConfirmRerun(false);
                  setNotice(`New generation queued: ${job.id}`);
                }
              })
            }
          >
            Queue saved generation
          </button>{" "}
          <button
            className="text-button"
            disabled={busy}
            onClick={() => setConfirmRerun(false)}
          >
            Keep browsing
          </button>
        </div>
      )}
      <div className="section-heading artifact-heading">
        <h3>Original artifacts</h3>
        <button
          className="secondary-button"
          disabled={busy}
          onClick={() =>
            void action(async () => {
              const result = await apiRequest<{
                artifacts: Artifact[];
                warnings: string[];
              }>(`${historyPath(entry.job.id)}/artifacts`);
              if (active.current) {
                setArtifacts(result.artifacts);
                setWarnings(result.warnings);
              }
            })
          }
        >
          {artifacts ? "Recheck integrity" : "Inspect artifacts"}
        </button>
      </div>
      <p className="field-help">
        Inspection reads files and verifies available hashes. Large files can
        take a moment.
      </p>
      {warnings.map((warning, index) => (
        <p key={index} className="notice warning">
          {warning}
        </p>
      ))}
      {artifacts?.map((artifact) => (
        <article className="artifact-card" key={artifact.name}>
          <div className="job-heading">
            <strong>{artifact.name}</strong>
            <span className={`integrity integrity-${artifact.integrity}`}>
              {artifact.integrity}
            </span>
          </div>
          <p className="field-help">
            {artifact.bytes?.toLocaleString() ?? "Unknown"} bytes
          </p>
          {artifact.sha256 && (
            <code className="artifact-hash">SHA-256 {artifact.sha256}</code>
          )}
          {artifact.download_url && (
            <a href={artifact.download_url} download>
              Download original
            </a>
          )}
          {artifact.text_preview !== null && (
            <details>
              <summary>Text preview (first 16 KiB)</summary>
              <pre className="artifact-preview">{artifact.text_preview}</pre>
            </details>
          )}
        </article>
      ))}
    </section>
  );
}
