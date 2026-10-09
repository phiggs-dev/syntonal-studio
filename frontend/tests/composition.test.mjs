/** Composition regressions protect exact text, 63-bit seeds, immutable versions, and preview timing. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
async function load(name) {
  const source = await readFile(
    new URL(`../src/${name}.ts`, import.meta.url),
    "utf8",
  );
  const output = ts.transpileModule(
    source.replace(
      /import \{ apiRequest \} from ["']\.\/api["'];/,
      "const apiRequest = (...args: unknown[]) => Promise.resolve(args);",
    ),
    {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  return import(
    `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`
  );
}
const api = await load("composition");
const { previewNotes } = await load("scoreTiming");
const request = {
  title: "Original",
  style: "  style\n",
  lyrics: "\nwords\n",
  cot: "full",
  seed: "9223372036854775807",
  cfg_scale: null,
};
test("seed boundaries stay exact without Number coercion", () => {
  assert.equal(api.validateSeed(request.seed), true);
  for (const value of ["9223372036854775808", "-1", "1.0", "1e3", " 1", ""])
    assert.equal(api.validateSeed(value), false);
  assert.equal(api.validateSeed("0"), true);
});
test("planning preserves original inputs and explicitly excludes edited ABC", async () => {
  const [path, options] = await api.queuePlan({ ...request, abc: "edited" });
  assert.equal(path, "/api/compose/plans");
  assert.deepEqual(JSON.parse(options.body), {
    ...request,
    operation: "plan",
    abc: null,
  });
});
test("exact plan route cannot accidentally send editor request", async () => {
  const [path, options] = await api.renderPlan("abc");
  assert.equal(path, "/api/compose/plans/abc/render");
  assert.deepEqual(JSON.parse(options.body), {});
});
test("new version stores exact text and both source links", async () => {
  const score = {
    title: "Draft",
    abc: "X:1\nK:C\n C D |\n",
    project_id: null,
    parent_score_id: "parent",
    source_generation_id: "source",
  };
  const [path, options] = await api.saveScore(score);
  assert.equal(path, "/api/compose/scores");
  assert.equal(options.method, "POST");
  assert.deepEqual(JSON.parse(options.body), score);
});
test("score render references saved version rather than unsaved text", async () => {
  const [path, options] = await api.renderScore("version", {
    ...request,
    abc: "unsaved",
  });
  assert.equal(path, "/api/compose/scores/version/render");
  assert.deepEqual(JSON.parse(options.body), {
    ...request,
    abc: null,
    operation: "song",
  });
});
test("historical symbolic requests route into Compose without losing conditioning", () => {
  assert.equal(api.needsComposition(request), false);
  for (const extension of [
    { operation: "plan" },
    { operation: "exact_plan" },
    { abc: "X:1" },
    { score_version_id: "x" },
    { source_plan_id: "y" },
  ])
    assert.equal(api.needsComposition({ ...request, ...extension }), true);
});
const report = (note) => ({
  bpm: 120,
  voices: { Vocal: { notes: [note] }, Ins: { notes: [] } },
});
test("validated quarter-note fractions become seconds precisely", () => {
  assert.deepEqual(
    previewNotes(
      report({
        onset_quarters: "3/2",
        duration_quarters: "1/2",
        midi_pitch: 60,
      }),
    ),
    [{ onset: 0.75, duration: 0.25, midi: 60 }],
  );
});
test("malformed or unbounded playback events are rejected before audio starts", () => {
  for (const note of [
    { onset_quarters: "1/0", duration_quarters: "1", midi_pitch: 60 },
    { onset_quarters: "0", duration_quarters: "0", midi_pitch: 60 },
    { onset_quarters: "0", duration_quarters: "1", midi_pitch: 128 },
    { onset_quarters: "2000", duration_quarters: "1", midi_pitch: 60 },
  ])
    assert.throws(() => previewNotes(report(note)));
  assert.throws(() => previewNotes(null));
});
const { DraftOperationGate, scoreAncestry } = await load("compositionDraft");
test("a delayed draft action cannot overlap a newer replacement", async () => {
  const gate = new DraftOperationGate();
  let release;
  let visible = "original";
  const first = gate.run(async () => {
    await new Promise((resolve) => {
      release = resolve;
    });
    visible = "first plan";
  });
  const replacement = () =>
    gate.run(async () => {
      visible = "requested plan";
    });
  assert.equal(gate.busy, true);
  assert.equal(await replacement(), false);
  assert.equal(visible, "original");
  release();
  await first;
  assert.equal(await replacement(), true);
  assert.equal(visible, "requested plan");
  await assert.rejects(
    gate.run(async () => {
      throw Error("failed request");
    }),
  );
  assert.equal(gate.busy, false);
});
test("historical score reuse retains generation and version ancestry through save and render", async () => {
  const reused = {
    request: {
      ...request,
      abc: "X:1\nK:C\nC |",
      score_version_id: "original-score",
    },
    parent_generation_id: "original-generation",
    project_id: null,
    warnings: [],
  };
  const ancestry = scoreAncestry(null, null, reused);
  assert.deepEqual(ancestry, {
    parent_score_id: "original-score",
    source_generation_id: "original-generation",
  });
  const [, saveOptions] = await api.saveScore({
    title: "Edited",
    abc: reused.request.abc + "\n",
    project_id: null,
    ...ancestry,
  });
  const saved = {
    ...JSON.parse(saveOptions.body),
    id: "new-score",
    created_at: "now",
    sha256: "hash",
  };
  const [renderPath] = await api.renderScore(saved.id, request);
  assert.equal(renderPath, "/api/compose/scores/new-score/render");
  assert.equal(saved.source_generation_id, "original-generation");
  assert.deepEqual(scoreAncestry(null, saved, reused), {
    parent_score_id: "new-score",
    source_generation_id: "original-generation",
  });
  assert.deepEqual(scoreAncestry(null, null, null), {
    parent_score_id: null,
    source_generation_id: null,
  });
});

test("bar preview clips tied notes at both boundaries and isolates the selected voice", async () => {
  const { previewRangeNotes } = await load("scoreTiming");
  const report = { bpm: 120, voices: {
    Vocal: { notes: [
      { onset_quarters: "0", duration_quarters: "6", midi_pitch: 60 },
      { onset_quarters: "7", duration_quarters: "4", midi_pitch: 62 },
    ] },
    Ins: { notes: [{ onset_quarters: "4", duration_quarters: "4", midi_pitch: 48 }] },
  } };
  assert.deepEqual(previewRangeNotes(report, { start: 4, end: 8, voice: "Vocal" }), [
    { onset: 0, duration: 1, midi: 60 }, { onset: 1.5, duration: .5, midi: 62 },
  ]);
  assert.throws(() => previewRangeNotes(report, { start: 12, end: 16, voice: "Vocal" }), /rests/);
  assert.throws(() => previewRangeNotes(report, { start: 8, end: 4, voice: "Vocal" }), /range/);
});
