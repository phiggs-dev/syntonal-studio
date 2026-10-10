/** Original style/lyrics are submitted unchanged; CFG means classifier-free guidance. */
import { useEffect, useId, useState, type FormEvent } from "react";
import {
  cancelGeneration,
  errorMessage,
  submitGeneration,
  type ConditioningMode,
  type GenerationJob,
} from "./generation";

import { getProjects, reuseGeneration, type Project, type ReuseDraft } from "./library";
import { LyricsEditor } from "./LyricsEditor";
import { DraftRecovery } from "./DraftRecovery";
import { useRecoverableDraft } from "./useRecoverableDraft";
import { isInputDraft, inputDraftHasContent, type InputDraft } from "./draftStorage";
import { GenerationProgress } from "./GenerationProgress";
import { generationStageLabels as stageLabels, isActiveGeneration, primaryGeneration, prioritizeGenerationJobs } from "./generationProgressModel";

const modes: { value: ConditioningMode; title: string; detail: string }[] = [
  {
    value: "full",
    title: "Full · recommended",
    detail: "Create a melody-and-chord symbolic plan before recording.",
  },
  {
    value: "melody",
    title: "Melody",
    detail: "Create a melody plan with freer accompaniment.",
  },
  {
    value: "off",
    title: "Off",
    detail: "Generate directly from style and lyrics, without a symbolic plan.",
  },
];
function randomSeed(): string {
  const words = crypto.getRandomValues(new Uint32Array(2));
  return ((BigInt(words[0] & 0x7fffffff) << 32n) | BigInt(words[1])).toString();
}
interface CreateWorkspaceProps {
  draftScope: string | null;
  jobs: GenerationJob[];
  connection: string;
  updatesLive?: boolean;
  settingsDirty: boolean;
  rememberJob: (job: GenerationJob) => void;
  onListen: (job: GenerationJob) => void;
  projects: Project[];
  draft: ReuseDraft | null;
}
export function CreateWorkspace({
  draftScope,
  jobs,
  connection,
  updatesLive = true,
  settingsDirty,
  rememberJob,
  onListen,
  projects,
  draft,
}: CreateWorkspaceProps) {
  const generationFormId = useId();
  const [projectId, setProjectId] = useState("");
  const [parentId, setParentId] = useState<string | null>(null);
  const [pendingDraft, setPendingDraft] = useState<ReuseDraft | null>(null);
  useEffect(() => {
    if (draft) setPendingDraft(draft);
  }, [draft]);
  function applyDraft() {
    if (!pendingDraft) return;
    const request = pendingDraft.request;
    setTitle(request.title);
    setStyle(request.style);
    setLyrics(request.lyrics);
    setMode(request.cot);
    setSeed(request.seed);
    setGuidance(request.cfg_scale === null ? "" : String(request.cfg_scale));
    setProjectId(pendingDraft.project_id ?? "");
    setParentId(pendingDraft.parent_generation_id);
    setPendingDraft(null);
    setError("");
    setReceipt(
      "Original inputs loaded. Review or edit them before generating with your current saved settings.",
    );
  }
  const [title, setTitle] = useState("");
  const [style, setStyle] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [mode, setMode] = useState<ConditioningMode>("full");
  const [seed, setSeed] = useState("831001");
  const [guidance, setGuidance] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState("");
  const [cancelling, setCancelling] = useState<string[]>([]);
  const recovery = useRecoverableDraft<InputDraft>({
    scope: draftScope, workspace: "create", validate: isInputDraft, hasContent: inputDraftHasContent,
    data: { title, style, lyrics, mode, seed, guidance, projectId, parentId },
    onRestore: async value => {
      const notices: string[] = [];
      const [projectResult, parentResult] = await Promise.allSettled([
        value.projectId ? getProjects() : Promise.resolve(null),
        value.parentId ? reuseGeneration(value.parentId) : Promise.resolve(null),
      ]);
      const projectValid = !value.projectId || projectResult.status === "fulfilled" && projectResult.value?.projects.some(project => project.id === value.projectId);
      const parentValid = !value.parentId || parentResult.status === "fulfilled";
      if (!projectValid) notices.push("The old project could not be verified; this draft is unassigned.");
      if (!parentValid) notices.push("The source recording could not be verified; its lineage link was removed.");
      setTitle(value.title); setStyle(value.style); setLyrics(value.lyrics); setMode(value.mode);
      setSeed(value.seed); setGuidance(value.guidance); setProjectId(projectValid ? value.projectId : "");
      setParentId(parentValid ? value.parentId : null); setError("");
      setReceipt(["Draft restored. Review before generating; no job was queued.", ...notices].join(" "));
    },
  });
  const activeJobs = jobs.filter(
    (job) => job.status === "running" || job.status === "queued",
  ).length;
  const currentJob = primaryGeneration(jobs);
  const orderedJobs = prioritizeGenerationJobs(jobs);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!recovery.ready || recovery.restoring || submitting) return;
    setError("");
    setReceipt("");
    if (!/^\d+$/.test(seed) || BigInt(seed) > 9223372036854775807n) {
      setError(
        "Seed must be a whole number between 0 and 9223372036854775807.",
      );
      return;
    }
    const cfgScale = guidance === "" ? null : Number(guidance);
    if (
      cfgScale !== null &&
      (!Number.isFinite(cfgScale) || cfgScale < 0 || cfgScale > 20)
    ) {
      setError(
        "CFG scale must be between 0 and 20, or blank for the upstream default.",
      );
      return;
    }
    setSubmitting(true);
    try {
      const job = await submitGeneration({
        project_id: projectId || null,
        parent_generation_id: parentId,
        title,
        style,
        lyrics,
        cot: mode,
        seed,
        cfg_scale: cfgScale,
      });
      rememberJob(job);
      setReceipt(
        `Generation queued: ${job.title || job.id}. Your inputs remain here for another take.`,
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }
  async function cancel(id: string) {
    setCancelling((previous) => [...previous, id]);
    setError("");
    try {
      rememberJob(await cancelGeneration(id));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setCancelling((previous) => previous.filter((value) => value !== id));
    }
  }
  return (
    <>
    <DraftRecovery recovery={recovery} disabled={submitting} />
    <div className="create-grid">
      <form
        id={generationFormId}
        inert={!recovery.ready || recovery.restoring}
        className="panel composition-panel"
        onSubmit={(event) => void submit(event)}
      >
        <div className="section-heading">
          <div>
            <span className="eyebrow">START WITH AN IDEA</span>
            <h2>Your next song</h2>
          </div>
          <span className="muted">One request. One recording.</span>
        </div>
        {pendingDraft && (
          <div className="notice warning">
            <p>
              Load the original inputs from generation{" "}
              {pendingDraft.parent_generation_id}? This replaces the current
              Create draft. No generation starts automatically.
            </p>
            {pendingDraft.warnings.map((warning, index) => (
              <p key={index}>{warning}</p>
            ))}
            <button
              type="button"
              className="primary-button"
              onClick={applyDraft}
            >
              Load these inputs
            </button>{" "}
            <button
              type="button"
              className="text-button"
              onClick={() => setPendingDraft(null)}
            >
              Keep current draft
            </button>
          </div>
        )}
        {parentId && (
          <p className="field-help">
            Derived from {parentId}.{" "}
            <button
              type="button"
              className="text-button"
              onClick={() => setParentId(null)}
            >
              Start independent recording
            </button>
          </p>
        )}
        <div className="field">
          <label htmlFor="song-project">Project</label>
          <select
            id="song-project"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            <option value="">Unassigned</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="song-title">
            Song name <span className="muted">(optional)</span>
          </label>
          <input
            id="song-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={200}
            placeholder="Untitled idea"
          />
        </div>
        <div className="field">
          <label htmlFor="song-style">Style</label>
          <textarea
            id="song-style"
            value={style}
            onChange={(event) => setStyle(event.target.value)}
            rows={4}
            required
            placeholder="Warm indie folk, English vocals, fingerpicked acoustic guitar, gentle percussion, intimate live-room sound"
          />
          <p className="field-help">
            Describe genre, voices, instruments, mood, and arrangement in your
            own words.
          </p>
        </div>
        <LyricsEditor id="song-lyrics" value={lyrics} onChange={setLyrics} rows={11} required />
        <fieldset className="mode-fieldset">
          <legend>Symbolic conditioning (COT)</legend>
          <div className="mode-options">
            {modes.map((item) => (
              <label
                className={`mode-option ${mode === item.value ? "selected" : ""}`}
                key={item.value}
              >
                <input
                  type="radio"
                  name="conditioning"
                  value={item.value}
                  checked={mode === item.value}
                  onChange={() => setMode(item.value)}
                />
                <span>
                  <strong>{item.title}</strong>
                  <small>{item.detail}</small>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="field">
          <label htmlFor="song-seed">Seed</label>
          <div className="seed-row">
            <input
              id="song-seed"
              inputMode="numeric"
              pattern="[0-9]+"
              value={seed}
              onChange={(event) => setSeed(event.target.value)}
              required
            />
            <button
              type="button"
              className="secondary-button"
              onClick={() => setSeed(randomSeed())}
            >
              Randomize
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={!jobs.length}
              onClick={() => {
                if (jobs[0]) setSeed(jobs[0].request.seed);
              }}
            >
              Reuse last
            </button>
          </div>
          <p className="field-help">
            Kept for each take until you change it. Model and environment
            changes can affect reproduction.
          </p>
        </div>
        <details className="advanced-details">
          <summary>Advanced generation settings</summary>
          <div className="field">
            <label htmlFor="song-guidance">CFG scale (optional)</label>
            <input
              id="song-guidance"
              type="number"
              min="0"
              max="20"
              step="any"
              value={guidance}
              placeholder={mode === "off" ? "Default: 1.01" : "Default: 1.0"}
              onChange={(event) => setGuidance(event.target.value)}
            />
            <p className="field-help">
              Blank uses YuE2’s {mode === "off" ? "1.01" : "1.0"} default for
              this mode. Higher values are not inherently better.
            </p>
          </div>
        </details>
        {settingsDirty && (
          <p className="notice warning">
            Settings have unsaved changes. Generation uses your last saved
            configuration.
          </p>
        )}
        <p className="field-help">
          Original audio and generation artifacts are saved to your configured
          output folder.
        </p>
      </form>
      <section className="panel jobs-panel" aria-label="Generation jobs">
        <div className="section-heading generations-heading">
          <div>
            <h2>Generations</h2>
            <span className="queue-count">{activeJobs} active / queued</span>
          </div>
          <button
            type="submit"
            form={generationFormId}
            className="primary-button"
            disabled={submitting || !recovery.ready || recovery.restoring}
          >
            {submitting ? "Submitting…" : "Generate song ↗"}
          </button>
        </div>
        <p className="field-help" role="status">
          {connection}
        </p>
        {error && (
          <div role="alert" className="notice error">
            {error}
          </div>
        )}
        {receipt && (
          <div role="status" className="notice success">
            {receipt}
          </div>
        )}
        {currentJob && <div className="active-generation" id={`create-generation-${currentJob.id}`} tabIndex={-1}>
          <h3>{currentJob.title || "Untitled recording"}</h3>
          <GenerationProgress job={currentJob} updatesLive={updatesLive} />
          <button type="button" className="text-button"
            disabled={currentJob.cancel_requested || cancelling.includes(currentJob.id)}
            onClick={() => void cancel(currentJob.id)}
          >{currentJob.cancel_requested ? "Stopping…" : "Cancel"}</button>
        </div>}
        <div className="generation-job-list" aria-label="Generation history" tabIndex={0}>
        {!jobs.length && (
          <div className="empty-jobs">
            <span aria-hidden="true">♫</span>
            <h3>Make your first recording</h3>
            <p>
              Your queued, completed, and failed generations will appear here.
            </p>
          </div>
        )}
        {orderedJobs.map((job) => {
          const card = <article className="job-card" key={job.id} id={`create-generation-details-${job.id}`} tabIndex={-1}>

            <div className="job-heading">
              <h3>{job.title || "Untitled recording"}</h3>
              <span className={`job-status status-${job.status}`}>
                {stageLabels[job.stage]}
              </span>
            </div>
            <p className="job-time">
              {new Date(job.created_at).toLocaleString()} · {job.request.cot} ·
              Seed {job.request.seed}
            </p>
            {isActiveGeneration(job) && job.id !== currentJob?.id && (
              <GenerationProgress job={job} updatesLive={updatesLive} />
            )}
            {job.error && <div className="notice error">{job.error}</div>}
            {job.truncated && (
              <div className="notice warning">
                Generation reached a model/token limit and may be incomplete.
              </div>
            )}
            <div className="job-actions">
              {job.audio_url && (
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => onListen(job)}
                >
                  Listen
                </button>
              )}
              {(job.status === "queued" || job.status === "running") && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={job.cancel_requested || cancelling.includes(job.id)}
                  onClick={() => void cancel(job.id)}
                >
                  {job.cancel_requested ? "Cancellation requested" : "Cancel"}
                </button>
              )}
              <button
                type="button"
                className="text-button"
                onClick={() => setSeed(job.request.seed)}
              >
                Reuse seed
              </button>
            </div>
            {(job.status === "running" || job.status === "cancelled") && (
              <p className="field-help">
                Cancellation stops at a safe boundary. Interrupted generations
                cannot resume.
              </p>
            )}
            <details className="advanced-details">
              <summary>Job details & original inputs</summary>
              <dl className="job-metadata">
                <dt>Generation ID</dt>
                <dd>{job.id}</dd>
                <dt>Output folder</dt>
                <dd>{job.output_directory}</dd>
                <dt>CFG scale</dt>
                <dd>
                  {job.request.cfg_scale ??
                    `Upstream default (${job.request.cot === "off" ? "1.01" : "1.0"})`}
                </dd>
                <dt>Style</dt>
                <dd className="original-text">{job.request.style}</dd>
                <dt>Lyrics</dt>
                <dd className="original-text">{job.request.lyrics}</dd>
              </dl>
              <a
                href={`/api/jobs/${encodeURIComponent(job.id)}/log`}
                target="_blank"
                rel="noreferrer"
              >
                Open generation log ↗
              </a>
            </details>
          </article>;
          return job.id === currentJob?.id
            ? <details className="current-generation-details" key={job.id}>
                <summary>Current job details &amp; original inputs</summary>{card}
              </details>
            : card;
        })}
        </div>
      </section>
    </div>
    </>
  );
}

/** Native audio controls retain playback state because this component remains mounted across navigation. */
export function GenerationPlayer({
  job,
  decoder,
}: {
  job: GenerationJob | undefined;
  decoder?: string | null;
}) {
  const [loop, setLoop] = useState(false);
  const [failedAudioUrl, setFailedAudioUrl] = useState<string | null>(null);
  const [detailsCollapsed, setDetailsCollapsed] = useState(true);
  const playerDetailsId = useId();
  const playerActionsId = useId();
  const isCollapsed = Boolean(job?.audio_url) && detailsCollapsed;
  return (
    <section
      className={`persistent-player${isCollapsed ? " player-collapsed" : ""}`}
      aria-label="Audio player"
    >
      <div className="player-description">
        <span className="eyebrow" hidden={isCollapsed}>
          NOW LISTENING
        </span>
        <strong>
          {job ? job.title || "Untitled recording" : "Your next recording"}
        </strong>
        <div className="player-details" id={playerDetailsId} hidden={isCollapsed}>
          <span className="player-metadata">
            {job
              ? `${job.sample_rate ?? "—"} Hz · ${job.channels ?? "—"} channels · ${job.duration_seconds?.toFixed(1) ?? "—"} s`
              : "Choose Listen on a completed generation."}
          </span>
          {decoder && <small>Decoder: {decoder}</small>}
          {job && <small className="player-id">{job.id}</small>}
        </div>
      </div>
      {job?.audio_url ? (
        <div className="player-controls">
          <audio
            controls
            preload="metadata"
            src={job.audio_url}
            loop={loop}
            onError={() => setFailedAudioUrl(job.audio_url)}
            onPlaying={() => setFailedAudioUrl(null)}
            aria-label={`Play ${job.title || job.id}`}
          />
          <div className="player-actions" id={playerActionsId} hidden={isCollapsed}>
            <label>
              <input
                type="checkbox"
                checked={loop}
                onChange={(event) => setLoop(event.target.checked)}
              />{" "}
              Loop
            </label>
            <a href={job.audio_url} download={`${job.id}.flac`}>
              Download original FLAC
            </a>
          </div>
          {failedAudioUrl === job.audio_url && (
            <p role="alert" className="notice error">
              Audio could not play. Try the original FLAC download or another
              browser.
            </p>
          )}
          {job.truncated && (
            <p className="notice warning">
              This recording may be incomplete: YuE2 reported truncation.
            </p>
          )}
        </div>
      ) : (
        <span className="muted">No audio selected</span>
      )}
      {job?.audio_url && (
        <button
          type="button"
          className="player-toggle"
          aria-expanded={!isCollapsed}
          aria-controls={`${playerDetailsId} ${playerActionsId}`}
          aria-label={
            isCollapsed ? "Expand player details" : "Collapse player details"
          }
          title={
            isCollapsed ? "Expand player details" : "Collapse player details"
          }
          onClick={() => setDetailsCollapsed((collapsed) => !collapsed)}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d={isCollapsed ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
    </section>
  );
}
