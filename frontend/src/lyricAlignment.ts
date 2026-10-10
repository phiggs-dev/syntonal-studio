/** Manual editorial links use vocal attack indices, valid only against exact source snapshots. */
import type { EditorMetadata, LyricAlignment, ScoreTimeline, SyllableAssignment } from "./visualScore";
export function vocalNotes(score: ScoreTimeline) {
  return score.bars.Vocal.flatMap(bar => bar.events.filter(event => event.pitch !== null && !event.tiedFrom).map(event => ({ bar, event })));
}
export function alignmentIsCurrent(alignment: LyricAlignment, abc: string, lyrics: string): boolean {
  return alignment.abc === abc && alignment.lyrics === lyrics;
}
export function splitSyllables(text: string): SyllableAssignment[] {
  const parts = text.split("|").map(part => part.trim());
  if (!parts.length || parts.length > 500 || parts.some(part => !part || part.length > 200)) throw Error("Enter 1–500 syllables separated by |, with no empty syllables (200 characters maximum each).");
  return parts.map(text => ({ text, first_note: null, last_note: null }));
}
export function assignSyllable(alignment: LyricAlignment, section: number, line: number, index: number, first: number | null, last: number | null, score: ScoreTimeline): LyricAlignment {
  const notes = vocalNotes(score);
  if (score.errors.length || alignment.abc !== score.abc) throw Error("The score changed. Rebuild stale links before assigning notes.");
  if ((first === null) !== (last === null) || first !== null && (last === null || !Number.isInteger(first) || !Number.isInteger(last) || first < 0 || last < first || last >= notes.length)) throw Error("Choose an ordered vocal note range.");
  if (first !== null && notes.slice(first, last! + 1).some(note => note.bar.section !== section)) throw Error("Assignments must stay in the selected section.");
  const target = alignment.lines.find(item => item.section === section && item.line === line);
  if (!target?.syllables[index]) throw Error("Choose a syllable first.");
  if (first !== null && alignment.lines.some(item => item.syllables.some((syllable, position) => !(item === target && position === index) && syllable.first_note !== null && syllable.last_note !== null && syllable.first_note <= last! && syllable.last_note >= first))) throw Error("These notes already belong to another syllable. Clear or move that assignment first.");
  return { ...alignment, lines: alignment.lines.map(item => item !== target ? item : { ...item, syllables: item.syllables.map((syllable, position) => position !== index ? syllable : { ...syllable, first_note: first, last_note: last }) }) };
}

/** Preserve current lyrics separately from the older phrase/alignment snapshots when saving stale links. */
export function metadataForScoreSave(metadata: EditorMetadata | null, lyrics: string): EditorMetadata | null {
  return metadata ? { ...metadata, working_lyrics: lyrics } : null;
}
