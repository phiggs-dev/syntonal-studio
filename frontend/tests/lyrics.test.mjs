import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
const source = await readFile(new URL("../src/lyricsModel.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { lyricSections, insertLyricSection, lyricHeadingWarnings, decodeLyrics } = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
const bytes = text => new TextEncoder().encode(text).buffer;
test("repeated section occurrences have distinct labels and exact offsets without changing text", () => {
  const text = "  opening\r\n[Verse]\r\nA\r\n[Chorus]\r\nB\r\n[Chorus]\r\nC\r\n[Custom part]\r\nD";
  const sections = lyricSections(text);
  assert.deepEqual(sections.map(item => item.label), ["Verse", "Chorus 1", "Chorus 2", "Custom part"]);
  for (const item of sections) assert.equal(text.slice(item.start, item.end), `[${item.title}]`);
  assert.equal(sections[2].line, 5);
});
test("section insertion preserves selected lyrics and creates separate heading lines", () => {
  const text = "One two three";
  const {value,cursor} = insertLyricSection(text, 4, "Chorus");
  assert.equal(value, "One \n[Chorus]\ntwo three");
  assert.equal(value.slice(cursor), "two three");
});
test("insertion preserves CRLF and supports empty, first-line and final positions", () => {
  assert.deepEqual(insertLyricSection("", 0, "Verse"), {value:"[Verse]\n",cursor:8});
  assert.equal(insertLyricSection("A\r\nB", 3, "Bridge").value,"A\r\n[Bridge]\r\nB");
  assert.equal(insertLyricSection("A", 1, "Outro").value,"A\n[Outro]\n");
});
test("unknown section insertion and oversized edits fail without truncation", () => {
  assert.throws(() => insertLyricSection("A", 0, "Bogus"));
  assert.throws(() => insertLyricSection("a".repeat(100000), 10, "Verse"));
});
test("heading guidance is nonblocking and permits custom section names", () => {
  assert.equal(lyricHeadingWarnings("[Verse\nHello\n[Chorus] trailing\n[Custom Part]\nworld").length, 2);
  assert.deepEqual(lyricHeadingWarnings("[Verse]\r\nWords\r\n[Chorus]\r\nWords"), []);
});
test("UTF-8 import preserves whitespace, Unicode, BOM and CRLF exactly", () => {
  const text = "\uFEFF[Verse]\r\n  Café 音楽  \r\n\r\n";
  assert.equal(decodeLyrics(bytes(text)),text);
});
test("invalid UTF-8, binary text and oversized files reject instead of silently replacing text", () => {
  assert.throws(() => decodeLyrics(new Uint8Array([0xff,0xfe,0x41]).buffer), /UTF-8/);
  assert.throws(() => decodeLyrics(bytes("a\0b")), /binary/);
  assert.throws(() => decodeLyrics(bytes("a".repeat(100001))), /100,000/);
  assert.throws(() => decodeLyrics(new Uint8Array(400001).buffer), /too large/);
});
