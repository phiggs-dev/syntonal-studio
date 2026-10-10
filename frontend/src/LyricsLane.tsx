import { useState } from "react";
import type { LyricPhrase, TimelineBar } from "./visualScore";
interface Props {
  lines: string[]; phrases: LyricPhrase[]; bars: TimelineBar[]; widths: number[]; offset: number;
  selected: string; first: number; last: number; stale: boolean; disabled: boolean;
  onSelect: (line: number) => void; onBar: (bar: number) => void; onRange: (first: number, last: number) => void;
  onLink: () => void; onRemove: (line: number) => void; onEdit: (line: number, text: string) => boolean;
}
function LineEditor({ text, onSave }: { text: string; onSave: (value: string) => boolean }) {
  const [value, setValue] = useState(text);
  return <div className="lyrics-line-editor">
    <label>Edit lyric line <input aria-label="Edit lyric line" value={value} maxLength={10_000} onChange={event => setValue(event.target.value)} /></label>
    <button type="button" className="secondary-button" disabled={!value.trim() || value === text} onClick={() => onSave(value)}>Save lyric edit</button>
  </div>;
}
export function LyricsLane({ lines, phrases, bars, widths, offset, selected, first, last, stale, disabled, onSelect, onBar, onRange, onLink, onRemove, onEdit }: Props) {
  const linked = phrases.filter(phrase => phrase.text === lines[phrase.line] && bars.some(bar => bar.number === phrase.first_bar) && bars.some(bar => bar.number === phrase.last_bar)).sort((first, second) => first.line - second.line);
  const unlinked = lines.map((text, index) => ({ text, index })).filter(line => !linked.some(phrase => phrase.line === line.index));
  const chosen = selected === "" ? null : Number(selected);
  return <section className="lyrics-lane" aria-label="Lyrics lane">
    <h4>Lyrics lane</h4>
    <p className="field-help">Link whole lines to bars for composition and navigation. These references do not control sung timing.</p>
    {stale && <p className="notice warning" role="status">Lyrics changed. Previous phrase links are inactive. Relink a line to replace them.</p>}
    {!!linked.length && <div className="lyrics-lane-scroll" tabIndex={0} aria-label="Lyrics by bar">
      <div style={{ width: widths.reduce((sum, width) => sum + width, offset) }}>
        <div className="lyrics-lane-ruler" style={{ paddingLeft: offset }}>{bars.map((bar, index) => <button type="button" className="text-button" key={bar.id} style={{ width: widths[index] }} aria-pressed={chosen !== null && bar.number >= first && bar.number <= last} onClick={() => onBar(bar.number)}>Bar {bar.number}</button>)}</div>
        {linked.map(phrase => {
          const start = bars.findIndex(bar => bar.number === phrase.first_bar);
          const end = bars.findIndex(bar => bar.number === phrase.last_bar);
          const left = offset + widths.slice(0, start).reduce((sum, width) => sum + width, 0);
          const width = widths.slice(start, end + 1).reduce((sum, width) => sum + width, 0);
          return <div className="lyrics-lane-track" key={phrase.line}><button type="button" className="lyrics-phrase-block" aria-pressed={selected === String(phrase.line)} style={{ marginLeft: left, width }} onClick={() => onSelect(phrase.line)}><span>{phrase.text}</span><small>Bars {phrase.first_bar}–{phrase.last_bar}</small></button></div>;
        })}
      </div>
    </div>}
    {unlinked.length > 0 && <div className="lyrics-unlinked"><strong>Unlinked lines</strong>{unlinked.map(line => <button type="button" className="text-button" aria-pressed={selected === String(line.index)} key={line.index} onClick={() => onSelect(line.index)}>{line.index + 1}. {line.text}</button>)}</div>}
    {!lines.length && <p className="field-help">No matching lyric lines for this section. Add them in the lyrics editor using the matching section heading.</p>}
    {chosen !== null && lines[chosen] !== undefined && <fieldset className="lyrics-phrase-controls" disabled={disabled}>
      <LineEditor key={`${chosen}:${lines[chosen]}`} text={lines[chosen]} onSave={text => onEdit(chosen, text)} />
      <div className="score-toolbar">
        <label>From bar <select aria-label="First phrase bar" value={first} onChange={event => onRange(Number(event.target.value), Math.max(last, Number(event.target.value)))}>{bars.map(bar => <option key={bar.id} value={bar.number}>{bar.number}</option>)}</select></label>
        <label>Through bar <select aria-label="Last phrase bar" value={last} onChange={event => onRange(first, Number(event.target.value))}>{bars.filter(bar => bar.number >= first).map(bar => <option key={bar.id} value={bar.number}>{bar.number}</option>)}</select></label>
        <button type="button" className="secondary-button" onClick={onLink}>Link line to bars</button>
        {linked.some(phrase => phrase.line === chosen) && <button type="button" className="text-button" onClick={() => onRemove(chosen)}>Unlink line</button>}
      </div>
    </fieldset>}
  </section>;
}
