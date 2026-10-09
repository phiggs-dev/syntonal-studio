/** Job stages are forward-only; HTTP replies and SSE snapshots may arrive out of order. */
import type { GenerationJob } from "./generation";

const stageOrder: Record<GenerationJob["stage"], number> = {
  queued: 0,
  loading: 1,
  planning: 2,
  semantic: 3,
  synthesizing: 4,
  decoding: 5,
  saving: 6,
  complete: 7,
  failed: 7,
  cancelled: 7,
};

function isTerminal(job: GenerationJob): boolean {
  return job.status === "complete" || job.status === "failed" || job.status === "cancelled";
}

export function mergeGenerationJob(
  existing: GenerationJob,
  incoming: GenerationJob,
): GenerationJob {
  // A terminal receipt is final; a delayed acknowledgement must never hide its result.
  const preserveExisting = isTerminal(existing) ||
    (!isTerminal(incoming) && (stageOrder[existing.stage] > stageOrder[incoming.stage] ||
      (stageOrder[existing.stage] === stageOrder[incoming.stage] &&
       (existing.progress_revision ?? 0) > (incoming.progress_revision ?? 0))));
  const latest = preserveExisting ? existing : incoming;
  return {
    ...latest,
    token_count: Math.max(existing.token_count, incoming.token_count),
    cancel_requested: existing.cancel_requested || incoming.cancel_requested,
  };
}

export function mergeGenerationJobs(
  existing: GenerationJob[],
  incoming: GenerationJob[],
): GenerationJob[] {
  const merged = new Map(existing.map((job) => [job.id, job]));
  for (const job of incoming) {
    const previous = merged.get(job.id);
    merged.set(job.id, previous ? mergeGenerationJob(previous, job) : job);
  }
  // Snapshots taken before a new submission must not temporarily remove that job.
  return [...merged.values()].sort((left, right) =>
    right.created_at.localeCompare(left.created_at),
  );
}
