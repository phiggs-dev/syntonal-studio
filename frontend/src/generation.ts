/** COT is YuE2 conditioning mode; seeds stay decimal strings to preserve 63-bit precision. */
import { useEffect, useState } from "react";
import { apiRequest } from "./api";
import { mergeGenerationJobs } from "./generationMerge";

export type ConditioningMode = "full" | "melody" | "off";
export interface GenerationRequest {
  operation?: "song" | "plan" | "exact_plan";
  abc?: string | null;
  source_plan_id?: string | null;
  score_version_id?: string | null;
  project_id?: string | null;
  parent_generation_id?: string | null;
  title: string;
  style: string;
  lyrics: string;
  cot: ConditioningMode;
  seed: string;
  cfg_scale: number | null;
}
export interface JobProgress {
  label: string;
  completed: number;
  total: number | null;
  unit: "tokens" | "steps" | "chunks" | null;
  finished: boolean;
}
export interface GenerationJob {
  id: string;
  title: string;
  status: "queued" | "running" | "complete" | "failed" | "cancelled";
  stage:
    | "queued"
    | "loading"
    | "planning"
    | "semantic"
    | "synthesizing"
    | "decoding"
    | "saving"
    | "complete"
    | "failed"
    | "cancelled";
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  request: GenerationRequest;
  output_directory: string;
  error: string | null;
  audio_url: string | null;
  sample_rate: number | null;
  channels: number | null;
  duration_seconds: number | null;
  truncated: boolean;
  token_count: number;
  stage_started_at?: string | null;
  progress?: JobProgress | null;
  progress_revision?: number;
  queue_position?: number | null;
  cancel_requested: boolean;
}
interface JobsResponse {
  jobs: GenerationJob[];
}
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Unexpected error. Please retry.";
export const submitGeneration = (request: GenerationRequest) =>
  apiRequest<GenerationJob>("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
export const cancelGeneration = (id: string) =>
  apiRequest<GenerationJob>(`/api/jobs/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
  });

/** One subscription survives workspace navigation; polling covers interrupted SSE connections. */
export function useGenerationJobs() {
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const [connection, setConnection] = useState(
    "Connecting to generation updates…",
  );
  const [updatesLive, setUpdatesLive] = useState(false);
  useEffect(() => {
    let disposed = false;
    let streamHealthy = false;
    let fetching = false;
    let streamRevision = 0;
    const refresh = async () => {
      if (fetching || disposed) return;
      fetching = true;
      const revision = streamRevision;
      try {
        const response = await apiRequest<JobsResponse>("/api/jobs");
        if (!disposed && revision === streamRevision) {
          setJobs((previous) => mergeGenerationJobs(previous, response.jobs));
          if (!streamHealthy)
            setConnection(
              "Updates checked every 5 seconds; reconnecting live stream…",
            );
        }
      } catch (error) {
        if (!disposed && !streamHealthy) setConnection(errorMessage(error));
      } finally {
        fetching = false;
      }
    };
    void refresh();
    const source = new EventSource("/api/jobs/events");
    source.addEventListener("jobs", (event: MessageEvent<string>) => {
      try {
        const response = JSON.parse(event.data) as JobsResponse;
        if (!Array.isArray(response.jobs))
          throw new Error("Invalid job update");
        streamRevision += 1;
        streamHealthy = true;
        setUpdatesLive(true);
        setJobs((previous) => mergeGenerationJobs(previous, response.jobs));
        setConnection("Live generation updates connected");
      } catch {
        streamHealthy = false;
        setUpdatesLive(false);
        setConnection("Could not read a live update. Refreshing job status…");
        void refresh();
      }
    });
    source.onerror = () => {
      streamHealthy = false;
      setUpdatesLive(false);
      void refresh();
    };
    const interval = window.setInterval(() => {
      if (!streamHealthy) void refresh();
    }, 5000);
    return () => {
      disposed = true;
      source.close();
      window.clearInterval(interval);
    };
  }, []);
  const rememberJob = (job: GenerationJob) =>
    setJobs((previous) => mergeGenerationJobs(previous, [job]));
  return { jobs, connection, updatesLive, rememberJob };
}
