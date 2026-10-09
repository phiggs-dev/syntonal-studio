/** Composition APIs preserve score text and keep exact token reuse separate from edited conditioning. */
import { apiRequest } from "./api";
import type { GenerationJob, GenerationRequest } from "./generation";
export interface PlanSummary {
  id: string;
  title: string;
  project_id: string | null;
  created_at: string;
  cot: "full" | "melody";
  seed: string;
  truncated: boolean;
  operation: "song" | "plan" | "exact_plan";
}
export interface PlanDetail {
  plan: PlanSummary;
  request: GenerationRequest;
  abc: string;
  can_reuse_exact: boolean;
  warnings: string[];
}
export interface ScoreVersion {
  id: string;
  title: string;
  abc: string;
  created_at: string;
  project_id: string | null;
  parent_score_id: string | null;
  source_generation_id: string | null;
  sha256: string;
}
export interface ValidationReport {
  valid: boolean;
  report: Record<string, unknown> | null;
  errors: string[];
  scope: string;
}
export interface ComparisonReport {
  valid: boolean;
  match: boolean | null;
  differences: string[];
  errors: string[];
  scope: string;
  diff: string;
}
export type ScoreInput = Pick<
  ScoreVersion,
  "title" | "abc" | "project_id" | "parent_score_id" | "source_generation_id"
>;
export const composePost = <T>(path: string, body: unknown) =>
  apiRequest<T>(`/api/compose/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
export const listPlans = () =>
  apiRequest<{ plans: PlanSummary[]; warnings: string[] }>(
    "/api/compose/plans",
  );
export const listScores = () =>
  apiRequest<{ scores: ScoreVersion[]; warnings: string[] }>(
    "/api/compose/scores",
  );
export const loadPlan = (id: string) =>
  apiRequest<PlanDetail>(`/api/compose/plans/${encodeURIComponent(id)}`);
export const saveScore = (body: ScoreInput) =>
  composePost<ScoreVersion>("scores", body);
export const queuePlan = (request: GenerationRequest) =>
  composePost<GenerationJob>("plans", {
    ...request,
    operation: "plan",
    abc: null,
  });
export const renderPlan = (id: string) =>
  composePost<GenerationJob>(`plans/${encodeURIComponent(id)}/render`, {});
export const renderScore = (id: string, request: GenerationRequest) =>
  composePost<GenerationJob>(`scores/${encodeURIComponent(id)}/render`, {
    ...request,
    operation: "song",
    abc: null,
  });
export function validateSeed(seed: string): boolean {
  return /^[0-9]{1,19}$/.test(seed) && BigInt(seed) < 2n ** 63n;
}
export function needsComposition(request: GenerationRequest): boolean {
  return Boolean(
    request.abc ||
    request.source_plan_id ||
    request.score_version_id ||
    (request.operation && request.operation !== "song"),
  );
}
