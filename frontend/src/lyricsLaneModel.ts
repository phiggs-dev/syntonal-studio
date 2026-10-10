/** Phrase editing preserves section occurrences, blank lines, and original line endings. */
import type { EditorMetadata, LyricPhrase } from "./visualScore";
export interface LyricLineSpan { text: string; start: number; end: number }
export function lyricLineSpans(lyrics: string, title: string, occurrence: number): LyricLineSpan[] {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const blocks = [...lyrics.matchAll(/^\[([^\]]+)\][ \t]*\r?\n([\s\S]*?)(?=^\[|$(?![\s\S]))/gm)];
  const block = blocks.filter(item => normalize(item[1]) === normalize(title))[occurrence];
  if (!block) return [];
  const content = block[2];
  const origin = block.index! + block[0].length - content.length;
  return [...content.matchAll(/[^\r\n]+/g)].filter(match => match[0].trim()).map(match => ({ text: match[0].trim(), start: origin + match.index!, end: origin + match.index! + match[0].length }));
}
export function replaceLyricLine(lyrics: string, title: string, occurrence: number, line: number, text: string): string {
  const span = lyricLineSpans(lyrics, title, occurrence)[line];
  if (!span || !text.trim() || /[\r\n]/.test(text) || text.trim().length > 10_000 || /^\s*\[/.test(text)) throw Error("Enter one lyric line (up to 10,000 characters). Use the lyrics editor to add lines or section headings.");
  const original = lyrics.slice(span.start, span.end);
  const replacement = original.match(/^\s*/)?.[0] + text.trim() + original.match(/\s*$/)?.[0];
  const result = lyrics.slice(0, span.start) + replacement + lyrics.slice(span.end);
  if (result.length > 100_000) throw Error("Lyrics exceed 100,000 characters.");
  return result;
}
export function updatePhrase(metadata: EditorMetadata | null, lyrics: string, phrase: LyricPhrase): EditorMetadata {
  const current = metadata?.lyrics === lyrics ? metadata.phrases : [];
  if (!phrase.text || phrase.text.length > 10_000 || phrase.first_bar > phrase.last_bar) throw Error("Choose an ordered bar range and a lyric line up to 10,000 characters.");
  if (current.length >= 2000 && !current.some(item => item.section === phrase.section && item.line === phrase.line)) throw Error("This score already has 2,000 phrase links.");
  return { ...metadata, lyrics, working_lyrics: lyrics, phrases: [...current.filter(item => !(item.section === phrase.section && item.line === phrase.line)), phrase] };
}
