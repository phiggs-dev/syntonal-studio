import { useEffect, useMemo, useRef, useState } from "react";
import { AbcEditor, ScorePreview } from "./AbcEditor";
import { PianoRoll } from "./PianoRoll";
import { ScorePlayback } from "./ScorePlayback";
import type { ValidationReport } from "./composition";
import {
  chainInfo, durationLabel, editTimelineChord, editTimelineEvent, insertTimelineNote, moveTimelineEvent, parseTimeline,
  pitchLabel, sectionLyrics, type EditorMetadata, type TimelineBar, type TimelineEvent, type VoiceName,
} from "./visualScore";

interface Snapshot { abc: string; metadata: EditorMetadata | null }
interface Props {
  abc: string;
  lyrics: string;
  onChange: (value: string) => void;
  metadata: EditorMetadata | null;
  onMetadataChange: (value: EditorMetadata | null) => void;
  validation: ValidationReport | null;
  onValidate: () => void;
  active: boolean;
}
const durationChoices = [
  { label: "Thirty-second", whole: 1 / 32 }, { label: "Sixteenth", whole: 1 / 16 },
  { label: "Dotted sixteenth", whole: 3 / 32 }, { label: "Eighth", whole: 1 / 8 },
  { label: "Dotted eighth", whole: 3 / 16 }, { label: "Quarter", whole: 1 / 4 },
  { label: "Dotted quarter", whole: 3 / 8 }, { label: "Half", whole: 1 / 2 },
  { label: "Dotted half", whole: 3 / 4 }, { label: "Whole", whole: 1 }, { label: "Two whole notes", whole: 2 },
];

