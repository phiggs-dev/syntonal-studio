/** Studio timeline for YuE2's bounded ABC dialect. Native validation remains authoritative. */
export type VoiceName = "Vocal" | "Ins";
export interface TimelineEvent {
  id: string;
  onset: number; // Integer L: units from the start of this bar.
  duration: number;
  pitch: number | null;
  chain: string;
  tiedFrom: boolean;
  tiedTo: boolean;
}
export interface TimelineAnnotation { onset: number; kind: "chord" | "key"; value: string }
export interface TimelineBar {
  id: string;
  number: number;
  voice: VoiceName;
  section: number;
  absolute: number; // Integer L: units from the start of this voice.
  length: number;
  meter: [number, number];
  events: TimelineEvent[];
  annotations: TimelineAnnotation[];
  sourceStart: number;
  sourceEnd: number;
  compressedIndex: number;
  compressedCount: number;
  issues: string[];
}
export interface TimelineSection { title: string; index: number; firstBar: number; lastBar: number }
export interface ScoreTimeline {
  abc: string;
  unitDenominator: number;
  bpm: number;
  sections: TimelineSection[];
  bars: Record<VoiceName, TimelineBar[]>;
  errors: string[];
}
export interface LyricPhrase { section: number; line: number; text: string; first_bar: number; last_bar: number }
export interface SyllableAssignment { text: string; first_note: number | null; last_note: number | null }
export interface AlignmentLine { section: number; line: number; text: string; syllables: SyllableAssignment[] }
export interface LyricAlignment { abc: string; lyrics: string; lines: AlignmentLine[] }
export interface EditorMetadata { lyrics: string; phrases: LyricPhrase[]; alignment?: LyricAlignment | null; working_lyrics?: string | null }
const supportedDurations = [48, 32, 24, 16, 12, 8, 6, 4, 3, 2, 1];
const majorKeys = ["Cb", "Gb", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#"];
const minorKeys = ["Abm", "Ebm", "Bbm", "Fm", "Cm", "Gm", "Dm", "Am", "Em", "Bm", "F#m", "C#m", "G#m", "D#m", "A#m"];
const naturalPitches: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const chordPattern = /^[A-G](?:bb|##|b|#)?(?:m|dim|aug|7|maj7|m7|dim7|m7b5|sus4|sus2|6|m6|7sus4|m\(maj7\))?(?:\/[A-G](?:bb|##|b|#)?)?$/;
function keyAlterations(key: string): Record<string, number> {
  const index = majorKeys.includes(key) ? majorKeys.indexOf(key) : minorKeys.indexOf(key);
  if (index < 0) throw Error(`Unsupported key ${key}.`);
  const count = index - 7;
  const result: Record<string, number> = {};
  for (const letter of (count > 0 ? "FCGDAEB" : "BEADGCF").slice(0, Math.abs(count))) result[letter] = count > 0 ? 1 : -1;
  return result;
}
function meterValue(value: string): [number, number] {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value);
  if (!match) throw Error(`Unsupported meter ${value}.`);
  const [numerator, denominator] = match.slice(1).map(Number);
  if (numerator > 64 || denominator > 1024 || (denominator & (denominator - 1))) throw Error("Meter is outside the timeline's editing range.");
  return [numerator, denominator];
}

export function parseTimeline(abc: string): ScoreTimeline {
  const result: ScoreTimeline = { abc, unitDenominator: 32, bpm: 120, sections: [], bars: { Vocal: [], Ins: [] }, errors: [] };
  if (!abc.trim()) return result;
  if (abc.length > 100000) { result.errors.push("Score exceeds 100,000 characters."); return result; }
  const lines: { text: string; offset: number }[] = [];
  let offset = 0;
  for (const line of abc.split(/(?<=\n)/)) { lines.push({ text: line.replace(/\r?\n$/, ""), offset }); offset += line.length; }
  try {
    if (lines[0]?.text !== "X:1" || lines[1]?.text !== "T:") throw Error("Timeline requires the native X:1 and blank T: header. Use Advanced for other ABC formats.");
    const meter = meterValue(lines[2]?.text.replace(/^M:/, "") ?? "");
    const unit = /^L:1\/(\d+)$/.exec(lines[3]?.text ?? "");
    const denominator = Number(unit?.[1]);
    if (!unit || denominator < 1 || denominator > 1024 || (denominator & (denominator - 1))) throw Error("Unsupported note-length unit. Use Advanced.");
    result.unitDenominator = denominator;
    const tempo = /^Q:1\/4=([1-9]\d*)$/.exec(lines[4]?.text ?? "");
    if (!tempo) throw Error("Expected quarter-note tempo Q:1/4=<BPM>.");
    result.bpm = Number(tempo[1]);
    if (lines[5]?.text !== 'V: Vocal clef=treble name="Vocal Melody" snm="Vocal"' || lines[6]?.text !== 'V: Ins clef=treble name="Ins Melody" snm="Inst."') throw Error("Preserve the native Vocal and Ins voice definitions.");
    const key = lines[7]?.text.replace(/^K:/, "") ?? "";
    keyAlterations(key);
    const contexts = {
      Vocal: { meter, key, keys: [[0, key]] as [number, string][], absolute: 0, pending: null as { pitch: number; written: number; chain: string } | null },
      Ins: { meter, key, keys: [[0, key]] as [number, string][], absolute: 0, pending: null as { pitch: number; written: number; chain: string } | null },
    };
    let cursor = 8;
    let section: TimelineSection | undefined;
    while (cursor < lines.length) {
      let title = "";
      while (lines[cursor]?.text.startsWith("% ")) { title = lines[cursor].text.slice(2); cursor++; }
      if (!section || title) {
        section = { title: title || "Score", index: result.sections.length, firstBar: result.bars.Vocal.length + 1, lastBar: result.bars.Vocal.length };
        result.sections.push(section);
      }
      const counts: number[] = [];
      for (const voice of ["Vocal", "Ins"] as const) {
        if (lines[cursor]?.text !== `V: ${voice}`) throw Error(`Expected V: ${voice} near line ${cursor + 1}.`);
        cursor++;
        const context = contexts[voice];
        const fields = new Set<string>();
        while (/^[MK]:/.test(lines[cursor]?.text ?? "")) {
          const line = lines[cursor++].text;
          if (fields.has(line[0])) throw Error("Duplicate meter/key field.");
          fields.add(line[0]);
          if (line.startsWith("M:")) context.meter = meterValue(line.slice(2));
          else { keyAlterations(line.slice(2)); context.key = line.slice(2); context.keys.push([context.absolute, context.key]); }
        }
        const music = lines[cursor++];
        if (!music?.text.endsWith("|")) throw Error(`Music near line ${cursor} must end with a plain barline.`);
        let partOffset = 0;
        let count = 0;
        for (const part of music.text.slice(0, -1).split("|")) {
          const compressed = /^\s*Z([2-4])?\s*$/.exec(part);
          const expanded = compressed ? Number(compressed[1] || 1) : 1;
          for (let repeat = 0; repeat < expanded; repeat++) {
            const length = context.meter[0] * denominator / context.meter[1];
            const number = result.bars[voice].length + 1;
            const bar: TimelineBar = { id: `${voice}:${number}`, number, voice, section: section.index, absolute: context.absolute, length,
              meter: [...context.meter], events: [], annotations: [], sourceStart: music.offset + partOffset, sourceEnd: music.offset + partOffset + part.length,
              compressedIndex: repeat, compressedCount: expanded, issues: [] };
            result.bars[voice].push(bar);
            try {
              if (!Number.isInteger(length) || length < 1 || length > 8192) throw Error("Bar length cannot be edited at this score's resolution.");
              if (compressed) {
                if (context.pending) throw Error("A tied note enters a full-bar rest.");
                bar.events.push({ id: `${bar.id}:0`, onset: 0, duration: length, pitch: null, chain: `${bar.id}:0`, tiedFrom: false, tiedTo: false });
              } else {
                const pattern = /"([^"\r\n]*)"|\[K:([^\]\r\n]+)\]|(\^\^|__|\^|_|=)?([A-Ga-gz])([,']*)(\d*)(-?)/y;
                let position = 0;
                let time = 0;
                let local: Record<string, number> = {};
                while (position < part.length) {
                  if (/\s/.test(part[position])) { position++; continue; }
                  pattern.lastIndex = position;
                  const match = pattern.exec(part);
                  if (!match) throw Error(`Unsupported notation near ${part.slice(position, position + 12)}.`);
                  position = pattern.lastIndex;
                  if (time >= length) throw Error("An event starts after the bar ends.");
                  if (match[1] !== undefined) {
                    if (!chordPattern.test(match[1]) || voice !== "Vocal") throw Error("Unsupported chord annotation.");
                    bar.annotations.push({ onset: time, kind: "chord", value: match[1] }); continue;
                  }
                  if (match[2] !== undefined) {
                    keyAlterations(match[2]); context.key = match[2]; context.keys.push([context.absolute + time, context.key]); local = {};
                    bar.annotations.push({ onset: time, kind: "key", value: match[2] }); continue;
                  }
                  const [, , , accidental, note, octave, units, tie] = match;
                  const duration = Number(units || 1);
                  if (!supportedDurations.includes(duration)) throw Error(`Unsupported ABC duration ${duration}.`);
                  if (time + duration > length) throw Error("Note/rest extends past the barline.");
                  if (octave.includes(",") && octave.includes("'")) throw Error("Mixed octave marks.");
                  const id = `${bar.id}:${bar.events.length}`;
                  let pitch: number | null = null;
                  let written = 0;
                  let chain = id;
                  const tiedFrom = context.pending !== null;
                  if (note === "z") {
                    if (accidental || octave || tie || context.pending) throw Error("Invalid rest or tie entering a rest.");
                  } else {
                    const letter = note.toUpperCase();
                    written = 60 + naturalPitches[letter] + (note === note.toLowerCase() ? 12 : 0) + 12 * ([...octave].filter(c => c === "'").length - [...octave].filter(c => c === ",").length);
                    if (accidental) local[letter] = ({ "=": 0, "_": -1, "__": -2, "^": 1, "^^": 2 } as Record<string, number>)[accidental];
                    pitch = written + (local[letter] ?? keyAlterations(context.key)[letter] ?? 0);
                    if (context.pending) {
                      if (!accidental && written === context.pending.written) pitch = context.pending.pitch;
                      if (pitch !== context.pending.pitch) throw Error("Tied notes change pitch.");
                      chain = context.pending.chain;
                    }
                    if (pitch < 0 || pitch > 127) throw Error("Pitch is outside MIDI range.");
                  }
                  bar.events.push({ id, onset: time, duration, pitch, chain, tiedFrom, tiedTo: Boolean(tie) });
                  context.pending = tie && pitch !== null ? { pitch, written, chain } : null;
                  time += duration;
                }
                if (time !== length) throw Error(`Bar has ${time * 4 / denominator} quarter-note beats; expected ${length * 4 / denominator}.`);
              }
            } catch (error) { bar.issues.push(error instanceof Error ? error.message : "Invalid bar."); }
            context.absolute += length;
            count++;
          }
          partOffset += part.length + 1;
        }
        counts.push(count);
        if (count < 1 || count > 4) throw Error("Each native music line must contain 1–4 expanded bars.");
      }
      if (counts[0] !== counts[1]) throw Error("Vocal and instrumental music lines have different bar counts.");
      section.lastBar = result.bars.Vocal.length;
    }
    for (const voice of ["Vocal", "Ins"] as const) {
      if (contexts[voice].pending) result.errors.push(`${voice}: unresolved tie at the end of the score.`);
      for (const bar of result.bars[voice]) for (const issue of bar.issues) result.errors.push(`${voice}, bar ${bar.number}: ${issue}`);
    }
    if (JSON.stringify(contexts.Vocal.keys) !== JSON.stringify(contexts.Ins.keys)) throw Error("Voice key-change timelines differ.");
    for (let index = 0; index < result.bars.Vocal.length; index++) {
      const a = result.bars.Vocal[index], b = result.bars.Ins[index];
      if (!b || a.absolute !== b.absolute || a.meter.join() !== b.meter.join()) throw Error("Voice bar grids differ.");
    }
  } catch (error) { result.errors.push(error instanceof Error ? error.message : "Unsupported score."); }
  return result;
}

