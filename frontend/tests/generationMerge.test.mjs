/** Regression tests run the actual TypeScript merge helper without a browser or new dependencies. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/generationMerge.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { mergeGenerationJob, mergeGenerationJobs } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);
const queued = {
  id: "song-1", title: "Original", status: "queued", stage: "queued",
  created_at: "2026-09-16T12:00:00Z", started_at: null, finished_at: null,
  request: { title: "Original", style: "folk", lyrics: "line", cot: "full", seed: "9223372036854775807", cfg_scale: null },
  output_directory: "/outputs/song-1", error: null, audio_url: null,
  sample_rate: null, channels: null, duration_seconds: null,
  truncated: false, token_count: 0, cancel_requested: false,
};

test("late POST acknowledgement cannot replace a completed SSE result", () => {
  const complete = { ...queued, status: "complete", stage: "complete", token_count: 800, audio_url: "/api/jobs/song-1/audio", sample_rate: 48000 };
  assert.deepEqual(mergeGenerationJob(complete, queued), complete);
});

test("late cancellation acknowledgement preserves terminal failure and cancellation intent", () => {
  const failed = { ...queued, status: "failed", stage: "failed", token_count: 600, error: "Out of memory" };
  const acknowledgement = { ...queued, status: "running", stage: "semantic", token_count: 400, cancel_requested: true };
  assert.deepEqual(mergeGenerationJob(failed, acknowledgement), { ...failed, cancel_requested: true });
});

test("running stages, token counts, and cancellation flags cannot regress", () => {
  const decoding = { ...queued, status: "running", stage: "decoding", token_count: 900, cancel_requested: true };
  const semantic = { ...queued, status: "running", stage: "semantic", token_count: 300 };
  assert.deepEqual(mergeGenerationJob(decoding, semantic), decoding);
  assert.deepEqual(mergeGenerationJob(semantic, decoding), decoding);
});

test("terminal result advances a running job while preserving earlier cancellation intent", () => {
  const running = { ...queued, status: "running", stage: "decoding", token_count: 900, cancel_requested: true };
  const complete = { ...running, status: "complete", stage: "complete", cancel_requested: false, audio_url: "/audio" };
  assert.deepEqual(mergeGenerationJob(running, complete), { ...complete, cancel_requested: true });
});

test("older snapshots preserve newly submitted jobs and keep newest-first ordering", () => {
  const newer = { ...queued, id: "song-2", created_at: "2026-09-16T13:00:00Z" };
  const merged = mergeGenerationJobs([newer, queued], [queued]);
  assert.deepEqual(merged, [newer, queued]);
  assert.deepEqual(mergeGenerationJobs([queued], [newer]), [newer, queued]);
});

test("delayed same-stage snapshots cannot roll back measured work or loading subactivities", () => {
  const older = {...queued,status:"running",stage:"synthesizing",progress_revision:10,progress:{label:"Synthesizing audio",completed:8,total:96,unit:"steps",finished:false}};
  const newer = {...older,progress_revision:20,progress:{...older.progress,completed:48}};
  assert.deepEqual(mergeGenerationJob(newer,older),newer);
  const decoderLoading = {...newer,stage:"decoding",progress_revision:21,progress:{label:"Loading audio decoder",completed:0,total:null,unit:null,finished:false}};
  assert.deepEqual(mergeGenerationJob(newer,decoderLoading),decoderLoading);
  assert.deepEqual(mergeGenerationJob(decoderLoading,newer),decoderLoading);
});
