import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
const source = await readFile(new URL("../src/lyricsLaneModel.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {lyricLineSpans,replaceLyricLine,updatePhrase}=await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
const lyrics='[Verse]\r\n  Golden hour  \r\n\r\nCarry home\r\n[Verse]\r\nAgain\r\n';
test('line spans identify repeated section occurrences without changing whitespace',()=>{
  assert.deepEqual(lyricLineSpans(lyrics,'verse',0).map(line=>line.text),['Golden hour','Carry home']);
  assert.deepEqual(lyricLineSpans(lyrics,'Verse',1).map(line=>line.text),['Again']);
  assert.deepEqual(lyricLineSpans(lyrics,'Chorus',0),[]);
});
test('editing one line preserves blank lines, CRLF, indentation, and other occurrences',()=>{
  assert.equal(replaceLyricLine(lyrics,'Verse',0,0,'Evening light'),'[Verse]\r\n  Evening light  \r\n\r\nCarry home\r\n[Verse]\r\nAgain\r\n');
  assert.equal(replaceLyricLine(lyrics,'Verse',1,0,'Return'),lyrics.replace('Again','Return'));
  for(const text of ['', 'a\nb','[Chorus]','x'.repeat(10001)]) assert.throws(()=>replaceLyricLine(lyrics,'Verse',0,0,text));
});
test('moving a phrase replaces only its section occurrence and preserves hidden alignment',()=>{
  const alignment={abc:'old ABC',lyrics,lines:[]};
  const first={section:0,line:0,text:'Golden hour',first_bar:1,last_bar:2};
  const repeated={...first,section:1,first_bar:5,last_bar:6};
  const original={lyrics,phrases:[first,repeated],alignment};
  const moved=updatePhrase(original,lyrics,{...first,first_bar:2,last_bar:4});
  assert.equal(moved.phrases.length,2);assert.deepEqual(moved.phrases[0],repeated);
  assert.equal(moved.alignment,alignment);assert.equal(original.phrases[0].first_bar,1);
});
test('stale phrase snapshots are never silently reactivated by linking current text',()=>{
  const previous={lyrics:'old',phrases:[{section:1,line:0,text:'old',first_bar:1,last_bar:1}],alignment:{abc:'ABC',lyrics:'old',lines:[]}};
  const next=updatePhrase(previous,lyrics,{section:0,line:0,text:'Golden hour',first_bar:1,last_bar:2});
  assert.equal(next.phrases.length,1);assert.equal(next.lyrics,lyrics);
  assert.equal(next.alignment.lyrics,'old');
});

test('phrase range errors reject without altering the previous metadata',()=>{
  const metadata={lyrics,phrases:[]};
  assert.throws(()=>updatePhrase(metadata,lyrics,{section:0,line:0,text:'Line',first_bar:2,last_bar:1}));
  assert.deepEqual(metadata.phrases,[]);
});
