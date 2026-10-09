/** Preview timings are quarter-note fractions; oscillator playback is synthetic, never YuE2 audio. */
export interface PreviewNote {
  onset: number;
  duration: number;
  midi: number;
}
function fraction(value: unknown): number {
  if (typeof value !== "string" || !/^\d+(?:\/\d+)?$/.test(value))
    throw Error("Unsupported note timing.");
  const [numerator, denominator = "1"] = value.split("/").map(Number);
  const result = numerator / Number(denominator);
  if (!Number.isFinite(result) || result < 0)
    throw Error("Invalid note timing.");
  return result;
}
export function previewNotes(
  report: Record<string, unknown> | null,
): PreviewNote[] {
  if (
    !report ||
    typeof report.bpm !== "number" ||
    !Number.isFinite(report.bpm) ||
    report.bpm <= 0
  )
    throw Error("No validated tempo available.");
  const voices = report.voices;
  if (!voices || typeof voices !== "object")
    throw Error("No validated voices available.");
  const notes: PreviewNote[] = [];
  const secondsPerQuarter = 60 / report.bpm;
  for (const voice of Object.values(voices)) {
    if (
      !voice ||
      typeof voice !== "object" ||
      !("notes" in voice) ||
      !Array.isArray(voice.notes)
    )
      throw Error("Unsupported voice report.");
    for (const note of voice.notes) {
      if (
        !note ||
        typeof note !== "object" ||
        typeof note.midi_pitch !== "number" ||
        !Number.isInteger(note.midi_pitch) ||
        note.midi_pitch < 0 ||
        note.midi_pitch > 127
      )
        throw Error("Invalid note pitch.");
      const onset = fraction(note.onset_quarters) * secondsPerQuarter;
      const duration = fraction(note.duration_quarters) * secondsPerQuarter;
      if (duration <= 0 || onset + duration > 600)
        throw Error("Synthetic preview is limited to ten minutes.");
      notes.push({ onset, duration, midi: note.midi_pitch });
      if (notes.length > 20000)
        throw Error("Too many notes for synthetic preview.");
    }
  }
  if (!notes.length) throw Error("No sounding notes to preview.");
  return notes;
}

export interface PreviewRange {
  start: number; // Quarter-note units, matching the native report.
  end: number;
  voice: "Vocal" | "Ins";
}
export function previewRangeNotes(report: Record<string, unknown> | null, range?: PreviewRange): PreviewNote[] {
  if (!range) return previewNotes(report);
  if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.end <= range.start)
    throw Error("Select a valid bar range.");
  if (!report || typeof report.voices !== "object" || !report.voices) throw Error("No validated voices available.");
  const notes = previewNotes({ ...report, voices: { [range.voice]: (report.voices as Record<string, unknown>)[range.voice] } });
  const bpm = report.bpm as number; // previewNotes validated the tempo above.
  const start = range.start * 60 / bpm, end = range.end * 60 / bpm;
  const clipped = notes.filter(note => note.onset < end && note.onset + note.duration > start).map(note => ({
    ...note, onset: Math.max(note.onset, start) - start,
    duration: Math.min(note.onset + note.duration, end) - Math.max(note.onset, start),
  }));
  if (!clipped.length) throw Error("This range contains only rests.");
  return clipped;
}
