/** Compose stores immutable ABC versions; exact reuse keeps the native plan request and tokens. */
import { useEffect, useRef, useState } from "react";
import { GenerationProgress } from "./GenerationProgress";
import { isActiveGeneration, primaryGeneration, prioritizeGenerationJobs } from "./generationProgressModel";
import { VisualScoreEditor } from "./VisualScoreEditor";
import type { EditorMetadata } from "./visualScore";
import { DraftOperationGate, scoreAncestry } from "./compositionDraft";
import {
  cancelGeneration,
  errorMessage,
  type GenerationJob,
  type GenerationRequest,
} from "./generation";
import type { Project, ReuseDraft } from "./library";
import {
  composePost,
  listPlans,
  listScores,
  loadPlan,
  queuePlan,
  renderPlan,
  renderScore,
  saveScore,
  validateSeed,
  type PlanDetail,
  type PlanSummary,
  type ScoreVersion,
  type ValidationReport,
  type ComparisonReport,
} from "./composition";
interface Props {
  projects: Project[];
  jobs: GenerationJob[];
  rememberJob: (job: GenerationJob) => void;
  settingsDirty: boolean;
  draft: ReuseDraft | null;
  openPlanId: string | null;
  openPlanNonce: number;
  active: boolean;
  updatesLive?: boolean;
}
const emptyRequest: GenerationRequest = {
  title: "",
  style: "",
  lyrics: "",
  cot: "full",
  seed: "831001",
  cfg_scale: null,
  project_id: null,
};
export default function ComposeWorkspace({
  projects,
  jobs,
  rememberJob,
  settingsDirty,
  draft,
  openPlanId,
  openPlanNonce,
  active,
  updatesLive = true,
}: Props) {
  const compositionJobs = prioritizeGenerationJobs(jobs.filter(job =>
    job.request.operation === "plan" || job.request.operation === "exact_plan" || job.request.score_version_id,
  ));
  const currentJob = primaryGeneration(compositionJobs);
  const [request, setRequest] = useState(emptyRequest);
  const [guidance, setGuidance] = useState("");
  const [inputBaseline, setInputBaseline] = useState(
    JSON.stringify(emptyRequest),
  );
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [scores, setScores] = useState<ScoreVersion[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [plan, setPlan] = useState<PlanDetail | null>(null);
  const [score, setScore] = useState<ScoreVersion | null>(null);
  const [abc, setAbc] = useState("");
  const [baseline, setBaseline] = useState("");
  const [editorMetadata, setEditorMetadata] = useState<EditorMetadata | null>(null);
  const [metadataBaseline, setMetadataBaseline] = useState("null");
  const [editorRevision, setEditorRevision] = useState(0);
  const [scoreTitle, setScoreTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const operations = useRef(new DraftOperationGate());
  const [pendingPlan, setPendingPlan] = useState<string | null>(null);
  const [reusedSource, setReusedSource] = useState<ReuseDraft | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [validation, setValidation] = useState<{
    abc: string;
    value: ValidationReport;
  } | null>(null);
  const [comparison, setComparison] = useState<{
    abc: string;
    value: ComparisonReport;
  } | null>(null);
  const [voices, setVoices] = useState<"both" | "Vocal" | "Ins">("both");
  const [allowTempo, setAllowTempo] = useState(false);
  const [exactConfirm, setExactConfirm] = useState(false);
  const [pendingDraft, setPendingDraft] = useState<ReuseDraft | null>(null);
  const dirty = abc !== baseline || JSON.stringify(editorMetadata) !== metadataBaseline;
  const inputsDirty =
    JSON.stringify(request) !== inputBaseline ||
    guidance !== (request.cfg_scale === null ? "" : String(request.cfg_scale));
  const catalogRevision = jobs
    .filter((job) => job.status === "complete")
    .map((job) => job.id)
    .join(",");
  const refreshId = useRef(0);
  async function refresh() {
    const id = ++refreshId.current;
    try {
      const [p, s] = await Promise.all([listPlans(), listScores()]);
      if (id !== refreshId.current) return;
      setPlans(p.plans);
      setScores(s.scores);
      setWarnings([...p.warnings, ...s.warnings]);
    } catch (error) {
      if (id === refreshId.current) setError(errorMessage(error));
    }
  }
  useEffect(() => {
    if (active) void refresh();
  }, [active, catalogRevision]);
  useEffect(() => {
    if (draft) setPendingDraft(draft);
  }, [draft]);
  useEffect(() => {
    if (openPlanId) void choosePlan(openPlanId);
  }, [openPlanId, openPlanNonce]);
  useEffect(() => {
    if (!dirty && !inputsDirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, inputsDirty]);
  async function action(task: () => Promise<void>) {
    if (operations.current.busy) {
      setNotice(
        "Another composition action is finishing. Please retry this action afterward.",
      );
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operations.current.run(task);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  function mayReplace() {
    return (
      (!dirty && !inputsDirty) ||
      window.confirm(
        "Replace the current composition draft? Save a score version or export ABC first to preserve unsaved edits.",
      )
    );
  }
  function replace(text: string, title: string) {
    setReusedSource(null);
    setAbc(text);
    setBaseline(text);
    setEditorMetadata(null);
    setMetadataBaseline("null");
    setEditorRevision(previous => previous + 1);
    setScoreTitle(title);
    setValidation(null);
    setComparison(null);
    setExactConfirm(false);
  }
  function applyRequest(value: GenerationRequest) {
    const next = {
      ...value,
      cot: value.cot === "off" ? ("full" as const) : value.cot,
    };
    setRequest(next);
    setInputBaseline(JSON.stringify(next));
    setGuidance(value.cfg_scale === null ? "" : String(value.cfg_scale));
  }
  async function choosePlan(id: string) {
    if (operations.current.busy) {
      setPendingPlan(id);
      return;
    }
    if (!mayReplace()) return;
    setPendingPlan(null);
    await action(async () => {
      const value = await loadPlan(id);
      setPlan(value);
      setScore(null);
      replace(value.abc, value.plan.title);
      applyRequest(value.request);
    });
  }
  function chooseScore(value: ScoreVersion) {
    if (operations.current.busy || !mayReplace()) return;
    setScore(value);
    setPlan(null);
    replace(value.abc, value.title);
    const metadata = value.editor_metadata ?? null;
    setEditorMetadata(metadata);
    setMetadataBaseline(JSON.stringify(metadata));
    setRequest((previous) => ({ ...previous, project_id: value.project_id, ...(metadata ? { lyrics: metadata.lyrics } : {}) }));
  }
  function nativeRequest(): GenerationRequest {
    if (!validateSeed(request.seed))
      throw Error("Seed must be an integer from 0 to 9223372036854775807.");
    if (!request.style.trim() || !request.lyrics.trim())
      throw Error("Style and lyrics are required.");
    const cfg = guidance === "" ? null : Number(guidance);
    if (cfg !== null && (!Number.isFinite(cfg) || cfg < 0 || cfg > 20))
      throw Error(
        "CFG must be from 0 to 20, or blank for the upstream default.",
      );
    return {
      ...request,
      cfg_scale: cfg,
      cot: request.cot === "off" ? "full" : request.cot,
      operation: "song",
      abc: null,
      source_plan_id: null,
      score_version_id: null,
    };
  }
  function queued(job: GenerationJob) {
    rememberJob(job);
    setNotice(
      `Queued ${job.request.operation === "plan" ? "plan" : "recording"}: ${job.id}`,
    );
  }
  const currentValidation = validation?.abc === abc ? validation.value : null;
  const currentComparison = comparison?.abc === abc ? comparison.value : null;
  return (
    <>
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
      {warnings.length > 0 && (
        <details className="notice warning library-warnings">
          <summary>Some saved items need attention ({warnings.length})</summary>
          <ul>
            {warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </details>
      )}
      {pendingPlan && (
        <div className="notice" role="status">
          <p>
            A plan was requested from History while another action was
            finishing. Load it when ready; your current draft remains available.
          </p>
          <button
            className="primary-button"
            disabled={busy}
            onClick={() => void choosePlan(pendingPlan)}
          >
            Load requested plan
          </button>{" "}
          <button className="text-button" onClick={() => setPendingPlan(null)}>
            Keep current draft
          </button>
        </div>
      )}
      {pendingDraft && (
        <div className="notice">
          <p>
            Load historical composition inputs and ABC? This replaces the
            current composition draft. No generation starts.
          </p>
          {pendingDraft.warnings.map((warning, index) => (
            <p key={index}>{warning}</p>
          ))}
          <button
            className="primary-button"
            disabled={busy}
            onClick={() => {
              if (!mayReplace()) return;
              applyRequest(pendingDraft.request);
              setPlan(null);
              setScore(null);
              replace(
                pendingDraft.request.abc ?? "",
                pendingDraft.request.title,
              );
              setRequest((previous) => ({
                ...previous,
                parent_generation_id: pendingDraft.parent_generation_id,
              }));
              setReusedSource(pendingDraft);
              setPendingDraft(null);
            }}
          >
            Load composition inputs
          </button>{" "}
          <button className="text-button" onClick={() => setPendingDraft(null)}>
            Keep current draft
          </button>
        </div>
      )}
      <div className="compose-grid">
        <section className="panel">
          <h2>Plan a composition</h2>
          <p>
            Generate a symbolic plan without audio, or render a saved score
            using these inputs.
          </p>
          {currentJob && <div className="active-generation" tabIndex={-1}>
          <h3>{currentJob.title || "Untitled composition"}</h3>
          <GenerationProgress job={currentJob} updatesLive={updatesLive} />
          <button type="button" className="text-button" disabled={busy || currentJob.cancel_requested}
            onClick={() => void action(async () => rememberJob(await cancelGeneration(currentJob.id)))}
          >{currentJob.cancel_requested ? "Stopping…" : "Cancel"}</button>
        </div>}
        <fieldset className="settings-fieldset" disabled={busy}>
            <div className="field">
              <label htmlFor="compose-project">Project</label>
              <select
                id="compose-project"
                value={request.project_id ?? ""}
                onChange={(event) =>
                  setRequest({
                    ...request,
                    project_id: event.target.value || null,
                  })
                }
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
              <label htmlFor="compose-title">Plan / recording title</label>
              <input
                id="compose-title"
                maxLength={200}
                value={request.title}
                onChange={(event) =>
                  setRequest({ ...request, title: event.target.value })
                }
              />
            </div>
            <div className="field">
              <label htmlFor="compose-style">Style</label>
              <textarea
                id="compose-style"
                rows={3}
                maxLength={100000}
                value={request.style}
                onChange={(event) =>
                  setRequest({ ...request, style: event.target.value })
                }
              />
            </div>
            <div className="field">
              <label htmlFor="compose-lyrics">Lyrics</label>
              <textarea
                id="compose-lyrics"
                rows={7}
                maxLength={100000}
                value={request.lyrics}
                onChange={(event) =>
                  setRequest({ ...request, lyrics: event.target.value })
                }
              />
            </div>
            <div className="fields-grid">
              <div className="field">
                <label htmlFor="compose-cot">Conditioning</label>
                <select
                  id="compose-cot"
                  value={request.cot}
                  onChange={(event) =>
                    setRequest({
                      ...request,
                      cot: event.target.value as "full" | "melody",
                    })
                  }
                >
                  <option value="full">Full: melody and chords</option>
                  <option value="melody">Melody</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="compose-seed">Seed</label>
                <input
                  id="compose-seed"
                  inputMode="numeric"
                  value={request.seed}
                  onChange={(event) =>
                    setRequest({ ...request, seed: event.target.value })
                  }
                />
              </div>
            </div>
            <details className="advanced-details">
              <summary>Advanced</summary>
              <div className="field">
                <label htmlFor="compose-cfg">CFG scale (optional)</label>
                <input
                  id="compose-cfg"
                  type="number"
                  min={0}
                  max={20}
                  step="any"
                  placeholder="Default: 1.0"
                  value={guidance}
                  onChange={(event) => setGuidance(event.target.value)}
                />
              </div>
            </details>
            {settingsDirty && (
              <p className="notice warning">
                Settings have unsaved changes. Jobs use your last saved
                configuration.
              </p>
            )}
            <button
              className="primary-button"
              onClick={() =>
                void action(async () =>
                  queued(await queuePlan(nativeRequest())),
                )
              }
            >
              Generate plan only
            </button>
          </fieldset>
          <h3>Composition jobs</h3>
          {compositionJobs.map((job) => (
              <article className="job-card" key={job.id}>
                <strong>{job.title || job.id}</strong>
                <p>
                  {job.request.operation === "plan" ? "Plan" : "Recording"} ·{" "}
                  {job.stage} · {job.token_count} tokens
                </p>
                {isActiveGeneration(job) && job.id !== currentJob?.id && (
                  <GenerationProgress job={job} updatesLive={updatesLive} />
                )}
                {job.error && <p className="notice error">{job.error}</p>}
                {job.truncated && (
                  <p className="notice warning">
                    Plan or recording reached a token limit.
                  </p>
                )}
                {job.status === "queued" || job.status === "running" ? (
                  <button
                    className="secondary-button"
                    disabled={busy || job.cancel_requested}
                    onClick={() =>
                      void action(async () =>
                        rememberJob(await cancelGeneration(job.id)),
                      )
                    }
                  >
                    {job.cancel_requested ? "Cancellation requested" : "Cancel"}
                  </button>
                ) : (
                  job.status === "complete" && (
                    <button
                      className="secondary-button"
                      disabled={busy}
                      onClick={() => void choosePlan(job.id)}
                    >
                      Load plan
                    </button>
                  )
                )}{" "}
                <a
                  href={`/api/jobs/${job.id}/log`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Log
                </a>
              </article>
            ))}
        </section>
        <section className="panel compose-editor-panel">
          <div className="section-heading">
            <h2>Score workspace</h2>
            <button
              className="text-button"
              disabled={busy}
              onClick={() => void refresh()}
            >
              Refresh library
            </button>
          </div>
          <fieldset className="settings-fieldset" disabled={busy}>
            <div className="field">
              <label htmlFor="compose-plan">Saved native plan</label>
              <select
                id="compose-plan"
                value={plan?.plan.id ?? ""}
                onChange={(event) => {
                  if (event.target.value) void choosePlan(event.target.value);
                }}
              >
                <option value="">Choose a plan…</option>
                {plans.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title || item.id} ·{" "}
                    {new Date(item.created_at).toLocaleString()}
                  </option>
                ))}
              </select>
            </div>
            {plan && (
              <div className="notice">
                <p>
                  Original plan: {plan.plan.cot} · seed {plan.plan.seed}
                  {plan.plan.truncated ? " · Truncated" : ""}
                </p>
                {plan.warnings.map((warning, index) => (
                  <p key={index}>{warning}</p>
                ))}
                <p>
                  Exact reuse retains original style, lyrics, seed, mode and
                  verified tokens. It uses the currently configured model and
                  decoder; identical audio is not guaranteed. Editor changes are
                  not included.
                </p>
                <button
                  className="secondary-button"
                  disabled={!plan.can_reuse_exact}
                  onClick={() => setExactConfirm(true)}
                >
                  Render original plan exactly…
                </button>
                {exactConfirm && (
                  <p>
                    <button
                      className="primary-button"
                      onClick={() =>
                        void action(async () => {
                          queued(await renderPlan(plan.plan.id));
                          setExactConfirm(false);
                        })
                      }
                    >
                      Queue exact plan render
                    </button>{" "}
                    <button
                      className="text-button"
                      onClick={() => setExactConfirm(false)}
                    >
                      Keep editing
                    </button>
                  </p>
                )}
              </div>
            )}
            <div className="field">
              <label htmlFor="compose-score">Saved ABC version</label>
              <select
                id="compose-score"
                value={score?.id ?? ""}
                onChange={(event) => {
                  const value = scores.find(
                    (item) => item.id === event.target.value,
                  );
                  if (value) chooseScore(value);
                }}
              >
                <option value="">Choose a version…</option>
                {scores.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title || "Untitled score"} ·{" "}
                    {new Date(item.created_at).toLocaleString()}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="score-title">Score version title</label>
              <input
                id="score-title"
                maxLength={200}
                value={scoreTitle}
                onChange={(event) => setScoreTitle(event.target.value)}
              />
            </div>
            <div className="job-actions">
              <label className="secondary-button">
                Import ABC
                <input
                  className="abc-file-input"
                  type="file"
                  accept=".abc,.txt,text/plain"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (!file || !mayReplace()) return;
                    void action(async () => {
                      if (file.size > 400000)
                        throw Error(
                          "ABC file is too large. Maximum 100,000 characters.",
                        );
                      const text = await file.text();
                      if (text.length > 100000)
                        throw Error("ABC exceeds 100,000 characters.");
                      setPlan(null);
                      setScore(null);
                      replace("", file.name);
                      setAbc(text);
                    });
                  }}
                />
              </label>
              <button
                className="secondary-button"
                disabled={!abc}
                onClick={() => {
                  const url = URL.createObjectURL(
                    new Blob([abc], { type: "text/plain;charset=utf-8" }),
                  );
                  const anchor = document.createElement("a");
                  anchor.href = url;
                  anchor.download = "score.abc";
                  anchor.click();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                }}
              >
                Export draft ABC
              </button>
            </div>
          </fieldset>
          <div inert={busy}>
            <VisualScoreEditor
              key={editorRevision}
              abc={abc}
              lyrics={request.lyrics}
              onChange={setAbc}
              metadata={editorMetadata}
              onMetadataChange={setEditorMetadata}
              validation={currentValidation}
              active={active && !busy}
              onValidate={() => void action(async () => setValidation({
                abc,
                value: await composePost<ValidationReport>("validate", { abc }),
              }))}
            />
          </div>
          <p className="field-help">
            {abc.length.toLocaleString()} characters ·{" "}
            {dirty ? "Unsaved composition changes" : "Draft matches saved source"} ·
            Ctrl/Cmd+Z undo · Ctrl/Cmd+F search
          </p>
          <fieldset className="settings-fieldset" disabled={busy}>
            <div className="job-actions">
              <button
                className="primary-button"
                disabled={!abc || abc.length > 100000}
                onClick={() =>
                  void action(async () => {
                    const value = await saveScore({
                      title: scoreTitle,
                      abc,
                      editor_metadata: editorMetadata,
                      project_id: request.project_id ?? null,
                      ...scoreAncestry(plan, score, reusedSource),
                    });
                    setScore(value);
                    setBaseline(value.abc);
                    setMetadataBaseline(JSON.stringify(value.editor_metadata ?? null));
                    setNotice(`Saved new immutable score version ${value.id}`);
                    await refresh();
                  })
                }
              >
                Save new version
              </button>
              <button
                className="secondary-button"
                disabled={!abc}
                onClick={() =>
                  void action(async () =>
                    setValidation({
                      abc,
                      value: await composePost<ValidationReport>("validate", {
                        abc,
                      }),
                    }),
                  )
                }
              >
                Validate draft
              </button>
              <button
                className="secondary-button"
                disabled={!score || dirty}
                onClick={() =>
                  void action(async () => {
                    if (score)
                      queued(await renderScore(score.id, nativeRequest()));
                  })
                }
              >
                Render saved score
              </button>
            </div>
            <p className="field-help">
              Edited-score rendering uses the saved ABC and current inputs on
              the left. Save changes first. Supported upstream validation is
              required.
            </p>
            <div className="fields-grid">
              <div className="field">
                <label htmlFor="compose-voices">
                  Voices for compare / chord removal
                </label>
                <select
                  id="compose-voices"
                  value={voices}
                  onChange={(event) =>
                    setVoices(event.target.value as typeof voices)
                  }
                >
                  <option value="both">Both voices</option>
                  <option value="Vocal">Vocal</option>
                  <option value="Ins">Ins</option>
                </select>
              </div>
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={allowTempo}
                  onChange={(event) => setAllowTempo(event.target.checked)}
                />
                Allow tempo change in comparison
              </label>
            </div>
            <div className="job-actions">
              <button
                className="secondary-button"
                disabled={!abc || !baseline}
                onClick={() =>
                  void action(async () =>
                    setComparison({
                      abc,
                      value: await composePost<ComparisonReport>("compare", {
                        before: baseline,
                        after: abc,
                        voices,
                        allow_tempo_change: allowTempo,
                      }),
                    }),
                  )
                }
              >
                Compare with loaded baseline
              </button>
              <button
                className="secondary-button"
                disabled={!abc}
                onClick={() =>
                  void action(async () => {
                    const result = await composePost<{
                      abc: string;
                      validation: ValidationReport;
                    }>("strip-chords", { abc, keep_voice: voices });
                    setAbc(result.abc);
                    setValidation({
                      abc: result.abc,
                      value: result.validation,
                    });
                    setNotice(
                      "Chord removal applied to the draft. Save a new version to retain it.",
                    );
                  })
                }
              >
                Remove chords from draft
              </button>
            </div>
          </fieldset>
          {currentValidation && (
            <div
              className={`notice ${currentValidation.valid ? "success" : "warning"}`}
            >
              <strong>
                {currentValidation.valid
                  ? "Supported by upstream ABC helper"
                  : "Unsupported or invalid ABC"}
              </strong>
              <p>{currentValidation.scope}</p>
              {currentValidation.errors.map((value, index) => (
                <p key={index}>{value}</p>
              ))}
              <details>
                <summary>Validation report</summary>
                <pre className="artifact-preview">
                  {JSON.stringify(currentValidation.report, null, 2)}
                </pre>
              </details>
            </div>
          )}
          {currentComparison && (
            <div className="notice">
              <strong>
                {!currentComparison.valid
                  ? "Comparison unavailable"
                  : currentComparison.match
                    ? "Compared note timing and pitches match"
                    : "Compared score events differ"}
              </strong>
              <p>{currentComparison.scope}</p>
              {[
                ...currentComparison.errors,
                ...currentComparison.differences,
              ].map((value, index) => (
                <p key={index}>{value}</p>
              ))}
              <pre className="artifact-preview">
                {currentComparison.diff || "No text differences."}
              </pre>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