export function VisualScoreEditor({ abc, lyrics, onChange, metadata, onMetadataChange, validation, onValidate, active }: Props) {
  const timeline = useMemo(() => parseTimeline(abc), [abc]);
  const [sectionIndex, setSectionIndex] = useState(0);
  const [voice, setVoice] = useState<VoiceName>("Vocal");
  const [selection, setSelection] = useState<{ bar: string; event: string } | null>(null);
  const [chordSelection, setChordSelection] = useState<{ bar: string; index: number } | null>(null);
  const [chord, setChord] = useState("");
  const [duration, setDuration] = useState("");
  const [pitch, setPitch] = useState("60");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [view, setView] = useState<"timeline" | "piano" | "notation">("timeline");
  const [zoom, setZoom] = useState(72);
  const [firstBar, setFirstBar] = useState(1);
  const [lastBar, setLastBar] = useState(1);
  const [lyricLine, setLyricLine] = useState("");
  const [history, setHistory] = useState<{ past: Snapshot[]; future: Snapshot[] }>({ past: [], future: [] });
  const expected = useRef({ abc, metadata: JSON.stringify(metadata) });
  const section = timeline.sections[Math.min(sectionIndex, timeline.sections.length - 1)];
  const bars = timeline.bars[voice].filter(bar => bar.section === section?.index);
  const selectedBar = bars.find(bar => bar.id === selection?.bar);
  const selectedEvent = selectedBar?.events.find(event => event.id === selection?.event);
  const info = selectedBar && selectedEvent ? chainInfo(timeline, selectedBar, selectedEvent) : null;
  const occurrence = section ? timeline.sections.slice(0, section.index).filter(item => item.title.toLowerCase() === section.title.toLowerCase()).length : 0;
  const words = section ? sectionLyrics(lyrics, section.title, occurrence) : "";
  const lines = words.split(/\r?\n/).filter(line => line.trim());
  const metadataCurrent = !metadata || metadata.lyrics === lyrics;
  const phrases = metadataCurrent ? metadata?.phrases.filter(phrase => phrase.section === section?.index) ?? [] : [];
  const previewFirst = Math.max(section?.firstBar ?? 1, firstBar);
  const previewLast = Math.min(section?.lastBar ?? 1, Math.max(previewFirst, lastBar));
  const rangeFirst = timeline.bars[voice].find(bar => bar.number === previewFirst);
  const rangeLast = timeline.bars[voice].find(bar => bar.number === previewLast);

  useEffect(() => {
    if (expected.current.abc !== abc || expected.current.metadata !== JSON.stringify(metadata)) {
      setHistory({ past: [], future: [] });
      setSelection(null); setChordSelection(null); setError("");
      expected.current = { abc, metadata: JSON.stringify(metadata) };
    }
  }, [abc, metadata]);
  function emit(snapshot: Snapshot) {
    expected.current = { abc: snapshot.abc, metadata: JSON.stringify(snapshot.metadata) };
    onChange(snapshot.abc); onMetadataChange(snapshot.metadata);
    setSelection(null); setChordSelection(null); setError("");
  }
  function commit(nextAbc: string, nextMetadata = metadata) {
    if (nextAbc === abc && JSON.stringify(nextMetadata) === JSON.stringify(metadata)) return;
    setHistory(previous => ({ past: [...previous.past.slice(-99), { abc, metadata }], future: [] }));
    emit({ abc: nextAbc, metadata: nextMetadata });
  }
  function undo() {
    const previous = history.past.at(-1);
    if (!previous) return;
    setHistory({ past: history.past.slice(0, -1), future: [{ abc, metadata }, ...history.future] });
    emit(previous); setMessage("Undid the last score edit.");
  }
  function redo() {
    const next = history.future[0];
    if (!next) return;
    setHistory({ past: [...history.past, { abc, metadata }], future: history.future.slice(1) });
    emit(next); setMessage("Redid the score edit.");
  }
  function attempt(task: () => string) {
    try { commit(task()); setMessage("Draft updated. Validate before saving or rendering."); return true; }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to edit the score."); return false; }
  }
  function chooseEvent(bar: TimelineBar, event: TimelineEvent) {
    const selected = chainInfo(timeline, bar, event);
    setSelection({ bar: bar.id, event: event.id }); setChordSelection(null);
    setDuration(String(selected.duration)); setPitch(String(event.pitch ?? 60)); setError("");
    setFirstBar(bar.number); setLastBar(bar.number);
  }
  function resize(bar: TimelineBar, event: TimelineEvent, units: number) {
    return attempt(() => editTimelineEvent(timeline, bar.id, event.id, { duration: units }));
  }
  function linkLine() {
    if (!section || !lyricLine || previewFirst > previewLast) return;
    const phrase = { section: section.index, line: Number(lyricLine), text: lines[Number(lyricLine)], first_bar: previewFirst, last_bar: previewLast };
    const current = metadataCurrent ? metadata?.phrases ?? [] : [];
    commit(abc, { lyrics, phrases: [...current.filter(item => !(item.section === phrase.section && item.line === phrase.line)), phrase] });
    setMessage("Linked the lyric line to this bar range. This is a phrase reference, not syllable alignment.");
  }
  return <div className="visual-score-editor" onKeyDownCapture={event => {
    if (!(event.ctrlKey || event.metaKey)) return;
    // Text inputs keep their own text undo; the score history also includes Advanced edits.
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea") && !target.closest(".abc-editor")) return;
    if (event.key.toLowerCase() === "z" || event.key.toLowerCase() === "y") {
      event.preventDefault(); event.stopPropagation();
      if (event.shiftKey || event.key.toLowerCase() === "y") redo(); else undo();
    }
  }}>
    <div className="score-toolbar">
      <h3>Composition editor</h3>
      <div className="job-actions">
        <button type="button" className="secondary-button" onClick={undo} disabled={!history.past.length}>Undo</button>
        <button type="button" className="secondary-button" onClick={redo} disabled={!history.future.length}>Redo</button>
        <button type="button" className="secondary-button" onClick={onValidate} disabled={!abc}>Validate draft</button>
      </div>
    </div>
    {!section && <p className="field-help">Load a plan or import native ABC to explore its bars.</p>}
    <nav className="score-section-tabs" aria-label="Score sections">
      {timeline.sections.map(item => <button type="button" key={item.index} aria-pressed={section?.index === item.index}
        onClick={() => { setSectionIndex(item.index); setSelection(null); setChordSelection(null); setFirstBar(item.firstBar); setLastBar(item.firstBar); setLyricLine(""); setError(""); }}>
        {item.title} <small>Bars {item.firstBar}–{item.lastBar}</small>
      </button>)}
    </nav>
    {section && <>
      <div className="score-toolbar">
        <h4>{section.title}</h4>
        <label>Part <select aria-label="Score part" value={voice} onChange={event => { setVoice(event.target.value as VoiceName); setSelection(null); setChordSelection(null); }}>
          <option value="Vocal">Vocal melody</option><option value="Ins">Instrumental melody</option>
        </select></label>
        <div className="score-section-tabs" aria-label="Score view">
          <button type="button" aria-pressed={view === "timeline"} onClick={() => setView("timeline")}>Timeline</button>
          <button type="button" aria-pressed={view === "piano"} onClick={() => setView("piano")}>Piano Roll</button>
          <button type="button" aria-pressed={view === "notation"} onClick={() => setView("notation")}>Notation</button>
        </div>
        <label>Zoom <select aria-label="Timeline zoom" value={zoom} onChange={event => setZoom(Number(event.target.value))}>
          <option value={48}>Compact</option><option value={72}>Normal</option><option value={112}>Large</option><option value={288}>Detailed</option>
        </select></label>
      </div>
      {timeline.errors.length > 0 && <div className="notice warning" role="status">
        <strong>Resolve score issues before visual editing</strong>
        <ul>{timeline.errors.map((issue, index) => <li key={index}>{issue}</li>)}</ul>
        <p>The original source remains available in Advanced.</p>
      </div>}
      <details className="score-phrase-panel"><summary>Lyrics and phrase references</summary>
        <label>Lyric line <select aria-label="Lyric line" value={lyricLine} onChange={event => setLyricLine(event.target.value)}>
          <option value="">Choose a line to reference…</option>
          {lines.map((line, index) => <option key={index} value={index}>{index + 1}. {line}</option>)}
        </select></label>
        {!lines.length && <p className="field-help">No matching lyrics in the current inputs for this section.</p>}
        <div className="score-toolbar">
          <label>From bar <select aria-label="First phrase bar" value={previewFirst} onChange={event => setFirstBar(Number(event.target.value))}>{bars.map(bar => <option key={bar.id} value={bar.number}>{bar.number}</option>)}</select></label>
          <label>Through bar <select aria-label="Last phrase bar" value={previewLast} onChange={event => setLastBar(Number(event.target.value))}>{bars.filter(bar => bar.number >= previewFirst).map(bar => <option key={bar.id} value={bar.number}>{bar.number}</option>)}</select></label>
          <button type="button" className="secondary-button" disabled={!lyricLine || !!timeline.errors.length} onClick={linkLine}>Link line to bars</button>
        </div>
        <p className="field-help">Choose a line and its bars for a phrase reference. These links are saved with new score versions; they do not assign syllables to notes.</p>
        {!metadataCurrent && <div className="notice warning">Lyrics changed. Previous phrase links are inactive. Linking a line will replace them.
          <button type="button" className="text-button" onClick={() => commit(abc, null)}>Discard previous links</button>
        </div>}
        {phrases.map((phrase, index) => <div className="score-phrase" key={index}>
          <button type="button" className="text-button" onClick={() => { setFirstBar(phrase.first_bar); setLastBar(phrase.last_bar); setLyricLine(String(phrase.line)); }}>{phrase.text} · Bars {phrase.first_bar}–{phrase.last_bar}</button>
          <button type="button" className="text-button" aria-label={`Remove phrase link ${phrase.text}`} onClick={() => commit(abc, { lyrics, phrases: (metadata?.phrases ?? []).filter(item => item !== phrase) })}>Remove</button>
        </div>)}
      </details>
      <ScorePlayback validation={validation} active={active} abc={abc}
        range={rangeFirst && rangeLast ? { start: rangeFirst.absolute * 4 / timeline.unitDenominator, end: (rangeLast.absolute + rangeLast.length) * 4 / timeline.unitDenominator, voice, label: `bars ${previewFirst}–${previewLast}` } : undefined} />
      {view === "notation" ? <><h4>Complete score notation</h4><ScorePreview abc={abc} /></> : view === "piano" ? (
        <PianoRoll score={timeline} bars={bars} zoom={zoom} selectedChain={selectedEvent?.chain}
          phrases={phrases} active={active} onSelect={chooseEvent} onResize={resize}
          onMove={(note, start, nextPitch) => attempt(() => moveTimelineEvent(timeline, note.bar.id, note.event.id, start, nextPitch))}
          onInsert={(bar, onset, length, nextPitch) => attempt(() => insertTimelineNote(timeline, bar.id, onset, length, nextPitch))}
          onDelete={note => attempt(() => editTimelineEvent(timeline, note.bar.id, note.event.id, { pitch: null }))}
          onChord={(bar, index) => { setChordSelection({ bar: bar.id, index }); setChord(bar.annotations[index].value); setSelection(null); setError(""); }}
        />
      ) : <>
        <p className="field-help">Blocks show actual lengths. Select a note, rest or chord. Drag a selected block’s right edge to resize, or use the duration controls below. Beat numbers follow the meter’s denominator.</p>
        <div className="score-timeline" tabIndex={0} aria-label={`${section.title} bar timeline`}>
          <div className="score-timeline-track">
            {bars.map(bar => <section className={`score-bar ${bar.issues.length ? "score-bar-invalid" : ""}`} key={bar.id}
              style={{ width: bar.length * 4 / timeline.unitDenominator * Math.max(zoom, 240 / Math.min(...bars.map(item => item.length * 4 / timeline.unitDenominator))) }} aria-label={`${voice} bar ${bar.number}`}>
              <div className="score-bar-heading"><button type="button" className="text-button" onClick={() => { setFirstBar(bar.number); setLastBar(bar.number); }}>Bar {bar.number}</button><span>{bar.meter.join("/")}</span></div>
              <div className="score-bar-phrases">{phrases.filter(phrase => phrase.first_bar <= bar.number && phrase.last_bar >= bar.number).map((phrase, index) => <span key={index}>{phrase.text}</span>)}</div>
              <div className="score-chord-lane" aria-label={`Chords in bar ${bar.number}`}>
                {bar.annotations.map((annotation, index) => annotation.kind === "chord" ? <button type="button" className="score-chord" key={index}
                  style={{ left: `${annotation.onset / bar.length * 100}%` }} disabled={!!timeline.errors.length}
                  aria-pressed={chordSelection?.bar === bar.id && chordSelection.index === index}
                  onClick={() => { setChordSelection({ bar: bar.id, index }); setChord(annotation.value); setSelection(null); setError(""); }}>{annotation.value}</button> : null)}
              </div>
              <div className="score-beats">{Array.from({ length: bar.meter[0] }, (_, beat) => <span key={beat} style={{ left: `${beat / bar.meter[0] * 100}%` }}>{beat + 1}</span>)}</div>
              <div className="score-event-lane" style={{ backgroundSize: `${100 / bar.meter[0]}% 100%` }}>
                {bar.events.map(event => {
                  const selected = event.chain === selectedEvent?.chain;
                  const label = `${pitchLabel(event.pitch)}, ${durationLabel(event.duration, timeline.unitDenominator)}, bar ${bar.number}, beat ${1 + event.onset / (timeline.unitDenominator / bar.meter[1])}${event.tiedFrom || event.tiedTo ? ", tied continuation" : ""}`;
                  return <div key={event.id} className={`score-event ${event.pitch === null ? "score-rest" : ""} ${selected ? "score-event-selected" : ""}`}
                    style={{ left: `${event.onset / bar.length * 100}%`, width: `${event.duration / bar.length * 100}%` }}>
                    <button type="button" title={label} aria-label={label} aria-pressed={selected} disabled={!!timeline.errors.length}
                      onClick={() => chooseEvent(bar, event)}><strong>{pitchLabel(event.pitch)}</strong><small>{durationLabel(event.duration, timeline.unitDenominator)}</small>{event.tiedFrom || event.tiedTo ? <span aria-hidden="true">⌒</span> : null}</button>
                    {selected && !event.tiedTo && <div className="score-resize-handle" role="separator" aria-label="Resize selected note or rest" aria-orientation="vertical" aria-valuemin={1} aria-valuemax={chainInfo(timeline, bar, event).available} aria-valuenow={chainInfo(timeline, bar, event).duration} tabIndex={0}
                      onKeyDown={eventKey => { if (eventKey.key === "ArrowRight" || eventKey.key === "ArrowLeft") { eventKey.preventDefault(); resize(bar, event, Math.max(1, chainInfo(timeline, bar, event).duration + (eventKey.key === "ArrowRight" ? 1 : -1))); } }}
                      onPointerDown={pointer => {
                        const handle = pointer.currentTarget;
                        const lane = handle.parentElement?.parentElement;
                        if (!lane) return;
                        handle.setPointerCapture(pointer.pointerId);
                        handle.dataset.startX = String(pointer.clientX);
                        handle.dataset.startDuration = String(chainInfo(timeline, bar, event).duration);
                        handle.dataset.unitsPerPixel = String(bar.length / lane.getBoundingClientRect().width);
                      }}
                      onPointerMove={pointer => {
                        const handle = pointer.currentTarget;
                        if (!handle.hasPointerCapture(pointer.pointerId)) return;
                        const units = Math.max(1, Math.round(Number(handle.dataset.startDuration) + (pointer.clientX - Number(handle.dataset.startX)) * Number(handle.dataset.unitsPerPixel)));
                        setMessage(`Release to set ${durationLabel(units, timeline.unitDenominator)}. Overlaps will be rejected.`);
                      }}
                      onPointerCancel={() => setMessage("Resize canceled.")}
                      onPointerUp={pointer => {
                        const handle = pointer.currentTarget;
                        if (!handle.hasPointerCapture(pointer.pointerId)) return;
                        handle.releasePointerCapture(pointer.pointerId);
                        const units = Math.max(1, Math.round(Number(handle.dataset.startDuration) + (pointer.clientX - Number(handle.dataset.startX)) * Number(handle.dataset.unitsPerPixel)));
                        if (units !== Number(handle.dataset.startDuration)) resize(bar, event, units);
                      }} />}
                  </div>;
                })}
              </div>
              {bar.issues.map((issue, index) => <p className="score-bar-error" key={index}>{issue}</p>)}
            </section>)}
          </div>
        </div>
      </>}
      {selectedEvent && selectedBar && info && <form className="score-inspector" onSubmit={event => { event.preventDefault(); attempt(() => editTimelineEvent(timeline, selectedBar.id, selectedEvent.id, { duration: Number(duration) })); }}>
        <h4>{pitchLabel(selectedEvent.pitch)} · Bar {info.first.bar.number}, beat {1 + info.first.event.onset / (timeline.unitDenominator / info.first.bar.meter[1])}</h4>
        <p className="field-help">{info.members.length > 1 ? `Editing the complete tied note (${info.members.length} segments). ` : ""}Shortening leaves a rest. Lengthening consumes following silence, with ties across barlines. Other notes and chords stay in place.</p>
        <div className="score-toolbar">
          <label>Pitch <select aria-label="Selected pitch" value={pitch} onChange={event => setPitch(event.target.value)}>{Array.from({ length: 128 }, (_, midi) => <option key={midi} value={midi}>{pitchLabel(midi)}</option>)}</select></label>
          <button type="button" className="secondary-button" onClick={() => attempt(() => editTimelineEvent(timeline, selectedBar.id, selectedEvent.id, { pitch: Number(pitch) }))}>{selectedEvent.pitch === null ? "Turn into note" : "Apply pitch"}</button>
          {selectedEvent.pitch !== null && <button type="button" className="secondary-button" onClick={() => attempt(() => editTimelineEvent(timeline, selectedBar.id, selectedEvent.id, { pitch: null }))}>Turn into rest</button>}
        </div>
        <div className="score-toolbar">
          <label>Duration <select aria-label="Selected duration" value={duration} onChange={event => setDuration(event.target.value)}>
            {!durationChoices.some(choice => choice.whole * timeline.unitDenominator === Number(duration)) && <option value={duration}>{durationLabel(Number(duration), timeline.unitDenominator)}</option>}
            {durationChoices.filter(choice => Number.isInteger(choice.whole * timeline.unitDenominator)).map(choice => <option key={choice.label} value={choice.whole * timeline.unitDenominator}>{choice.label}</option>)}
          </select></label>
          <button type="submit" className="primary-button">Apply duration</button>
          <button type="button" className="secondary-button" onClick={() => resize(selectedBar, selectedEvent, info.available)}>Extend into available silence</button>
          <button type="button" className="secondary-button" disabled={info.duration < 2} onClick={() => attempt(() => editTimelineEvent(timeline, selectedBar.id, selectedEvent.id, { splitAfter: Math.floor(info.duration / 2) }))}>Split in half</button>
        </div>
        <p className="field-help">Current: {durationLabel(info.duration, timeline.unitDenominator)}. Available without moving notes: {durationLabel(info.available, timeline.unitDenominator)}.</p>
      </form>}
      {chordSelection && <form className="score-inspector" onSubmit={event => { event.preventDefault(); attempt(() => editTimelineChord(timeline, chordSelection.bar, chordSelection.index, chord)); }}>
        <label>Chord <input aria-label="Selected chord" value={chord} onChange={event => setChord(event.target.value)} /></label>
        <button type="submit" className="primary-button">Apply chord</button>
      </form>}
    </>}
    {error && <p role="alert" className="notice warning">{error}</p>}
    <p role="status" className="field-help">{message}</p>
    <details><summary>Advanced · ABC source</summary><AbcEditor value={abc}
      onUndo={undo} onRedo={redo}
      onChange={text => { commit(text, null); setMessage(metadata?.phrases.length ? "Source edited. Phrase links were cleared; Undo restores them." : "ABC draft updated."); }} /></details>
  </div>;
}
