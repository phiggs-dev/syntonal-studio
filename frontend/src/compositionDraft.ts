/** Draft operations run exclusively; history navigation retains a deferred replacement intent. */
import type { PlanDetail, ScoreVersion } from "./composition";
import type { ReuseDraft } from "./library";
export class DraftOperationGate {
  busy = false;
  async run(task: () => Promise<void>): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      await task();
      return true;
    } finally {
      this.busy = false;
    }
  }
}
export function scoreAncestry(
  plan: PlanDetail | null,
  score: ScoreVersion | null,
  reused: ReuseDraft | null,
) {
  return {
    parent_score_id: score?.id ?? reused?.request.score_version_id ?? null,
    source_generation_id:
      plan?.plan.id ??
      score?.source_generation_id ??
      reused?.parent_generation_id ??
      null,
  };
}
