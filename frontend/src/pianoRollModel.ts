import type { ScoreTimeline, TimelineBar, TimelineEvent } from "./visualScore";

export interface PianoNote {
  chain: string;
  bar: TimelineBar;
  event: TimelineEvent;
  start: number;
  duration: number;
  pitch: number;
  visibleStart: number;
  visibleEnd: number;
}
/** Merge tied segments for drawing while retaining a source anchor for all edit operations. */
export function pianoRollNotes(score: ScoreTimeline, bars: TimelineBar[]): PianoNote[] {
  if (!bars.length) return [];
  const origin = bars[0].absolute;
  const end = bars.at(-1)!.absolute + bars.at(-1)!.length;
  const chains = new Map<string, PianoNote>();
  for (const bar of score.bars[bars[0].voice]) for (const event of bar.events) {
    if (event.pitch === null) continue;
    const existing = chains.get(event.chain);
    if (existing) existing.duration += event.duration;
    else chains.set(event.chain, { chain: event.chain, bar, event, start: bar.absolute + event.onset,
      duration: event.duration, pitch: event.pitch, visibleStart: 0, visibleEnd: 0 });
  }
  return [...chains.values()].filter(note => note.start < end && note.start + note.duration > origin).map(note => {
    const visibleBar = bars.find(bar => bar.events.some(event => event.chain === note.chain))!;
    return { ...note, bar: visibleBar, event: visibleBar.events.find(event => event.chain === note.chain)!,
      visibleStart: Math.max(note.start, origin), visibleEnd: Math.min(note.start + note.duration, end) };
  });
}
export function snapPianoPosition(position: number, step: number): number {
  return Math.round(position / step) * step;
}
