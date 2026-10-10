import { useState } from "react";
import { alignmentIsCurrent, assignSyllable, splitSyllables, vocalNotes } from "./lyricAlignment";
import { durationLabel, pitchLabel, type EditorMetadata, type ScoreTimeline } from "./visualScore";
interface Props {
  score: ScoreTimeline; lyrics: string; section: number; lines: string[];
  metadata: EditorMetadata | null; onChange: (metadata: EditorMetadata) => void;
}
export function LyricAlignmentEditor({ score, lyrics, section, lines, metadata, onChange }: Props) {
  const [lineIndex, setLineIndex] = useState(0);
  const [splitting, setSplitting] = useState<string | null>(null);
  const [error, setError] = useState("");
  const alignment = metadata?.alignment;
  const stale = Boolean(alignment && !alignmentIsCurrent(alignment, score.abc, lyrics));
  const row = alignment?.lines.find(item => item.section === section && item.line === lineIndex);
  const notes = vocalNotes(score);
  const available = notes.map((note, index) => ({ ...note, index })).filter(note => note.bar.section === section);
  function update(task: () => NonNullable<EditorMetadata["alignment"]>) {
    try { onChange({ lyrics, phrases: metadata?.lyrics === lyrics ? metadata.phrases : [], alignment: task() }); setError(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to update alignment."); }
  }
  function reset() {
    if (alignment?.lines.length && !window.confirm("Remove all existing syllable assignments and start again with the current lyrics and score? Undo can restore them.")) return;
    update(() => ({ abc: score.abc, lyrics, lines: [] })); setSplitting(null);
  }
  const splitText = splitting ?? row?.syllables.map(item => item.text).join(" | ") ?? lines[lineIndex]?.trim().split(/\s+/).join(" | ") ?? "";
  function applySplit() {
    if (row?.syllables.some(item => item.first_note !== null) && !window.confirm("Replace this line's syllables and clear its note assignments?")) return;
    update(() => {
      const current = alignment ?? { abc: score.abc, lyrics, lines: [] };
      const syllables = splitSyllables(splitText);
      if (current.lines.length >= 500 && !row) throw Error("Alignment supports up to 500 lines.");
      const otherLines = current.lines.filter(item => !(item.section === section && item.line === lineIndex));
      return { ...current, lines: [...otherLines, { section, line: lineIndex, text: lines[lineIndex], syllables }] };
    });
  }
  function assign(index: number, first: number | null, last: number | null) {
    if (alignment) update(() => assignSyllable(alignment, section, lineIndex, index, first, last, score));
  }
  function chooseFirst(index: number, value: string) {
    const first = value === "" ? null : Number(value);
    const last = first === null ? null : Math.max(first, row?.syllables[index].last_note ?? first);
    assign(index, first, last);
  }
  const noteLabel = (index: number) => {
    const note = notes[index];
    return `Note ${index + 1} · bar ${note.bar.number}, beat ${1 + note.event.onset / (score.unitDenominator / note.bar.meter[1])} · ${pitchLabel(note.event.pitch)}`;
  };
  return <details className="score-phrase-panel lyric-alignment-panel"><summary>Manual syllable-to-note alignment{stale ? " · needs review" : ""}</summary>
    <p className="field-help">Composition annotations only. YuE does not receive these assignments and may sing different timing. Notes in a range share one syllable; rests stay silent and tied notes count as one sustained note.</p>
    {stale && <div className="notice warning" role="status">Lyrics or score changed. Previous assignments are preserved but inactive and hidden from the note display. Rebuild before editing; Undo restores earlier score edits.</div>}
    {alignment && <button type="button" className="text-button" onClick={reset}>{stale ? "Rebuild stale alignment" : "Clear all syllable assignments"}</button>}
    <fieldset disabled={stale || !!score.errors.length || !lines.length}>
      <label>Line to align <select aria-label="Alignment lyric line" value={lineIndex} onChange={event => { setLineIndex(Number(event.target.value)); setSplitting(null); setError(""); }}>
        {lines.map((line, index) => <option key={index} value={index}>{index + 1}. {line}</option>)}
      </select></label>
      <label>Syllable split <input aria-label="Syllable split" value={splitText} onChange={event => setSplitting(event.target.value)} /></label>
      <p className="field-help">Separate syllables with |, for example: Gold | en | hour. Edit this split freely; applying a new split clears this line’s assignments.</p>
      <button type="button" className="secondary-button" onClick={applySplit}>Apply syllable split</button>
      {row && <p className="field-help">{row.syllables.filter(item => item.first_note === null).length} unassigned syllables. Choose a first and last note to move or extend an assignment.</p>}
      {row?.syllables.map((syllable, index) => <div className="syllable-assignment" key={index}>
        <strong>{syllable.text}</strong>
        <label>First note <select aria-label={`First note for syllable ${index + 1}`} value={syllable.first_note ?? ""} onChange={event => chooseFirst(index, event.target.value)}>
          <option value="">Unassigned</option>{available.map(note => <option key={note.index} value={note.index}>{noteLabel(note.index)}</option>)}
        </select></label>
        <label>Last note <select aria-label={`Last note for syllable ${index + 1}`} disabled={syllable.first_note === null} value={syllable.last_note ?? ""} onChange={event => assign(index, syllable.first_note, Number(event.target.value))}>
          <option value="" disabled>Unassigned</option>{available.filter(note => note.index >= (syllable.first_note ?? 0)).map(note => <option key={note.index} value={note.index}>{noteLabel(note.index)}</option>)}
        </select></label>
        <button type="button" className="text-button" disabled={syllable.first_note === null} onClick={() => assign(index, null, null)}>Clear</button>
      </div>)}
    </fieldset>
    {!lines.length && <p className="field-help">Add lyrics under a matching section heading to align this section.</p>}
    {!stale && !score.errors.length && <div className="alignment-note-strip" aria-label="Vocal notes with syllable assignments">{available.map(note => {
      const syllable = alignment?.lines.flatMap(item => item.syllables).find(item => item.first_note !== null && item.last_note !== null && item.first_note <= note.index && item.last_note >= note.index);
      return <div className="alignment-note" key={note.index}><strong>{noteLabel(note.index)}</strong><small>{durationLabel(note.event.duration, score.unitDenominator)}{note.event.tiedTo ? " + tied continuation" : ""}</small><span>{syllable ? (syllable.first_note === note.index ? syllable.text : "—") : "Unassigned"}</span></div>;
    })}</div>}
    {error && <div className="notice warning" role="alert">{error}</div>}
  </details>;
}
