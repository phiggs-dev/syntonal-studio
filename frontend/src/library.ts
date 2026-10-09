/** Projects and history describe Studio metadata; artifact URLs serve preserved source bytes. */
import { apiRequest } from "./api";
import type { GenerationJob, GenerationRequest } from "./generation";
export interface Project {
  id: string;
  name: string;
  notes: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}
export interface HistoryEntry {
  job: GenerationJob;
  project_id: string | null;
  display_name: string;
  favorite: boolean;
  notes: string;
  model: string | null;
  decoder: string | null;
  model_revision: string | null;
  decoder_revision: string | null;
  parent_generation_id: string | null;
  relation: string | null;
  generation_seconds: number | null;
}
export interface Artifact {
  name: string;
  bytes: number | null;
  sha256: string | null;
  integrity: "verified" | "mismatch" | "unverified" | "missing";
  text_preview: string | null;
  download_url: string | null;
}
export interface ReuseDraft {
  request: GenerationRequest;
  parent_generation_id: string;
  project_id: string | null;
  warnings: string[];
  nonce?: number;
}
export const historyPath = (id: string) =>
  `/api/history/${encodeURIComponent(id)}`;
export const getProjects = () =>
  apiRequest<{ projects: Project[] }>("/api/projects");
export const saveProject = (
  value: { name: string; notes: string; tags: string[] },
  id?: string,
) =>
  apiRequest<Project>(id ? `/api/projects/${id}` : "/api/projects", {
    method: id ? "PATCH" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
export const updateHistory = (
  id: string,
  value: Partial<
    Pick<HistoryEntry, "project_id" | "display_name" | "favorite" | "notes">
  >,
) =>
  apiRequest<HistoryEntry>(historyPath(id), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
export const reuseGeneration = (id: string) =>
  apiRequest<ReuseDraft>(`${historyPath(id)}/reuse`);
export const rerunGeneration = (id: string) =>
  apiRequest<GenerationJob>(`${historyPath(id)}/rerun`, { method: "POST" });
export function historyQuery(filters: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters))
    if (value) params.set(key, value);
  return params.toString();
}
