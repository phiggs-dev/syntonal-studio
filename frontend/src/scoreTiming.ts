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
