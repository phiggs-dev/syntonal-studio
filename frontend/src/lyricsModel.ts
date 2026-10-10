/** Editorial helpers preserve lyric text; section tags are not new model parameters. */
export const MAX_LYRICS_LENGTH = 100_000;
export const lyricSectionTags = ["Intro", "Verse", "Pre-Chorus", "Chorus", "Bridge", "Outro"] as const;
export interface LyricSection { title: string; label: string; start: number; end: number; line: number }
export function lyricSections(text: string): LyricSection[] {
  const matches = [...text.matchAll(/^\[([^\]\r\n]+)\][ \t]*\r?$/gm)];
  const totals = new Map<string, number>();
  for (const match of matches) {
    const key = match[1].trim().toLowerCase();
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }
  const occurrences = new Map<string, number>();
  return matches.map(match => {
    const title = match[1].trim(), key = title.toLowerCase();
    const occurrence = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, occurrence);
    return { title, label: (totals.get(key) ?? 0) > 1 ? `${title} ${occurrence}` : title,
      start: match.index!, end: match.index! + match[0].replace(/\r$/, "").length,
      line: text.slice(0, match.index).split("\n").length - 1 };
  });
}
export function insertLyricSection(text: string, position: number, tag: string) {
  if (!(lyricSectionTags as readonly string[]).includes(tag)) throw Error("Choose a supported section heading.");
  const cursor = Math.max(0, Math.min(text.length, position));
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  // Insert before selected text rather than replacing any lyrics.
  const before = text.slice(0, cursor), after = text.slice(cursor);
  const prefix = before && !before.endsWith("\n") ? newline : "";
  const addition = `${prefix}[${tag}]${newline}`;
  const value = before + addition + after;
  if (value.length > MAX_LYRICS_LENGTH) throw Error("Lyrics exceed 100,000 characters.");
  return { value, cursor: cursor + addition.length };
}
export function lyricHeadingWarnings(text: string): string[] {
  return text.split(/\r?\n/).flatMap((line, index) =>
    /^\s*\[/.test(line) && !/^\[[^\]\r\n]+\][ \t]*$/.test(line)
      ? [`Line ${index + 1}: put the section heading on its own line, for example [Verse].`] : []);
}
export function decodeLyrics(bytes: ArrayBuffer): string {
  if (bytes.byteLength > 400_000) throw Error("Lyrics file is too large. Maximum 100,000 characters.");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw Error("This file is not readable UTF-8 text. Save it as UTF-8 .txt and try again."); }
  if (text.includes("\0")) throw Error("This file contains binary data. Choose a UTF-8 lyrics .txt file.");
  if (text.length > MAX_LYRICS_LENGTH) throw Error("Lyrics exceed 100,000 characters.");
  return text;
}