export function pitchLabel(pitch: number | null): string {
  if (pitch === null) return "Rest";
  return ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"][pitch % 12] + (Math.floor(pitch / 12) - 1);
}
export function durationLabel(units: number, denominator: number): string {
  const whole = units / denominator;
  for (const [fraction, label] of [[1, "Whole"], [.5, "Half"], [.25, "Quarter"], [.125, "Eighth"], [.0625, "Sixteenth"], [.03125, "Thirty-second"]] as const) {
    if (whole === fraction) return label;
    if (whole === fraction * 1.5) return `Dotted ${label.toLowerCase()}`;
  }
  return `${Number((whole * 4).toFixed(4))} quarter-note beats`;
}
function pitchSource(pitch: number | null): string {
  if (pitch === null) return "z";
  const names = ["=C", "^C", "=D", "_E", "=E", "=F", "^F", "=G", "_A", "=A", "_B", "=B"];
  const octave = Math.floor(pitch / 12) - 5;
  return names[pitch % 12] + (octave >= 0 ? "'".repeat(octave) : ",".repeat(-octave));
}
/** Rebuild only edited bars, spelling pitches explicitly so neighboring notes keep their sound. */
function serializeBar(bar: TimelineBar): string {
  if (bar.events.length === 1 && bar.events[0].pitch === null && !bar.annotations.length) return "Z";
  let output = "";
  for (const event of bar.events) {
    let time = event.onset;
    const end = time + event.duration;
    while (time < end) {
      for (const annotation of bar.annotations.filter(item => item.onset === time)) output += annotation.kind === "chord" ? `"${annotation.value}"` : `[K:${annotation.value}]`;
      const nextMarker = bar.annotations.find(item => item.onset > time && item.onset < end)?.onset ?? end;
      const duration = supportedDurations.find(value => value <= nextMarker - time)!;
      if (!duration) throw Error("Timing is outside supported resolution.");
      output += pitchSource(event.pitch) + duration + (event.pitch !== null && (time + duration < end || event.tiedTo) ? "-" : "");
      time += duration;
    }
  }
  return output;
}
function writeBars(score: ScoreTimeline, updates: Map<string, TimelineBar>): string {
  if (score.errors.length) throw Error("Fix the highlighted score issues in Advanced before visual editing.");
  const edits: { start: number; end: number; text: string }[] = [];
  const seen = new Set<string>();
  for (const bar of updates.values()) {
    const key = `${bar.sourceStart}:${bar.sourceEnd}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const group = score.bars[bar.voice].filter(item => item.sourceStart === bar.sourceStart);
    edits.push({ start: bar.sourceStart, end: bar.sourceEnd, text: group.map(item => updates.has(item.id) ? serializeBar(updates.get(item.id)!) : item.compressedCount > 1 ? "Z" : score.abc.slice(item.sourceStart, item.sourceEnd)).join("|") });
  }
  let abc = score.abc;
  for (const edit of edits.sort((a, b) => b.start - a.start)) abc = abc.slice(0, edit.start) + edit.text + abc.slice(edit.end);
  const checked = parseTimeline(abc);
  if (checked.errors.length) throw Error(checked.errors[0]);
  return abc;
}
export function chainInfo(score: ScoreTimeline, bar: TimelineBar, event: TimelineEvent) {
  const members = score.bars[bar.voice].flatMap(item => item.events.filter(note => note.chain === event.chain).map(note => ({ bar: item, event: note })));
  const first = members[0];
  const start = first.bar.absolute + first.event.onset;
  const duration = members.reduce((total, item) => total + item.event.duration, 0);
  const section = score.sections[first.bar.section];
  const sectionBars = score.bars[bar.voice].filter(item => item.section === section.index);
  const sectionEnd = sectionBars.at(-1)!.absolute + sectionBars.at(-1)!.length;
  const next = score.bars[bar.voice].flatMap(item => item.events.map(note => ({ note, start: item.absolute + note.onset })))
    .find(item => item.start >= start + duration && item.note.pitch !== null);
  // A tie may already cross a section boundary; keep that chain editable without adding new overlap.
  const limit = Math.max(start + duration, Math.min(next?.start ?? sectionEnd, sectionEnd));
  return { members, start, duration, available: limit - start, first };
}
export function editTimelineEvent(score: ScoreTimeline, barId: string, eventId: string,
  change: { pitch?: number | null; duration?: number; splitAfter?: number }): string {
  const bar = [...score.bars.Vocal, ...score.bars.Ins].find(item => item.id === barId);
  const event = bar?.events.find(item => item.id === eventId);
  if (!bar || !event) throw Error("Select a note or rest again.");
  const info = chainInfo(score, bar, event);
  const duration = change.duration ?? info.duration;
  const pitch = change.pitch === undefined ? event.pitch : change.pitch;
  if (pitch !== null && (!Number.isInteger(pitch) || pitch < 0 || pitch > 127)) throw Error("Pitch must be in MIDI range.");
  if (!Number.isInteger(duration) || duration < 1) throw Error("Choose a duration at the score's note resolution.");
  if (duration > info.available) throw Error(`That duration overlaps another note or the section end. Available: ${durationLabel(info.available, score.unitDenominator)}. Shorten the following note or convert it to a rest first.`);
  const split = change.splitAfter;
  if (split !== undefined && (!Number.isInteger(split) || split <= 0 || split >= duration)) throw Error("Split must fall inside the selected note/rest.");
  const newEnd = info.start + duration;
  const affectedEnd = Math.max(newEnd, info.start + info.duration);
  const updates = new Map<string, TimelineBar>();
  for (const original of score.bars[bar.voice]) {
    if (original.absolute >= affectedEnd || original.absolute + original.length <= info.start) continue;
    const events: TimelineEvent[] = [];
    for (const old of original.events) {
      const start = original.absolute + old.onset, end = start + old.duration;
      if (old.chain === event.chain || (old.pitch === null && start < newEnd && end > info.start)) {
        if (start < info.start) events.push({ ...old, duration: info.start - start });
        if (end > newEnd) {
          const tailStart = Math.max(start, newEnd);
          events.push({ ...old, id: `${old.id}:tail`, chain: `${old.id}:tail`, onset: tailStart - original.absolute, duration: end - tailStart, pitch: null, tiedFrom: false, tiedTo: false });
        }
      } else events.push({ ...old });
    }
    const boundaries = split === undefined ? [info.start, newEnd] : [info.start, info.start + split, newEnd];
    for (let index = 0; index < boundaries.length - 1; index++) {
      const start = Math.max(boundaries[index], original.absolute), end = Math.min(boundaries[index + 1], original.absolute + original.length);
      if (end > start) events.push({ id: `${event.id}:edit:${index}`, chain: `${event.chain}:edit:${index}`, onset: start - original.absolute, duration: end - start, pitch,
        tiedFrom: pitch !== null && start > boundaries[index], tiedTo: pitch !== null && end < boundaries[index + 1] });
    }
    events.sort((a, b) => a.onset - b.onset);
    updates.set(original.id, { ...original, events });
  }
  return writeBars(score, updates);
}
export function editTimelineChord(score: ScoreTimeline, barId: string, annotationIndex: number, chord: string): string {
  if (!chordPattern.test(chord)) throw Error("Enter a chord such as C, Dm, Bbmaj7 or G/B.");
  const bar = score.bars.Vocal.find(item => item.id === barId);
  if (!bar || bar.annotations[annotationIndex]?.kind !== "chord") throw Error("Select the chord again.");
  return writeBars(score, new Map([[bar.id, { ...bar, annotations: bar.annotations.map((item, index) => index === annotationIndex ? { ...item, value: chord } : item) }]]));
}
export function sectionLyrics(lyrics: string, title: string, occurrence: number): string {
  const blocks = [...lyrics.matchAll(/^\[([^\]]+)\][ \t]*\r?\n([\s\S]*?)(?=^\[|$(?![\s\S]))/gm)];
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const matches = blocks.filter(block => normalize(block[1]) === normalize(title));
  return matches[occurrence]?.[2].trim() ?? "";
}

/** Place/move a monophonic note without moving neighbors or changing bar/annotation times. */
function placeTimelineNote(score: ScoreTimeline, bar: TimelineBar, start: number, duration: number, pitch: number, sourceChain?: string): string {
  if (score.errors.length) throw Error("Fix the highlighted score issues in Advanced before visual editing.");
  if (!Number.isInteger(start) || !Number.isInteger(duration) || duration < 1) throw Error("Choose a position and length at the score's resolution.");
  if (!Number.isInteger(pitch) || pitch < 0 || pitch > 127) throw Error("Pitch must be in MIDI range.");
  const sectionBars = score.bars[bar.voice].filter(item => item.section === bar.section);
  const sectionStart = sectionBars[0].absolute;
  const sectionEnd = sectionBars.at(-1)!.absolute + sectionBars.at(-1)!.length;
  const end = start + duration;
  if (start < sectionStart || end > sectionEnd) throw Error("Keep the note within the selected section.");
  const sourceMembers = score.bars[bar.voice].flatMap(item => item.events.filter(event => sourceChain !== undefined && event.chain === sourceChain).map(event => ({ bar: item, event })));
  if (sourceMembers.some(item => item.bar.section !== bar.section)) throw Error("This tie crosses sections. Change its pitch or length with the inspector; moving it requires Advanced.");
  for (const original of sectionBars) for (const event of original.events) {
    const eventStart = original.absolute + event.onset;
    if (event.pitch !== null && event.chain !== sourceChain && eventStart < end && eventStart + event.duration > start)
      throw Error("That position overlaps another note. Choose empty space, shorten the note, or turn the other note into a rest first.");
  }
  const updates = new Map<string, TimelineBar>();
  for (const original of sectionBars) {
    const hasSource = sourceMembers.some(item => item.bar.id === original.id);
    const hasTarget = original.absolute < end && original.absolute + original.length > start;
    if (!hasSource && !hasTarget) continue;
    const events: TimelineEvent[] = [];
    for (const old of original.events) {
      const oldStart = original.absolute + old.onset, oldEnd = oldStart + old.duration;
      if (old.chain === sourceChain || (old.pitch === null && oldStart < end && oldEnd > start)) {
        // Everything released by a move becomes silence; preserve space outside the new note.
        if (oldStart < start) events.push({ ...old, id: `${old.id}:before`, chain: `${old.id}:before`, duration: Math.min(oldEnd, start) - oldStart, pitch: null, tiedFrom: false, tiedTo: false });
        if (oldEnd > end) {
          const tailStart = Math.max(oldStart, end);
          events.push({ ...old, id: `${old.id}:after`, chain: `${old.id}:after`, onset: tailStart - original.absolute, duration: oldEnd - tailStart, pitch: null, tiedFrom: false, tiedTo: false });
        }
      } else events.push({ ...old });
    }
    if (hasTarget) {
      const noteStart = Math.max(start, original.absolute), noteEnd = Math.min(end, original.absolute + original.length);
      events.push({ id: `${original.id}:placed`, chain: "placed", onset: noteStart - original.absolute, duration: noteEnd - noteStart, pitch, tiedFrom: noteStart > start, tiedTo: noteEnd < end });
    }
    events.sort((a, b) => a.onset - b.onset);
    updates.set(original.id, { ...original, events });
  }
  return writeBars(score, updates);
}
export function insertTimelineNote(score: ScoreTimeline, barId: string, onset: number, duration: number, pitch: number): string {
  const bar = [...score.bars.Vocal, ...score.bars.Ins].find(item => item.id === barId);
  if (!bar || onset < 0 || onset >= bar.length) throw Error("Choose a position inside a bar.");
  return placeTimelineNote(score, bar, bar.absolute + onset, duration, pitch);
}
export function moveTimelineEvent(score: ScoreTimeline, barId: string, eventId: string, start: number, pitch: number): string {
  const bar = [...score.bars.Vocal, ...score.bars.Ins].find(item => item.id === barId);
  const event = bar?.events.find(item => item.id === eventId);
  if (!bar || !event || event.pitch === null) throw Error("Select a sounding note to move.");
  const info = chainInfo(score, bar, event);
  if (start === info.start) {
    return pitch === event.pitch ? score.abc : editTimelineEvent(score, barId, eventId, { pitch });
  }
  return placeTimelineNote(score, bar, start, info.duration, pitch, event.chain);
}
