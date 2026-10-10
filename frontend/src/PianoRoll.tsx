import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { pianoRollNotes, snapPianoPosition, type PianoNote } from "./pianoRollModel";
import { durationLabel, pitchLabel, type ScoreTimeline, type TimelineBar, type TimelineEvent } from "./visualScore";

interface Props {
  score: ScoreTimeline;
  bars: TimelineBar[];
  zoom: number;
  selectedChain?: string;
  highlighted: { first: number; last: number } | null;
  onBarSelect: (bar: number) => void;
  active: boolean;
  onSelect: (bar: TimelineBar, event: TimelineEvent) => void;
  onResize: (bar: TimelineBar, event: TimelineEvent, duration: number) => void;
  onMove: (note: PianoNote, start: number, pitch: number) => boolean;
  onInsert: (bar: TimelineBar, onset: number, duration: number, pitch: number) => boolean;
  onDelete: (note: PianoNote) => void;
  onChord: (bar: TimelineBar, index: number) => void;
}
interface DragPreview { chain: string; start: number; duration: number; pitch: number }
interface PointerDrag {
  note: PianoNote;
  mode: "move" | "resize";
  x: number;
  y: number;
  scrollLeft: number;
  scrollTop: number;
  target: HTMLElement;
  pointerId: number;
  preview: DragPreview;
  moved: boolean;
}
const rowHeight = 24;
const keyboardWidth = 72;
const blackKeys = new Set([1, 3, 6, 8, 10]);
const pitches = Array.from({ length: 128 }, (_, index) => 127 - index);

