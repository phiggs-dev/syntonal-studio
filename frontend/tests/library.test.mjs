/** API regression tests preserve exact seeds, metadata bodies, and filter semantics. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
const source = await readFile(
  new URL("../src/library.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(
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
const {
  historyQuery,
  historyPath,
  saveProject,
  updateHistory,
  reuseGeneration,
  rerunGeneration,
} = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);
test("history filters retain a maximum 63-bit seed and reserved query characters", () => {
  const query = new URLSearchParams(
    historyQuery({
      seed: "9223372036854775807",
      q: "piano & voice + strings",
      model: "m-a-p/YuE2-3B",
      project_id: "",
      favorite: "true",
    }),
  );
  assert.equal(query.get("seed"), "9223372036854775807");
  assert.equal(query.get("q"), "piano & voice + strings");
  assert.equal(query.get("model"), "m-a-p/YuE2-3B");
  assert.equal(query.has("project_id"), false);
  assert.equal(query.get("favorite"), "true");
});
test("all projects and unassigned remain distinct filters", () => {
  assert.equal(historyQuery({ project_id: "" }), "");
  assert.equal(
    historyQuery({ project_id: "unassigned" }),
    "project_id=unassigned",
  );
});
test("metadata assignment and removal preserve exact notes and do not submit generation", async () => {
  const value = {
    project_id: null,
    display_name: "A take",
    notes: "  Exact notes\n\nSecond line  ",
    favorite: true,
  };
  const [path, options] = await updateHistory("recording", value);
  assert.equal(path, "/api/history/recording");
  assert.equal(options.method, "PATCH");
  assert.deepEqual(JSON.parse(options.body), value);
});
test("project creation and update use distinct methods while preserving metadata", async () => {
  const value = { name: "Song", notes: "line\nline", tags: ["folk"] };
  const [path, options] = await saveProject(value);
  assert.equal(path, "/api/projects");
  assert.equal(options.method, "POST");
  assert.deepEqual(JSON.parse(options.body), value);
  const [updatedPath, updatedOptions] = await saveProject(value, "project");
  assert.equal(updatedPath, "/api/projects/project");
  assert.equal(updatedOptions.method, "PATCH");
});
test("reuse reads a draft while saved rerun explicitly posts without current settings", async () => {
  assert.deepEqual(await reuseGeneration("song"), ["/api/history/song/reuse"]);
  assert.deepEqual(await rerunGeneration("song"), [
    "/api/history/song/rerun",
    { method: "POST" },
  ]);
  assert.equal(historyPath("../song?other"), "/api/history/..%2Fsong%3Fother");
});
