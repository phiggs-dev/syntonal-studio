/** Workflow milestones are not equal portions of generation time. */
import type { GenerationJob } from "./generation";

export const generationStageLabels: Record<GenerationJob["stage"], string> = {
  queued: "Queued", loading: "Preparing models", planning: "Planning the score",
  semantic: "Generating the song", synthesizing: "Synthesizing audio",
  decoding: "Decoding audio", saving: "Saving recording", complete: "Complete",
  failed: "Failed", cancelled: "Cancelled",
};
export function isActiveGeneration(job: GenerationJob): boolean {
  return job.status === "running" || job.status === "queued";
}
export function prioritizeGenerationJobs(jobs: GenerationJob[]): GenerationJob[] {
  return [...jobs].sort((left, right) => {
    const rank = (job: GenerationJob) => job.status === "running" ? 0 : job.status === "queued" ? 1 : 2;
    const difference = rank(left) - rank(right);
    if (difference) return difference;
    if (left.status === "queued" && right.status === "queued") {
      return (left.queue_position ?? Infinity) - (right.queue_position ?? Infinity) || left.created_at.localeCompare(right.created_at);
    }
    return right.created_at.localeCompare(left.created_at);
  });
}
export function primaryGeneration(jobs: GenerationJob[]): GenerationJob | undefined {
  return prioritizeGenerationJobs(jobs).find(isActiveGeneration);
}
export function generationSteps(job: GenerationJob): { stage: GenerationJob["stage"]; label: string }[] {
  const steps: { stage: GenerationJob["stage"]; label: string }[] = [{ stage: "loading", label: "Prepare" }];
  const useScore = job.request.operation === "exact_plan" || Boolean(job.request.abc);
  if (job.request.cot !== "off") steps.push({ stage: "planning", label: useScore ? "Use score" : "Plan" });
  if (job.request.operation !== "plan") {
    steps.push({ stage: "semantic", label: "Generate" }, { stage: "synthesizing", label: "Synthesize" }, { stage: "decoding", label: "Decode" });
  }
  steps.push({ stage: "saving", label: "Save" });
  return steps;
}
export function generationProgressView(job: GenerationJob) {
  const progress = job.progress;
  let label = job.stage === "saving" && job.request.operation === "plan"
    ? "Saving composition plan" : generationStageLabels[job.stage];
  if (job.status === "running" && progress) {
    const labels: Record<string, string> = {
      "Loading model": "Loading music model…", "Loading audio decoder": "Loading audio decoder…",
      "Using provided score": "Using saved score", "Planning score": "Planning the score",
      "Generating song": "Generating the song", "Synthesizing audio": "Synthesizing audio",
      "Decoding audio": "Decoding audio",
    };
    label = labels[progress.label] ?? label;
  }
  if (job.status === "running" && job.stage === "planning" && job.request.operation === "exact_plan") label = "Using saved score";
  let total: number | null = null;
  let completed: number | null = null;
  const matchesMeasuredStage = progress && (
    (job.stage === "synthesizing" && progress.label === "Synthesizing audio" && progress.unit === "steps") ||
    (job.stage === "decoding" && progress.label === "Decoding audio" && progress.unit === "chunks")
  );
  if (job.status === "running" && matchesMeasuredStage && progress &&
      typeof progress.total === "number" && Number.isFinite(progress.total) && progress.total > 0 &&
      Number.isFinite(progress.completed) && progress.completed >= 0) {
    total = progress.total;
    completed = Math.min(progress.completed, total);
  }
  // Submitted GPU work can reach its total before the native method returns.
  const finishing = total !== null && completed !== null && completed >= total;
  if (finishing) label = job.stage === "synthesizing" ? "Finishing synthesis…" : "Finalizing decoded audio…";
  let detail = "Working on your recording";
  if (total !== null && completed !== null) {
    detail = `${completed.toLocaleString()} of ${total.toLocaleString()} ${job.stage === "synthesizing" ? "synthesis steps" : "audio chunks"}`;
  } else if (job.status === "queued") {
    detail = job.queue_position ? `Position ${job.queue_position} in queue · Waiting to start` : "Waiting to start";
  } else if (job.stage === "planning") {
    const reusesScore = job.request.operation === "exact_plan" || Boolean(job.request.abc);
    detail = reusesScore ? "Reusing the selected score" : "Composing the score";
  } else if (job.stage === "semantic") {
    detail = "Building the musical performance";
  } else if (job.stage === "loading") {
    detail = "Preparing models and local files";
  } else if (job.stage === "saving") {
    detail = job.request.operation === "plan" ? "Saving the composition plan" : "Saving audio and original artifacts";
  } else if (progress?.label === "Loading audio decoder") {
    detail = "Preparing the audio decoder";
  }
  return { label, detail, total, completed, finishing };
}
export function generationElapsed(job: GenerationJob, now: number): string | null {
  if (!job.started_at) return null;
  const start = Date.parse(job.started_at);
  const end = job.finished_at ? Date.parse(job.finished_at) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  return seconds >= 3600
    ? `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
    : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
