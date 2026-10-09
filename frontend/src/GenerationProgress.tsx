import { useEffect, useId, useState } from "react";
import type { GenerationJob } from "./generation";
import {
  generationElapsed, generationProgressView, generationSteps,
  isActiveGeneration, primaryGeneration,
} from "./generationProgressModel";

function GenerationElapsed({ job }: { job: GenerationJob }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (job.status !== "running") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [job.status]);
  const elapsed = generationElapsed(job, now);
  return elapsed ? <span className="generation-elapsed" aria-live="off">Elapsed {elapsed}</span> : null;
}

export function GenerationProgress({ job, updatesLive = true }: {
  job: GenerationJob; updatesLive?: boolean;
}) {
  const labelId = useId();
  const view = generationProgressView(job);
  const steps = generationSteps(job);
  const activeIndex = steps.findIndex(step => step.stage === job.stage);
  const active = isActiveGeneration(job);
  return <div className={`generation-progress${updatesLive ? "" : " generation-progress-offline"}`}>
    <div className="generation-progress-heading">
      <span id={labelId} role="status">
        {job.cancel_requested && active ? "Stopping at a safe boundary…" : view.label}
      </span>
      <GenerationElapsed job={job} />
    </div>
    {job.status !== "queued" && active && <ol className="generation-steps" aria-label="Generation stages">
      {steps.map((step, index) => <li
        key={step.stage}
        aria-current={index === activeIndex ? "step" : undefined}
        className={index < activeIndex ? "generation-step-complete" : index === activeIndex ? "generation-step-current" : ""}
      >
        <span aria-hidden="true">{index < activeIndex ? "✓" : index === activeIndex ? "●" : "○"}</span> {step.label}
        <span className="screen-reader-only">
          {index < activeIndex ? " completed" : index === activeIndex ? " current" : " pending"}
        </span>
      </li>)}
    </ol>}
    {job.status === "running" && (view.total !== null && view.completed !== null
      ? <progress className="generation-meter" max={view.total} value={view.completed}
          aria-labelledby={labelId} aria-valuetext={view.detail} />
      : <div className="generation-activity" role="progressbar" aria-labelledby={labelId}><span /></div>)}
    {active && <p className="generation-progress-detail">{view.detail}</p>}
    {!updatesLive && active && <p className="generation-progress-detail" role="status">
      Live updates reconnecting. Showing the last reported stage.
    </p>}
    {job.progress?.unit === "tokens" && active && <details className="generation-token-details">
      <summary>Progress details</summary>
      <span>{job.progress.completed.toLocaleString()} tokens generated in this stage.</span>
    </details>}
  </div>;
}

export function GenerationStatusChip({ jobs, onOpen, updatesLive = true }: {
  jobs: GenerationJob[]; updatesLive?: boolean; onOpen: (job: GenerationJob) => void;
}) {
  const job = primaryGeneration(jobs);
  if (!job) return null;
  const view = generationProgressView(job);
  const title = job.title || "Untitled recording";
  const status = job.cancel_requested ? "Stopping…" : updatesLive ? view.label : `Last reported: ${view.label}`;
  const queued = jobs.filter(item => item.status === "queued").length;
  return <button type="button" className="generation-status-chip" onClick={() => onOpen(job)}
    title={`${title} · ${status}${queued ? ` · ${queued} queued` : ""}`}
    aria-label={`Open generation progress for ${title}: ${status}`}
  >
    <span className={job.status === "running" && updatesLive ? "generation-status-dot running" : "generation-status-dot"} aria-hidden="true" />
    <span>{title} · {status}{queued ? ` · ${queued} queued` : ""}</span>
  </button>;
}
