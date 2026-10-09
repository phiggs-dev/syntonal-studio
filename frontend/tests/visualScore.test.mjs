import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
const source = await readFile(new URL("../src/visualScore.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { parseTimeline, editTimelineEvent, editTimelineChord, chainInfo, pitchLabel, durationLabel, sectionLyrics, insertTimelineNote, moveTimelineEvent } = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
export function score(vocal, ins = "Z|", options = {}) {
  return `X:1\nT:\nM:${options.meter ?? "4/4"}\nL:1/${options.unit ?? 32}\nQ:1/4=120\nV: Vocal clef=treble name="Vocal Melody" snm="Vocal"\nV: Ins clef=treble name="Ins Melody" snm="Inst."\nK:${options.key ?? "C"}\n% verse\nV: Vocal\n${vocal}\nV: Ins\n${ins}\n`;
}
function valid(abc) { const model = parseTimeline(abc); assert.deepEqual(model.errors, []); return model; }
function change(abc, barIndex, eventIndex, update, voice = "Vocal") {
  const model = valid(abc), bar = model.bars[voice][barIndex];
  const edited = editTimelineEvent(model, bar.id, bar.events[eventIndex].id, update);
  valid(edited); return edited;
}
function sounding(model, voice = "Vocal") {
  return model.bars[voice].flatMap(bar => bar.events.filter(event => event.pitch !== null).map(event => [bar.absolute + event.onset, event.duration, event.pitch, event.tiedFrom, event.tiedTo]));
}
test("bars retain meter, positions, chords and expanded whole-bar rests", () => {
  const model = valid(score('"Dm"d8e8z16|Z2|', "Z3|"));
  assert.equal(model.bars.Vocal.length, 3);
  assert.deepEqual(model.bars.Vocal[0].events.map(e => [e.onset, e.duration, e.pitch]), [[0, 8, 74], [8, 8, 76], [16, 16, null]]);
  assert.deepEqual(model.bars.Vocal[0].annotations, [{ onset: 0, kind: "chord", value: "Dm" }]);
  assert.equal(model.sections[0].lastBar, 3);
});
test("shortening a note leaves silence and preserves later notes, chords, and CRLF", () => {
  const abc = score('"C"C16"G"G16|').replaceAll("\n", "\r\n");
  const edited = change(abc, 0, 0, { duration: 8 });
  const model = valid(edited);
  assert.deepEqual(model.bars.Vocal[0].events.map(e => [e.onset, e.duration, e.pitch]), [[0, 8, 60], [8, 8, null], [16, 16, 67]]);
  assert.equal(model.bars.Vocal[0].annotations[1].onset, 16);
  assert.equal(edited.replace(/\r\n/g, "").includes("\n"), false);
  assert.equal(edited.slice(0, edited.indexOf('"C"')), abc.slice(0, abc.indexOf('"C"')));
  assert.equal(edited.slice(edited.lastIndexOf("V: Ins")), abc.slice(abc.lastIndexOf("V: Ins")));
});
test("lengthening consumes only silence and preserves annotations within it", () => {
  const edited = change(score('C8z8"G"z8D8|'), 0, 0, { duration: 24 });
  const model = valid(edited);
  assert.equal(model.bars.Vocal[0].annotations[0].onset, 16);
  assert.deepEqual(sounding(model).at(-1).slice(0, 3), [24, 8, 62]);
  const info = chainInfo(model, model.bars.Vocal[0], model.bars.Vocal[0].events[0]);
  assert.equal(info.duration, 24);
});
test("overlap conflicts reject without altering the source", () => {
  const abc = score("C8D24|");
  assert.throws(() => change(abc, 0, 0, { duration: 16 }), /overlaps/);
  assert.throws(() => change(abc, 0, 1, { duration: 32 }), /overlaps/);
});
test("cross-bar extension creates valid ties and preserves following notes", () => {
  const edited = change(score("z24C8|z16D16|", "Z2|"), 0, 1, { duration: 24 });
  const model = valid(edited);
  assert.equal(model.bars.Vocal[0].events.at(-1).tiedTo, true);
  assert.equal(model.bars.Vocal[1].events[0].tiedFrom, true);
  assert.equal(chainInfo(model, model.bars.Vocal[1], model.bars.Vocal[1].events[0]).duration, 24);
  assert.deepEqual(sounding(model).at(-1).slice(0, 3), [48, 16, 62]);
});
test("shortening a tied chain through a continuation leaves a rest in each released bar", () => {
  const model = valid(change(score("z24C8-|C16z8D8|", "Z2|"), 1, 0, { duration: 4 }));
  assert.equal(model.bars.Vocal[0].events[1].duration, 4);
  assert.equal(model.bars.Vocal[1].events[0].pitch, null);
  assert.deepEqual(sounding(model).at(-1).slice(0, 3), [56, 8, 62]);
});
test("pitch edits update a whole tied chain but retain neighboring accidentals", () => {
  const model = valid(change(score("^F16F16-|F8F24|", "Z2|"), 1, 0, { pitch: 67 }));
  assert.deepEqual(sounding(model).map(n => n[2]), [66, 67, 67, 65]);
});
test("ties elsewhere do not block editing an unrelated note", () => {
  const model = valid(change(score("C16-C8D8|"), 0, 2, { pitch: 64 }));
  assert.equal(sounding(model).at(-1)[2], 64);
});
test("editing one expanded rest preserves all bars and other voices", () => {
  const abc = score("Z3|", "C32|D32|E32|");
  const edited = change(abc, 1, 0, { pitch: 60, duration: 8 });
  const model = valid(edited);
  assert.equal(model.bars.Vocal.length, 3);
  assert.equal(model.bars.Vocal[0].events[0].pitch, null);
  assert.equal(model.bars.Vocal[1].events[0].pitch, 60);
  assert.equal(model.bars.Vocal[2].events[0].pitch, null);
  assert.equal(edited.slice(edited.lastIndexOf("V: Ins")), abc.slice(abc.lastIndexOf("V: Ins")));
});
test("rest resizing, note/rest conversion and splitting are supported", () => {
  const original = score("z16C16|");
  const shortened = change(original, 0, 0, { duration: 8 });
  assert.equal(valid(shortened).bars.Vocal[0].events.length, 3);
  const converted = change(shortened, 0, 0, { pitch: 62 });
  assert.equal(valid(converted).bars.Vocal[0].events[0].pitch, 62);
  const split = change(original, 0, 1, { splitAfter: 8 });
  assert.deepEqual(sounding(valid(split)).map(e => e.slice(0, 3)), [[16, 8, 60], [24, 8, 60]]);
  assert.equal(sounding(valid(split))[0][4], false);
});
test("instrumental editing does not change vocal bars", () => {
  const abc = score("C32|", "D8z24|");
  const edited = change(abc, 0, 0, { duration: 16, pitch: 64 }, "Ins");
  assert.equal(edited.slice(0, edited.lastIndexOf("V: Ins")), abc.slice(0, abc.lastIndexOf("V: Ins")));
  assert.equal(valid(edited).bars.Ins[0].events[0].duration, 16);
});
test("chord edits retain timing and key-dependent pitches", () => {
  const abc = score('"F"F16"C"F16|', "Z|", { key: "G" });
  const model = valid(abc);
  const edited = editTimelineChord(model, "Vocal:1", 1, "Bbmaj7");
  assert.deepEqual(valid(edited).bars.Vocal[0].annotations, [{ onset: 0, kind: "chord", value: "F" }, { onset: 16, kind: "chord", value: "Bbmaj7" }]);
  assert.deepEqual(sounding(valid(edited)), sounding(model));
  assert.throws(() => editTimelineChord(model, "Vocal:1", 1, "bad"), /chord/);
});
test("meter and unit-length variations display and edit in musical units", () => {
  const model = valid(change(score("C4z8|", "Z|", { unit: 16, meter: "3/4" }), 0, 0, { duration: 6 }));
  assert.equal(model.bars.Vocal[0].length, 12);
  assert.equal(durationLabel(6, 16), "Dotted quarter");
  assert.equal(pitchLabel(60), "C4");
  assert.equal(pitchLabel(null), "Rest");
});
test("inline key changes retain position during duration edits", () => {
  const model = valid(change(score("C8z8[K:G]F16|", "z16[K:G]z16|"), 0, 0, { duration: 16 }));
  assert.equal(model.bars.Vocal[0].annotations[0].onset, 16);
  assert.equal(sounding(model).at(-1)[2], 66);
});
test("invalid bars and unsupported notation fail closed with bar locations", () => {
  const model = parseTimeline(score("C8D8|"));
  assert.match(model.errors[0], /Vocal, bar 1/);
  assert.throws(() => editTimelineEvent(model, "Vocal:1", "Vocal:1:0", { pitch: 62 }), /highlighted/);
  assert.match(parseTimeline(score("(C16D16)|")).errors[0], /Unsupported notation/);
  assert.ok(parseTimeline(score("C32-|Z|", "Z2|")).errors.length);
});
test("repeat lyric sections remain distinct without invented alignment", () => {
  const lyrics = "[Verse]\nFirst line\n[Chorus]\nSing\n[Verse]\nSecond line\n";
  assert.equal(sectionLyrics(lyrics, "verse", 0), "First line");
  assert.equal(sectionLyrics(lyrics, "verse", 1), "Second line");
  assert.equal(sectionLyrics(lyrics, "intro", 0), "");
});


test("piano-roll insertion fills a rest without moving other notes or chords", () => {
  const original = score('C8z8"G"G16|Z|', "Z2|");
  const model = valid(original);
  const inserted = valid(insertTimelineNote(model, "Vocal:1", 8, 8, 64));
  assert.deepEqual(sounding(inserted).map(item => item.slice(0, 3)), [[0, 8, 60], [8, 8, 64], [16, 16, 67]]);
  assert.equal(inserted.bars.Vocal[0].annotations[0].onset, 16);
  assert.deepEqual(inserted.bars.Ins.map(bar => bar.events), model.bars.Ins.map(bar => bar.events));
});
test("piano-roll movement leaves silence and preserves fixed neighbor timing", () => {
  const model = valid(score('C8z8"G"G16|Z|', "Z2|"));
  const moved = valid(moveTimelineEvent(model, "Vocal:1", "Vocal:1:0", 40, 62));
  assert.deepEqual(sounding(moved).map(item => item.slice(0, 3)), [[16, 16, 67], [40, 8, 62]]);
  assert.equal(moved.bars.Vocal[0].events[0].pitch, null);
  assert.equal(moved.bars.Vocal[0].annotations[0].onset, 16);
});
test("piano-roll movement supports self-overlap and tied continuation across bars", () => {
  const model = valid(score("C16z16|Z|", "Z2|"));
  const moved = valid(moveTimelineEvent(model, "Vocal:1", "Vocal:1:0", 24, 65));
  assert.equal(moved.bars.Vocal[0].events.at(-1).tiedTo, true);
  assert.equal(moved.bars.Vocal[1].events[0].tiedFrom, true);
  assert.equal(chainInfo(moved, moved.bars.Vocal[1], moved.bars.Vocal[1].events[0]).duration, 16);
  const shifted = valid(moveTimelineEvent(model, "Vocal:1", "Vocal:1:0", 8, 60));
  assert.equal(shifted.bars.Vocal[0].events[0].pitch, null);
  assert.equal(shifted.bars.Vocal[0].events[1].onset, 8);
});
test("piano-roll collisions, boundaries and fractional positions fail without edits", () => {
  const model = valid(score("C8z8G16|"));
  assert.throws(() => moveTimelineEvent(model, "Vocal:1", "Vocal:1:0", 12, 60), /overlaps/);
  assert.throws(() => insertTimelineNote(model, "Vocal:1", 16, 8, 60), /overlaps/);
  assert.throws(() => moveTimelineEvent(model, "Vocal:1", "Vocal:1:0", -8, 60), /section/);
  assert.throws(() => insertTimelineNote(model, "Vocal:1", 31, 8, 60), /section/);
  assert.throws(() => insertTimelineNote(model, "Vocal:1", 8.5, 2, 60), /resolution/);
});
test("piano-roll movement in Ins preserves vocal source bytes and pitches", () => {
  const original = score("C32|Z|", "D8z24|Z|", { key: "G" });
  const moved = moveTimelineEvent(valid(original), "Ins:1", "Ins:1:0", 32, 66);
  assert.equal(moved.slice(0, moved.lastIndexOf("V: Ins")), original.slice(0, original.lastIndexOf("V: Ins")));
  assert.equal(sounding(valid(moved), "Ins")[0][2], 66);
});
test("piano-roll geometry merges ties and omits rest blocks", async () => {
  const source = await readFile(new URL("../src/pianoRollModel.ts", import.meta.url), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const { pianoRollNotes, snapPianoPosition } = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
  const model = valid(score("z24C8-|C8z24|", "Z2|"));
  const notes = pianoRollNotes(model, model.bars.Vocal);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].start, 24);
  assert.equal(notes[0].duration, 16);
  assert.equal(notes[0].visibleEnd, 40);
  assert.equal(snapPianoPosition(7, 2), 8);
  assert.deepEqual(pianoRollNotes(model, []), []);
});