export function PianoRoll({ score, bars, zoom, selectedChain, highlighted, onBarSelect, active,
  onSelect, onResize, onMove, onInsert, onDelete, onChord }: Props) {
  const notes = useMemo(() => pianoRollNotes(score, bars), [score, bars]);
  const viewport = useRef<HTMLDivElement>(null);
  const audio = useRef<AudioContext | null>(null);
  const drag = useRef<PointerDrag | null>(null);
  const suppressClick = useRef(false);
  const focusRequest = useRef<{ start: number; pitch: number; source: string } | null>(null);
  const [preview, setPreview] = useState<DragPreview | null>(null);
  const [snapFraction, setSnapFraction] = useState(16);
  const [newLength, setNewLength] = useState(4);
  const [draw, setDraw] = useState(false);
  const [keyboardPitch, setKeyboardPitch] = useState(60);
  const [status, setStatus] = useState("");
  const origin = bars[0]?.absolute ?? 0;
  const end = bars.length ? bars.at(-1)!.absolute + bars.at(-1)!.length : origin;
  const pixelsPerUnit = zoom * 4 / score.unitDenominator;
  const width = Math.max(1, (end - origin) * pixelsPerUnit);
  const snap = Math.max(1, score.unitDenominator / snapFraction);
  const noteLength = Math.max(1, score.unitDenominator / newLength);
  const disabled = score.errors.length > 0;
  const contextKey = `${bars[0]?.voice}:${bars[0]?.section}`;
  const initialCenter = useRef(60);
  initialCenter.current = notes.length ? notes.reduce((sum, note) => sum + note.pitch, 0) / notes.length : 60;

  useEffect(() => {
    const request = focusRequest.current;
    if (request && request.source !== score.abc) {
      focusRequest.current = null;
      viewport.current?.querySelector<HTMLButtonElement>(`button[data-note-start="${request.start}"][data-note-pitch="${request.pitch}"]`)?.focus({ preventScroll: true });
    }
  }, [score.abc, notes]);
  function moveNote(note: PianoNote, start: number, pitch: number) {
    focusRequest.current = null;
    if (onMove(note, start, pitch) && (start !== note.start || pitch !== note.pitch))
      focusRequest.current = { start, pitch, source: score.abc };
  }
  function fitNotes() {
    const host = viewport.current;
    if (host) host.scrollTop = Math.max(0, (127 - initialCenter.current) * rowHeight - (host.clientHeight - 96) / 2);
  }
  useEffect(() => { fitNotes(); }, [contextKey]);
  useEffect(() => {
    drag.current = null;
    setPreview(null);
  }, [score.abc, contextKey]);
  useEffect(() => {
    if (!active) {
      const current = audio.current;
      audio.current = null;
      if (current) void current.close();
    }
    return () => {
      const current = audio.current;
      audio.current = null;
      if (current) void current.close();
    };
  }, [active]);

  async function audition(pitch: number) {
    if (!active) return;
    try {
      const context = audio.current ?? new AudioContext();
      audio.current = context;
      await context.resume();
      if (audio.current !== context) return;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "triangle";
      oscillator.frequency.value = 440 * 2 ** ((pitch - 69) / 12);
      gain.gain.setValueAtTime(0.04, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.22);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.23);
    } catch { setStatus("Keyboard tone preview is unavailable in this browser."); }
  }
  function beginPointer(event: ReactPointerEvent<HTMLElement>, note: PianoNote, mode: "move" | "resize") {
    if (disabled || !viewport.current || event.button !== 0) return;
    event.preventDefault();
    onSelect(note.bar, note.event);
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { note, mode, x: event.clientX, y: event.clientY,
      scrollLeft: viewport.current.scrollLeft, scrollTop: viewport.current.scrollTop,
      target: event.currentTarget, pointerId: event.pointerId,
      preview: { chain: note.chain, start: note.start, duration: note.duration, pitch: note.pitch }, moved: false };
  }
  function updatePointer(event: ReactPointerEvent<HTMLElement>) {
    const current = drag.current, host = viewport.current;
    if (!current || !host || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.x + host.scrollLeft - current.scrollLeft;
    const dy = event.clientY - current.y + host.scrollTop - current.scrollTop;
    current.moved ||= Math.abs(dx) + Math.abs(dy) >= 3;
    if (!current.moved) return;
    current.preview = current.mode === "move" ? {
      chain: current.note.chain,
      start: snapPianoPosition(current.note.start + dx / pixelsPerUnit - origin, snap) + origin,
      duration: current.note.duration,
      pitch: Math.max(0, Math.min(127, current.note.pitch - Math.round(dy / rowHeight))),
    } : {
      chain: current.note.chain, start: current.note.start, pitch: current.note.pitch,
      duration: Math.max(snap, snapPianoPosition(current.note.duration + dx / pixelsPerUnit, snap)),
    };
    setPreview(current.preview);
    setStatus(`${pitchLabel(current.preview.pitch)} · ${durationLabel(current.preview.duration, score.unitDenominator)}. Release to apply; overlaps are rejected.`);
  }
  function finishPointer(event: ReactPointerEvent<HTMLElement>, cancel = false) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (current.target.hasPointerCapture(event.pointerId)) current.target.releasePointerCapture(event.pointerId);
    drag.current = null;
    setPreview(null);
    if (!cancel && current.moved) {
      suppressClick.current = true;
      if (current.mode === "resize") onResize(current.note.bar, current.note.event, current.preview.duration);
      else moveNote(current.note, current.preview.start, current.preview.pitch);
    }
    setStatus(cancel ? "Drag canceled." : "");
  }
  function addAt(event: React.MouseEvent<HTMLDivElement>, pitch: number) {
    if (disabled) return;
    const position = Math.floor((event.clientX - event.currentTarget.getBoundingClientRect().left) / pixelsPerUnit / snap) * snap + origin;
    const bar = bars.find(item => item.absolute <= position && item.absolute + item.length > position);
    if (bar && onInsert(bar, position - bar.absolute, noteLength, pitch))
      focusRequest.current = { start: position, pitch, source: score.abc };
  }
  const pointerHandlers = {
    onPointerMove: updatePointer,
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => finishPointer(event),
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => finishPointer(event, true),
    onLostPointerCapture: () => { drag.current = null; setPreview(null); },
  };
  return <div className="piano-roll-editor">
    <div className="score-toolbar">
      <label>Snap <select aria-label="Piano roll snap" value={snapFraction} onChange={event => setSnapFraction(Number(event.target.value))}>
        {[4, 8, 16, 32].filter(value => score.unitDenominator >= value).map(value => <option key={value} value={value}>1/{value} note</option>)}
        {score.unitDenominator < 16 && <option value={16}>Finest available</option>}
      </select></label>
      <label>New note <select aria-label="New piano note duration" value={newLength} onChange={event => setNewLength(Number(event.target.value))}>
        {[1, 2, 4, 8, 16, 32].filter(value => score.unitDenominator >= value).map(value => <option key={value} value={value}>{durationLabel(score.unitDenominator / value, score.unitDenominator)}</option>)}
        {score.unitDenominator < 4 && <option value={4}>Finest available</option>}
      </select></label>
      <button type="button" className="secondary-button" aria-pressed={draw} onClick={() => setDraw(value => !value)}>{draw ? "Draw notes" : "Select / move"}</button>
      <button type="button" className="secondary-button" onClick={fitNotes}>Fit notes</button>
    </div>
    <p className="field-help">Drag notes to change pitch or timing; drag their right edge to resize. Double-click empty space to add a note, or enable Draw notes for a single click. Rests are empty space. Arrow keys move notes; Shift+Left/Right changes length; Delete makes them rests. Changes use the same inspector and Undo/Redo as Timeline.</p>
    <div className="piano-roll-viewport" ref={viewport} tabIndex={0} aria-label="Piano roll: pitch keyboard and musical timeline"
      onKeyDown={event => {
        if (event.key === "Escape" && drag.current) {
          const current = drag.current;
          drag.current = null; setPreview(null); setStatus("Drag canceled.");
          if (current.target.hasPointerCapture(current.pointerId)) current.target.releasePointerCapture(current.pointerId);
        }
      }}>
      <div className="piano-roll-content" style={{ width: keyboardWidth + width }}>
        <div className="piano-roll-header">
          <div className="piano-key-corner">Pitch</div>
          <div className="piano-ruler" style={{ width, marginLeft: keyboardWidth }}>
            {bars.map(bar => <div className={`piano-ruler-bar ${highlighted && bar.number >= highlighted.first && bar.number <= highlighted.last ? "piano-bar-highlighted" : ""}`} key={bar.id} style={{ left: (bar.absolute - origin) * pixelsPerUnit, width: bar.length * pixelsPerUnit }}>
              <button type="button" className="piano-bar-title text-button" aria-label={`Select bar ${bar.number}`} onClick={() => onBarSelect(bar.number)}>Bar {bar.number} · {bar.meter.join("/")}</button>
              {(score.bars.Vocal.find(item => item.number === bar.number)?.annotations ?? []).map((annotation, index) => annotation.kind === "chord" ?
                <button type="button" key={index} className="piano-chord" style={{ left: annotation.onset * pixelsPerUnit }} disabled={disabled}
                  onClick={() => onChord(score.bars.Vocal.find(item => item.number === bar.number)!, index)}>{annotation.value}</button> : null)}
              {Array.from({ length: bar.meter[0] }, (_, beat) => <span className="piano-beat-title" key={beat} style={{ left: beat / bar.meter[0] * bar.length * pixelsPerUnit }}>{beat + 1}</span>)}
            </div>)}
          </div>
        </div>
        <div className="piano-roll-body" style={{ height: 128 * rowHeight }}>
          {pitches.map(pitch => <div className={`piano-pitch-row ${blackKeys.has(pitch % 12) ? "piano-black-row" : ""}`} key={pitch}
            style={{ top: (127 - pitch) * rowHeight, height: rowHeight }}>
            <button type="button" className="piano-key" data-key-pitch={pitch} tabIndex={pitch === keyboardPitch ? 0 : -1} onFocus={() => setKeyboardPitch(pitch)} aria-label={`Preview ${pitchLabel(pitch)}`} disabled={!active} onClick={() => void audition(pitch)} onKeyDown={event => {
              if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                event.preventDefault();
                const nextPitch = Math.max(0, Math.min(127, pitch + (event.key === "ArrowUp" ? 1 : -1)));
                setKeyboardPitch(nextPitch);
                viewport.current?.querySelector<HTMLButtonElement>(`button[data-key-pitch="${nextPitch}"]`)?.focus();
              }
            }}>{pitchLabel(pitch)}</button>
            <div className={`piano-row-space ${draw ? "piano-draw" : ""}`} style={{ width, marginLeft: keyboardWidth, backgroundSize: `${snap * pixelsPerUnit}px 100%` }}
              onClick={event => { if (draw && event.detail === 1) addAt(event, pitch); }}
              onDoubleClick={event => { if (!draw) addAt(event, pitch); }} />
          </div>)}
          {bars.map(bar => <div className="piano-bar-line" key={bar.id} aria-hidden="true" style={{ left: keyboardWidth + (bar.absolute - origin) * pixelsPerUnit }} />)}
          {notes.map(note => {
            const drawing = preview?.chain === note.chain ? preview : note;
            const selected = selectedChain === note.chain;
            const visibleStart = Math.max(origin, drawing.start), visibleEnd = Math.min(end, drawing.start + drawing.duration);
            const label = `${pitchLabel(drawing.pitch)}, ${durationLabel(drawing.duration, score.unitDenominator)}, bar ${note.bar.number}`;
            return <div className={`piano-note ${selected ? "piano-note-selected" : ""}`} key={note.chain}
              style={{ left: keyboardWidth + (visibleStart - origin) * pixelsPerUnit, top: (127 - drawing.pitch) * rowHeight + 2,
                width: Math.max(2, (visibleEnd - visibleStart) * pixelsPerUnit), height: rowHeight - 4 }}>
              <button type="button" className="piano-note-body" data-note-start={note.start} data-note-pitch={note.pitch} aria-label={label} title={label} aria-pressed={selected} disabled={disabled}
                onFocus={() => onSelect(note.bar, note.event)} onClick={() => { if (suppressClick.current) suppressClick.current = false; else onSelect(note.bar, note.event); }} onPointerDown={event => beginPointer(event, note, "move")} {...pointerHandlers}
                onKeyDown={event => {
                  if (disabled || event.ctrlKey || event.metaKey) return;
                  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Delete", "Backspace"].includes(event.key)) {
                    event.preventDefault();
                    if (event.key === "Delete" || event.key === "Backspace") onDelete(note);
                    else if (event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) onResize(note.bar, note.event, Math.max(1, note.duration + (event.key === "ArrowRight" ? snap : -snap)));
                    else moveNote(note, note.start + (event.key === "ArrowRight" ? snap : event.key === "ArrowLeft" ? -snap : 0),
                      note.pitch + (event.key === "ArrowUp" ? 1 : event.key === "ArrowDown" ? -1 : 0));
                  }
                }}>{pitchLabel(drawing.pitch)}</button>
              {selected && note.start + note.duration <= end && <div className="piano-note-resize" role="separator" aria-label="Resize piano note" aria-orientation="vertical"
                aria-valuemin={1} aria-valuenow={note.duration} tabIndex={disabled ? -1 : 0}
                onPointerDown={event => beginPointer(event, note, "resize")} {...pointerHandlers}
                onKeyDown={event => {
                  if (!disabled && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
                    event.preventDefault(); onResize(note.bar, note.event, Math.max(1, note.duration + (event.key === "ArrowRight" ? snap : -snap)));
                  }
                }} />}
            </div>;
          })}
        </div>
      </div>
    </div>
    <p className="field-help" role="status">{status || "Keyboard buttons play short synthetic tones. Use the inspector to edit notes without dragging; empty regions can also be edited as rests in Timeline."}</p>
  </div>;
}
