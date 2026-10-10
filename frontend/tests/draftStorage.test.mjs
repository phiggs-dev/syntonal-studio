import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
const source = await readFile(new URL("../src/draftStorage.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { isInputDraft, isCompositionDraft, inputDraftHasContent, draftPrefix, readDrafts, writeDraft } = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
class MemoryStorage {
  values = new Map();
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
  removeItem(key) { this.values.delete(key); }
}
const draft = {title:"Untitled",style:"  piano  ",lyrics:"[Verse]\r\nCafé\r\n",mode:"full",seed:"9223372036854775807",guidance:"",projectId:"",parentId:null};
const timestamp = "2026-10-09T12:00:00.000Z";
const composition = {...draft,abc:"V: Vocal\nC4|\n",scoreTitle:"Version",editorMetadata:{lyrics:draft.lyrics,phrases:[{section:0,line:0,text:"Café",first_bar:1,last_bar:1}]},planId:"a".repeat(32),scoreId:null,parentScoreId:null,sourceGenerationId:"a".repeat(32)};
test("draft snapshots round-trip exact text, maximum seeds and configuration strings", () => {
  const storage = new MemoryStorage();
  writeDraft(storage,"library","create","tab-a",draft,timestamp);
  assert.deepEqual(readDrafts(storage,"library","create",isInputDraft).drafts[0].data,draft);
});
test("separate tabs cannot overwrite another slot, including stale autosaves", () => {
  const storage = new MemoryStorage();
  writeDraft(storage,"library","create","tab-a",draft,timestamp);
  writeDraft(storage,"library","create","tab-b",{...draft,title:"Tab B"},timestamp);
  writeDraft(storage,"library","create","tab-a",{...draft,title:"A newer edit"},timestamp);
  assert.deepEqual(new Set(readDrafts(storage,"library","create",isInputDraft).drafts.map(item=>item.data.title)),new Set(["A newer edit","Tab B"]));
});
test("libraries and workspaces are isolated with collision-safe encoded keys", () => {
  const storage = new MemoryStorage();
  writeDraft(storage,"library:compose","create","a",draft,timestamp);
  writeDraft(storage,"library","compose","a",composition,timestamp);
  assert.equal(readDrafts(storage,"library","create",isInputDraft).drafts.length,0);
  assert.equal(readDrafts(storage,"library","compose",isCompositionDraft).drafts.length,1);
  assert.notEqual(draftPrefix("library:compose","create"),draftPrefix("library","compose"));
});
test("composition snapshots preserve ABC, phrase metadata and lineage references", () => {
  const storage = new MemoryStorage();
  writeDraft(storage,"library","compose","a",composition,timestamp);
  assert.deepEqual(readDrafts(storage,"library","compose",isCompositionDraft).drafts[0].data,composition);
});
test("malformed, future-schema and oversized snapshots remain untouched alongside valid ones", () => {
  const storage = new MemoryStorage(), prefix = draftPrefix("library","create");
  writeDraft(storage,"library","create","valid",draft,timestamp);
  storage.setItem(prefix+"bad","{");
  storage.setItem(prefix+"future",JSON.stringify({version:99,data:draft}));
  storage.setItem(prefix+"large","x".repeat(2000001));
  const before = [...storage.values];
  const scan = readDrafts(storage,"library","create",isInputDraft);
  assert.equal(scan.drafts.length,1); assert.equal(scan.unreadable.length,3);
  assert.deepEqual([...storage.values],before);
});
test("invalid field shapes, oversized text, lineage paths and phrase ranges reject", () => {
  assert.equal(isInputDraft({...draft,lyrics:"a".repeat(100001)}),false);
  assert.equal(isInputDraft({...draft,parentId:"../../outside"}),false);
  assert.equal(isInputDraft({...draft,seed:123}),false);
  assert.equal(isCompositionDraft({...composition,editorMetadata:{lyrics:"",phrases:[{section:0,line:0,text:"word",first_bar:2,last_bar:1}]}}),false);
  assert.equal(isCompositionDraft({...composition,mode:"off"}),false);
});
test("unavailable or full storage propagates failure while preserving older snapshots", () => {
  const storage = new MemoryStorage();
  writeDraft(storage,"library","create","existing",draft,timestamp);
  storage.setItem = () => { throw Error("QuotaExceededError"); };
  assert.throws(()=>writeDraft(storage,"library","create","new",draft,timestamp),/Quota/);
  assert.equal(readDrafts(storage,"library","create",isInputDraft).drafts.length,1);
});
test("blank initial inputs are not meaningful but metadata and changed seed/mode are", () => {
  const empty = {...draft,title:"",style:"",lyrics:"",seed:"831001"};
  assert.equal(inputDraftHasContent(empty),false);
  for (const change of [{seed:"123"},{mode:"melody"},{guidance:"0"},{projectId:"b".repeat(32)}]) assert.equal(inputDraftHasContent({...empty,...change}),true);
});
