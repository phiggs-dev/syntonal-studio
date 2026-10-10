import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
async function load(name) {
  const source = await readFile(new URL(`../src/${name}.ts`, import.meta.url), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}
const {parseTimeline, editTimelineEvent} = await load("visualScore");
const {vocalNotes, splitSyllables, assignSyllable, alignmentIsCurrent, metadataForScoreSave} = await load("lyricAlignment");
const {isCompositionDraft} = await load("draftStorage");
const abc = 'X:1\nT:\nM:4/4\nL:1/32\nQ:1/4=120\nV: Vocal clef=treble name="Vocal Melody" snm="Vocal"\nV: Ins clef=treble name="Ins Melody" snm="Inst."\nK:C\n% verse\nV: Vocal\nC32-|C8D8z16|\nV: Ins\nZ2|\n% verse\nV: Vocal\nE16F16|\nV: Ins\nZ|\n';
const score = parseTimeline(abc), lyrics = '[Verse]\nGolden hour\n[Verse]\nCarry home';
const base = () => ({abc, lyrics, lines:[{section:0,line:0,text:'Golden hour',syllables:splitSyllables('Gold | en | hour')},{section:1,line:0,text:'Carry home',syllables:splitSyllables('Car | ry | home')}]});
test('vocal attacks exclude rests and merge tied segments across bars',()=>{
  assert.deepEqual(score.errors,[]);
  assert.equal(vocalNotes(score).length,4);
  assert.deepEqual(vocalNotes(score).map(note=>note.bar.number),[1,2,3,3]);
});
test('editable splitting preserves Unicode and rejects empty or oversized syllables',()=>{
  assert.deepEqual(splitSyllables(' Ca | fé ').map(item=>item.text),['Ca','fé']);
  assert.throws(()=>splitSyllables('a || b'));assert.throws(()=>splitSyllables('x'.repeat(201)));
});
test('assign, extend melisma, move and clear are immutable operations with collision protection',()=>{
  const initial=base();let next=assignSyllable(initial,0,0,0,0,1,score);
  assert.equal(initial.lines[0].syllables[0].first_note,null);
  assert.equal(next.lines[0].syllables[0].last_note,1);
  assert.throws(()=>assignSyllable(next,0,0,1,1,1,score),/already belong/);
  next=assignSyllable(next,0,0,0,1,1,score);
  next=assignSyllable(next,0,0,1,0,0,score);
  next=assignSyllable(next,0,0,0,null,null,score);
  assert.equal(next.lines[0].syllables[0].first_note,null);
});
test('repeated lyric sections remain distinct and ranges cannot cross sections',()=>{
  const next=assignSyllable(base(),1,0,0,2,3,score);
  assert.equal(next.lines[0].syllables[0].first_note,null);
  assert.equal(next.lines[1].syllables[0].first_note,2);
  assert.throws(()=>assignSyllable(base(),0,0,0,0,2,score),/selected section/);
  for(const [first,last] of [[1,0],[-1,0],[0,99],[0,null],[0.5,1]]) assert.throws(()=>assignSyllable(base(),0,0,0,first,last,score));
});
test('lyrics and any score edit invalidate links; returning exact sources restores validity',()=>{
  const alignment=base();assert.equal(alignmentIsCurrent(alignment,abc,lyrics),true);
  assert.equal(alignmentIsCurrent(alignment,abc,lyrics+'!'),false);
  const changed=editTimelineEvent(score,score.bars.Vocal[1].id,score.bars.Vocal[1].events[1].id,{pitch:65});
  assert.equal(alignmentIsCurrent(alignment,changed,lyrics),false);
  assert.throws(()=>assignSyllable(alignment,0,0,0,0,0,parseTimeline(changed)),/score changed/);
  assert.equal(alignmentIsCurrent(alignment,abc,lyrics),true);
});
test('browser recovery retains alignment and rejects malformed assignments without losing legacy drafts',()=>{
  const draft={title:'',style:'',lyrics,mode:'full',seed:'831001',guidance:'',projectId:'',parentId:null,abc,scoreTitle:'',editorMetadata:{lyrics,phrases:[],alignment:base()},planId:null,scoreId:null,parentScoreId:null,sourceGenerationId:null};
  assert.equal(isCompositionDraft(JSON.parse(JSON.stringify(draft))),true);
  draft.editorMetadata.alignment.lines[0].syllables[0].first_note=1;
  assert.equal(isCompositionDraft(draft),false);
  delete draft.editorMetadata.alignment;
  assert.equal(isCompositionDraft(draft),true);
});

test('saving changed lyrics preserves the working text and keeps previous links stale on reload',()=>{
  const metadata={lyrics,phrases:[],alignment:base()};
  const saved=metadataForScoreSave(metadata,lyrics+' changed');
  assert.equal(saved.working_lyrics,lyrics+' changed');
  assert.equal(saved.alignment.lyrics,lyrics);
  assert.equal(alignmentIsCurrent(saved.alignment,abc,saved.working_lyrics),false);
  assert.equal(metadata.working_lyrics,undefined);
});

test('saving phrase-only metadata also retains current lyrics while its old snapshot stays stale',()=>{
  const metadata={lyrics:'Old words',phrases:[]};
  const saved=metadataForScoreSave(metadata,'New words');
  assert.equal(saved.working_lyrics,'New words');
  assert.equal(saved.lyrics,'Old words');
  assert.equal(metadataForScoreSave(null,'New words'),null);
});
