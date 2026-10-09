import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
const source = await readFile(new URL("../src/generationProgressModel.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { generationProgressView, generationSteps, generationElapsed, primaryGeneration, prioritizeGenerationJobs } = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
const job = { id:"song", status:"running", stage:"semantic", started_at:"2026-10-09T12:00:00Z", finished_at:null, created_at:"2026-10-09T11:00:00Z", token_count:200, request:{cot:"full",operation:"song"} };

test("token output and model limits never imply percentage completion", () => {
  const view = generationProgressView({...job, progress:{label:"Generating song",completed:9000,total:9000,unit:"tokens"}});
  assert.equal(view.total, null);
  assert.equal(view.completed, null);
});
test("only matching synthesis/decode work totals produce a filled bar", () => {
  const progress = {label:"Synthesizing audio",completed:48,total:96,unit:"steps"};
  assert.deepEqual(generationProgressView({...job,stage:"synthesizing",progress}), {label:"Synthesizing audio",detail:"48 of 96 synthesis steps",total:96,completed:48,finishing:false});
  assert.equal(generationProgressView({...job,stage:"decoding",progress}).total, null);
  assert.equal(generationProgressView({...job,stage:"synthesizing",progress:{...progress,total:0}}).total, null);
  assert.equal(generationProgressView({...job,status:"failed",stage:"failed",progress}).total, null);
  assert.equal(generationProgressView({...job,stage:"decoding",progress:{label:"Decoding audio",completed:3,total:8,unit:"chunks"}}).detail, "3 of 8 audio chunks");
});
test("submitted steps do not claim completed generation and decoder loading stays unknown", () => {
  const view = generationProgressView({...job,stage:"synthesizing",progress:{label:"Synthesizing audio",completed:96,total:96,unit:"steps"}});
  assert.equal(view.label, "Finishing synthesis…");
  assert.equal(view.finishing,true);
  const loading = generationProgressView({...job,stage:"decoding",progress:{label:"Loading audio decoder",completed:0,total:null,unit:null}});
  assert.equal(loading.label,"Loading audio decoder…");
  assert.equal(loading.total,null);
});
test("workflow steps omit audio for plan-only and generated planning for supplied scores", () => {
  assert.deepEqual(generationSteps({...job,request:{cot:"full",operation:"plan"}}).map(step=>step.stage),["loading","planning","saving"]);
  assert.equal(generationSteps({...job,request:{cot:"off"}}).some(step=>step.stage==="planning"),false);
  assert.equal(generationSteps({...job,request:{cot:"full",operation:"exact_plan"}})[1].label,"Use score");
  assert.equal(generationSteps({...job,request:{cot:"full",abc:"X:1"}})[1].label,"Use score");
});
test("elapsed time excludes waiting and stops at completion", () => {
  assert.equal(generationElapsed(job,Date.parse("2026-10-09T12:01:24Z")),"1:24");
  assert.equal(generationElapsed({...job,started_at:null},Date.now()),null);
  assert.equal(generationElapsed({...job,finished_at:"2026-10-09T12:01:24Z"},Date.now()),"1:24");
  assert.equal(generationElapsed({...job,started_at:"invalid"},Date.now()),null);
  assert.equal(generationElapsed(job,Date.parse("2026-10-09T13:01:24Z")),"1:01:24");
});
test("active summary chooses running work then FIFO waiting jobs without mutating inputs", () => {
  const first={...job,id:"first",status:"queued",stage:"queued",queue_position:1};
  const second={...first,id:"second",queue_position:2};
  const done={...job,id:"done",status:"complete",stage:"complete"};
  const input=[second,done,first,job];
  assert.deepEqual(prioritizeGenerationJobs(input).map(job=>job.id),["song","first","second","done"]);
  assert.equal(primaryGeneration(input).id,"song");
  assert.equal(primaryGeneration([second,first]).id,"first");
  assert.deepEqual(input,[second,done,first,job]);
  assert.equal(generationProgressView(second).detail,"Position 2 in queue · Waiting to start");
});

test("saved scores and plan-only saving have accurate activity descriptions", () => {
  assert.equal(generationProgressView({...job,stage:"planning",request:{cot:"full",operation:"exact_plan"}}).detail,"Reusing the selected score");
  assert.equal(generationProgressView({...job,stage:"saving",request:{cot:"full",operation:"plan"}}).label,"Saving composition plan");
});
